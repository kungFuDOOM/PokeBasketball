-- Wallet link: the player asks for a nonce first. It is stored in pokejam_wallet_nonces before anything is signed.
-- pokejam-link-wallet still checks the signature, then pokejam_link_wallet stores the address and marks that nonce used.
-- A link whose nonce was never opened does not write a wallet. Additive. NOT applied by the repo.

alter table public.pokejam_wallet_nonces add column if not exists consumed_at timestamptz;

-- The signed-in player opens a nonce. The browser made the random text; this only records it on their user id.
create or replace function public.pokejam_wallet_nonce_open(p_nonce text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare me uuid := auth.uid(); recent int; owner uuid; spent timestamptz;
begin
  if me is null then return jsonb_build_object('ok', false, 'code', 'no_user'); end if;
  if coalesce(auth.jwt() ->> 'is_anonymous', 'false') = 'true' then
    return jsonb_build_object('ok', false, 'code', 'guest');
  end if;
  if p_nonce is null or p_nonce !~ '^[1-9A-HJ-NP-Za-km-z]{16,64}$' then
    return jsonb_build_object('ok', false, 'code', 'bad_nonce');
  end if;
  if not exists (select 1 from public.pokejam_profiles where id = me) then
    return jsonb_build_object('ok', false, 'code', 'no_profile');
  end if;
  delete from public.pokejam_wallet_nonces where used_at < now() - interval '1 day';
  select user_id, consumed_at into owner, spent from public.pokejam_wallet_nonces where nonce = p_nonce;
  if owner = me and spent is null and exists (
    select 1 from public.pokejam_wallet_nonces where nonce = p_nonce and used_at > now() - interval '20 minutes'
  ) then
    return jsonb_build_object('ok', true, 'nonce', p_nonce);
  end if;
  if owner is not null then return jsonb_build_object('ok', false, 'code', 'replay'); end if;
  select count(*) into recent from public.pokejam_wallet_nonces where user_id = me and used_at > now() - interval '1 hour';
  if recent >= 10 then return jsonb_build_object('ok', false, 'code', 'rate'); end if;
  begin
    insert into public.pokejam_wallet_nonces(nonce, user_id) values (p_nonce, me);
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'code', 'replay');
  end;
  return jsonb_build_object('ok', true, 'nonce', p_nonce);
end $$;

revoke all on function public.pokejam_wallet_nonce_open(text) from public, anon;
grant execute on function public.pokejam_wallet_nonce_open(text) to authenticated;

-- Service role only, after the edge function has checked the signature.
-- The nonce must already be open for this user. The same wallet on the same account can be confirmed again.
create or replace function public.pokejam_link_wallet(p_user uuid, p_wallet text, p_nonce text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare cur text; owner uuid; nonce_user uuid; spent timestamptz; opened timestamptz;
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
  select user_id, consumed_at, used_at into nonce_user, spent, opened
    from public.pokejam_wallet_nonces where nonce = p_nonce for update;
  if nonce_user is null then
    return jsonb_build_object('ok', false, 'code', 'nonce');
  end if;
  if nonce_user <> p_user or spent is not null or opened < now() - interval '20 minutes' then
    return jsonb_build_object('ok', false, 'code', 'replay');
  end if;
  begin
    insert into public.pokejam_linked_wallets(user_id, wallet) values (p_user, p_wallet);
  exception when unique_violation then
    return jsonb_build_object('ok', false, 'code', 'taken');
  end;
  update public.pokejam_wallet_nonces set consumed_at = now() where nonce = p_nonce and consumed_at is null;
  return jsonb_build_object('ok', true, 'wallet', p_wallet);
end $$;

revoke all on function public.pokejam_link_wallet(uuid, text, text) from public, anon, authenticated;
grant execute on function public.pokejam_link_wallet(uuid, text, text) to service_role;
