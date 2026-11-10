-- Live buy-and-burn prices (pokejam-ads-live). Needs 20261205_pokejam_ads_burn_credit.sql.
--
-- A burn tier that also has a USDC price is charged at 20% off that USDC price, in $PJAM, using the live token
-- price. The Edge Function works that amount out (burn-price.ts) and passes it as p_price. Tiers with no USDC
-- price keep the catalog row in pokejam_live_ad_plans. USDC prices are unchanged.
--
-- The page's amount and a fresh quote may differ by up to 5% (BURN_PRICE_TOLERANCE_BPS in burn-price.ts) while the
-- token price moves. The booking locks the amount the page showed. A burn below the locked price still buys nothing
-- on a booking's first day. After that day, and for an extra run, p_rate is the fresh live quote: the higher of the
-- locked price and that quote applies, and a burn within 5% under it still covers the full run. Further under is
-- credit, the same as any other short burn.
--
-- Safe to apply again. Drops the previous 7-arg create and 4-arg pay only so the new signatures replace them
-- (create or replace cannot add an argument). Devnet pokejam_ad_* is untouched. Wallet and burn addresses are not.

drop function if exists public.pokejam_live_ad_create(text, text, text, text, timestamptz, numeric, text);

create or replace function public.pokejam_live_ad_create(p_wallet text, p_text text, p_theme text, p_plan text, p_start timestamptz,
  p_expect numeric default null, p_blockhash text default null, p_price numeric default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  h int := public.pokejam_live_ad_hours(p_plan);
  price numeric := public.pokejam_live_ad_price(p_plan);
  a public.pokejam_live_ads;
begin
  perform public.pokejam_live_ad_check(p_wallet, p_text, p_theme);
  if h is null then raise exception 'unknown plan'; end if;
  -- p_price is the live quote. Only the Edge Function sets it, after checking it against a fresh price.
  if p_price is not null then
    if p_price = 'NaN' or p_price = 'Infinity' or p_price = '-Infinity' or p_price <= 0 or p_price <> trunc(p_price) then
      raise exception 'bad burn price';
    end if;
    price := p_price;
  end if;
  if price is null then raise exception 'this plan is not paid by burning $PJAM'; end if;
  if p_expect is not null and p_expect <> price then raise exception 'price changed: % now', price; end if;
  if (select count(*) from public.pokejam_live_ads where wallet = p_wallet and state = 'pending' and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'too many unpaid bookings: try again in a few minutes';
  end if;
  insert into public.pokejam_live_ads(code, wallet, text, theme, plan, hours, price, wants_start, blockhash)
  values (encode(extensions.gen_random_bytes(6), 'hex'), p_wallet, public.pokejam_ad_clean(p_text), p_theme, p_plan, h, price,
    public.pokejam_ad_start(p_start), p_blockhash)
  returning * into a;
  return public.pokejam_live_ad_view(a);
end $$;

drop function if exists public.pokejam_live_ad_pay(uuid, text, numeric, text);

-- pokejam_live_ad_pay from 20261205, plus p_rate: the fresh live quote, when the Edge Function has one.
create or replace function public.pokejam_live_ad_pay(p_id uuid, p_sig text, p_burned numeric, p_burner text, p_rate numeric default null)
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
  floor_price numeric;
  live_rate numeric := p_rate;
  late boolean;
  short_by numeric;
  taken numeric := 0;
  covered numeric;
  left_to_spend numeric;
  part numeric;
begin
  perform pg_advisory_xact_lock(hashtext('pokejam_live_ads'));
  select * into dup from public.pokejam_live_ads where burn_sig = p_sig or usdc_sig = p_sig;
  if found then
    if dup.burn_sig = p_sig and (dup.id = p_id or dup.extra_of = p_id) then return public.pokejam_live_ad_view(dup); end if;
    raise exception 'burn already used';
  end if;
  if exists (select 1 from public.pokejam_live_ad_usdc_intents where signature = p_sig) then raise exception 'burn already used'; end if;
  select * into c from public.pokejam_live_ad_burn_credit where signature = p_sig;
  if found then
    if c.ad_id = p_id then return public.pokejam_live_ad_view((select x from public.pokejam_live_ads x where x.id = p_id)); end if;
    raise exception 'burn already used';
  end if;
  select * into a from public.pokejam_live_ads where id = p_id for update;
  if not found then raise exception 'no such booking'; end if;
  if p_burned is null or p_burned = 'NaN' or p_burned = 'Infinity' or p_burned = '-Infinity'
     or p_burned <= 0 or p_burned <> trunc(p_burned) then raise exception 'nothing was burned'; end if;
  if p_burner is distinct from a.wallet then raise exception 'that burn did not come from the wallet that booked this ad'; end if;
  if live_rate is not null and (live_rate = 'NaN' or live_rate = 'Infinity' or live_rate = '-Infinity'
     or live_rate <= 0 or live_rate <> trunc(live_rate)) then
    live_rate := null;
  end if;
  late := a.state <> 'pending' or a.created_at < now() - interval '1 day';
  if a.pay_method = 'usdc' then
    rate_price := public.pokejam_live_ad_price('hour');
    rate_hours := 1;
    floor_price := rate_price;
  else
    rate_price := a.price;
    rate_hours := a.hours;
    -- The locked price covers the booking's own first day. After that, and for extra runs, a higher current price
    -- applies: the live quote when we have one, otherwise the catalog price.
    if late then
      rate_price := greatest(a.price, coalesce(live_rate, public.pokejam_live_ad_price(a.plan)));
    end if;
    -- 5% under a live quote still covers the run (BURN_PRICE_TOLERANCE_BPS). A first-day booking stays exact.
    floor_price := case when late and live_rate is not null and rate_price is not null then ceil(rate_price * 95 / 100) else rate_price end;
  end if;

  banned := exists (select 1 from public.pokejam_ad_bans where wallet = a.wallet);
  short_by := case when floor_price is null then null else greatest(floor_price - p_burned, 0) end;
  if short_by > 0 and not banned and a.state <> 'removed' and (select coalesce(sum(remaining), 0) from public.pokejam_live_ad_burn_credit
      where wallet = a.wallet and remaining > 0) >= short_by then
    taken := short_by;
  end if;
  covered := p_burned + taken;
  if short_by is null or covered < floor_price then
    insert into public.pokejam_live_ad_burn_credit(signature, wallet, amount, remaining, ad_id) values (p_sig, a.wallet, p_burned, p_burned, a.id);
    if a.state = 'pending' then
      update public.pokejam_live_ads set state = 'dust', burn_sig = p_sig, burned = p_burned, burner = p_burner, paid_at = now()
      where id = a.id returning * into a;
    end if;
    return public.pokejam_live_ad_view(a);
  end if;

  -- Inside the 5% band, the run is the full plan. At or above the rate, extra tokens still buy extra time.
  secs := case
    when rate_price is null or rate_price <= 0 then 0
    when covered >= rate_price then least(floor(covered * rate_hours * 3600 / rate_price), 366 * 86400)::int
    else least(rate_hours * 3600, 366 * 86400)
  end;
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
  if taken > 0 then
    left_to_spend := taken;
    for c in select * from public.pokejam_live_ad_burn_credit where wallet = a.wallet and remaining > 0
      order by created_at, signature for update
    loop
      exit when left_to_spend = 0;
      part := least(c.remaining, left_to_spend);
      left_to_spend := left_to_spend - part;
      update public.pokejam_live_ad_burn_credit set remaining = remaining - part,
        used_for = case when remaining = part then a.id end, used_at = case when remaining = part then now() end
      where signature = c.signature and remaining = c.remaining;
      if not found then raise exception 'credit changed while booking'; end if;
    end loop;
    if left_to_spend <> 0 then raise exception 'credit changed while booking'; end if;
  end if;
  if banned or (a.extra_of is not null and exists (select 1 from public.pokejam_live_ads o where o.id = a.extra_of and o.state = 'removed')) then
    update public.pokejam_live_ads set state = 'removed', removed_at = now(), removed_left = secs,
      removed_reason = case when banned then 'wallet banned' else (select removed_reason from public.pokejam_live_ads where id = a.extra_of) end
    where id = a.id returning * into a;
  end if;
  return public.pokejam_live_ad_view(a);
end $$;

revoke all on function public.pokejam_live_ad_create(text, text, text, text, timestamptz, numeric, text, numeric) from public, anon, authenticated;
grant execute on function public.pokejam_live_ad_create(text, text, text, text, timestamptz, numeric, text, numeric) to service_role;
revoke all on function public.pokejam_live_ad_pay(uuid, text, numeric, text, numeric) from public, anon, authenticated;
grant execute on function public.pokejam_live_ad_pay(uuid, text, numeric, text, numeric) to service_role;
