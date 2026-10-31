-- PokeJam billboard ads on the LIVE site (pokejam.xyz, Solana mainnet), paid by burning real $PJAM or in USDC.
--
-- Additive only. 20261104_pokejam_ads.sql (the devnet test site's pokejam-ads) is untouched: nothing here drops,
-- alters or redefines any of its tables or functions, and none of its functions can see the rows below. Mainnet
-- bookings live in their own tables (pokejam_live_*), so devnet test burns never share a board, a schedule, a total
-- or a scan cursor with real ones. What is shared on purpose:
--   - the text rules (pokejam_ad_clean, pokejam_ad_verdict) and the wanted-start rule (pokejam_ad_start);
--   - the ban list (pokejam_ad_bans): a wallet banned for abuse on either board is banned on both;
--   - the rate-limit table (pokejam_ad_hits), with keys prefixed "live:".
--
-- The pokejam-ads-live Edge Function calls these with the same names as the devnet function, prefixed: every
-- pokejam_ad_<x> it would call is pokejam_live_ad_<x> here, with the same argument names. Settings live in
-- pokejam_config under "live_" + the devnet key (live_ad_price_hour, live_ad_spots, live_ad_scan_cursor, ...).
--
-- Two ways to pay for the same board (one schedule, one set of spots, one spot per wallet at a time):
--   Burn $PJAM: the booking flow of 20261104 unchanged (create → wallet burns with memo "pokejam-ad:<code>" → pay).
--     Plans hour/day/week, priced in PJAM base units (6 decimals).
--   USDC: pokejam_live_ad_usdc_intent checks everything that could refuse the ad (text, ban, paused sales, the price
--     the page showed, too many open intents) and records a one-time intent: random reference key, memo, the exact
--     USDC amount for the plan, the wallet, text, theme and wanted start, the receiver and mint, expiring in 15 min.
--     The advertiser's wallet sends a USDC transfer to the receiver's USDC account. The Edge Function reads it from
--     the chain and checks it (mint, destination account and its owner, amount >= the intent's, confirmed, signer,
--     memo/reference), then calls pokejam_live_ad_usdc_pay, which puts the ad on the board for the plan's full run
--     from the first opening. One ad per intent, one intent per signature (unique), so a replayed or re-submitted
--     signature never books twice. Plans week/month, priced in USDC base units (6 decimals): $150 and $500 for the
--     bookable courtside half. An open intent holds no board space, like an unpaid burn booking.
--   Like a burn, a USDC payment that really landed is never lost: a late one (after the intent expired) still books,
--   from the first opening; a banned wallet's is recorded and stays down.

insert into public.pokejam_config(key, value) values
  ('live_ads_paused', 'false'),
  ('live_ad_spots', '3'),
  -- PJAM burn prices on mainnet. Same as the devnet defaults until the owner sets real ones (tunable, no deploy).
  ('live_ad_price_hour', '100000000000'),
  ('live_ad_price_day', '1500000000000'),
  ('live_ad_price_week', '7500000000000'),
  -- USDC prices (6 decimals) for the bookable courtside half.
  ('live_ad_usdc_week', '150000000'),    -- $150
  ('live_ad_usdc_month', '500000000')    -- $500
on conflict (key) do nothing;

-- ---------- tables ----------

-- The live board's bookings: 20261104's pokejam_ads, plus how it was paid and a month plan (USDC only).
create table if not exists public.pokejam_live_ads (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  wallet text not null check (wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  text text not null check (char_length(text) between 1 and 24),
  theme text not null check (theme in ('gold', 'fire', 'water', 'grass', 'electric', 'psychic', 'ghost', 'ice')),
  plan text not null check (plan in ('hour', 'day', 'week', 'month')),
  hours int not null check (hours > 0),
  -- 'burn': price and burned are PJAM base units. 'usdc': price and usdc_paid are USDC base units.
  pay_method text not null default 'burn' check (pay_method in ('burn', 'usdc')),
  price numeric(39, 0) not null check (price > 0),
  wants_start timestamptz not null,
  blockhash text,
  state text not null default 'pending' check (state in ('pending', 'paid', 'dust', 'removed')),
  starts_at timestamptz,
  ends_at timestamptz,
  moved boolean not null default false,
  burn_sig text unique,
  burned numeric(39, 0),
  burner text,
  usdc_sig text unique,
  usdc_paid numeric(39, 0),
  paid_at timestamptz,
  extra_of uuid references public.pokejam_live_ads(id),
  replaces uuid references public.pokejam_live_ads(id),
  replaced_by uuid references public.pokejam_live_ads(id),
  removed_reason text,
  removed_at timestamptz,
  removed_left int,
  created_at timestamptz not null default now(),
  check (state = 'pending' or burn_sig is not null or usdc_sig is not null or replaces is not null),
  check (state not in ('paid', 'removed') or (starts_at is not null and ends_at > starts_at)),
  check (pay_method = 'usdc' or usdc_sig is null),
  check (pay_method = 'burn' or burn_sig is null)
);
create index if not exists pokejam_live_ads_run on public.pokejam_live_ads (starts_at, ends_at) where state = 'paid';
create index if not exists pokejam_live_ads_wallet on public.pokejam_live_ads (wallet, created_at);
alter table public.pokejam_live_ads enable row level security;
revoke all on public.pokejam_live_ads from anon, authenticated, public;

create table if not exists public.pokejam_live_ad_reports (
  ad_id uuid not null references public.pokejam_live_ads(id) on delete cascade,
  reporter text not null,
  reason text not null check (reason in ('offensive', 'scam', 'other')),
  at timestamptz not null default now(),
  primary key (ad_id, reporter)
);
alter table public.pokejam_live_ad_reports enable row level security;
revoke all on public.pokejam_live_ad_reports from anon, authenticated, public;

-- USDC payment intents. The signature is unique: one transaction pays one intent, once.
create table if not exists public.pokejam_live_ad_usdc_intents (
  id uuid primary key default gen_random_uuid(),
  wallet text not null check (wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  text text not null check (char_length(text) between 1 and 24),
  theme text not null check (theme in ('gold', 'fire', 'water', 'grass', 'electric', 'psychic', 'ghost', 'ice')),
  plan text not null check (plan in ('week', 'month')),
  hours int not null check (hours > 0),
  -- USDC base units (6 decimals), locked when the intent is made.
  amount numeric(39, 0) not null check (amount > 0),
  wants_start timestamptz not null,
  mint text not null,
  cluster text not null check (cluster in ('devnet', 'mainnet-beta')),
  receiver text not null,
  reference text not null unique,
  memo text not null unique,
  status text not null default 'open' check (status in ('open', 'paid')),
  signature text unique,
  payer text,
  paid_amount numeric(39, 0),
  ad_id uuid references public.pokejam_live_ads(id),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  paid_at timestamptz,
  check (status = 'open' or (signature is not null and ad_id is not null))
);
create index if not exists pokejam_live_ad_usdc_intents_wallet on public.pokejam_live_ad_usdc_intents (wallet, created_at);
alter table public.pokejam_live_ad_usdc_intents enable row level security;
revoke all on public.pokejam_live_ad_usdc_intents from anon, authenticated, public;

-- ---------- settings, prices, rate limits, text ----------

create or replace function public.pokejam_live_ad_cfg(p_key text, p_default text)
returns text language sql stable security definer set search_path = public as $$
  select public.pokejam_ad_cfg('live_' || p_key, p_default);
$$;

create or replace function public.pokejam_live_ad_set_cfg(p_key text, p_value text)
returns void language sql security definer set search_path = public as $$
  select public.pokejam_ad_set_cfg('live_' || p_key, p_value);
$$;

create or replace function public.pokejam_live_ad_hours(p_plan text)
returns int language sql immutable set search_path = public as $$
  select case p_plan when 'month' then 720 else public.pokejam_ad_hours(p_plan) end;
$$;

-- What a plan costs in PJAM base units by burning, or null when it can't be paid that way (month).
create or replace function public.pokejam_live_ad_price(p_plan text)
returns numeric language sql stable security definer set search_path = public as $$
  select case p_plan
    when 'hour' then public.pokejam_live_ad_cfg('ad_price_hour', '100000000000')::numeric
    when 'day' then public.pokejam_live_ad_cfg('ad_price_day', '1500000000000')::numeric
    when 'week' then public.pokejam_live_ad_cfg('ad_price_week', '7500000000000')::numeric
  end;
$$;

-- What a plan costs in USDC base units, or null when it can't be paid that way (hour, day).
create or replace function public.pokejam_live_ad_usdc_price(p_plan text)
returns numeric language sql stable security definer set search_path = public as $$
  select case p_plan
    when 'week' then public.pokejam_live_ad_cfg('ad_usdc_week', '150000000')::numeric
    when 'month' then public.pokejam_live_ad_cfg('ad_usdc_month', '500000000')::numeric
  end;
$$;

create or replace function public.pokejam_live_ad_allow(p_key text, p_max int, p_seconds int)
returns boolean language sql security definer set search_path = public as $$
  select public.pokejam_ad_allow('live:' || p_key, p_max, p_seconds);
$$;

create or replace function public.pokejam_live_ad_verdict(p text)
returns text language sql immutable security definer set search_path = public as $$
  select public.pokejam_ad_verdict(p);
$$;

-- ---------- the schedule ----------

create or replace function public.pokejam_live_ad_peak(p_from timestamptz, p_to timestamptz)
returns int language sql stable security definer set search_path = public as $$
  select coalesce(max((select count(*) from public.pokejam_live_ads a
                       where a.state = 'paid' and a.starts_at <= p.t and a.ends_at > p.t)), 0)::int
  from (select p_from as t
        union select starts_at from public.pokejam_live_ads where state = 'paid' and starts_at > p_from and starts_at < p_to) p;
$$;

create or replace function public.pokejam_live_ad_next_open(p_from timestamptz, p_seconds int, p_wallet text)
returns timestamptz language plpgsql stable security definer set search_path = public as $$
declare
  spots int := greatest(1, public.pokejam_live_ad_cfg('ad_spots', '3')::int);
  c timestamptz;
  len interval := make_interval(secs => p_seconds);
begin
  for c in select p_from union select ends_at from public.pokejam_live_ads where state = 'paid' and ends_at > p_from order by 1 loop
    if public.pokejam_live_ad_peak(c, c + len) < spots
       and not exists (select 1 from public.pokejam_live_ads where state = 'paid' and wallet = p_wallet and starts_at < c + len and ends_at > c) then
      return c;
    end if;
  end loop;
  return p_from;
end $$;

-- What a plan costs (PJAM by burning, USDC, or null for a way it can't be paid) and when it would run if booked now.
create or replace function public.pokejam_live_ad_quote(p_plan text, p_start timestamptz, p_wallet text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  h int := public.pokejam_live_ad_hours(p_plan);
  want timestamptz;
  s timestamptz;
begin
  if h is null then raise exception 'unknown plan'; end if;
  want := public.pokejam_ad_start(p_start);
  s := public.pokejam_live_ad_next_open(want, h * 3600, coalesce(p_wallet, ''));
  return jsonb_build_object('plan', p_plan, 'hours', h, 'price', public.pokejam_live_ad_price(p_plan)::text,
    'usdc', public.pokejam_live_ad_usdc_price(p_plan)::text,
    'starts_at', s, 'ends_at', s + make_interval(hours => h), 'moved', s > want + interval '1 minute');
end $$;

create or replace function public.pokejam_live_ad_view(a public.pokejam_live_ads)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object('id', a.id, 'code', a.code, 'wallet', a.wallet, 'text', a.text, 'theme', a.theme, 'plan', a.plan,
    'hours', a.hours, 'pay_method', a.pay_method, 'price', a.price::text, 'state', a.state, 'wants_start', a.wants_start,
    'starts_at', a.starts_at, 'ends_at', a.ends_at, 'moved', a.moved, 'burn_sig', a.burn_sig, 'burned', a.burned::text,
    'usdc_sig', a.usdc_sig, 'usdc_paid', a.usdc_paid::text, 'paid_at', a.paid_at,
    'blockhash', a.blockhash, 'created_at', a.created_at, 'extra_of', a.extra_of, 'replaces', a.replaces,
    'replaced_by', a.replaced_by, 'removed_reason', a.removed_reason, 'removed_left', a.removed_left,
    'banned', exists (select 1 from public.pokejam_ad_bans b where b.wallet = a.wallet));
$$;

-- Everything that could refuse an ad before anything is paid, either way.
create or replace function public.pokejam_live_ad_check(p_wallet text, p_text text, p_theme text)
returns void language plpgsql stable security definer set search_path = public as $$
declare why text := public.pokejam_ad_verdict(p_text);
begin
  if public.pokejam_live_ad_cfg('ads_paused', 'false') = 'true' then raise exception 'ad sales are paused'; end if;
  if p_wallet is null or p_wallet !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' then raise exception 'not a Solana wallet address'; end if;
  if exists (select 1 from public.pokejam_ad_bans where wallet = p_wallet) then raise exception 'this wallet is banned from advertising'; end if;
  if why is not null then raise exception 'ad text not allowed (%)', why; end if;
  if p_theme is null or p_theme not in ('gold', 'fire', 'water', 'grass', 'electric', 'psychic', 'ghost', 'ice') then raise exception 'pick a colour'; end if;
end $$;

-- ---------- paying by burning $PJAM (20261104's flow, on the live tables) ----------

create or replace function public.pokejam_live_ad_create(p_wallet text, p_text text, p_theme text, p_plan text, p_start timestamptz,
  p_expect numeric default null, p_blockhash text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  h int := public.pokejam_live_ad_hours(p_plan);
  price numeric := public.pokejam_live_ad_price(p_plan);
  a public.pokejam_live_ads;
begin
  perform public.pokejam_live_ad_check(p_wallet, p_text, p_theme);
  if h is null then raise exception 'unknown plan'; end if;
  if price is null then raise exception 'this plan is paid in USDC'; end if;
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

-- A checked burn naming booking p_id pays for airtime: pokejam_ad_pay's rules. A burn naming an ad that was paid in
-- USDC (only a hand-crafted burn can) buys an extra run at the current hourly PJAM rate.
create or replace function public.pokejam_live_ad_pay(p_id uuid, p_sig text, p_burned numeric, p_burner text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  a public.pokejam_live_ads;
  dup public.pokejam_live_ads;
  secs int;
  want timestamptz;
  s timestamptz;
  banned boolean;
  rate_price numeric;
  rate_hours int;
begin
  perform pg_advisory_xact_lock(hashtext('pokejam_live_ads'));
  select * into dup from public.pokejam_live_ads where burn_sig = p_sig or usdc_sig = p_sig;
  if found then
    if dup.burn_sig = p_sig and (dup.id = p_id or dup.extra_of = p_id) then return public.pokejam_live_ad_view(dup); end if;
    raise exception 'burn already used';
  end if;
  if exists (select 1 from public.pokejam_live_ad_usdc_intents where signature = p_sig) then raise exception 'burn already used'; end if;
  select * into a from public.pokejam_live_ads where id = p_id for update;
  if not found then raise exception 'no such booking'; end if;
  if p_burned is null or p_burned <= 0 then raise exception 'nothing was burned'; end if;
  if a.pay_method = 'usdc' then
    rate_price := public.pokejam_live_ad_price('hour');
    rate_hours := 1;
  else
    rate_price := a.price;
    rate_hours := a.hours;
  end if;
  secs := least(floor(p_burned * rate_hours * 3600 / rate_price), 366 * 86400)::int;
  banned := exists (select 1 from public.pokejam_ad_bans where wallet = a.wallet);
  if a.state <> 'pending' then
    insert into public.pokejam_live_ads(code, wallet, text, theme, plan, hours, price, wants_start, extra_of)
    values (encode(extensions.gen_random_bytes(6), 'hex'), a.wallet, a.text, a.theme,
      case when a.pay_method = 'usdc' then 'hour' else a.plan end, rate_hours, rate_price, now(), a.id)
    returning * into a;
  end if;
  if secs < 60 then
    update public.pokejam_live_ads set state = 'dust', burn_sig = p_sig, burned = p_burned, burner = p_burner, paid_at = now()
    where id = a.id returning * into a;
    return public.pokejam_live_ad_view(a);
  end if;
  want := greatest(a.wants_start, now());
  s := public.pokejam_live_ad_next_open(want, secs, a.wallet);
  update public.pokejam_live_ads set state = 'paid', burn_sig = p_sig, burned = p_burned, burner = p_burner, paid_at = now(),
    starts_at = s, ends_at = s + make_interval(secs => secs), moved = s > want + interval '1 minute'
  where id = a.id returning * into a;
  if banned or (a.extra_of is not null and exists (select 1 from public.pokejam_live_ads o where o.id = a.extra_of and o.state = 'removed')) then
    update public.pokejam_live_ads set state = 'removed', removed_at = now(), removed_left = secs,
      removed_reason = case when banned then 'wallet banned' else (select removed_reason from public.pokejam_live_ads where id = a.extra_of) end
    where id = a.id returning * into a;
  end if;
  return public.pokejam_live_ad_view(a);
end $$;

-- ---------- paying in USDC ----------

-- A one-time USDC intent for a week or month on the board. The Edge Function makes the reference key and memo and
-- passes the receiver, mint and cluster from its config. Raises (like pokejam_live_ad_create) for anything that
-- refuses the ad; returns the intent.
create or replace function public.pokejam_live_ad_usdc_intent(p_wallet text, p_text text, p_theme text, p_plan text, p_start timestamptz,
  p_reference text, p_memo text, p_receiver text, p_mint text, p_cluster text, p_expect numeric default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  h int := public.pokejam_live_ad_hours(p_plan);
  amount numeric := public.pokejam_live_ad_usdc_price(p_plan);
  i public.pokejam_live_ad_usdc_intents;
begin
  if coalesce(p_reference, '') !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' or coalesce(p_memo, '') !~ '^[A-Za-z0-9:_-]{6,64}$'
     or coalesce(p_receiver, '') !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' or coalesce(p_mint, '') !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
     or p_cluster is null or p_cluster not in ('devnet', 'mainnet-beta') then
    raise exception 'usdc intent: bad arguments';
  end if;
  perform public.pokejam_live_ad_check(p_wallet, p_text, p_theme);
  if h is null then raise exception 'unknown plan'; end if;
  if amount is null then raise exception 'this plan is paid by burning $PJAM'; end if;
  if p_expect is not null and p_expect <> amount then raise exception 'price changed: % now', amount; end if;
  if (select count(*) from public.pokejam_live_ad_usdc_intents where wallet = p_wallet and status = 'open' and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'too many unpaid bookings: try again in a few minutes';
  end if;
  insert into public.pokejam_live_ad_usdc_intents(wallet, text, theme, plan, hours, amount, wants_start, mint, cluster, receiver, reference, memo, expires_at)
  values (p_wallet, public.pokejam_ad_clean(p_text), p_theme, p_plan, h, amount, public.pokejam_ad_start(p_start), p_mint, p_cluster,
    p_receiver, p_reference, p_memo, now() + interval '15 minutes')
  returning * into i;
  return public.pokejam_live_ad_usdc_intent_view(i);
end $$;

create or replace function public.pokejam_live_ad_usdc_intent_view(i public.pokejam_live_ad_usdc_intents)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object('id', i.id, 'wallet', i.wallet, 'text', i.text, 'theme', i.theme, 'plan', i.plan, 'hours', i.hours,
    'amount', i.amount::text, 'wants_start', i.wants_start, 'mint', i.mint, 'cluster', i.cluster, 'receiver', i.receiver,
    'reference', i.reference, 'memo', i.memo, 'status', i.status, 'signature', i.signature, 'payer', i.payer,
    'paid_amount', i.paid_amount::text, 'ad_id', i.ad_id,
    'created_at', extract(epoch from i.created_at)::bigint, 'expires_at', extract(epoch from i.expires_at)::bigint);
$$;

-- The intent as the verifier needs it, or null.
create or replace function public.pokejam_live_ad_usdc_intent_get(p_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select public.pokejam_live_ad_usdc_intent_view(i) from public.pokejam_live_ad_usdc_intents i where i.id = p_id;
$$;

-- Called only after the Edge Function checked the transaction on chain. Idempotent. Returns {status, ad, intent}:
--   paid            the ad was booked now
--   duplicate       this intent was already paid by this same signature (a retry): nothing changes
--   intent_done     this intent was already paid by another signature
--   signature_used  this signature already paid something else (another intent, or a burn)
--   short           less than the intent's amount arrived: nothing is booked, the intent stays open
--   no_intent       unknown intent
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
     or exists (select 1 from public.pokejam_live_ads where usdc_sig = p_sig or burn_sig = p_sig) then
    return jsonb_build_object('status', 'signature_used');
  end if;
  if p_amount is null or p_amount < i.amount then return jsonb_build_object('status', 'short'); end if;
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

-- ---------- reading ----------

create or replace function public.pokejam_live_ad_get(p_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select public.pokejam_live_ad_view(a) from public.pokejam_live_ads a where a.id = p_id;
$$;

create or replace function public.pokejam_live_ad_by_code(p_code text)
returns jsonb language sql stable security definer set search_path = public as $$
  select public.pokejam_live_ad_view(a) from public.pokejam_live_ads a where a.code = p_code;
$$;

create or replace function public.pokejam_live_ad_mine(p_wallet text)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(public.pokejam_live_ad_view(a) order by a.created_at desc), '[]')
  from (select * from public.pokejam_live_ads where wallet = p_wallet and (created_at > now() - interval '60 days' or ends_at > now())
        and not (state = 'pending' and created_at < now() - interval '1 day')
        order by created_at desc limit 50) a;
$$;

create or replace function public.pokejam_live_ad_unsettled(p_limit int)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(public.pokejam_live_ad_view(a) order by a.created_at desc), '[]')
  from (select * from public.pokejam_live_ads where state = 'pending' and created_at > now() - interval '1 day'
        order by created_at desc limit greatest(1, least(p_limit, 50))) a;
$$;

-- ---------- moderation ----------

create or replace function public.pokejam_live_ad_remove(p_id uuid, p_reason text, p_ban boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a public.pokejam_live_ads;
begin
  perform pg_advisory_xact_lock(hashtext('pokejam_live_ads'));
  select * into a from public.pokejam_live_ads where id = p_id;
  if not found or a.state <> 'paid' then raise exception 'no paid ad with that id'; end if;
  if p_ban then
    insert into public.pokejam_ad_bans(wallet, reason) values (a.wallet, left(coalesce(p_reason, ''), 500))
    on conflict (wallet) do update set reason = excluded.reason, at = now();
  end if;
  update public.pokejam_live_ads set state = 'removed', removed_at = now(), removed_reason = left(coalesce(p_reason, ''), 500),
    removed_left = greatest(0, extract(epoch from ends_at - greatest(now(), starts_at)))::int
  where state = 'paid' and ends_at > now() and (id = p_id or (p_ban and wallet = a.wallet));
  select * into a from public.pokejam_live_ads where id = p_id;
  return public.pokejam_live_ad_view(a);
end $$;

create or replace function public.pokejam_live_ad_replace(p_id uuid, p_text text, p_theme text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  a public.pokejam_live_ads;
  n public.pokejam_live_ads;
  why text := public.pokejam_ad_verdict(p_text);
  s timestamptz;
begin
  perform pg_advisory_xact_lock(hashtext('pokejam_live_ads'));
  select * into a from public.pokejam_live_ads where id = p_id for update;
  if not found or a.state <> 'removed' then raise exception 'only an ad that was taken down can be replaced'; end if;
  if a.replaced_by is not null then raise exception 'this ad was already replaced'; end if;
  if exists (select 1 from public.pokejam_ad_bans where wallet = a.wallet) then raise exception 'this wallet is banned from advertising'; end if;
  if coalesce(a.removed_left, 0) < 60 then raise exception 'no time left to replace'; end if;
  if why is not null then raise exception 'ad text not allowed (%)', why; end if;
  if p_theme is null or p_theme not in ('gold', 'fire', 'water', 'grass', 'electric', 'psychic', 'ghost', 'ice') then raise exception 'pick a colour'; end if;
  s := public.pokejam_live_ad_next_open(now(), a.removed_left, a.wallet);
  insert into public.pokejam_live_ads(code, wallet, text, theme, plan, hours, pay_method, price, wants_start, state, starts_at, ends_at,
    moved, burned, paid_at, replaces)
  values (encode(extensions.gen_random_bytes(6), 'hex'), a.wallet, public.pokejam_ad_clean(p_text), p_theme, a.plan, a.hours, a.pay_method,
    a.price, now(), 'paid', s, s + make_interval(secs => a.removed_left), s > now() + interval '1 minute', 0, now(), a.id)
  returning * into n;
  update public.pokejam_live_ads set replaced_by = n.id where id = a.id;
  return public.pokejam_live_ad_view(n);
end $$;

create or replace function public.pokejam_live_ad_report(p_id uuid, p_reporter text, p_reason text)
returns int language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.pokejam_live_ads where id = p_id and state = 'paid') then raise exception 'no such ad on the board'; end if;
  insert into public.pokejam_live_ad_reports(ad_id, reporter, reason) values (p_id, p_reporter, p_reason) on conflict do nothing;
  if not found then return 0; end if;
  return (select count(*) from public.pokejam_live_ad_reports where ad_id = p_id);
end $$;

-- ---------- what the page and the game show ----------

create or replace function public.pokejam_live_ad_board()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'now', now(),
    'paused', public.pokejam_live_ad_cfg('ads_paused', 'false') = 'true',
    'spots', greatest(1, public.pokejam_live_ad_cfg('ad_spots', '3')::int),
    'prices', jsonb_build_object('hour', public.pokejam_live_ad_price('hour')::text, 'day', public.pokejam_live_ad_price('day')::text,
      'week', public.pokejam_live_ad_price('week')::text),
    'usdc', jsonb_build_object('week', public.pokejam_live_ad_usdc_price('week')::text, 'month', public.pokejam_live_ad_usdc_price('month')::text),
    'live', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'text', text, 'theme', theme, 'wallet', wallet,
        'starts_at', starts_at, 'ends_at', ends_at, 'burn_sig', burn_sig, 'usdc_sig', usdc_sig) order by starts_at, id)
      from public.pokejam_live_ads where state = 'paid' and starts_at <= now() and ends_at > now()), '[]'),
    'booked', coalesce((select jsonb_agg(jsonb_build_object('starts_at', starts_at, 'ends_at', ends_at) order by starts_at)
      from public.pokejam_live_ads where state = 'paid' and ends_at > now() and starts_at < now() + interval '14 days'), '[]'),
    'totals', (select jsonb_build_object('burned', coalesce(sum(burned), 0)::text, 'usdc', coalesce(sum(usdc_paid), 0)::text,
        'ads', count(*) filter (where extra_of is null), 'advertisers', count(distinct wallet),
        'hours', coalesce(round(sum(extract(epoch from ends_at - starts_at)) / 3600), 0))
      from public.pokejam_live_ads where burn_sig is not null or usdc_sig is not null)
  );
$$;

-- ---------- moderators (admin.html) ----------

create or replace function public.pokejam_admin_live_ads(p_days int default 7)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.pokejam_require_admin();
  return coalesce((select jsonb_agg(x order by (x->>'reports')::int desc, x->>'starts_at' desc) from (
    select public.pokejam_live_ad_view(a) || jsonb_build_object(
      'reports', (select count(*) from public.pokejam_live_ad_reports r where r.ad_id = a.id),
      'reasons', (select jsonb_object_agg(q.reason, q.n) from (select reason, count(*) as n from public.pokejam_live_ad_reports r
                  where r.ad_id = a.id group by reason) q)) as x
    from public.pokejam_live_ads a
    where a.state in ('paid', 'removed') and a.ends_at > now() - make_interval(days => greatest(1, p_days))
      and a.starts_at < now() + make_interval(days => greatest(1, p_days))
  ) y), '[]');
end $$;

create or replace function public.pokejam_admin_live_ad_remove(p_id uuid, p_reason text, p_ban boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := public.pokejam_require_admin(); r jsonb;
begin
  r := public.pokejam_live_ad_remove(p_id, p_reason, p_ban);
  insert into public.pokejam_admin_log(admin, action, target, detail)
  values (me, case when p_ban then 'live ad ban' else 'live ad remove' end, p_id, format('%s: %s', r->>'text', left(coalesce(p_reason, ''), 200)));
  return r;
end $$;

-- ---------- privileges ----------

do $$
declare f text;
begin
  foreach f in array array[
    'pokejam_live_ad_cfg(text, text)', 'pokejam_live_ad_set_cfg(text, text)', 'pokejam_live_ad_hours(text)', 'pokejam_live_ad_price(text)',
    'pokejam_live_ad_usdc_price(text)', 'pokejam_live_ad_allow(text, int, int)', 'pokejam_live_ad_verdict(text)',
    'pokejam_live_ad_peak(timestamptz, timestamptz)', 'pokejam_live_ad_next_open(timestamptz, int, text)',
    'pokejam_live_ad_quote(text, timestamptz, text)', 'pokejam_live_ad_view(public.pokejam_live_ads)',
    'pokejam_live_ad_check(text, text, text)',
    'pokejam_live_ad_create(text, text, text, text, timestamptz, numeric, text)', 'pokejam_live_ad_pay(uuid, text, numeric, text)',
    'pokejam_live_ad_usdc_intent(text, text, text, text, timestamptz, text, text, text, text, text, numeric)',
    'pokejam_live_ad_usdc_intent_view(public.pokejam_live_ad_usdc_intents)', 'pokejam_live_ad_usdc_intent_get(uuid)',
    'pokejam_live_ad_usdc_pay(uuid, text, numeric, text)',
    'pokejam_live_ad_get(uuid)', 'pokejam_live_ad_by_code(text)', 'pokejam_live_ad_mine(text)', 'pokejam_live_ad_unsettled(int)',
    'pokejam_live_ad_remove(uuid, text, boolean)', 'pokejam_live_ad_replace(uuid, text, text)', 'pokejam_live_ad_report(uuid, text, text)',
    'pokejam_live_ad_board()'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  foreach f in array array['pokejam_admin_live_ads(int)', 'pokejam_admin_live_ad_remove(uuid, text, boolean)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
