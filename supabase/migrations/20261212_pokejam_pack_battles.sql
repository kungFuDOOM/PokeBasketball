-- Pack Battles (devnet test): a skill battle for a Collector Crypt pack, on the same online stack as Ranked.
-- pokejam_* objects only. Runs after 20261023 (payouts), 20261024 (keep or sell) and 20261211 (fail-safes).
--
--   1. A player enters a tier (Starter $25, Elite $50, Bronze $100). Their half of the pot plus their half of the
--      fee is taken from their balance at once (pokejam_pack_post), so nobody can enter with money they don't have.
--   2. Two players waiting on the same tier are paired, near each other's MMR, into a 'pack' match with a server
--      seed. Teams are balanced from the seed (roster.ts), like Ranked. Both players sign their inputs.
--   3. After the game both upload their evidence, and the pokejam-pack-judge Edge Function replays it
--      (winnerCheck.ts, judgeMatch.ts) and settles here (pokejam_pack_settle): the winner's pack is queued for the
--      payout worker. A player who quits forfeits (kungFuDOOM's rule): they signed a resignation on the way out, or
--      went quiet and never uploaded. A tie, or a game that never got going, refunds both players in full, fee
--      included. A disconnect with both players still there, or evidence that can't be judged, is held for a person,
--      and nothing moves. Pack Battles uploads (each with its player's connection log) are kept 90 days for support.
--   4. Leaving the queue before a match is found refunds the entry. An entry nobody polls for 30 s is refunded.
--
-- Devnet only: there are no deposits or withdrawals yet. With pack_test_credits on, a player can take $100 of test
-- USDC a day into their balance (pokejam_pack_test_credit), so the test site can be played without a wallet.

-- ---------- the pack queue ----------

alter table public.pokejam_queue drop constraint if exists pokejam_queue_queue_check;
alter table public.pokejam_queue add constraint pokejam_queue_queue_check check (queue in ('social', 'ranked', 'pack'));
alter table public.pokejam_matches drop constraint if exists pokejam_matches_queue_check;
alter table public.pokejam_matches add constraint pokejam_matches_queue_check check (queue in ('social', 'ranked', 'pack'));

insert into public.pokejam_config(key, value) values ('pack_fee_bps', '500') on conflict (key) do nothing;
insert into public.pokejam_config(key, value) values ('pack_test_credits', 'false') on conflict (key) do nothing;

-- A tier's pot: the price of its Collector Crypt pack.
create or replace function public.pokejam_pack_tier_price(p_tier text)
returns bigint language sql immutable as $$
  select case p_tier when 'pokemon_25' then 25000000 when 'pokemon_50' then 50000000 when 'pokemon_100' then 100000000 end::bigint;
$$;

-- What one player pays to enter a tier: half the pot and half the fee.
create or replace function public.pokejam_pack_entry_cost(p_tier text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('stake', public.pokejam_pack_tier_price(p_tier) / 2,
    'fee', public.pokejam_pack_tier_price(p_tier) * coalesce((select (value #>> '{}')::int from public.pokejam_config where key = 'pack_fee_bps'), 500) / 20000);
$$;

create table if not exists public.pokejam_pack_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  tier text not null check (tier in ('pokemon_25', 'pokemon_50', 'pokemon_100')),
  wallet text not null check (wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  prefer_cash boolean not null default false,
  stake bigint not null check (stake > 0),
  fee bigint not null check (fee >= 0),
  mmr int not null,
  state text not null default 'waiting' check (state in ('waiting', 'matched', 'refunded')),
  match_id uuid references public.pokejam_matches(id) on delete restrict,
  joined_at timestamptz not null default now(),
  polled_at timestamptz not null default now()
);
create unique index if not exists pokejam_pack_entries_one_waiting on public.pokejam_pack_entries(user_id) where state = 'waiting';
create index if not exists pokejam_pack_entries_waiting on public.pokejam_pack_entries(tier, polled_at) where state = 'waiting';

create table if not exists public.pokejam_pack_battles (
  match_id uuid primary key references public.pokejam_matches(id) on delete restrict,
  tier text not null check (tier in ('pokemon_25', 'pokemon_50', 'pokemon_100')),
  pot bigint not null check (pot > 0),
  fee bigint not null check (fee >= 0),
  host_entry uuid not null references public.pokejam_pack_entries(id),
  guest_entry uuid not null references public.pokejam_pack_entries(id),
  state text not null default 'playing' check (state in ('playing', 'won', 'void', 'review')),
  winner uuid references auth.users(id),
  outcome text,
  note text,
  prize_id uuid references public.pokejam_pack_prizes(id),
  created_at timestamptz not null default now(),
  settled_at timestamptz
);
create index if not exists pokejam_pack_battles_playing on public.pokejam_pack_battles(created_at) where state = 'playing';

alter table public.pokejam_pack_entries enable row level security;
alter table public.pokejam_pack_battles enable row level security;
revoke all on public.pokejam_pack_entries, public.pokejam_pack_battles from anon, authenticated, public;
grant select on public.pokejam_pack_entries, public.pokejam_pack_battles to authenticated;
drop policy if exists "pokejam pack own entries" on public.pokejam_pack_entries;
create policy "pokejam pack own entries" on public.pokejam_pack_entries for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "pokejam pack own battles" on public.pokejam_pack_battles;
create policy "pokejam pack own battles" on public.pokejam_pack_battles for select to authenticated
  using (exists (select 1 from public.pokejam_matches m where m.id = match_id and (select auth.uid()) in (m.host, m.guest)));

-- Refund one waiting entry (internal).
create or replace function public.pokejam_pack_refund_entry(p_entry uuid, p_why text)
returns void language plpgsql security definer set search_path = public as $$
declare e public.pokejam_pack_entries;
begin
  select * into e from public.pokejam_pack_entries where id = p_entry for update;
  if e.id is null or e.state <> 'waiting' then return; end if;
  update public.pokejam_pack_entries set state = 'refunded' where id = e.id;
  perform public.pokejam_pack_post(e.user_id, e.stake + e.fee, 'pack-entry-refund', e.id::text, p_why);
end $$;

-- Refund entries nobody has polled for 30 s (they closed the tab). Anyone's matchmaking call sweeps a few.
create or replace function public.pokejam_pack_sweep(p_limit int default 20)
returns int language plpgsql security definer set search_path = public as $$
declare e record; n int := 0;
begin
  for e in select id from public.pokejam_pack_entries where state = 'waiting' and polled_at < now() - interval '30 seconds'
    order by polled_at limit greatest(1, least(p_limit, 200)) for update skip locked loop
    perform public.pokejam_pack_refund_entry(e.id, 'stopped searching');
    n := n + 1;
  end loop;
  return n;
end $$;

-- ---------- player RPCs ----------

-- Enter (or keep polling) a tier's queue. The first call takes the entry cost from my balance; later calls keep the
-- entry alive. Returns a match id once paired, else null. Poll every 2 s; stop polling and the entry is refunded.
create or replace function public.pokejam_pack_find(p_tier text, p_wallet text, p_prefer_cash boolean default false)
returns uuid language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); my public.pokejam_profiles; mine public.pokejam_pack_entries; other public.pokejam_pack_entries;
  mach public.pokejam_pack_machines; cost jsonb; win int; mid uuid;
begin
  if me is null then raise exception 'not signed in'; end if;
  if public.pokejam_pack_tier_price(p_tier) is null then raise exception 'bad tier'; end if;
  if p_wallet is null or p_wallet !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' then raise exception 'Enter a valid Solana wallet address for your card.'; end if;
  if public.pokejam_banned(me) then raise exception 'You are suspended from online play for now.'; end if;
  if not public.pokejam_human_ok(me) then raise exception 'human check needed'; end if;
  if not public.pokejam_rate_ok('pack-find', 60, interval '1 minute') then raise exception 'Slow down: too many matchmaking requests.'; end if;
  perform public.pokejam_pack_sweep(5);

  -- Already paired by the other player's call?
  select * into mine from public.pokejam_pack_entries where user_id = me and state = 'waiting' for update;
  if mine.id is null then
    select e.match_id into mid from public.pokejam_pack_entries e join public.pokejam_pack_battles b on b.match_id = e.match_id
      where e.user_id = me and e.state = 'matched' and b.state = 'playing' and b.created_at > now() - interval '2 minutes'
      order by e.joined_at desc limit 1;
    if mid is not null then return mid; end if;
    -- A new entry: the machine must be selling at the tier's price, and I must be able to pay.
    select * into mach from public.pokejam_pack_machines where code = p_tier;
    if mach.code is null or not mach.available or mach.price_micro is distinct from public.pokejam_pack_tier_price(p_tier) then
      raise exception 'This pack is paused right now%', coalesce(': ' || mach.why, '.');
    end if;
    if public.pokejam_pack_paused() then raise exception 'Pack Battles are paused right now.'; end if;
    select * into my from public.pokejam_profiles where id = me;
    if my.id is null then raise exception 'no profile'; end if;
    cost := public.pokejam_pack_entry_cost(p_tier);
    insert into public.pokejam_pack_entries(user_id, tier, wallet, prefer_cash, stake, fee, mmr)
      values (me, p_tier, p_wallet, coalesce(p_prefer_cash, false), (cost->>'stake')::bigint, (cost->>'fee')::bigint, my.mmr)
      returning * into mine;
    -- Raises "insufficient balance" (and rolls the entry back) if I can't pay.
    perform public.pokejam_pack_post(me, -(mine.stake + mine.fee), 'pack-entry', mine.id::text, 'Pack Battle entry');
  elsif mine.tier <> p_tier then
    raise exception 'You are already searching for another pack. Cancel that search first.';
  else
    update public.pokejam_pack_entries set polled_at = now() where id = mine.id returning * into mine;
  end if;

  win := least(1000, 100 + 10 * extract(epoch from now() - mine.joined_at)::int);
  select * into other from public.pokejam_pack_entries o
    where o.state = 'waiting' and o.tier = p_tier and o.user_id <> me and o.polled_at > now() - interval '10 seconds'
      and abs(o.mmr - mine.mmr) <= win and not public.pokejam_blocked_pair(me, o.user_id) and not public.pokejam_banned(o.user_id)
    order by abs(o.mmr - mine.mmr), o.joined_at limit 1 for update skip locked;
  if other.id is null then return null; end if;

  insert into public.pokejam_matches(queue, host, guest, host_mmr, guest_mmr, seed, quarter_len)
    values ('pack', other.user_id, me, other.mmr, mine.mmr, public.pokejam_new_seed(), 120) returning id into mid;
  update public.pokejam_pack_entries set state = 'matched', match_id = mid where id in (mine.id, other.id);
  insert into public.pokejam_pack_battles(match_id, tier, pot, fee, host_entry, guest_entry)
    values (mid, p_tier, other.stake + mine.stake, other.fee + mine.fee, other.id, mine.id);
  return mid;
end $$;

-- Stop searching: my waiting entry is refunded in full.
create or replace function public.pokejam_pack_leave()
returns void language plpgsql security definer set search_path = public as $$
declare e uuid;
begin
  select id into e from public.pokejam_pack_entries where user_id = auth.uid() and state = 'waiting';
  if e is not null then perform public.pokejam_pack_refund_entry(e, 'cancelled the search'); end if;
end $$;

-- Devnet test site only (pack_test_credits on): $100 of test USDC into my balance, once a day.
create or replace function public.pokejam_pack_test_credit()
returns bigint language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'not signed in'; end if;
  if not coalesce((select value = 'true'::jsonb from public.pokejam_config where key = 'pack_test_credits'), false) then
    raise exception 'Test credits are off.';
  end if;
  if not public.pokejam_pack_post(me, 100000000, 'test-credit', me::text || ':' || to_char(now() at time zone 'utc', 'YYYY-MM-DD'), 'devnet test USDC') then
    raise exception 'You already took today''s test credits. Come back tomorrow.';
  end if;
  return (select coalesce(sum(delta), 0)::bigint from public.pokejam_pack_ledger where user_id = me);
end $$;

-- Everything the Pack Battles screen shows: my balance, the three tiers (live from Collector Crypt), what entering
-- costs, whether test credits are on, my current search, and my recent prizes.
create or replace function public.pokejam_pack_lobby()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'balance', (select coalesce(sum(delta), 0) from public.pokejam_pack_ledger where user_id = auth.uid()),
    'test_credits', coalesce((select value = 'true'::jsonb from public.pokejam_config where key = 'pack_test_credits'), false),
    'paused', public.pokejam_pack_paused(),
    'tiers', (select coalesce(jsonb_agg(jsonb_build_object('code', t.code, 'pot', public.pokejam_pack_tier_price(t.code),
        'cost', public.pokejam_pack_entry_cost(t.code), 'available', coalesce(m.available, false)
          and m.price_micro = public.pokejam_pack_tier_price(t.code), 'why', m.why, 'odds', m.odds, 'ev', m.ev, 'buyback', m.buyback)
        order by public.pokejam_pack_tier_price(t.code)), '[]'::jsonb)
      from (values ('pokemon_25'), ('pokemon_50'), ('pokemon_100')) as t(code)
      left join public.pokejam_pack_machines m on m.code = t.code),
    'searching', (select jsonb_build_object('tier', tier, 'since', joined_at) from public.pokejam_pack_entries
      where user_id = auth.uid() and state = 'waiting'),
    'prizes', (select coalesce(jsonb_agg(p order by p.created_at desc), '[]'::jsonb) from (
      select id, battle_id, state, tier, price_micro, pull, sell_estimate, choose_by, choice, prefer_cash, cash_amount, nft_address, transfer_sig, created_at
      from public.pokejam_pack_prizes where user_id = auth.uid() order by created_at desc limit 10) p)
  );
$$;

-- One battle as I see it: where it stands and, when I won, my prize.
create or replace function public.pokejam_pack_battle(p_match uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('state', b.state, 'tier', b.tier, 'pot', b.pot, 'outcome', b.outcome, 'note', b.note,
    'won', b.winner = auth.uid(), 'prize', (select to_jsonb(p) - 'memo' - 'pay_memo' - 'last_error' from public.pokejam_pack_prizes p
      where p.id = b.prize_id and p.user_id = auth.uid()))
  from public.pokejam_pack_battles b join public.pokejam_matches m on m.id = b.match_id
  where b.match_id = p_match and auth.uid() in (m.host, m.guest);
$$;

-- ---------- service role (the pokejam-pack-judge Edge Function) ----------

-- Battles ready to judge: both players uploaded, or one did 3 minutes ago, or nobody did and an hour has passed
-- (the game never got going). With the match row, both names, both uploads and who uploaded (a player who never
-- did, in a game that stopped early, forfeits).
create or replace function public.pokejam_pack_due_battles(p_limit int)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(row_to_json(x)), '[]'::jsonb) from (
    select b.match_id, b.tier, m.seed, m.quarter_len, m.host, m.guest, m.host_key, m.guest_key,
      hp.trainer_name as host_name, gp.trainer_name as guest_name,
      (select coalesce(jsonb_agg(e.evidence), '[]'::jsonb) from public.pokejam_match_evidence e where e.match_id = b.match_id) as uploads,
      exists (select 1 from public.pokejam_match_evidence e where e.match_id = b.match_id and e.user_id = m.host) as host_uploaded,
      exists (select 1 from public.pokejam_match_evidence e where e.match_id = b.match_id and e.user_id = m.guest) as guest_uploaded
    from public.pokejam_pack_battles b
    join public.pokejam_matches m on m.id = b.match_id
    join public.pokejam_profiles hp on hp.id = m.host
    join public.pokejam_profiles gp on gp.id = m.guest
    where b.state = 'playing' and (
      (select count(*) from public.pokejam_match_evidence e where e.match_id = b.match_id) >= 2
      or exists (select 1 from public.pokejam_match_evidence e where e.match_id = b.match_id and e.created_at < now() - interval '3 minutes')
      or b.created_at < now() - interval '1 hour')
    order by b.created_at
    limit greatest(1, least(p_limit, 20))
  ) x;
$$;

-- Settle a judged battle (idempotent: a settled battle is returned as it stands).
--   p_result 'host' or 'guest': that player's pack is queued for the payout worker.
--   'void': no winner (a tie, or the game never got going): both players get their entries back, fee included.
--   'review': a disconnect with both players still there, or evidence that can't be judged; nothing moves until a
--   person decides.
create or replace function public.pokejam_pack_settle(p_match uuid, p_result text, p_outcome text, p_note text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare b public.pokejam_pack_battles; w public.pokejam_pack_entries; e public.pokejam_pack_entries; pid uuid;
begin
  if p_result not in ('host', 'guest', 'void', 'review') then raise exception 'bad result'; end if;
  select * into b from public.pokejam_pack_battles where match_id = p_match for update;
  if b.match_id is null then raise exception 'no such battle'; end if;
  if b.state <> 'playing' then return jsonb_build_object('state', b.state, 'prize', b.prize_id); end if;
  if p_result in ('host', 'guest') then
    select * into w from public.pokejam_pack_entries where id = case when p_result = 'host' then b.host_entry else b.guest_entry end;
    pid := public.pokejam_pack_queue_prize(p_match::text, w.user_id, w.wallet, b.tier, b.pot, w.prefer_cash);
    update public.pokejam_pack_battles set state = 'won', winner = w.user_id, prize_id = pid, outcome = left(p_outcome, 40),
      note = left(p_note, 1000), settled_at = now() where match_id = p_match;
    update public.pokejam_matches set status = 'done', winner = w.user_id, finished_at = coalesce(finished_at, now()) where id = p_match;
  elsif p_result = 'void' then
    for e in select * from public.pokejam_pack_entries where id in (b.host_entry, b.guest_entry) loop
      perform public.pokejam_pack_post(e.user_id, e.stake + e.fee, 'pack-refund', p_match::text || ':' || e.user_id::text, coalesce(p_note, 'no winner'));
    end loop;
    update public.pokejam_pack_battles set state = 'void', outcome = left(p_outcome, 40), note = left(p_note, 1000), settled_at = now()
      where match_id = p_match;
    update public.pokejam_matches set status = 'void', finished_at = coalesce(finished_at, now()) where id = p_match;
  else
    update public.pokejam_pack_battles set state = 'review', outcome = left(p_outcome, 40), note = left(p_note, 1000), settled_at = now()
      where match_id = p_match;
  end if;
  select * into b from public.pokejam_pack_battles where match_id = p_match;
  return jsonb_build_object('state', b.state, 'prize', b.prize_id);
end $$;

-- Health (20261211) also counts what's held in Pack Battles: entries waiting for a match, pots of battles still being
-- played, and battles waiting on a person.
create or replace function public.pokejam_pack_health(p_max_attempts int)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'balances', (select coalesce(sum(delta), 0) from public.pokejam_pack_ledger),
    'unbought_pots', (select coalesce(sum(price_micro), 0) from public.pokejam_pack_prizes
      where state in ('pending', 'sending', 'failed', 'revealed') and memo is null and nft_address is null and pay_txid is null)
      + (select coalesce(sum(e.stake + e.fee), 0) from public.pokejam_pack_entries e where e.state = 'waiting')
      + (select coalesce(sum(b.pot + b.fee), 0) from public.pokejam_pack_battles b where b.state in ('playing', 'review')),
    'parked', (select count(*) from public.pokejam_pack_prizes where state = 'failed' and attempts >= p_max_attempts)
      + (select count(*) from public.pokejam_pack_battles where state = 'review'),
    'held', (select count(*) from public.pokejam_pack_prizes where state = 'failed' and attempts < p_max_attempts),
    'cards_in_house_over_48h', (select count(*) from public.pokejam_pack_prizes
      where nft_address is not null and state not in ('sent', 'cashed') and coalesce(pulled_at, created_at) < now() - interval '48 hours'),
    'oldest_unsettled_minutes', (select coalesce(floor(extract(epoch from now() - min(created_at)) / 60), 0) from public.pokejam_pack_prizes
      where state in ('pending', 'sending', 'failed')),
    'paused', public.pokejam_pack_paused()
  );
$$;

-- Evidence retention (20261029) keeps Pack Battles uploads longer: 90 days, and for as long as a battle is unsettled
-- or held for a person. Each carries its player's connection log, which support needs to look into a disconnect.
create or replace function public.pokejam_prune_evidence(p_days int default 30)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from public.pokejam_match_evidence e where e.created_at < now() - make_interval(days => greatest(1, p_days))
    and not exists (select 1 from public.pokejam_pack_battles b where b.match_id = e.match_id
      and (b.state in ('playing', 'review') or b.created_at > now() - interval '90 days'));
  get diagnostics n = row_count;
  return n;
end $$;

-- ---------- grants ----------

revoke all on function public.pokejam_pack_tier_price(text), public.pokejam_pack_entry_cost(text), public.pokejam_pack_refund_entry(uuid, text),
  public.pokejam_pack_sweep(int), public.pokejam_pack_find(text, text, boolean), public.pokejam_pack_leave(), public.pokejam_pack_test_credit(),
  public.pokejam_pack_lobby(), public.pokejam_pack_battle(uuid), public.pokejam_pack_due_battles(int), public.pokejam_pack_settle(uuid, text, text, text)
  from public, anon, authenticated;
grant execute on function public.pokejam_pack_find(text, text, boolean), public.pokejam_pack_leave(), public.pokejam_pack_test_credit(),
  public.pokejam_pack_lobby(), public.pokejam_pack_battle(uuid) to authenticated;
grant execute on function public.pokejam_pack_sweep(int), public.pokejam_pack_due_battles(int), public.pokejam_pack_settle(uuid, text, text, text)
  to service_role;
