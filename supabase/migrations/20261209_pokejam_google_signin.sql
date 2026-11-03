-- PokeJam Ranked: Google sign-in abuse limit, and linking a Phantom wallet to an existing account.
-- Shared gauntlet-legends project: pokejam_* only. Additive. Safe to run again (create or replace, create if not exists).
-- Nothing dropped, no existing policy widened, no column removed. NOT applied by the repo; the owner runs it by hand.
--
-- Google accounts are cheap to make. Ranked already hides the rank for the first 5 placement matches, refuses guests,
-- applies bans per user id (pokejam_banned), runs the human check and the judge, and rate-limits matchmaking polls.
-- This adds one more limit: an account created in the last 24 hours may start at most 10 ranked matches in that day.
-- It applies to every new account (a fresh wallet is cheap too). After a day the limit is gone. Leaving a match does
-- not reset it: every ranked match that got a guest counts. Bans stay on the user id; a new Google account is a new
-- user id, which this cap only slows down.
--
-- supabase-js linkIdentity is OAuth and ID-token only. It cannot attach a Solana wallet. pokejam_link_wallet stores
-- the address on the SAME user id after the pokejam-link-wallet Edge Function has checked a signed message. Rank,
-- history and shields are rows keyed by that user id, so they stay. The table is not readable by clients; they call
-- pokejam_my_wallet for their own address. Emails are not stored here.

-- ---------- new-account cap ----------
create or replace function public.pokejam_ranked_new_account_guard()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare born timestamptz; n int;
begin
  if new.queue is distinct from 'ranked' then return new; end if;
  select u.created_at into born from auth.users u where u.id = new.user_id;
  if born is null or born < now() - interval '24 hours' then return new; end if;
  select count(*) into n from public.pokejam_matches m
    where m.queue = 'ranked' and m.guest is not null
      and new.user_id in (m.host, m.guest)
      and m.created_at > now() - interval '24 hours';
  if n >= 10 then
    raise exception 'New accounts can play 10 ranked matches on the first day. Try again tomorrow.';
  end if;
  return new;
end $$;

revoke all on function public.pokejam_ranked_new_account_guard() from public, anon, authenticated;

drop trigger if exists pokejam_ranked_queue_guard on public.pokejam_queue;
create trigger pokejam_ranked_queue_guard
  before insert or update on public.pokejam_queue
  for each row
  when (new.queue = 'ranked')
  execute function public.pokejam_ranked_new_account_guard();

-- ---------- linked wallet ----------
create table if not exists public.pokejam_linked_wallets (
  user_id uuid primary key references public.pokejam_profiles(id) on delete cascade,
  wallet text not null check (wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  linked_at timestamptz not null default now()
);
create unique index if not exists pokejam_linked_wallets_wallet on public.pokejam_linked_wallets (wallet);

alter table public.pokejam_linked_wallets enable row level security;
revoke all on public.pokejam_linked_wallets from anon, authenticated, public;

-- Nonces from link messages, so a signed message cannot be submitted twice. Not a list of emails or names.
create table if not exists public.pokejam_wallet_nonces (
  nonce text primary key check (nonce ~ '^[1-9A-HJ-NP-Za-km-z]{16,64}$'),
  user_id uuid not null,
  used_at timestamptz not null default now()
);
alter table public.pokejam_wallet_nonces enable row level security;
revoke all on public.pokejam_wallet_nonces from anon, authenticated, public;

-- Service role only, after the Edge Function has checked the signature. Idempotent when this user already has this wallet.
create or replace function public.pokejam_link_wallet(p_user uuid, p_wallet text, p_nonce text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare cur text; owner uuid; recent int;
begin
  if p_user is null then return jsonb_build_object('ok', false, 'code', 'no_user'); end if;
  if p_wallet is null or p_wallet !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' then
    return jsonb_build_object('ok', false, 'code', 'bad_wallet');
  end if;
  if p_nonce is null or p_nonce !~ '^[1-9A-HJ-NP-Za-km-z]{16,64}$' then
    return jsonb_build_object('ok', false, 'code', 'bad_nonce');
  end if;
  if not exists (select 1 from public.pokejam_profiles where id = p_user) then
    return jsonb_build_object('ok', false, 'code', 'no_profile');
  end if;
  select wallet into cur from public.pokejam_linked_wallets where user_id = p_user;
  if cur is not null and cur = p_wallet then
    return jsonb_build_object('ok', true, 'wallet', cur);
  end if;
  if cur is not null then
    return jsonb_build_object('ok', false, 'code', 'already');
  end if;
  select user_id into owner from public.pokejam_linked_wallets where wallet = p_wallet;
  if owner is not null and owner <> p_user then
    return jsonb_build_object('ok', false, 'code', 'taken');
  end if;
  delete from public.pokejam_wallet_nonces where used_at < now() - interval '1 day';
  select count(*) into recent from public.pokejam_wallet_nonces where user_id = p_user and used_at > now() - interval '1 hour';
  if recent >= 10 then return jsonb_build_object('ok', false, 'code', 'rate'); end if;
  begin
    insert into public.pokejam_wallet_nonces(nonce, user_id) values (p_nonce, p_user);
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'code', 'replay');
  end;
  begin
    insert into public.pokejam_linked_wallets(user_id, wallet) values (p_user, p_wallet);
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'code', 'taken');
  end;
  return jsonb_build_object('ok', true, 'wallet', p_wallet);
end $$;

revoke all on function public.pokejam_link_wallet(uuid, text, text) from public, anon, authenticated;
grant execute on function public.pokejam_link_wallet(uuid, text, text) to service_role;

-- The signed-in player's own linked wallet, or null. No one else's, and never an email.
create or replace function public.pokejam_my_wallet()
returns text
language sql
stable
security definer
set search_path = public
as $$
  select wallet from public.pokejam_linked_wallets where user_id = auth.uid();
$$;

revoke all on function public.pokejam_my_wallet() from public, anon;
grant execute on function public.pokejam_my_wallet() to authenticated;

-- Service role: the wallet stored for a user id. Used by shield payments. Null when they have not linked one.
create or replace function public.pokejam_linked_wallet(p_user uuid)
returns text
language sql
stable
security definer
set search_path = public
as $$
  select wallet from public.pokejam_linked_wallets where user_id = p_user;
$$;

revoke all on function public.pokejam_linked_wallet(uuid) from public, anon, authenticated;
grant execute on function public.pokejam_linked_wallet(uuid) to service_role;
