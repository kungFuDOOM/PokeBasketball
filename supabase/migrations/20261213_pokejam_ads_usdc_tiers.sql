-- Every courtside tier is sold in USDC. Buy-and-burn is not a fixed token amount: pokejam-ads-live
-- prices it at 20% off the matching USDC price using the live $PJAM price. The old burn rows
-- (100,000 / 1,500,000 / 7,500,000 $PJAM) are turned off so nothing charges them.
--
-- USDC amounts are whole tokens (6 decimals are applied in pokejam_live_ad_plan_amount).
--   hour 15, day 40, week 150, month 500.
-- Safe to apply again. It does not touch wallets, the burn instruction, or the USDC receiver.

insert into public.pokejam_live_ad_plans(method, plan, amount, enabled) values
  ('usdc', 'hour', 15, true),
  ('usdc', 'day', 40, true),
  ('usdc', 'week', 150, true),
  ('usdc', 'month', 500, true)
on conflict (method, plan) do update set amount = excluded.amount, enabled = true;

update public.pokejam_live_ad_plans set enabled = false where method = 'burn';

-- An extra burn on a USDC ad is an hour at the live quote (p_rate) when the Edge Function has one.
-- Without that quote there is no fixed hourly token price to fall back on.
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
    rate_price := coalesce(live_rate, public.pokejam_live_ad_price('hour'));
    rate_hours := 1;
    floor_price := rate_price;
  else
    rate_price := a.price;
    rate_hours := a.hours;
    if late then
      rate_price := greatest(a.price, coalesce(live_rate, public.pokejam_live_ad_price(a.plan)));
    end if;
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
