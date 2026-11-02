-- Burn credit for the LIVE ad board (pokejam-ads-live). Needs 20261204_pokejam_ads_live.sql.
--
-- Why: burned tokens can't come back. The page only ever builds a burn of exactly the price, so a burn below the price can
-- only be a hand-made transaction. 20261204 booked nothing for it, which also made the tokens worthless. Now a short burn
-- is kept as CREDIT for the wallet that made it, and counts toward a full slot later.
--
-- The rules:
--   - Credit is recorded only for a burn the Edge Function has already checked like any other burn (finalized, the right
--     mint and decimals, not older than the booking, signed by the booking's wallet, taken from an account that wallet owns).
--     So credit always belongs to the wallet that signed AND owned the burned account, and a burn from anyone else is
--     never credited. The credit row is keyed by the burn's signature, which is unique: one burn is credit once, ever.
--   - A booking is paid when (the burn that names it) + (that wallet's unspent credit) is at least the booking's price.
--     Credit rows are used whole, oldest first, and only as many as needed; a row is marked used by the booking it paid
--     for, in the same transaction, under the same advisory lock every pay function takes, so credit can't be spent twice.
--   - A burn that is already at least the price never touches credit.
--   - NO pro-rated airtime: a short burn buys no slot, shorter or otherwise. Credit alone books nothing; it needs a burn.
--   - An overpaid burn (or burn + credit above the price) keeps the existing rule: it runs longer at the plan's rate.
--   - The price is still locked for a day (then the higher of the locked and current price applies); extra runs pay the
--     current price. Credit is a number of tokens, not a price: a price rise after the credit was made applies in full.
--   - A signature counts once across burns, credit, USDC payments and intents (pay checks all four, USDC pay too).
--
-- Additive: one new table, one new column, two functions redefined with "create or replace" (pokejam_live_ad_pay, which now
-- credits short burns, and pokejam_live_ad_usdc_pay, which now also refuses a signature that is credit), one new function.
-- Safe to apply again. Devnet (pokejam-ads, 20261203) is untouched.

create table if not exists public.pokejam_live_ad_burn_credit (
  signature text primary key,
  wallet text not null check (wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  -- PJAM base units (6 decimals).
  amount numeric(39, 0) not null check (amount > 0),
  -- The booking whose memo the short burn carried.
  ad_id uuid references public.pokejam_live_ads(id),
  created_at timestamptz not null default now(),
  -- The booking this credit paid toward, once it has.
  used_for uuid references public.pokejam_live_ads(id),
  used_at timestamptz,
  check ((used_for is null) = (used_at is null))
);
create index if not exists pokejam_live_ad_burn_credit_open on public.pokejam_live_ad_burn_credit (wallet, created_at) where used_for is null;
alter table public.pokejam_live_ad_burn_credit enable row level security;
revoke all on public.pokejam_live_ad_burn_credit from anon, authenticated, public;

-- How much credit a booking used (audit), when it used any.
alter table public.pokejam_live_ads add column if not exists credit_used numeric(39, 0);

-- A wallet's unspent credit, in PJAM base units, as text.
create or replace function public.pokejam_live_ad_credit(p_wallet text)
returns text language sql stable security definer set search_path = public as $$
  select coalesce(sum(amount), 0)::text from public.pokejam_live_ad_burn_credit where wallet = p_wallet and used_for is null;
$$;

-- pokejam_live_ad_pay (20261204) plus credit. p_burned comes from a burn the function has verified for this booking's wallet.
create or replace function public.pokejam_live_ad_pay(p_id uuid, p_sig text, p_burned numeric, p_burner text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  a public.pokejam_live_ads;
  dup public.pokejam_live_ads;
  c public.pokejam_live_ad_burn_credit;
  secs int;
  want timestamptz;
  s timestamptz;
  banned boolean;
  rate_price numeric;
  rate_hours int;
  taken numeric := 0;
  taken_sigs text[] := '{}';
begin
  perform pg_advisory_xact_lock(hashtext('pokejam_live_ads'));
  select * into dup from public.pokejam_live_ads where burn_sig = p_sig or usdc_sig = p_sig;
  if found then
    if dup.burn_sig = p_sig and (dup.id = p_id or dup.extra_of = p_id) then return public.pokejam_live_ad_view(dup); end if;
    raise exception 'burn already used';
  end if;
  if exists (select 1 from public.pokejam_live_ad_usdc_intents where signature = p_sig) then raise exception 'burn already used'; end if;
  -- A short burn already kept as credit: asking again for the booking it named changes nothing.
  select * into c from public.pokejam_live_ad_burn_credit where signature = p_sig;
  if found then
    if c.ad_id = p_id then return public.pokejam_live_ad_view((select x from public.pokejam_live_ads x where x.id = p_id)); end if;
    raise exception 'burn already used';
  end if;
  select * into a from public.pokejam_live_ads where id = p_id for update;
  if not found then raise exception 'no such booking'; end if;
  if p_burned is null or p_burned <= 0 then raise exception 'nothing was burned'; end if;
  if a.pay_method = 'usdc' then
    rate_price := public.pokejam_live_ad_price('hour');
    rate_hours := 1;
  else
    rate_price := a.price;
    rate_hours := a.hours;
    -- The locked price covers the booking's own first day. After that, and for extra runs, a higher current price applies.
    if a.state <> 'pending' or a.created_at < now() - interval '1 day' then
      rate_price := greatest(a.price, public.pokejam_live_ad_price(a.plan));
    end if;
  end if;

  if rate_price is not null and p_burned < rate_price then
    -- Short on its own: add this wallet's unspent credit, oldest first, only as much as it takes.
    for c in select * from public.pokejam_live_ad_burn_credit where wallet = a.wallet and used_for is null
      order by created_at, signature for update
    loop
      exit when p_burned + taken >= rate_price;
      taken := taken + c.amount;
      taken_sigs := taken_sigs || c.signature;
    end loop;
  end if;
  if rate_price is null or p_burned + taken < rate_price then
    -- Still short: it buys no slot, not even a shorter one. Keep the burn as credit for this wallet, spend none.
    insert into public.pokejam_live_ad_burn_credit(signature, wallet, amount, ad_id) values (p_sig, a.wallet, p_burned, a.id);
    if a.state = 'pending' then
      update public.pokejam_live_ads set state = 'dust', burn_sig = p_sig, burned = p_burned, burner = p_burner, paid_at = now()
      where id = a.id returning * into a;
    end if;
    return public.pokejam_live_ad_view(a);
  end if;

  secs := least(floor((p_burned + taken) * rate_hours * 3600 / rate_price), 366 * 86400)::int;
  banned := exists (select 1 from public.pokejam_ad_bans where wallet = a.wallet);
  if a.state <> 'pending' then
    insert into public.pokejam_live_ads(code, wallet, text, theme, plan, hours, price, wants_start, extra_of)
    values (encode(extensions.gen_random_bytes(6), 'hex'), a.wallet, a.text, a.theme,
      case when a.pay_method = 'usdc' then 'hour' else a.plan end, rate_hours, coalesce(rate_price, a.price), now(), a.id)
    returning * into a;
  end if;
  want := greatest(a.wants_start, now());
  s := public.pokejam_live_ad_next_open(want, secs, a.wallet);
  update public.pokejam_live_ads set state = 'paid', burn_sig = p_sig, burned = p_burned, burner = p_burner, paid_at = now(),
    starts_at = s, ends_at = s + make_interval(secs => secs), moved = s > want + interval '1 minute', credit_used = nullif(taken, 0)
  where id = a.id returning * into a;
  if taken_sigs <> '{}' then
    update public.pokejam_live_ad_burn_credit set used_for = a.id, used_at = now() where signature = any(taken_sigs) and used_for is null;
  end if;
  if banned or (a.extra_of is not null and exists (select 1 from public.pokejam_live_ads o where o.id = a.extra_of and o.state = 'removed')) then
    update public.pokejam_live_ads set state = 'removed', removed_at = now(), removed_left = secs,
      removed_reason = case when banned then 'wallet banned' else (select removed_reason from public.pokejam_live_ads where id = a.extra_of) end
    where id = a.id returning * into a;
  end if;
  return public.pokejam_live_ad_view(a);
end $$;

-- pokejam_live_ad_usdc_pay (20261204), with one more place a signature can already have been used: burn credit.
create or replace function public.pokejam_live_ad_usdc_pay(p_intent uuid, p_sig text, p_amount numeric, p_payer text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  i public.pokejam_live_ad_usdc_intents;
  a public.pokejam_live_ads;
  want timestamptz;
  s timestamptz;
  secs int;
  banned boolean;
begin
  if p_intent is null or coalesce(p_sig, '') = '' then raise exception 'usdc pay: missing intent or signature'; end if;
  perform pg_advisory_xact_lock(hashtext('pokejam_live_ads'));
  select * into i from public.pokejam_live_ad_usdc_intents where id = p_intent for update;
  if not found then return jsonb_build_object('status', 'no_intent'); end if;
  if i.status = 'paid' then
    if i.signature = p_sig then
      select * into a from public.pokejam_live_ads where id = i.ad_id;
      return jsonb_build_object('status', 'duplicate', 'ad', public.pokejam_live_ad_view(a), 'intent', public.pokejam_live_ad_usdc_intent_view(i));
    end if;
    return jsonb_build_object('status', 'intent_done');
  end if;
  if exists (select 1 from public.pokejam_live_ad_usdc_intents where signature = p_sig)
     or exists (select 1 from public.pokejam_live_ads where usdc_sig = p_sig or burn_sig = p_sig)
     or exists (select 1 from public.pokejam_live_ad_burn_credit where signature = p_sig) then
    return jsonb_build_object('status', 'signature_used');
  end if;
  if p_amount is null or p_amount < i.amount then return jsonb_build_object('status', 'short'); end if;
  -- The intent's price is locked for a day; after that a higher current price applies.
  if i.created_at < now() - interval '1 day' and p_amount < coalesce(public.pokejam_live_ad_usdc_price(i.plan), 0) then
    return jsonb_build_object('status', 'short');
  end if;
  banned := exists (select 1 from public.pokejam_ad_bans where wallet = i.wallet);
  secs := i.hours * 3600;
  want := greatest(i.wants_start, now());
  s := public.pokejam_live_ad_next_open(want, secs, i.wallet);
  insert into public.pokejam_live_ads(code, wallet, text, theme, plan, hours, pay_method, price, wants_start, state, starts_at, ends_at,
    moved, usdc_sig, usdc_paid, burner, paid_at)
  values (encode(extensions.gen_random_bytes(6), 'hex'), i.wallet, i.text, i.theme, i.plan, i.hours, 'usdc', i.amount, i.wants_start,
    'paid', s, s + make_interval(secs => secs), s > want + interval '1 minute', p_sig, p_amount, p_payer, now())
  returning * into a;
  if banned then
    update public.pokejam_live_ads set state = 'removed', removed_at = now(), removed_left = secs, removed_reason = 'wallet banned'
    where id = a.id returning * into a;
  end if;
  update public.pokejam_live_ad_usdc_intents set status = 'paid', signature = p_sig, payer = p_payer, paid_amount = p_amount,
    ad_id = a.id, paid_at = now()
  where id = i.id returning * into i;
  return jsonb_build_object('status', 'paid', 'ad', public.pokejam_live_ad_view(a), 'intent', public.pokejam_live_ad_usdc_intent_view(i));
end $$;

-- Service role only, like every other live ad function.
revoke all on function public.pokejam_live_ad_credit(text) from public, anon, authenticated;
grant execute on function public.pokejam_live_ad_credit(text) to service_role;
revoke all on function public.pokejam_live_ad_pay(uuid, text, numeric, text) from public, anon, authenticated;
grant execute on function public.pokejam_live_ad_pay(uuid, text, numeric, text) to service_role;
revoke all on function public.pokejam_live_ad_usdc_pay(uuid, text, numeric, text) from public, anon, authenticated;
grant execute on function public.pokejam_live_ad_usdc_pay(uuid, text, numeric, text) to service_role;
