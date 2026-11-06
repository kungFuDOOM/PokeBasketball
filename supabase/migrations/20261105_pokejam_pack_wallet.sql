-- Pack Battles: real USDC in and out (the escrow checklist in supabase/functions/README.md). pokejam_* objects only.
-- Runs after 20261103 (Pack Battles). The pokejam-pack-wallet Edge Function does the chain side; every balance change
-- here goes through pokejam_pack_post.
--
--   * A proven wallet: a player links one wallet by signing a one-time message with it. One wallet per player, and a
--     wallet belongs to one player. Changing it starts a cooldown before any withdrawal (an account takeover can't
--     link a new wallet and cash out at once).
--   * Deposits: a finalized USDC transfer into the house's USDC account, from the player's proven wallet, is credited
--     once (ref = signature + instruction). A sender nobody has proven is held for a person; under the minimum is dust.
--   * Withdrawals: debited first, then sent by the worker, only to the proven wallet. Daily limits per player and for
--     the house, a review over a threshold, and a kill switch. The transaction is recorded before it's submitted and a
--     lost reply is settled from the chain; one that fails for good is credited back once.
--   * Fees: a won battle's fee is recorded as house revenue, so the house's USDC reconciles against the ledger.
--   * Real money: pack_real_money (off) turns test credits off for good and makes a battle's card go to the proven
--     wallet. The workers on mainnet refuse to run unless it's on and test credits are off.

-- ---------- settings (USDC base units) ----------

insert into public.pokejam_config(key, value) values
  ('pack_real_money', 'false'),
  ('pack_min_deposit', '1000000'),
  ('pack_min_withdrawal', '5000000'),
  ('pack_withdraw_daily_limit', '500000000'),
  ('pack_withdraw_review_over', '250000000'),
  ('pack_withdraw_house_daily_cap', '5000000000'),
  ('pack_wallet_cooldown_hours', '48'),
  ('pack_withdrawals_paused', 'false')
on conflict (key) do nothing;

create or replace function public.pokejam_pack_setting(p_key text, p_default bigint)
returns bigint language sql stable security definer set search_path = public as $$
  select coalesce((select (value #>> '{}')::bigint from public.pokejam_config where key = p_key), p_default);
$$;

create or replace function public.pokejam_pack_flag(p_key text)
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select value = 'true'::jsonb from public.pokejam_config where key = p_key), false);
$$;

-- ---------- the proven wallet ----------

create table if not exists public.pokejam_pack_wallets (
  user_id uuid primary key references auth.users(id) on delete restrict,
  wallet text not null unique check (wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  proven_at timestamptz not null default now(),
  -- No withdrawal before this: the moment of linking for a first wallet, plus the cooldown for a change.
  withdraw_after timestamptz not null default now()
);

create table if not exists public.pokejam_pack_wallet_challenges (
  user_id uuid primary key references auth.users(id) on delete cascade,
  wallet text not null,
  message text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create table if not exists public.pokejam_pack_wallet_log (
  id bigserial primary key,
  user_id uuid not null references auth.users(id) on delete restrict,
  old_wallet text,
  new_wallet text not null,
  at timestamptz not null default now()
);

alter table public.pokejam_pack_wallets enable row level security;
alter table public.pokejam_pack_wallet_challenges enable row level security;
alter table public.pokejam_pack_wallet_log enable row level security;
revoke all on public.pokejam_pack_wallets, public.pokejam_pack_wallet_challenges, public.pokejam_pack_wallet_log
  from anon, authenticated, public;

-- The message my wallet signs to prove it's mine. Good for 10 minutes; asking again replaces it.
create or replace function public.pokejam_pack_wallet_challenge(p_wallet text)
returns text language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); msg text; other uuid;
begin
  if me is null then raise exception 'not signed in'; end if;
  if p_wallet is null or p_wallet !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' then raise exception 'That is not a Solana wallet address.'; end if;
  if public.pokejam_banned(me) then raise exception 'You are suspended from online play for now.'; end if;
  if not public.pokejam_rate_ok('pack-wallet', 10, interval '10 minutes') then raise exception 'Slow down: too many wallet requests.'; end if;
  select user_id into other from public.pokejam_pack_wallets where wallet = p_wallet;
  if other is not null and other <> me then raise exception 'This wallet is already linked to another player.'; end if;
  msg := format(E'Poké Jam Pack Battles\nLink this wallet to my player. Deposits are credited from it and withdrawals go only to it.\n\nWallet: %s\nPlayer: %s\nCode: %s\nExpires: %s',
    p_wallet, me, encode(extensions.gen_random_bytes(12), 'hex'), to_char((now() + interval '10 minutes') at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'));
  insert into public.pokejam_pack_wallet_challenges(user_id, wallet, message, expires_at) values (me, p_wallet, msg, now() + interval '10 minutes')
    on conflict (user_id) do update set wallet = excluded.wallet, message = excluded.message, expires_at = excluded.expires_at, created_at = now();
  return msg;
end $$;

-- Service role: my open challenge, for the Edge Function to check a signature against.
create or replace function public.pokejam_pack_wallet_challenge_of(p_user uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('wallet', wallet, 'message', message) from public.pokejam_pack_wallet_challenges
  where user_id = p_user and expires_at > now();
$$;

-- Service role, once the signature checks out: link the wallet. A change starts the cooldown.
create or replace function public.pokejam_pack_wallet_link(p_user uuid, p_wallet text, p_message text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare c public.pokejam_pack_wallet_challenges; cur public.pokejam_pack_wallets; other uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended('pokejam_pack_wallet:' || p_wallet, 0));
  select * into c from public.pokejam_pack_wallet_challenges where user_id = p_user for update;
  if c.user_id is null or c.expires_at <= now() or c.wallet <> p_wallet or c.message <> p_message then
    raise exception 'That sign-in request has expired. Try linking the wallet again.';
  end if;
  delete from public.pokejam_pack_wallet_challenges where user_id = p_user;
  select user_id into other from public.pokejam_pack_wallets where wallet = p_wallet;
  if other is not null and other <> p_user then raise exception 'This wallet is already linked to another player.'; end if;
  select * into cur from public.pokejam_pack_wallets where user_id = p_user for update;
  if cur.user_id is null then
    insert into public.pokejam_pack_wallets(user_id, wallet) values (p_user, p_wallet) returning * into cur;
    insert into public.pokejam_pack_wallet_log(user_id, old_wallet, new_wallet) values (p_user, null, p_wallet);
  elsif cur.wallet <> p_wallet then
    insert into public.pokejam_pack_wallet_log(user_id, old_wallet, new_wallet) values (p_user, cur.wallet, p_wallet);
    update public.pokejam_pack_wallets set wallet = p_wallet, proven_at = now(),
      withdraw_after = now() + make_interval(hours => public.pokejam_pack_setting('pack_wallet_cooldown_hours', 48)::int)
      where user_id = p_user returning * into cur;
  end if;
  return jsonb_build_object('wallet', cur.wallet, 'withdraw_after', cur.withdraw_after);
end $$;

create or replace function public.pokejam_pack_wallet_of(p_user uuid)
returns text language sql stable security definer set search_path = public as $$
  select wallet from public.pokejam_pack_wallets where user_id = p_user;
$$;

-- ---------- deposits ----------

create table if not exists public.pokejam_pack_deposits (
  ref text primary key,                 -- signature:instruction (inner ones as signature:outer.inner)
  signature text not null,
  sender text not null,                 -- the authority that signed the transfer
  amount bigint not null check (amount > 0),
  slot bigint,
  block_time timestamptz,
  state text not null check (state in ('credited', 'held', 'dust')),
  user_id uuid references auth.users(id) on delete restrict,
  note text,
  created_at timestamptz not null default now(),
  credited_at timestamptz
);
create index if not exists pokejam_pack_deposits_user on public.pokejam_pack_deposits(user_id, created_at desc);
create index if not exists pokejam_pack_deposits_held on public.pokejam_pack_deposits(created_at) where state = 'held';
alter table public.pokejam_pack_deposits enable row level security;
revoke all on public.pokejam_pack_deposits from anon, authenticated, public;

-- Service role: one finalized transfer into the house's USDC account (the Edge Function checked the mint, the
-- destination and finality). Idempotent on ref: a transfer seen again returns how it was recorded.
create or replace function public.pokejam_pack_record_deposit(p_ref text, p_signature text, p_sender text, p_amount bigint,
  p_slot bigint, p_block_time timestamptz)
returns jsonb language plpgsql security definer set search_path = public as $$
declare d public.pokejam_pack_deposits; who uuid; st text;
begin
  if p_amount is null or p_amount <= 0 then raise exception 'deposit amount must be positive'; end if;
  perform pg_advisory_xact_lock(hashtextextended('pokejam_pack_deposit:' || p_ref, 0));
  select * into d from public.pokejam_pack_deposits where ref = p_ref;
  if d.ref is not null then
    if d.amount <> p_amount or d.sender <> p_sender then raise exception 'deposit % already recorded with a different sender or amount', p_ref; end if;
    return jsonb_build_object('state', d.state, 'user', d.user_id, 'new', false);
  end if;
  select user_id into who from public.pokejam_pack_wallets where wallet = p_sender;
  st := case when who is null then 'held' when p_amount < public.pokejam_pack_setting('pack_min_deposit', 1000000) then 'dust' else 'credited' end;
  insert into public.pokejam_pack_deposits(ref, signature, sender, amount, slot, block_time, state, user_id, note, credited_at)
    values (p_ref, p_signature, p_sender, p_amount, p_slot, p_block_time, st, who,
      case st when 'held' then 'sent from a wallet no player has proven' when 'dust' then 'under the minimum deposit' end,
      case when st = 'credited' then now() end)
    returning * into d;
  if st = 'credited' then perform public.pokejam_pack_post(who, p_amount, 'deposit', p_ref, 'USDC deposit'); end if;
  return jsonb_build_object('state', d.state, 'user', d.user_id, 'new', true);
end $$;

-- Admin (service role): credit a held deposit (or dust) to a player, once, after checking who sent it.
create or replace function public.pokejam_pack_credit_deposit(p_ref text, p_user uuid, p_note text)
returns boolean language plpgsql security definer set search_path = public as $$
declare d public.pokejam_pack_deposits;
begin
  select * into d from public.pokejam_pack_deposits where ref = p_ref for update;
  if d.ref is null then raise exception 'no such deposit'; end if;
  if d.state = 'credited' then return false; end if;
  perform public.pokejam_pack_post(p_user, d.amount, 'deposit', d.ref, coalesce(p_note, 'USDC deposit, credited by hand'));
  update public.pokejam_pack_deposits set state = 'credited', user_id = p_user, note = left(p_note, 500), credited_at = now() where ref = p_ref;
  return true;
end $$;

-- Where the deposit scan has read up to: the newest signature of the house account it has finished with.
create or replace function public.pokejam_pack_deposit_cursor()
returns text language sql stable security definer set search_path = public as $$
  select value #>> '{}' from public.pokejam_config where key = 'pack_deposit_cursor';
$$;

create or replace function public.pokejam_pack_set_deposit_cursor(p_signature text)
returns void language sql security definer set search_path = public as $$
  insert into public.pokejam_config(key, value) values ('pack_deposit_cursor', to_jsonb(p_signature))
    on conflict (key) do update set value = excluded.value;
$$;

-- ---------- withdrawals ----------

create table if not exists public.pokejam_pack_withdrawals (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete restrict,
  wallet text not null check (wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  amount bigint not null check (amount > 0),
  state text not null default 'pending' check (state in ('pending', 'review', 'sending', 'sent', 'refunded')),
  attempts int not null default 0,
  txid text,
  blockhash text,
  submitted_at timestamptz,
  next_try_at timestamptz not null default now(),
  last_error text,
  note text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  sent_at timestamptz
);
create index if not exists pokejam_pack_withdrawals_user on public.pokejam_pack_withdrawals(user_id, created_at desc);
create index if not exists pokejam_pack_withdrawals_due on public.pokejam_pack_withdrawals(next_try_at) where state = 'pending';
alter table public.pokejam_pack_withdrawals enable row level security;
revoke all on public.pokejam_pack_withdrawals from anon, authenticated, public;

-- Withdraw p_amount to my proven wallet. Debited from my balance at once; the worker sends it within a minute, or
-- a person looks first over pack_withdraw_review_over.
create or replace function public.pokejam_pack_withdraw(p_amount bigint)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); w public.pokejam_pack_wallets; lim bigint; used bigint; mn bigint; r public.pokejam_pack_withdrawals;
begin
  if me is null then raise exception 'not signed in'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'Enter an amount to withdraw.'; end if;
  if public.pokejam_banned(me) then raise exception 'You are suspended from online play for now. Contact support to withdraw.'; end if;
  if not public.pokejam_rate_ok('pack-withdraw', 5, interval '10 minutes') then raise exception 'Slow down: too many withdrawal requests.'; end if;
  if public.pokejam_pack_paused() or public.pokejam_pack_flag('pack_withdrawals_paused') then
    raise exception 'Withdrawals are paused right now. Your balance is safe.';
  end if;
  select * into w from public.pokejam_pack_wallets where user_id = me;
  if w.user_id is null then raise exception 'Link your wallet first: withdrawals only go to the wallet you proved is yours.'; end if;
  if w.withdraw_after > now() then
    raise exception 'Your wallet changed recently, so withdrawals open again at % UTC.', to_char(w.withdraw_after at time zone 'utc', 'YYYY-MM-DD HH24:MI');
  end if;
  mn := public.pokejam_pack_setting('pack_min_withdrawal', 5000000);
  if p_amount < mn then raise exception 'The smallest withdrawal is $%.', trim_scale(round(mn / 1e6, 2)); end if;
  perform pg_advisory_xact_lock(hashtextextended('pokejam_pack_ledger:' || me::text, 0));
  lim := public.pokejam_pack_setting('pack_withdraw_daily_limit', 500000000);
  select coalesce(sum(amount), 0) into used from public.pokejam_pack_withdrawals
    where user_id = me and state <> 'refunded' and created_at > now() - interval '24 hours';
  if used + p_amount > lim then
    raise exception 'That is over the daily withdrawal limit: $% left in the next 24 hours.', trim_scale(round(greatest(lim - used, 0) / 1e6, 2));
  end if;
  insert into public.pokejam_pack_withdrawals(user_id, wallet, amount, state)
    values (me, w.wallet, p_amount, case when p_amount > public.pokejam_pack_setting('pack_withdraw_review_over', 250000000) then 'review' else 'pending' end)
    returning * into r;
  -- Raises "insufficient balance" (and rolls the request back) if I don't have it.
  perform public.pokejam_pack_post(me, -p_amount, 'withdrawal', r.id::text, 'USDC withdrawal to ' || w.wallet);
  return jsonb_build_object('id', r.id, 'state', r.state, 'amount', r.amount, 'wallet', r.wallet);
end $$;

-- Credit a withdrawal back, once (it failed for good, or a person rejected it).
create or replace function public.pokejam_pack_withdrawal_refund(p_id uuid, p_why text)
returns void language plpgsql security definer set search_path = public as $$
declare r public.pokejam_pack_withdrawals;
begin
  select * into r from public.pokejam_pack_withdrawals where id = p_id for update;
  if r.id is null then raise exception 'no such withdrawal'; end if;
  if r.state = 'refunded' then return; end if;
  if r.state = 'sent' then raise exception 'withdrawal % was sent; it cannot be refunded', p_id; end if;
  if r.txid is not null then raise exception 'withdrawal % has a transaction in flight; settle it from the chain first', p_id; end if;
  perform public.pokejam_pack_post(r.user_id, r.amount, 'withdrawal-refund', r.id::text, left(p_why, 500));
  update public.pokejam_pack_withdrawals set state = 'refunded', last_error = left(p_why, 1000), updated_at = now() where id = p_id;
end $$;

-- Service role (the worker): withdrawals ready to send, claimed for this run. Stuck ones (a crash mid-send) come back
-- after 10 minutes with their recorded transaction, which the worker settles from the chain before anything else.
create or replace function public.pokejam_pack_claim_withdrawals(p_limit int)
returns setof public.pokejam_pack_withdrawals language plpgsql security definer set search_path = public as $$
begin
  update public.pokejam_pack_withdrawals set state = 'pending', next_try_at = now(), updated_at = now()
    where state = 'sending' and updated_at < now() - interval '10 minutes';
  return query update public.pokejam_pack_withdrawals w set state = 'sending', updated_at = now()
    where w.id in (select id from public.pokejam_pack_withdrawals where state = 'pending' and next_try_at <= now()
      order by created_at limit greatest(1, least(p_limit, 50)) for update skip locked)
    returning w.*;
end $$;

-- Why the house may not send p_amount right now, or null when it may: the kill switches and the house-wide daily cap.
create or replace function public.pokejam_pack_withdraw_check(p_amount bigint)
returns text language plpgsql stable security definer set search_path = public as $$
declare cap bigint; sent bigint;
begin
  if public.pokejam_pack_paused() or public.pokejam_pack_flag('pack_withdrawals_paused') then return 'withdrawals are paused'; end if;
  cap := public.pokejam_pack_setting('pack_withdraw_house_daily_cap', 5000000000);
  select coalesce(sum(amount), 0) into sent from public.pokejam_pack_withdrawals
    where txid is not null and state in ('sending', 'pending', 'sent') and submitted_at > now() - interval '24 hours';
  if sent + p_amount > cap then
    return format('the house daily withdrawal cap is reached (%s of %s USDC in 24 hours)', round(sent / 1e6, 2), round(cap / 1e6, 2));
  end if;
  return null;
end $$;

-- About to submit: record the transaction first. False (and the worker doesn't submit) unless it's this run's.
create or replace function public.pokejam_pack_withdrawal_submitting(p_id uuid, p_txid text, p_blockhash text)
returns boolean language sql security definer set search_path = public as $$
  with r as (
    update public.pokejam_pack_withdrawals set txid = p_txid, blockhash = p_blockhash, submitted_at = now(), updated_at = now()
    where id = p_id and state = 'sending' and txid is null returning 1
  ) select exists (select 1 from r);
$$;

-- The chain says that transaction can never land (it failed, or its blockhash expired unseen): forget it.
create or replace function public.pokejam_pack_withdrawal_cleared(p_id uuid)
returns void language sql security definer set search_path = public as $$
  update public.pokejam_pack_withdrawals set txid = null, blockhash = null, submitted_at = null, updated_at = now()
  where id = p_id and state = 'sending';
$$;

create or replace function public.pokejam_pack_withdrawal_sent(p_id uuid, p_txid text)
returns void language sql security definer set search_path = public as $$
  update public.pokejam_pack_withdrawals set state = 'sent', txid = p_txid, sent_at = now(), last_error = null, updated_at = now()
  where id = p_id and state = 'sending';
$$;

-- Waits without using an attempt (a transaction still landing, the house short of USDC or SOL, the cap).
create or replace function public.pokejam_pack_withdrawal_held(p_id uuid, p_reason text, p_retry_seconds int)
returns void language sql security definer set search_path = public as $$
  update public.pokejam_pack_withdrawals set state = 'pending', last_error = left(p_reason, 1000),
    next_try_at = now() + make_interval(secs => greatest(5, least(p_retry_seconds, 3600))), updated_at = now()
  where id = p_id and state = 'sending';
$$;

-- A send that failed. After p_max attempts it's credited back once.
create or replace function public.pokejam_pack_withdrawal_failed(p_id uuid, p_reason text, p_max int)
returns text language plpgsql security definer set search_path = public as $$
declare r public.pokejam_pack_withdrawals;
begin
  update public.pokejam_pack_withdrawals set attempts = attempts + 1, last_error = left(p_reason, 1000), updated_at = now()
    where id = p_id and state = 'sending' and txid is null returning * into r;
  if r.id is null then return null; end if;
  if r.attempts >= greatest(1, p_max) then
    perform public.pokejam_pack_withdrawal_refund(p_id, 'withdrawal failed: ' || coalesce(p_reason, ''));
    return 'refunded';
  end if;
  update public.pokejam_pack_withdrawals set state = 'pending', next_try_at = now() + make_interval(secs => 60 * r.attempts) where id = p_id;
  return 'pending';
end $$;

-- Admin (service role): a withdrawal held for review is sent (approve) or credited back.
create or replace function public.pokejam_pack_review_withdrawal(p_id uuid, p_approve boolean, p_note text)
returns text language plpgsql security definer set search_path = public as $$
declare r public.pokejam_pack_withdrawals;
begin
  select * into r from public.pokejam_pack_withdrawals where id = p_id for update;
  if r.id is null then raise exception 'no such withdrawal'; end if;
  if r.state <> 'review' then return r.state; end if;
  if p_approve then
    update public.pokejam_pack_withdrawals set state = 'pending', next_try_at = now(), note = left(p_note, 500), updated_at = now() where id = p_id;
    return 'pending';
  end if;
  update public.pokejam_pack_withdrawals set note = left(p_note, 500) where id = p_id;
  perform public.pokejam_pack_withdrawal_refund(p_id, coalesce(p_note, 'rejected on review'));
  return 'refunded';
end $$;

-- ---------- fees: house revenue ----------

create table if not exists public.pokejam_pack_revenue (
  match_id uuid primary key references public.pokejam_pack_battles(match_id) on delete restrict,
  fee bigint not null check (fee >= 0),
  created_at timestamptz not null default now()
);
alter table public.pokejam_pack_revenue enable row level security;
revoke all on public.pokejam_pack_revenue from anon, authenticated, public;

-- A won battle's fee is the house's. A void battle refunds it, and one under review holds it until a person decides.
create or replace function public.pokejam_pack_book_fee()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.state = 'won' and old.state is distinct from 'won' then
    insert into public.pokejam_pack_revenue(match_id, fee) values (new.match_id, new.fee) on conflict (match_id) do nothing;
  end if;
  return new;
end $$;
drop trigger if exists pokejam_pack_book_fee on public.pokejam_pack_battles;
create trigger pokejam_pack_book_fee after update of state on public.pokejam_pack_battles
  for each row execute function public.pokejam_pack_book_fee();

-- ---------- real money ----------

-- With real money, a battle's card goes only to the player's proven wallet.
create or replace function public.pokejam_pack_entry_wallet()
returns trigger language plpgsql security definer set search_path = public as $$
declare w text;
begin
  if public.pokejam_pack_flag('pack_real_money') then
    select wallet into w from public.pokejam_pack_wallets where user_id = new.user_id;
    if w is null then raise exception 'Link your wallet first: a card you win is sent to it.'; end if;
    new.wallet := w;
  end if;
  return new;
end $$;
drop trigger if exists pokejam_pack_entry_wallet on public.pokejam_pack_entries;
create trigger pokejam_pack_entry_wallet before insert on public.pokejam_pack_entries
  for each row execute function public.pokejam_pack_entry_wallet();

-- Test credits never run with real money, whatever pack_test_credits says.
create or replace function public.pokejam_pack_test_credit()
returns bigint language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'not signed in'; end if;
  if public.pokejam_pack_flag('pack_real_money') or not public.pokejam_pack_flag('pack_test_credits') then
    raise exception 'Test credits are off.';
  end if;
  if not public.pokejam_pack_post(me, 100000000, 'test-credit', me::text || ':' || to_char(now() at time zone 'utc', 'YYYY-MM-DD'), 'devnet test USDC') then
    raise exception 'You already took today''s test credits. Come back tomorrow.';
  end if;
  return (select coalesce(sum(delta), 0)::bigint from public.pokejam_pack_ledger where user_id = me);
end $$;

-- The lobby (20261103) also shows my wallet, my recent deposits and withdrawals, and the limits.
create or replace function public.pokejam_pack_lobby()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'balance', (select coalesce(sum(delta), 0) from public.pokejam_pack_ledger where user_id = auth.uid()),
    'real_money', public.pokejam_pack_flag('pack_real_money'),
    'test_credits', public.pokejam_pack_flag('pack_test_credits') and not public.pokejam_pack_flag('pack_real_money'),
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
      from public.pokejam_pack_prizes where user_id = auth.uid() order by created_at desc limit 10) p),
    'wallet', (select jsonb_build_object('address', wallet, 'withdraw_after', withdraw_after) from public.pokejam_pack_wallets
      where user_id = auth.uid()),
    'deposits', (select coalesce(jsonb_agg(d order by d.created_at desc), '[]'::jsonb) from (
      select signature, amount, state, created_at from public.pokejam_pack_deposits where user_id = auth.uid()
      order by created_at desc limit 5) d),
    'withdrawals', (select coalesce(jsonb_agg(w order by w.created_at desc), '[]'::jsonb) from (
      select id, amount, wallet, state, txid, created_at, sent_at from public.pokejam_pack_withdrawals where user_id = auth.uid()
      order by created_at desc limit 5) w),
    'limits', jsonb_build_object('min_deposit', public.pokejam_pack_setting('pack_min_deposit', 1000000),
      'min_withdrawal', public.pokejam_pack_setting('pack_min_withdrawal', 5000000),
      'daily_withdrawal', public.pokejam_pack_setting('pack_withdraw_daily_limit', 500000000),
      'withdrawn_today', (select coalesce(sum(amount), 0) from public.pokejam_pack_withdrawals
        where user_id = auth.uid() and state <> 'refunded' and created_at > now() - interval '24 hours'),
      'cooldown_hours', public.pokejam_pack_setting('pack_wallet_cooldown_hours', 48),
      'withdrawals_paused', public.pokejam_pack_paused() or public.pokejam_pack_flag('pack_withdrawals_paused'))
  );
$$;

-- Health (20261103) also counts withdrawals not sent yet (already off the balances, still in the house), deposits
-- held for a person, fee revenue, and the real-money switches the workers check on mainnet.
create or replace function public.pokejam_pack_health(p_max_attempts int)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'balances', (select coalesce(sum(delta), 0) from public.pokejam_pack_ledger),
    'unbought_pots', (select coalesce(sum(price_micro), 0) from public.pokejam_pack_prizes
      where state in ('pending', 'sending', 'failed', 'revealed') and memo is null and nft_address is null and pay_txid is null)
      + (select coalesce(sum(e.stake + e.fee), 0) from public.pokejam_pack_entries e where e.state = 'waiting')
      + (select coalesce(sum(b.pot + b.fee), 0) from public.pokejam_pack_battles b where b.state in ('playing', 'review')),
    'unsent_withdrawals', (select coalesce(sum(amount), 0) from public.pokejam_pack_withdrawals where state in ('pending', 'review', 'sending')),
    'withdrawals_in_review', (select count(*) from public.pokejam_pack_withdrawals where state = 'review'),
    'held_deposits', (select count(*) from public.pokejam_pack_deposits where state = 'held'),
    'held_deposit_amount', (select coalesce(sum(amount), 0) from public.pokejam_pack_deposits where state in ('held', 'dust')),
    'fee_revenue', (select coalesce(sum(fee), 0) from public.pokejam_pack_revenue),
    'parked', (select count(*) from public.pokejam_pack_prizes where state = 'failed' and attempts >= p_max_attempts)
      + (select count(*) from public.pokejam_pack_battles where state = 'review'),
    'held', (select count(*) from public.pokejam_pack_prizes where state = 'failed' and attempts < p_max_attempts),
    'cards_in_house_over_48h', (select count(*) from public.pokejam_pack_prizes
      where nft_address is not null and state not in ('sent', 'cashed') and coalesce(pulled_at, created_at) < now() - interval '48 hours'),
    'oldest_unsettled_minutes', (select coalesce(floor(extract(epoch from now() - min(created_at)) / 60), 0) from public.pokejam_pack_prizes
      where state in ('pending', 'sending', 'failed')),
    'paused', public.pokejam_pack_paused(),
    'real_money', public.pokejam_pack_flag('pack_real_money'),
    'test_credits', public.pokejam_pack_flag('pack_test_credits')
  );
$$;

-- ---------- grants ----------

revoke all on function public.pokejam_pack_setting(text, bigint), public.pokejam_pack_flag(text),
  public.pokejam_pack_wallet_challenge(text), public.pokejam_pack_wallet_challenge_of(uuid), public.pokejam_pack_wallet_link(uuid, text, text),
  public.pokejam_pack_wallet_of(uuid), public.pokejam_pack_record_deposit(text, text, text, bigint, bigint, timestamptz),
  public.pokejam_pack_credit_deposit(text, uuid, text), public.pokejam_pack_deposit_cursor(), public.pokejam_pack_set_deposit_cursor(text),
  public.pokejam_pack_withdraw(bigint), public.pokejam_pack_withdrawal_refund(uuid, text), public.pokejam_pack_claim_withdrawals(int),
  public.pokejam_pack_withdraw_check(bigint), public.pokejam_pack_withdrawal_submitting(uuid, text, text),
  public.pokejam_pack_withdrawal_cleared(uuid), public.pokejam_pack_withdrawal_sent(uuid, text),
  public.pokejam_pack_withdrawal_held(uuid, text, int), public.pokejam_pack_withdrawal_failed(uuid, text, int),
  public.pokejam_pack_review_withdrawal(uuid, boolean, text), public.pokejam_pack_book_fee(), public.pokejam_pack_entry_wallet(),
  public.pokejam_pack_test_credit(), public.pokejam_pack_lobby(), public.pokejam_pack_health(int)
  from public, anon, authenticated;
grant execute on function public.pokejam_pack_wallet_challenge(text), public.pokejam_pack_withdraw(bigint),
  public.pokejam_pack_test_credit(), public.pokejam_pack_lobby() to authenticated;
grant execute on function public.pokejam_pack_setting(text, bigint), public.pokejam_pack_flag(text),
  public.pokejam_pack_wallet_challenge_of(uuid), public.pokejam_pack_wallet_link(uuid, text, text), public.pokejam_pack_wallet_of(uuid),
  public.pokejam_pack_record_deposit(text, text, text, bigint, bigint, timestamptz), public.pokejam_pack_credit_deposit(text, uuid, text),
  public.pokejam_pack_deposit_cursor(), public.pokejam_pack_set_deposit_cursor(text), public.pokejam_pack_withdrawal_refund(uuid, text),
  public.pokejam_pack_claim_withdrawals(int), public.pokejam_pack_withdraw_check(bigint), public.pokejam_pack_withdrawal_submitting(uuid, text, text),
  public.pokejam_pack_withdrawal_cleared(uuid), public.pokejam_pack_withdrawal_sent(uuid, text),
  public.pokejam_pack_withdrawal_held(uuid, text, int), public.pokejam_pack_withdrawal_failed(uuid, text, int),
  public.pokejam_pack_review_withdrawal(uuid, boolean, text), public.pokejam_pack_health(int)
  to service_role;
