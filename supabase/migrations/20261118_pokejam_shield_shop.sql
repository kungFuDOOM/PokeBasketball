-- PokeJam Rank Shield shop (PR B, Stripe TEST MODE first): the server side of buying shields. Shared gauntlet-legends
-- project: pokejam_* only. Additive and safe to run again; nothing is dropped. Run AFTER 20261117_pokejam_rank_shield.sql
-- (which created products, purchases and stripe_events). NET_VERSION and the netcode are untouched.
--
-- Who calls what:
--  - Edge Function shield-create-checkout (service role): pokejam_shield_checkout_check before it creates a Stripe Checkout
--    Session. Refuses guests, unknown/inactive/unpriced products, a purchase that would push the held count over 14, more
--    than 42 shields bought this season (pending checkouts included), more than 5 sessions per user per hour, and any user
--    with a dispute on file.
--  - Edge Function shield-stripe-webhook (service role): pokejam_shield_credit_purchase after a PAID checkout,
--    pokejam_shield_revoke after a full refund or a dispute. Both are idempotent: the Stripe event id is inserted first
--    (pokejam_stripe_events, on conflict do nothing), the purchase is unique per Checkout Session, and the ledger row is
--    unique per (user, reason, ref). A rolled-back call also rolls back the event row, so Stripe's retry works.
--  - Players (authenticated): pokejam_shield_shop() for the shop sheet (products without Stripe ids, held, purchases left).
--
-- Units are always the product row's units, never the caller's: p_units in pokejam_shield_credit_purchase is kept for the
-- call signature and ignored. Stripe Price ids live in pokejam_shield_products.stripe_price_id (set by the owner).
--
-- A credit that would pass the hold cap of 14 credits up to the cap; the rest is recorded on the purchase
-- (credit_short, needs_refund = true) so the owner can refund it by hand. A refund or dispute removes up to the credited
-- units, never below 0; units already used can't be recovered and are recorded in clawback_short. Rank points are not
-- reversed. A dispute also blocks that user from buying again (pokejam_shield_flags) until the owner clears it.

-- ---------- tables ----------
alter table public.pokejam_shield_purchases add column if not exists credited_units int;
alter table public.pokejam_shield_purchases add column if not exists credit_short int not null default 0;
alter table public.pokejam_shield_purchases add column if not exists needs_refund boolean not null default false;
alter table public.pokejam_shield_purchases add column if not exists updated_at timestamptz not null default now();

-- One row per checkout attempt: the rate limit (5 per user per hour) and "pending" units for the season cap. Marked done
-- when the matching purchase is credited. Sessions are created to expire after 31 minutes, so pending counts 35.
create table if not exists public.pokejam_shield_checkouts (
  id bigserial primary key,
  user_id uuid not null references public.pokejam_profiles(id) on delete cascade,
  sku text not null,
  units int not null,
  done boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists pokejam_shield_checkouts_user on public.pokejam_shield_checkouts(user_id, created_at desc);

create table if not exists public.pokejam_shield_flags (
  user_id uuid primary key references public.pokejam_profiles(id) on delete cascade,
  purchase_blocked boolean not null default false,
  reason text,
  updated_at timestamptz not null default now()
);

alter table public.pokejam_shield_checkouts enable row level security;
alter table public.pokejam_shield_flags enable row level security;
revoke all on public.pokejam_shield_checkouts, public.pokejam_shield_flags from anon, authenticated, public;
revoke all on sequence public.pokejam_shield_checkouts_id_seq from anon, authenticated, public;

-- ---------- checkout check ----------
-- {ok: true, sku, units, price_cents, stripe_price_id, checkout_id} or {ok: false, code, message}. Records the attempt when
-- ok. Takes the user's inventory row lock, so two simultaneous checkouts can't both pass the same cap.
-- Codes: guest, unknown_sku, inactive, blocked, hold_cap, season_cap, rate_limited.
create or replace function public.pokejam_shield_checkout_check(p_user uuid, p_sku text, p_anonymous boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare prod public.pokejam_shield_products; v_held int; v_bought int; v_pending int; v_recent int; v_id bigint;
        s public.pokejam_seasons;
begin
  if p_user is null or coalesce(p_anonymous, false) then
    return jsonb_build_object('ok', false, 'code', 'guest', 'message', 'Sign in with Google or Phantom to buy');
  end if;
  if not exists (select 1 from public.pokejam_profiles where id = p_user) then
    return jsonb_build_object('ok', false, 'code', 'guest', 'message', 'Sign in with Google or Phantom to buy');
  end if;
  select * into prod from public.pokejam_shield_products where sku = p_sku;
  if prod.sku is null then return jsonb_build_object('ok', false, 'code', 'unknown_sku', 'message', 'Unknown pack'); end if;
  if not prod.active then return jsonb_build_object('ok', false, 'code', 'inactive', 'message', 'This pack is not on sale'); end if;
  insert into public.pokejam_shield_inventory(user_id) values (p_user) on conflict (user_id) do nothing;
  select count into v_held from public.pokejam_shield_inventory where user_id = p_user for update;
  if exists (select 1 from public.pokejam_shield_flags where user_id = p_user and purchase_blocked) then
    return jsonb_build_object('ok', false, 'code', 'blocked', 'message', 'Purchases are off for this account. Email kungfudoom@mail.grokbot.com');
  end if;
  if v_held + prod.units > 14 then
    return jsonb_build_object('ok', false, 'code', 'hold_cap', 'message', 'You can hold at most 14 Rank Shields');
  end if;
  s := public.pokejam_ranked_season();
  select coalesce(sum(units), 0)::int into v_bought from public.pokejam_shield_purchases
    where user_id = p_user and status = 'paid' and created_at >= s.starts_at;
  select coalesce(sum(units), 0)::int into v_pending from public.pokejam_shield_checkouts
    where user_id = p_user and not done and created_at > now() - interval '35 minutes';
  if v_bought + v_pending + prod.units > 42 then
    return jsonb_build_object('ok', false, 'code', 'season_cap', 'message', 'Season purchase limit reached (42 Rank Shields)');
  end if;
  select count(*)::int into v_recent from public.pokejam_shield_checkouts
    where user_id = p_user and created_at > now() - interval '1 hour';
  if v_recent >= 5 then
    return jsonb_build_object('ok', false, 'code', 'rate_limited', 'message', 'Too many checkouts. Try again in a while');
  end if;
  insert into public.pokejam_shield_checkouts(user_id, sku, units) values (p_user, prod.sku, prod.units) returning id into v_id;
  return jsonb_build_object('ok', true, 'sku', prod.sku, 'units', prod.units, 'price_cents', prod.price_cents,
    'stripe_price_id', prod.stripe_price_id, 'checkout_id', v_id);
end $$;

-- ---------- credit ----------
-- Idempotent. Returns {status: 'credited' | 'duplicate_event' | 'duplicate_session', credited, short}.
create or replace function public.pokejam_shield_credit_purchase(p_session text, p_user uuid, p_sku text, p_units int,
  p_payment_intent text, p_amount_cents int, p_event text, p_event_type text default 'checkout.session.completed')
returns jsonb language plpgsql security definer set search_path = public as $$
declare prod public.pokejam_shield_products; v_new text; v_held int; v_credit int; v_short int;
begin
  if coalesce(p_session, '') = '' or p_user is null or coalesce(p_event, '') = '' then raise exception 'credit: missing session, user or event'; end if;
  insert into public.pokejam_stripe_events(event_id, type) values (p_event, p_event_type) on conflict (event_id) do nothing returning event_id into v_new;
  if v_new is null then return jsonb_build_object('status', 'duplicate_event', 'credited', 0, 'short', 0); end if;
  select * into prod from public.pokejam_shield_products where sku = p_sku;
  if prod.sku is null then raise exception 'credit: unknown sku %', p_sku; end if;
  v_new := null;
  insert into public.pokejam_shield_purchases(session_id, user_id, sku, units, payment_intent, amount_cents)
    values (p_session, p_user, prod.sku, prod.units, nullif(p_payment_intent, ''), p_amount_cents)
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
    where id = (select id from public.pokejam_shield_checkouts where user_id = p_user and sku = prod.sku and not done
                order by created_at desc limit 1);
  return jsonb_build_object('status', 'credited', 'credited', v_credit, 'short', v_short);
end $$;

-- ---------- revoke ----------
-- p_reason 'refund' (full refund) or 'dispute'. Idempotent per event and per purchase: the shields are removed once, a
-- dispute after a refund only adds the block. Returns {status: 'revoked' | 'flagged' | 'duplicate_event' | 'unknown_purchase',
-- removed, short}. 'unknown_purchase' records nothing (the credit may not have landed yet): the webhook answers 500 so
-- Stripe retries.
create or replace function public.pokejam_shield_revoke(p_payment_intent text, p_reason text, p_event text, p_event_type text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare pu public.pokejam_shield_purchases; v_new text; v_held int; v_remove int; v_short int;
begin
  if p_reason not in ('refund', 'dispute') then raise exception 'revoke: bad reason'; end if;
  if coalesce(p_payment_intent, '') = '' or coalesce(p_event, '') = '' then raise exception 'revoke: missing payment intent or event'; end if;
  select * into pu from public.pokejam_shield_purchases where payment_intent = p_payment_intent for update;
  if pu.session_id is null then return jsonb_build_object('status', 'unknown_purchase', 'removed', 0, 'short', 0); end if;
  insert into public.pokejam_stripe_events(event_id, type) values (p_event, coalesce(p_event_type, p_reason)) on conflict (event_id) do nothing returning event_id into v_new;
  if v_new is null then return jsonb_build_object('status', 'duplicate_event', 'removed', 0, 'short', 0); end if;
  if p_reason = 'dispute' then
    insert into public.pokejam_shield_flags(user_id, purchase_blocked, reason) values (pu.user_id, true, 'dispute')
      on conflict (user_id) do update set purchase_blocked = true, reason = 'dispute', updated_at = now();
  end if;
  if pu.status <> 'paid' then
    -- Already revoked once (refund then dispute, or a repeat): no second removal.
    if p_reason = 'dispute' and pu.status = 'refunded' then
      update public.pokejam_shield_purchases set status = 'disputed', updated_at = now() where session_id = pu.session_id;
    end if;
    return jsonb_build_object('status', 'flagged', 'removed', 0, 'short', pu.clawback_short);
  end if;
  insert into public.pokejam_shield_inventory(user_id) values (pu.user_id) on conflict (user_id) do nothing;
  select count into v_held from public.pokejam_shield_inventory where user_id = pu.user_id for update;
  v_remove := greatest(0, least(coalesce(pu.credited_units, pu.units), v_held));
  v_short := coalesce(pu.credited_units, pu.units) - v_remove;
  if v_remove > 0 then
    update public.pokejam_shield_inventory set count = count - v_remove, updated_at = now() where user_id = pu.user_id;
  end if;
  insert into public.pokejam_shield_ledger(user_id, delta, reason, ref)
    values (pu.user_id, -v_remove, case p_reason when 'refund' then 'refund' else 'clawback' end, p_payment_intent)
    on conflict (user_id, reason, ref) do nothing;
  update public.pokejam_shield_purchases set status = case p_reason when 'refund' then 'refunded' else 'disputed' end,
    clawback_short = v_short, updated_at = now() where session_id = pu.session_id;
  return jsonb_build_object('status', 'revoked', 'removed', v_remove, 'short', v_short);
end $$;

-- ---------- shop info for the UI ----------
-- Active products (no Stripe ids), how many shields I hold, how many I may still buy this season and whether purchases are
-- off for me. Guests get the same answer; the buy button is hidden for them in the client and refused by the checkout check.
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
    'products', coalesce((select jsonb_agg(jsonb_build_object('sku', sku, 'units', units, 'price_cents', price_cents) order by units)
                          from public.pokejam_shield_products where active), '[]'::jsonb));
end $$;

-- ---------- privileges ----------
revoke all on function
  public.pokejam_shield_checkout_check(uuid,text,boolean), public.pokejam_shield_credit_purchase(text,uuid,text,int,text,int,text,text),
  public.pokejam_shield_revoke(text,text,text,text), public.pokejam_shield_shop()
  from public, anon, authenticated;
grant execute on function public.pokejam_shield_checkout_check(uuid,text,boolean),
  public.pokejam_shield_credit_purchase(text,uuid,text,int,text,int,text,text),
  public.pokejam_shield_revoke(text,text,text,text) to service_role;
grant execute on function public.pokejam_shield_shop() to authenticated;
