-- PokeJam Rank Shield: pay with USDC from a Phantom wallet (Solana). Shared gauntlet-legends project: pokejam_* only.
-- Additive and safe to run again; nothing is dropped. Run AFTER 20261118_pokejam_shield_shop.sql. NET_VERSION and the
-- netcode are untouched. The Stripe path keeps working: pokejam_shield_credit_purchase now calls the same internal
-- crediting function the USDC path uses (same hold cap of 14, same season cap of 42, same ledger, same needs_refund flag).
--
-- Flow (Edge Functions, service role):
--  1. shield-usdc-intent -> pokejam_shield_usdc_intent: the shop caps (pokejam_shield_checkout_check: guest, dispute block,
--     14 held, 42 per season counting pending, 5 per hour) and a one-time intent: random reference key, memo, the amount
--     from pokejam_shield_products.usdc_amount, the player's wallet from their verified Supabase user, expiry in 15 min.
--  2. The player's Phantom signs and sends a USDC transferChecked to the house wallet (a public address, no private key
--     anywhere on our side).
--  3. shield-usdc-confirm reads the transaction from a Solana RPC, checks everything (mint, exact amount, recipient, signer,
--     reference, memo, time window) and only then calls pokejam_shield_credit_usdc. Idempotent: one credit per intent and one
--     intent per transaction signature (unique), so a replayed or re-submitted signature never credits twice.
--
-- On-chain payments cannot be charged back. A credit over the hold cap credits up to the cap and flags the purchase
-- (credit_short, needs_refund = true) so the owner refunds the USDC by hand, exactly like Stripe.

-- ---------- products: price in USDC base units (6 decimals) ----------
alter table public.pokejam_shield_products add column if not exists usdc_amount bigint
  check (usdc_amount is null or (usdc_amount > 0 and usdc_amount % 10000 = 0));
update public.pokejam_shield_products set usdc_amount = case sku when 'shield_3' then 1990000 when 'shield_7' then 3990000 when 'shield_14' then 6990000 end
  where usdc_amount is null and sku in ('shield_3', 'shield_7', 'shield_14');

-- ---------- purchases: which rail, and the on-chain facts ----------
alter table public.pokejam_shield_purchases add column if not exists rail text not null default 'stripe';
alter table public.pokejam_shield_purchases add column if not exists usdc_signature text;
alter table public.pokejam_shield_purchases add column if not exists wallet text;
create unique index if not exists pokejam_shield_purchases_usdc_sig on public.pokejam_shield_purchases(usdc_signature);

-- ---------- intents ----------
create table if not exists public.pokejam_shield_usdc_intents (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.pokejam_profiles(id) on delete cascade,
  sku text not null,
  units int not null,
  amount bigint not null check (amount > 0),
  mint text not null,
  cluster text not null,
  receiver text not null,
  wallet text not null,
  reference text not null unique,
  memo text not null unique,
  checkout_id bigint,
  status text not null default 'pending' check (status in ('pending', 'credited')),
  signature text unique,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  credited_at timestamptz
);
create index if not exists pokejam_shield_usdc_intents_user on public.pokejam_shield_usdc_intents(user_id, created_at desc);
alter table public.pokejam_shield_usdc_intents enable row level security;
revoke all on public.pokejam_shield_usdc_intents from anon, authenticated, public;

-- ---------- shared crediting (internal) ----------
-- The part of pokejam_shield_credit_purchase after its event row: one purchase row per session id, credit up to the hold cap,
-- record the shortfall, mark the pending checkout done. Returns {status: 'credited' | 'duplicate_session', credited, short}.
create or replace function public.pokejam_shield_grant(p_session text, p_user uuid, p_sku text, p_payment_intent text, p_amount_cents int,
  p_rail text default 'stripe', p_signature text default null, p_wallet text default null, p_checkout bigint default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare prod public.pokejam_shield_products; v_new text; v_held int; v_credit int; v_short int;
begin
  select * into prod from public.pokejam_shield_products where sku = p_sku;
  if prod.sku is null then raise exception 'credit: unknown sku %', p_sku; end if;
  insert into public.pokejam_shield_purchases(session_id, user_id, sku, units, payment_intent, amount_cents, rail, usdc_signature, wallet)
    values (p_session, p_user, prod.sku, prod.units, nullif(p_payment_intent, ''), p_amount_cents, p_rail, p_signature, p_wallet)
    on conflict (session_id) do nothing returning session_id into v_new;
  if v_new is null then return jsonb_build_object('status', 'duplicate_session', 'credited', 0, 'short', 0); end if;
  insert into public.pokejam_shield_inventory(user_id) values (p_user) on conflict (user_id) do nothing;
  select count into v_held from public.pokejam_shield_inventory where user_id = p_user for update;
  v_credit := greatest(0, least(prod.units, 14 - v_held));
  v_short := prod.units - v_credit;
  insert into public.pokejam_shield_ledger(user_id, delta, reason, ref) values (p_user, v_credit, 'purchase', p_session)
    on conflict (user_id, reason, ref) do nothing;
  if v_credit > 0 then
    update public.pokejam_shield_inventory set count = count + v_credit, updated_at = now() where user_id = p_user;
  end if;
  update public.pokejam_shield_purchases set credited_units = v_credit, credit_short = v_short, needs_refund = v_short > 0, updated_at = now()
    where session_id = p_session;
  update public.pokejam_shield_checkouts set done = true
    where id = coalesce(p_checkout, (select id from public.pokejam_shield_checkouts where user_id = p_user and sku = prod.sku and not done
                                      order by created_at desc limit 1));
  return jsonb_build_object('status', 'credited', 'credited', v_credit, 'short', v_short);
end $$;

-- Same signature and behaviour as 20261118; the crediting moved into pokejam_shield_grant.
create or replace function public.pokejam_shield_credit_purchase(p_session text, p_user uuid, p_sku text, p_units int,
  p_payment_intent text, p_amount_cents int, p_event text, p_event_type text default 'checkout.session.completed')
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_new text;
begin
  if coalesce(p_session, '') = '' or p_user is null or coalesce(p_event, '') = '' then raise exception 'credit: missing session, user or event'; end if;
  insert into public.pokejam_stripe_events(event_id, type) values (p_event, p_event_type) on conflict (event_id) do nothing returning event_id into v_new;
  if v_new is null then return jsonb_build_object('status', 'duplicate_event', 'credited', 0, 'short', 0); end if;
  return public.pokejam_shield_grant(p_session, p_user, p_sku, p_payment_intent, p_amount_cents);
end $$;

-- ---------- create an intent ----------
-- {ok: true, intent_id, sku, units, amount, expires_at} or {ok: false, code, message}. The codes of
-- pokejam_shield_checkout_check, plus no_wallet and no_usdc. Records the checkout attempt (rate limit, pending units) only
-- when the intent is created.
create or replace function public.pokejam_shield_usdc_intent(p_user uuid, p_anonymous boolean, p_sku text, p_wallet text,
  p_reference text, p_memo text, p_receiver text, p_mint text, p_cluster text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare prod public.pokejam_shield_products; c jsonb; v_id uuid; v_exp timestamptz;
begin
  if coalesce(p_reference, '') = '' or coalesce(p_memo, '') = '' or coalesce(p_receiver, '') = '' or coalesce(p_mint, '') = ''
     or p_cluster not in ('devnet', 'mainnet-beta') then
    raise exception 'usdc intent: bad arguments';
  end if;
  if p_user is not null and not coalesce(p_anonymous, false) then
    if coalesce(p_wallet, '') = '' then
      return jsonb_build_object('ok', false, 'code', 'no_wallet', 'message', 'Sign in with Phantom to pay with USDC');
    end if;
    select * into prod from public.pokejam_shield_products where sku = p_sku;
    if prod.sku is not null and prod.active and prod.usdc_amount is null then
      return jsonb_build_object('ok', false, 'code', 'no_usdc', 'message', 'This pack cannot be paid in USDC');
    end if;
  end if;
  c := public.pokejam_shield_checkout_check(p_user, p_sku, p_anonymous);
  if not (c ->> 'ok')::boolean then return c; end if;
  select * into prod from public.pokejam_shield_products where sku = p_sku;
  v_exp := now() + interval '15 minutes';
  insert into public.pokejam_shield_usdc_intents(user_id, sku, units, amount, mint, cluster, receiver, wallet, reference, memo, checkout_id, expires_at)
    values (p_user, prod.sku, prod.units, prod.usdc_amount, p_mint, p_cluster, p_receiver, p_wallet, p_reference, p_memo, (c ->> 'checkout_id')::bigint, v_exp)
    returning id into v_id;
  return jsonb_build_object('ok', true, 'intent_id', v_id, 'sku', prod.sku, 'units', prod.units, 'amount', prod.usdc_amount, 'expires_at', v_exp);
end $$;

-- ---------- read an intent (confirm) ----------
-- The intent as the verifier needs it, or null. Times are epoch seconds. Only the owner's own intent is returned.
create or replace function public.pokejam_shield_usdc_intent_get(p_intent uuid, p_user uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', i.id, 'sku', i.sku, 'units', i.units, 'amount', i.amount, 'mint', i.mint, 'cluster', i.cluster,
    'receiver', i.receiver, 'wallet', i.wallet, 'reference', i.reference, 'memo', i.memo, 'status', i.status, 'signature', i.signature,
    'created_at', extract(epoch from i.created_at)::bigint, 'expires_at', extract(epoch from i.expires_at)::bigint)
  from public.pokejam_shield_usdc_intents i where i.id = p_intent and i.user_id = p_user
$$;

-- ---------- credit a verified payment ----------
-- Called only after the Edge Function checked the transaction. Idempotent. Returns {status, credited, short, needs_refund}:
--   credited      the shields were added now
--   duplicate     this intent was already credited by this same signature (a retry): nothing changes
--   intent_done   this intent was already credited by another signature
--   signature_used this signature already paid another intent
--   no_intent / wrong_user  unknown intent, or not this user's
create or replace function public.pokejam_shield_credit_usdc(p_intent uuid, p_user uuid, p_signature text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare it public.pokejam_shield_usdc_intents; g jsonb; pu public.pokejam_shield_purchases;
begin
  if p_intent is null or p_user is null or coalesce(p_signature, '') = '' then raise exception 'credit usdc: missing intent, user or signature'; end if;
  select * into it from public.pokejam_shield_usdc_intents where id = p_intent for update;
  if it.id is null then return jsonb_build_object('status', 'no_intent', 'credited', 0, 'short', 0); end if;
  if it.user_id <> p_user then return jsonb_build_object('status', 'wrong_user', 'credited', 0, 'short', 0); end if;
  if it.status = 'credited' then
    if it.signature = p_signature then
      select * into pu from public.pokejam_shield_purchases where session_id = 'usdc:' || p_signature;
      return jsonb_build_object('status', 'duplicate', 'credited', coalesce(pu.credited_units, 0), 'short', coalesce(pu.credit_short, 0), 'needs_refund', coalesce(pu.needs_refund, false));
    end if;
    return jsonb_build_object('status', 'intent_done', 'credited', 0, 'short', 0);
  end if;
  if exists (select 1 from public.pokejam_shield_purchases where usdc_signature = p_signature or session_id = 'usdc:' || p_signature)
     or exists (select 1 from public.pokejam_shield_usdc_intents where signature = p_signature) then
    return jsonb_build_object('status', 'signature_used', 'credited', 0, 'short', 0);
  end if;
  g := public.pokejam_shield_grant('usdc:' || p_signature, it.user_id, it.sku, null, (it.amount / 10000)::int, 'usdc', p_signature, it.wallet, it.checkout_id);
  update public.pokejam_shield_usdc_intents set status = 'credited', signature = p_signature, credited_at = now() where id = it.id;
  return jsonb_build_object('status', 'credited', 'credited', (g ->> 'credited')::int, 'short', (g ->> 'short')::int, 'needs_refund', (g ->> 'short')::int > 0);
end $$;

-- ---------- shop info for the UI: now with the USDC price (base units, null = not payable in USDC) ----------
create or replace function public.pokejam_shield_shop()
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); v_held int := 0; v_bought int; s public.pokejam_seasons;
begin
  if me is null then raise exception 'not signed in'; end if;
  select coalesce((select count from public.pokejam_shield_inventory where user_id = me), 0) into v_held;
  s := public.pokejam_ranked_season();
  select coalesce(sum(units), 0)::int into v_bought from public.pokejam_shield_purchases
    where user_id = me and status = 'paid' and created_at >= s.starts_at;
  return jsonb_build_object('held', v_held, 'cap', 14, 'purchases_left', greatest(0, 42 - v_bought),
    'blocked', exists (select 1 from public.pokejam_shield_flags where user_id = me and purchase_blocked),
    'products', coalesce((select jsonb_agg(jsonb_build_object('sku', sku, 'units', units, 'price_cents', price_cents, 'usdc_amount', usdc_amount) order by units)
                          from public.pokejam_shield_products where active), '[]'::jsonb));
end $$;

-- ---------- privileges ----------
revoke all on function
  public.pokejam_shield_grant(text,uuid,text,text,int,text,text,text,bigint),
  public.pokejam_shield_credit_purchase(text,uuid,text,int,text,int,text,text),
  public.pokejam_shield_usdc_intent(uuid,boolean,text,text,text,text,text,text,text),
  public.pokejam_shield_usdc_intent_get(uuid,uuid), public.pokejam_shield_credit_usdc(uuid,uuid,text), public.pokejam_shield_shop()
  from public, anon, authenticated;
grant execute on function public.pokejam_shield_credit_purchase(text,uuid,text,int,text,int,text,text),
  public.pokejam_shield_usdc_intent(uuid,boolean,text,text,text,text,text,text,text),
  public.pokejam_shield_usdc_intent_get(uuid,uuid), public.pokejam_shield_credit_usdc(uuid,uuid,text) to service_role;
grant execute on function public.pokejam_shield_shop() to authenticated;
