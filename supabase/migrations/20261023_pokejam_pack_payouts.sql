-- Pack Battles payouts (step 3 of the plan on issue #4). Shared gauntlet-legends project: only pokejam_* objects.
--
-- After a battle has a winner (judged by src/multiplayer/shared/winnerCheck.ts), its prize is queued here and
-- the pokejam-pack-payouts Edge Function buys the winner's Collector Crypt pull, then sends the card, sells it
-- back for cash (if the winner prefers), or credits the whole pot if CC won't sell.
--
-- Players can read their own prizes and ledger rows, and anyone signed in can read the live machines. Every
-- write goes through the service-role functions below; only the pokejam-pack-* Edge Functions call them.
-- Money and prize rows are never deleted with a user (on delete restrict).

-- ---------- tables ----------

create table if not exists public.pokejam_pack_machines (
  code text primary key,
  price_micro bigint,
  available boolean not null default false,
  why text,
  odds jsonb,
  ev numeric,
  buyback numeric,
  updated_at timestamptz not null default now()
);

-- Append-only USDC ledger in base units (6 decimals). A balance is the sum of a player's rows; unique (kind, ref)
-- makes every credit idempotent, so a retried step can never pay twice. Escrow and deposits will post here too.
create table if not exists public.pokejam_pack_ledger (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete restrict,
  delta bigint not null check (delta <> 0),
  kind text not null,
  ref text not null,
  note text,
  created_at timestamptz not null default now(),
  unique (kind, ref)
);
create index if not exists pokejam_pack_ledger_user_idx on public.pokejam_pack_ledger(user_id);

-- One row per battle's prize: pending -> sending -> sent | cashed | refunded, or failed (retried with backoff,
-- parked after too many tries).
create table if not exists public.pokejam_pack_prizes (
  id uuid primary key default gen_random_uuid(),
  battle_id text not null unique,
  user_id uuid not null references auth.users(id) on delete restrict,
  wallet text not null check (wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  tier text not null check (tier in ('pokemon_25', 'pokemon_50', 'pokemon_100')),
  price_micro bigint not null check (price_micro > 0),
  prefer_cash boolean not null default false,
  state text not null default 'pending' check (state in ('pending', 'sending', 'sent', 'cashed', 'refunded', 'failed')),
  memo text,
  nft_address text,
  rarity text,
  pull jsonb,
  transfer_sig text,
  cash_amount bigint,
  attempts int not null default 0,
  last_error text,
  next_try_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists pokejam_pack_prizes_due_idx on public.pokejam_pack_prizes(state, next_try_at);
create index if not exists pokejam_pack_prizes_user_idx on public.pokejam_pack_prizes(user_id);

alter table public.pokejam_pack_machines enable row level security;
alter table public.pokejam_pack_ledger enable row level security;
alter table public.pokejam_pack_prizes enable row level security;

revoke all on public.pokejam_pack_machines, public.pokejam_pack_ledger, public.pokejam_pack_prizes from anon, authenticated, public;
revoke all on sequence public.pokejam_pack_ledger_id_seq from anon, authenticated, public;
grant select on public.pokejam_pack_machines, public.pokejam_pack_ledger, public.pokejam_pack_prizes to authenticated;

drop policy if exists "pokejam pack machines readable" on public.pokejam_pack_machines;
create policy "pokejam pack machines readable" on public.pokejam_pack_machines for select to authenticated using (true);
drop policy if exists "pokejam pack own ledger" on public.pokejam_pack_ledger;
create policy "pokejam pack own ledger" on public.pokejam_pack_ledger for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "pokejam pack own prizes" on public.pokejam_pack_prizes;
create policy "pokejam pack own prizes" on public.pokejam_pack_prizes for select to authenticated using (user_id = (select auth.uid()));

-- ---------- player RPC ----------

create or replace function public.pokejam_pack_balance()
returns bigint language sql stable security definer set search_path = public as $$
  select coalesce(sum(delta), 0)::bigint from public.pokejam_pack_ledger where user_id = auth.uid();
$$;

-- ---------- service-role functions (Edge Functions only) ----------

-- Queue a winner's prize. Idempotent per battle: returns the existing prize if it's already queued.
create or replace function public.pokejam_pack_queue_prize(p_battle text, p_user uuid, p_wallet text, p_tier text,
  p_price bigint, p_prefer_cash boolean default false)
returns uuid language plpgsql security definer set search_path = public as $$
declare pid uuid;
begin
  insert into public.pokejam_pack_prizes(battle_id, user_id, wallet, tier, price_micro, prefer_cash)
    values (p_battle, p_user, p_wallet, p_tier, p_price, coalesce(p_prefer_cash, false))
    on conflict (battle_id) do nothing returning id into pid;
  if pid is null then select id into pid from public.pokejam_pack_prizes where battle_id = p_battle; end if;
  return pid;
end $$;

-- Claim up to p_limit due prizes for one worker run. skip locked lets overlapping runs share the queue safely.
create or replace function public.pokejam_pack_claim_prizes(p_limit int, p_max_attempts int)
returns setof public.pokejam_pack_prizes language sql security definer set search_path = public as $$
  with due as (
    select id from public.pokejam_pack_prizes
    where (state = 'pending' or (state = 'failed' and attempts < p_max_attempts)) and next_try_at <= now()
    order by created_at
    limit greatest(1, least(coalesce(p_limit, 10), 50))
    for update skip locked
  )
  update public.pokejam_pack_prizes p set state = 'sending', updated_at = now()
  from due where p.id = due.id
  returning p.*;
$$;

-- After a crash: a prize stuck in 'sending' for 10+ minutes goes back in the queue when every step after it is
-- safe to retry (it has a memo or a card); otherwise a purchase may have been charged without its memo, so it's
-- parked for a person. The 10 minutes keep this away from a run that's still working.
create or replace function public.pokejam_pack_recover_prizes(p_max_attempts int)
returns void language sql security definer set search_path = public as $$
  update public.pokejam_pack_prizes set state = 'pending', next_try_at = now(), updated_at = now()
    where state = 'sending' and updated_at < now() - interval '10 minutes' and (nft_address is not null or memo is not null);
  update public.pokejam_pack_prizes set state = 'failed', attempts = p_max_attempts, updated_at = now(),
    last_error = 'Interrupted while buying: check Collector Crypt for a pack bought by the house for this battle before retrying'
    where state = 'sending' and updated_at < now() - interval '10 minutes' and nft_address is null and memo is null;
$$;

-- The purchase is paid: keep its memo before anything else can fail, so a retry resumes instead of buying again.
create or replace function public.pokejam_pack_prize_paid(p_id uuid, p_memo text)
returns void language sql security definer set search_path = public as $$
  update public.pokejam_pack_prizes set memo = p_memo, updated_at = now() where id = p_id and state = 'sending';
$$;

-- The pull is open and the card is in the house wallet.
create or replace function public.pokejam_pack_prize_pulled(p_id uuid, p_memo text, p_nft text, p_rarity text, p_pull jsonb)
returns void language sql security definer set search_path = public as $$
  update public.pokejam_pack_prizes set memo = p_memo, nft_address = p_nft, rarity = p_rarity, pull = p_pull, updated_at = now()
  where id = p_id and state = 'sending';
$$;

create or replace function public.pokejam_pack_prize_sent(p_id uuid, p_sig text)
returns void language sql security definer set search_path = public as $$
  update public.pokejam_pack_prizes set state = 'sent', transfer_sig = p_sig, last_error = null, updated_at = now()
  where id = p_id and state = 'sending';
$$;

-- The winner chose cash: credit the buyback and settle the prize, in one transaction.
create or replace function public.pokejam_pack_prize_cashed(p_id uuid, p_amount bigint, p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare p public.pokejam_pack_prizes;
begin
  if p_amount is null or p_amount <= 0 then raise exception 'cash amount must be positive'; end if;
  select * into p from public.pokejam_pack_prizes where id = p_id for update;
  if p.id is null then raise exception 'no such prize'; end if;
  if p.state = 'cashed' then return; end if;
  if p.state <> 'sending' then raise exception 'prize % is %, not sending', p_id, p.state; end if;
  insert into public.pokejam_pack_ledger(user_id, delta, kind, ref, note) values (p.user_id, p_amount, 'prize-cash', p_id::text, p_note)
    on conflict (kind, ref) do nothing;
  update public.pokejam_pack_prizes set state = 'cashed', cash_amount = p_amount, last_error = null, updated_at = now() where id = p_id;
end $$;

-- CC wouldn't sell the pull: credit the winner the pot it was going to buy, in one transaction.
create or replace function public.pokejam_pack_prize_refunded(p_id uuid, p_why text)
returns void language plpgsql security definer set search_path = public as $$
declare p public.pokejam_pack_prizes;
begin
  select * into p from public.pokejam_pack_prizes where id = p_id for update;
  if p.id is null then raise exception 'no such prize'; end if;
  if p.state = 'refunded' then return; end if;
  if p.state <> 'sending' then raise exception 'prize % is %, not sending', p_id, p.state; end if;
  if p.memo is not null or p.nft_address is not null then raise exception 'prize % was already paid for; it cannot be refunded', p_id; end if;
  insert into public.pokejam_pack_ledger(user_id, delta, kind, ref, note) values (p.user_id, p.price_micro, 'prize-refund', p_id::text, left(p_why, 500))
    on conflict (kind, ref) do nothing;
  update public.pokejam_pack_prizes set state = 'refunded', cash_amount = p.price_micro, last_error = left(p_why, 1000), updated_at = now() where id = p_id;
end $$;

create or replace function public.pokejam_pack_prize_failed(p_id uuid, p_attempts int, p_error text, p_retry_seconds int)
returns void language sql security definer set search_path = public as $$
  update public.pokejam_pack_prizes set state = 'failed', attempts = p_attempts, last_error = left(p_error, 1000),
    next_try_at = now() + make_interval(secs => greatest(0, least(p_retry_seconds, 3600))), updated_at = now()
  where id = p_id and state = 'sending';
$$;

-- Admin: send a parked prize again, after checking Collector Crypt that a first purchase didn't land.
create or replace function public.pokejam_pack_retry_prize(p_id uuid)
returns boolean language sql security definer set search_path = public as $$
  with r as (
    update public.pokejam_pack_prizes set state = 'pending', attempts = 0, next_try_at = now(), updated_at = now()
    where id = p_id and state = 'failed' returning 1
  ) select exists (select 1 from r);
$$;

-- Replace the lobby's copy of CC's machines (from the machines function or a payout run).
create or replace function public.pokejam_pack_upsert_machines(p_rows jsonb)
returns void language sql security definer set search_path = public as $$
  insert into public.pokejam_pack_machines(code, price_micro, available, why, odds, ev, buyback, updated_at)
  select r.code, r.price_micro, coalesce(r.available, false), r.why, r.odds, r.ev, r.buyback, now()
  from jsonb_to_recordset(p_rows) as r(code text, price_micro bigint, available boolean, why text, odds jsonb, ev numeric, buyback numeric)
  where r.code in ('pokemon_25', 'pokemon_50', 'pokemon_100')
  on conflict (code) do update set price_micro = excluded.price_micro, available = excluded.available, why = excluded.why,
    odds = excluded.odds, ev = excluded.ev, buyback = excluded.buyback, updated_at = excluded.updated_at;
$$;

revoke all on function public.pokejam_pack_balance(), public.pokejam_pack_queue_prize(text, uuid, text, text, bigint, boolean),
  public.pokejam_pack_claim_prizes(int, int), public.pokejam_pack_recover_prizes(int), public.pokejam_pack_prize_paid(uuid, text),
  public.pokejam_pack_prize_pulled(uuid, text, text, text, jsonb), public.pokejam_pack_prize_sent(uuid, text),
  public.pokejam_pack_prize_cashed(uuid, bigint, text), public.pokejam_pack_prize_refunded(uuid, text),
  public.pokejam_pack_prize_failed(uuid, int, text, int), public.pokejam_pack_retry_prize(uuid),
  public.pokejam_pack_upsert_machines(jsonb)
  from public, anon, authenticated;
grant execute on function public.pokejam_pack_balance() to authenticated;
grant execute on function public.pokejam_pack_queue_prize(text, uuid, text, text, bigint, boolean),
  public.pokejam_pack_claim_prizes(int, int), public.pokejam_pack_recover_prizes(int), public.pokejam_pack_prize_paid(uuid, text),
  public.pokejam_pack_prize_pulled(uuid, text, text, text, jsonb), public.pokejam_pack_prize_sent(uuid, text),
  public.pokejam_pack_prize_cashed(uuid, bigint, text), public.pokejam_pack_prize_refunded(uuid, text),
  public.pokejam_pack_prize_failed(uuid, int, text, int), public.pokejam_pack_retry_prize(uuid),
  public.pokejam_pack_upsert_machines(jsonb)
  to service_role;
