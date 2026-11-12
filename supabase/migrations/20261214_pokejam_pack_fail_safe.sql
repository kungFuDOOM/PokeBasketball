-- Pack Battles: fail-safe money handling. Shared gauntlet-legends project: only pokejam_* objects. Runs after
-- 20261023_pokejam_pack_payouts.sql and 20261024_pokejam_pack_keep_or_sell.sql.
--
--   * Every transaction the house sends to Collector Crypt (a purchase or a buyback) is recorded before it's
--     submitted: its id and blockhash. If the reply is lost, the worker asks the chain whether it landed (and,
--     once its blockhash has expired, knows for sure it never will) instead of guessing or parking the prize.
--   * Nothing can be charged without that record, so a crash always leaves a prize that's safe to retry.
--   * A kill switch and an hourly spending cap stop every purchase, delivery and buyback, or every purchase over
--     the cap, without a deploy.
--   * The ledger is append-only, and pokejam_pack_post is the one way to move a balance (never below zero).
--   * pokejam_pack_health says what the house owes and what needs a person, for the worker's alerts.

-- ---------- columns ----------

alter table public.pokejam_pack_prizes
  add column if not exists pay_txid text,
  add column if not exists pay_memo text,
  add column if not exists pay_blockhash text,
  add column if not exists pay_amount bigint check (pay_amount > 0),
  add column if not exists paid_at timestamptz,
  add column if not exists cash_txid text,
  add column if not exists cash_blockhash text,
  add column if not exists cash_pending bigint check (cash_pending > 0),
  add column if not exists cash_memo text,
  add column if not exists pulled_at timestamptz;

-- ---------- settings ----------

-- (pokejam_config comes from 20261027_pokejam_human_check.sql; created here too in case this runs first.)
create table if not exists public.pokejam_config (
  key text primary key,
  value jsonb not null
);
alter table public.pokejam_config enable row level security;
revoke all on public.pokejam_config from anon, authenticated, public;

-- pack_payouts_paused: true stops the worker entirely (no purchase, delivery or buyback) until it's false again.
-- pack_max_spend_per_hour: the most the house may spend on pulls in any hour, in USDC base units.
insert into public.pokejam_config(key, value) values ('pack_payouts_paused', 'false') on conflict (key) do nothing;
insert into public.pokejam_config(key, value) values ('pack_max_spend_per_hour', '1000000000') on conflict (key) do nothing;

create or replace function public.pokejam_pack_paused()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select value = 'true'::jsonb from public.pokejam_config where key = 'pack_payouts_paused'), false);
$$;

-- Why the house may not spend p_amount on a pull right now, or null when it may.
create or replace function public.pokejam_pack_spend_check(p_amount bigint)
returns text language plpgsql stable security definer set search_path = public as $$
declare cap bigint; spent bigint;
begin
  if public.pokejam_pack_paused() then return 'payouts are paused'; end if;
  select coalesce((select (value #>> '{}')::bigint from public.pokejam_config where key = 'pack_max_spend_per_hour'), 0) into cap;
  select coalesce(sum(pay_amount), 0) into spent from public.pokejam_pack_prizes where paid_at > now() - interval '1 hour';
  if spent + p_amount > cap then
    return format('the hourly spending cap is reached (%s of %s USDC in the last hour)', round(spent / 1e6, 2), round(cap / 1e6, 2));
  end if;
  return null;
end $$;

-- ---------- the ledger: append-only, never below zero ----------

create or replace function public.pokejam_pack_ledger_append_only()
returns trigger language plpgsql as $$
begin
  raise exception 'pokejam_pack_ledger is append-only: post a correcting row instead';
end $$;
drop trigger if exists pokejam_pack_ledger_append_only on public.pokejam_pack_ledger;
create trigger pokejam_pack_ledger_append_only before update or delete on public.pokejam_pack_ledger
  for each row execute function public.pokejam_pack_ledger_append_only();

-- Move a player's balance by p_delta (a credit, or a debit when negative). Idempotent on (kind, ref): posting the
-- same row again returns false and changes nothing; the same (kind, ref) with a different user or amount is an
-- error. A debit that would take the balance below zero is refused. One player's posts run one at a time.
create or replace function public.pokejam_pack_post(p_user uuid, p_delta bigint, p_kind text, p_ref text, p_note text default null)
returns boolean language plpgsql security definer set search_path = public as $$
declare old public.pokejam_pack_ledger; bal bigint;
begin
  if p_delta is null or p_delta = 0 then raise exception 'amount must not be zero'; end if;
  if coalesce(p_kind, '') = '' or coalesce(p_ref, '') = '' then raise exception 'kind and ref are required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('pokejam_pack_ledger:' || p_user::text, 0));
  select * into old from public.pokejam_pack_ledger where kind = p_kind and ref = p_ref;
  if old.id is not null then
    if old.user_id <> p_user or old.delta <> p_delta then
      raise exception 'ledger row %/% already exists with a different user or amount', p_kind, p_ref;
    end if;
    return false;
  end if;
  if p_delta < 0 then
    select coalesce(sum(delta), 0) into bal from public.pokejam_pack_ledger where user_id = p_user;
    if bal + p_delta < 0 then raise exception 'insufficient balance: % available, % needed', bal, -p_delta; end if;
  end if;
  insert into public.pokejam_pack_ledger(user_id, delta, kind, ref, note) values (p_user, p_delta, p_kind, p_ref, left(p_note, 500));
  return true;
end $$;

-- ---------- purchases and buybacks: recorded before they're sent ----------

-- About to submit a purchase: record it first. False (and the worker doesn't submit) unless the prize is this
-- worker's and has no purchase yet.
create or replace function public.pokejam_pack_prize_submitting(p_id uuid, p_memo text, p_txid text, p_blockhash text, p_amount bigint)
returns boolean language sql security definer set search_path = public as $$
  with r as (
    update public.pokejam_pack_prizes set pay_memo = p_memo, pay_txid = p_txid, pay_blockhash = p_blockhash, pay_amount = p_amount,
      paid_at = now(), updated_at = now()
    where id = p_id and state = 'sending' and memo is null and nft_address is null and pay_txid is null returning 1
  ) select exists (select 1 from r);
$$;

-- The chain says that purchase can never land (it failed, or its blockhash expired unseen): forget it.
create or replace function public.pokejam_pack_prize_submit_cleared(p_id uuid)
returns void language sql security definer set search_path = public as $$
  update public.pokejam_pack_prizes set pay_memo = null, pay_txid = null, pay_blockhash = null, pay_amount = null, paid_at = null,
    updated_at = now()
  where id = p_id and state = 'sending' and memo is null and nft_address is null;
$$;

-- About to submit a buyback: record it first, with what it pays the house.
create or replace function public.pokejam_pack_prize_cashing(p_id uuid, p_txid text, p_blockhash text, p_amount bigint, p_memo text)
returns boolean language sql security definer set search_path = public as $$
  with r as (
    update public.pokejam_pack_prizes set cash_txid = p_txid, cash_blockhash = p_blockhash, cash_pending = p_amount, cash_memo = p_memo,
      updated_at = now()
    where id = p_id and state = 'sending' and nft_address is not null and cash_txid is null returning 1
  ) select exists (select 1 from r);
$$;

create or replace function public.pokejam_pack_prize_cash_cleared(p_id uuid)
returns void language sql security definer set search_path = public as $$
  update public.pokejam_pack_prizes set cash_txid = null, cash_blockhash = null, cash_pending = null, cash_memo = null, updated_at = now()
  where id = p_id and state = 'sending';
$$;

-- The pull is open: also note when, for the buyback window.
create or replace function public.pokejam_pack_prize_pulled(p_id uuid, p_memo text, p_nft text, p_rarity text, p_pull jsonb)
returns void language sql security definer set search_path = public as $$
  update public.pokejam_pack_prizes set memo = p_memo, nft_address = p_nft, rarity = p_rarity, pull = p_pull,
    pulled_at = coalesce(pulled_at, now()), updated_at = now()
  where id = p_id and state = 'sending';
$$;

-- A refund is only for a pull that was never paid for: not with a purchase in flight either.
create or replace function public.pokejam_pack_prize_refunded(p_id uuid, p_why text)
returns void language plpgsql security definer set search_path = public as $$
declare p public.pokejam_pack_prizes;
begin
  select * into p from public.pokejam_pack_prizes where id = p_id for update;
  if p.id is null then raise exception 'no such prize'; end if;
  if p.state = 'refunded' then return; end if;
  if p.state <> 'sending' then raise exception 'prize % is %, not sending', p_id, p.state; end if;
  if p.memo is not null or p.nft_address is not null or p.pay_txid is not null then
    raise exception 'prize % was already paid for; it cannot be refunded', p_id;
  end if;
  insert into public.pokejam_pack_ledger(user_id, delta, kind, ref, note) values (p.user_id, p.price_micro, 'prize-refund', p_id::text, left(p_why, 500))
    on conflict (kind, ref) do nothing;
  update public.pokejam_pack_prizes set state = 'refunded', cash_amount = p.price_micro, last_error = left(p_why, 1000), updated_at = now() where id = p_id;
end $$;

-- After a crash, every prize stuck in 'sending' is safe to retry: nothing is submitted without a record, and a
-- recorded transaction is resolved on-chain before anything else happens.
create or replace function public.pokejam_pack_recover_prizes(p_max_attempts int)
returns void language sql security definer set search_path = public as $$
  update public.pokejam_pack_prizes set state = 'pending', next_try_at = now(), updated_at = now()
    where state = 'sending' and updated_at < now() - interval '10 minutes';
$$;

-- A prize that needs nothing from a person waits without using up its attempts (the house is short of USDC, the
-- hourly cap is reached, a transaction is still landing).
create or replace function public.pokejam_pack_prize_held(p_id uuid, p_reason text, p_retry_seconds int)
returns void language sql security definer set search_path = public as $$
  update public.pokejam_pack_prizes set state = 'failed', last_error = left(p_reason, 1000),
    next_try_at = now() + make_interval(secs => greatest(5, least(p_retry_seconds, 3600))), updated_at = now()
  where id = p_id and state = 'sending';
$$;

-- ---------- health ----------

-- What the house owes and what needs a person. Liabilities: every player's balance, plus the pot of every prize
-- whose pull isn't bought yet. The worker compares them with the house's USDC.
create or replace function public.pokejam_pack_health(p_max_attempts int)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'balances', (select coalesce(sum(delta), 0) from public.pokejam_pack_ledger),
    'unbought_pots', (select coalesce(sum(price_micro), 0) from public.pokejam_pack_prizes
      where state in ('pending', 'sending', 'failed', 'revealed') and memo is null and nft_address is null and pay_txid is null),
    'parked', (select count(*) from public.pokejam_pack_prizes where state = 'failed' and attempts >= p_max_attempts),
    'held', (select count(*) from public.pokejam_pack_prizes where state = 'failed' and attempts < p_max_attempts),
    'cards_in_house_over_48h', (select count(*) from public.pokejam_pack_prizes
      where nft_address is not null and state not in ('sent', 'cashed') and coalesce(pulled_at, created_at) < now() - interval '48 hours'),
    'oldest_unsettled_minutes', (select coalesce(floor(extract(epoch from now() - min(created_at)) / 60), 0) from public.pokejam_pack_prizes
      where state in ('pending', 'sending', 'failed')),
    'paused', public.pokejam_pack_paused()
  );
$$;

-- Alerts go out at most once per p_minutes for the same key.
create table if not exists public.pokejam_pack_alerts (
  key text primary key,
  sent_at timestamptz not null
);
alter table public.pokejam_pack_alerts enable row level security;
revoke all on public.pokejam_pack_alerts from anon, authenticated, public;

create or replace function public.pokejam_pack_alert_due(p_key text, p_minutes int)
returns boolean language plpgsql security definer set search_path = public as $$
declare n int;
begin
  insert into public.pokejam_pack_alerts(key, sent_at) values (p_key, now())
    on conflict (key) do update set sent_at = now()
    where public.pokejam_pack_alerts.sent_at < now() - make_interval(mins => greatest(1, p_minutes));
  get diagnostics n = row_count;
  return n = 1;
end $$;

-- ---------- grants ----------

revoke all on function public.pokejam_pack_paused(), public.pokejam_pack_spend_check(bigint),
  public.pokejam_pack_post(uuid, bigint, text, text, text), public.pokejam_pack_prize_submitting(uuid, text, text, text, bigint),
  public.pokejam_pack_prize_submit_cleared(uuid), public.pokejam_pack_prize_cashing(uuid, text, text, bigint, text),
  public.pokejam_pack_prize_cash_cleared(uuid), public.pokejam_pack_prize_held(uuid, text, int),
  public.pokejam_pack_health(int), public.pokejam_pack_alert_due(text, int), public.pokejam_pack_ledger_append_only()
  from public, anon, authenticated;
grant execute on function public.pokejam_pack_paused(), public.pokejam_pack_spend_check(bigint),
  public.pokejam_pack_post(uuid, bigint, text, text, text), public.pokejam_pack_prize_submitting(uuid, text, text, text, bigint),
  public.pokejam_pack_prize_submit_cleared(uuid), public.pokejam_pack_prize_cashing(uuid, text, text, bigint, text),
  public.pokejam_pack_prize_cash_cleared(uuid), public.pokejam_pack_prize_held(uuid, text, int),
  public.pokejam_pack_health(int), public.pokejam_pack_alert_due(text, int)
  to service_role;
