-- PokeJam billboard ads: advertisers burn $PJAM to put their ad on the courtside LED board.
--
-- How a booking moves:
--   1. pokejam_ad_create: the advertiser's text, colour theme, plan (an hour, a day or a week) and wanted start.
--      Everything that could refuse an ad is checked here, before anything is burned: the text (pokejam_ad_verdict),
--      a banned wallet, paused sales, the price the page showed. The row is 'pending' and holds no space on the
--      board, so nobody can block the board without burning. Its price is locked from here on.
--   2. The advertiser's wallet signs one transaction: BurnChecked of the price, plus the memo "pokejam-ad:<code>".
--      The server never signs it and holds no key: the tokens leave the supply, nobody receives them.
--   3. pokejam_ad_pay: the pokejam-ads Edge Function read the landed transaction from the chain and checked it.
--
-- A burn is never lost. pokejam_ad_pay turns every checked burn that names a booking into airtime:
--   - the run is what was burned at the booking's locked rate: the full plan for the price, longer for more, shorter
--     for less (a crafted burn worth under a minute is recorded as dust and runs nothing);
--   - it starts at the first opening from the wanted start, so a board that filled up while the advertiser was
--     signing moves the ad, never drops it;
--   - a second burn naming a booking that's already paid adds its own run straight after;
--   - a burn landing late, even days later (a durable nonce), still pays: bookings are never deleted.
-- Moderators can take an ad down (pokejam_ad_remove). Its remaining time is kept: the advertiser replaces the text,
-- signed by their wallet (pokejam_ad_replace), and it runs again. Only a wallet banned for abuse loses it.
--
-- Griefing: unpaid bookings hold nothing; a wallet holds at most one spot at a time (one advertiser can't take the
-- whole board); unpaid bookings, reports and every Edge Function action are rate-limited (pokejam_ad_allow);
-- reports only flag an ad for moderators, so a crowd of reports can't take a paid ad down.
--
-- The board has `ad_spots` spots (default 3): the LED ticker shows the live ads in turn. Prices are in the token's
-- base units (6 decimals), tunable here without a deploy. Everything is service-role only (the pokejam-ads Edge
-- Function), apart from the moderators' pokejam_admin_ad* functions for admin.html.

insert into public.pokejam_config(key, value) values
  ('ads_paused', 'false'),
  ('ad_spots', '3'),
  ('ad_price_hour', '100000000000'),     --    100,000 PJAM
  ('ad_price_day', '1500000000000'),     --  1,500,000 PJAM (16 hours' worth: 37% off)
  ('ad_price_week', '7500000000000')     --  7,500,000 PJAM (75 hours' worth: 55% off)
on conflict (key) do nothing;

create table if not exists public.pokejam_ads (
  id uuid primary key default gen_random_uuid(),
  -- The booking's name in the burn's memo.
  code text not null unique,
  wallet text not null check (wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'),
  text text not null check (char_length(text) between 1 and 24),
  theme text not null check (theme in ('gold', 'fire', 'water', 'grass', 'electric', 'psychic', 'ghost', 'ice')),
  plan text not null check (plan in ('hour', 'day', 'week')),
  hours int not null check (hours > 0),
  -- Locked when booked: what the plan costs, and so the rate a burn buys airtime at.
  price numeric(39, 0) not null check (price > 0),
  wants_start timestamptz not null,
  -- The blockhash the server built the burn on (it can't land once that expires, unless the wallet rebuilt it).
  blockhash text,
  state text not null default 'pending' check (state in ('pending', 'paid', 'dust', 'removed')),
  starts_at timestamptz,
  ends_at timestamptz,
  -- Moved to a later opening because the board (or this wallet's own spot) was taken.
  moved boolean not null default false,
  burn_sig text unique,
  burned numeric(39, 0),
  -- Who burned (normally the booking wallet; anyone may pay for an ad).
  burner text,
  paid_at timestamptz,
  -- A second burn for a booking that was already paid: its own run, straight after.
  extra_of uuid references public.pokejam_ads(id),
  -- A replacement for a removed ad: the remaining time, with new text and no new burn.
  replaces uuid references public.pokejam_ads(id),
  replaced_by uuid references public.pokejam_ads(id),
  removed_reason text,
  removed_at timestamptz,
  -- Seconds of airtime the advertiser still had when it was removed (theirs to replace, unless banned).
  removed_left int,
  created_at timestamptz not null default now(),
  check (state = 'pending' or burn_sig is not null or replaces is not null),
  check (state not in ('paid', 'removed') or (starts_at is not null and ends_at > starts_at))
);
create index if not exists pokejam_ads_run on public.pokejam_ads (starts_at, ends_at) where state = 'paid';
create index if not exists pokejam_ads_wallet on public.pokejam_ads (wallet, created_at);
alter table public.pokejam_ads enable row level security;
revoke all on public.pokejam_ads from anon, authenticated, public;

-- Wallets banned for abuse: no new bookings, and their ads come down for good.
create table if not exists public.pokejam_ad_bans (
  wallet text primary key,
  reason text,
  at timestamptz not null default now()
);
alter table public.pokejam_ad_bans enable row level security;
revoke all on public.pokejam_ad_bans from anon, authenticated, public;

-- Reports from viewers: one per ad per reporter (a hashed IP), for moderators to look at.
create table if not exists public.pokejam_ad_reports (
  ad_id uuid not null references public.pokejam_ads(id) on delete cascade,
  reporter text not null,
  reason text not null check (reason in ('offensive', 'scam', 'other')),
  at timestamptz not null default now(),
  primary key (ad_id, reporter)
);
alter table public.pokejam_ad_reports enable row level security;
revoke all on public.pokejam_ad_reports from anon, authenticated, public;

-- Rate limits: one row per counted hit.
create table if not exists public.pokejam_ad_hits (
  key text not null,
  at timestamptz not null default now()
);
create index if not exists pokejam_ad_hits_key on public.pokejam_ad_hits (key, at);
create index if not exists pokejam_ad_hits_at on public.pokejam_ad_hits (at);
alter table public.pokejam_ad_hits enable row level security;
revoke all on public.pokejam_ad_hits from anon, authenticated, public;

-- One devnet faucet claim per wallet a day.
create table if not exists public.pokejam_ad_faucet (
  wallet text primary key,
  last_at timestamptz not null
);
alter table public.pokejam_ad_faucet enable row level security;
revoke all on public.pokejam_ad_faucet from anon, authenticated, public;

create or replace function public.pokejam_ad_cfg(p_key text, p_default text)
returns text language sql stable security definer set search_path = public as $$
  select coalesce((select value #>> '{}' from public.pokejam_config where key = p_key), p_default);
$$;

create or replace function public.pokejam_ad_set_cfg(p_key text, p_value text)
returns void language sql security definer set search_path = public as $$
  insert into public.pokejam_config(key, value) values (p_key, to_jsonb(p_value))
  on conflict (key) do update set value = excluded.value;
$$;

create or replace function public.pokejam_ad_hours(p_plan text)
returns int language sql immutable set search_path = public as $$
  select case p_plan when 'hour' then 1 when 'day' then 24 when 'week' then 168 end;
$$;

create or replace function public.pokejam_ad_price(p_plan text)
returns numeric language sql stable security definer set search_path = public as $$
  select case p_plan
    when 'hour' then public.pokejam_ad_cfg('ad_price_hour', '100000000000')::numeric
    when 'day' then public.pokejam_ad_cfg('ad_price_day', '1500000000000')::numeric
    when 'week' then public.pokejam_ad_cfg('ad_price_week', '7500000000000')::numeric
  end;
$$;

-- Counts a hit on `p_key` and says whether it's within `p_max` per `p_seconds`.
create or replace function public.pokejam_ad_allow(p_key text, p_max int, p_seconds int)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  if random() < 0.01 then delete from public.pokejam_ad_hits where at < now() - interval '2 days'; end if;
  if (select count(*) from public.pokejam_ad_hits where key = p_key and at > now() - make_interval(secs => p_seconds)) >= p_max then
    return false;
  end if;
  insert into public.pokejam_ad_hits(key) values (p_key);
  return true;
end $$;

-- ---------- what an ad may say ----------

-- The text as the board shows it: capitals, single spaces, trimmed.
create or replace function public.pokejam_ad_clean(p text)
returns text language sql immutable set search_path = public as $$
  select btrim(regexp_replace(upper(coalesce(p, '')), '\s+', ' ', 'g'));
$$;

-- Why an ad can't run, or null when it can: 'length', 'chars', 'link', 'scam', 'impersonation', 'offensive'.
--
-- The board only has capitals, digits, spaces and a little punctuation, so look-alike letters, invisible characters
-- and emoji never get this far. Each word is compared with look-alikes undone ($H!T, 5H1T → shit), letters that
-- repeat ("FUUUCK") and plurals allowed. Runs of short pieces are joined, so spacing a word out (F U C K, SH IT,
-- FU CK) doesn't hide it, while ordinary phrases whose words only run together by accident (PUSH IT, WHO RULES,
-- OPEN ISSUE) are left alone. The worst slurs and the scam phrases are also checked with every space removed,
-- and a few words backwards. Innocent words that contain a blocked root (Scunthorpe, therapist) are let through.
create or replace function public.pokejam_ad_verdict(p text)
returns text language plpgsql immutable security definer set search_path = public as $$
declare
  t text := public.pokejam_ad_clean(p);
  toks text[];
  checks text[] := '{}';
  run text[] := '{}';
  tok text;
  sk text;
  w text;
  whole_all text;
  i int;
  j int;
  -- Anywhere inside a word.
  roots text[] := array['nigg', 'faggot', 'fagot', 'kike', 'tranny', 'retard', 'cunt', 'whore', 'rapist', 'hitler', 'kkk',
    'molest', 'wetback', 'beaner', 'porn', 'dildo', 'jizz', 'pussy', 'penis', 'vagina', 'fuck', 'shit', 'bitch', 'asshole',
    'cocksuck', 'dickhead', 'blowjob', 'handjob', 'onlyfans', 'hentai', 'twat', 'skank', 'phuck', 'fvck', 'fcuk', 'biatch',
    'milf', 'nsfw', 'cumshot', 'orgasm', 'incest', 'pedophil', 'killyourself', 'cocaine', 'fentanyl', 'xxx', 'nibba',
    'bestiality', 'masturbat', 'erection', 'genital', 'clitoris', 'testicle'];
  -- The whole word (or a joined run of short pieces), plurals too.
  wholes text[] := array['niger', 'nigga', 'niga', 'fag', 'spic', 'spick', 'chink', 'gook', 'coon', 'rape', 'pedo', 'nazi',
    'dyke', 'slut', 'cock', 'dick', 'ass', 'azz', 'arse', 'sex', 'sexy', 'sext', 'semen', 'anal', 'anus', 'cum', 'tit',
    'titty', 'titties', 'boob', 'nude', 'naked', 'horny', 'erotic', 'loli', 'shota', 'kys', 'heil', 'negro', 'fuk', 'fuq',
    'fck', 'sht', 'shyt', 'meth', 'heroin', 'prick', 'wank', 'bastard', 'thot', 'stfu', 'gtfo', 'wtf', 'fml'];
  -- Checked with every space removed too: the worst slurs, which don't turn up by accident across words.
  slurs text[] := array['nigger', 'nigga', 'faggot', 'kike', 'tranny', 'retard', 'cunt', 'wetback', 'chink',
    -- and phrases that only mean one thing
    'blowjob', 'handjob', 'killyourself', 'killurself', 'onlyfans', 'cumshot', 'motherfuck', 'suckmy', 'eatmy'];
  -- Backwards, a few that read as nothing else.
  backs text[] := array['fuck', 'shit', 'cunt', 'bitch', 'whore', 'porn', 'pussy', 'dildo', 'faggot'];
  -- Giveaway and wallet-drainer scams, the most common griefing on a crypto board. Checked across words.
  scams text[] := array['airdrop', 'giveaway', 'seedphrase', 'privatekey', 'recoveryphrase', 'secretphrase', 'freesol',
    'freecrypto', 'freeusdc', 'freenft', 'freemoney', 'freetoken', 'freepjam', 'sendsol', 'sendusdc', 'doubleyour',
    'claimnow', 'claimfree', 'claimyour', 'drainer', 'connectwallet', 'validatewallet', 'verifywallet', 'syncwallet', 'dmme', 'dmfor'];
  -- Posing as the game's staff or partners.
  staff text[] := array['admin', 'administrator', 'moderator', 'staff', 'helpdesk', 'kungfudoom', 'thepaypay', 'collectorcrypt'];
  -- Innocent words that contain a blocked root.
  innocent text := '(scunthorpe|penistone|therapist|shiitake|shitake|pussycat|pussywillow|cockatoo|cockatiel|hancock|peacock|dickens|snigger|niggle|retardant|matsushita|cocktail|cockpit|shitzu)';
begin
  if t = '' or char_length(t) > 24 then return 'length'; end if;
  if t ~ '[^A-Z0-9 $!?.,&+@#:''/%-]' then return 'chars'; end if;
  -- Links: a dot joining letters (SITE.COM, T.ME), a slash next to a letter, or spelled out.
  if t ~ '[A-Z0-9-]\.[A-Z]{2,}' or t ~ '[A-Z]/|/[A-Z]' or t ~ '(HTTP|WWW|DOTCOM|DOT COM|DOT IO|DOT XYZ|DOT GG|DISCORD ?GG)' then
    return 'link';
  end if;
  -- Hate numbers.
  if t ~ '(^|[^0-9])(1488|14 ?/ ?88)([^0-9]|$)' then return 'offensive'; end if;

  -- Words: split on spaces and punctuation, keeping the look-alike symbols ($ @ !) inside words.
  toks := array(select x from regexp_split_to_table(t, '[ .,&+:/%#?''-]+') x where x <> '');
  foreach tok in array toks || array[null::text] loop
    sk := case when tok is null then null else public.pokejam_name_skeleton(tok) end;
    if sk is not null and sk <> '' then checks := checks || sk; end if;
    -- A run of short pieces (three letters or fewer each) is also checked joined up: F U C K, SH IT, FU CK.
    if sk is not null and char_length(sk) between 1 and 3 then
      run := run || sk;
    else
      -- Every stretch of two or more pieces in the run (KISS MY A S S → "ass" among them).
      for i in 1 .. coalesce(array_length(run, 1), 0) - 1 loop
        for j in i + 1 .. array_length(run, 1) loop
          checks := checks || array_to_string(run[i:j], '');
        end loop;
      end loop;
      run := '{}';
    end if;
  end loop;

  foreach sk in array checks loop
    sk := regexp_replace(sk, innocent, '', 'g');
    foreach w in array roots loop
      if sk ~ public.pokejam_word_pattern(w) then return 'offensive'; end if;
    end loop;
    foreach w in array wholes loop
      if sk ~ ('^' || public.pokejam_word_pattern(w) || 's*$') then return 'offensive'; end if;
    end loop;
    foreach w in array backs loop
      if reverse(sk) ~ public.pokejam_word_pattern(w) then return 'offensive'; end if;
    end loop;
    foreach w in array staff loop
      if sk ~ ('^' || public.pokejam_word_pattern(w) || '$') then return 'impersonation'; end if;
    end loop;
    if sk ~ 'o+f+i+c+i+a+l+' then return 'impersonation'; end if;
  end loop;

  whole_all := regexp_replace(public.pokejam_name_skeleton(t), innocent, '', 'g');
  foreach w in array slurs loop
    if whole_all ~ public.pokejam_word_pattern(w) then return 'offensive'; end if;
  end loop;
  foreach w in array scams loop
    if whole_all ~ public.pokejam_word_pattern(w) then return 'scam'; end if;
  end loop;
  return null;
end $$;

-- ---------- the schedule ----------

-- The most paid ads running at once anywhere in [p_from, p_to).
create or replace function public.pokejam_ad_peak(p_from timestamptz, p_to timestamptz)
returns int language sql stable security definer set search_path = public as $$
  select coalesce(max((select count(*) from public.pokejam_ads a
                       where a.state = 'paid' and a.starts_at <= p.t and a.ends_at > p.t)), 0)::int
  from (select p_from as t
        union select starts_at from public.pokejam_ads where state = 'paid' and starts_at > p_from and starts_at < p_to) p;
$$;

-- The first time at or after p_from when a run of p_seconds has a free spot the whole way, and the wallet has no
-- other ad running (one spot per advertiser at a time). Both only free up when an ad ends, so the answer is p_from
-- or the end of some ad.
create or replace function public.pokejam_ad_next_open(p_from timestamptz, p_seconds int, p_wallet text)
returns timestamptz language plpgsql stable security definer set search_path = public as $$
declare
  spots int := greatest(1, public.pokejam_ad_cfg('ad_spots', '3')::int);
  c timestamptz;
  len interval := make_interval(secs => p_seconds);
begin
  for c in select p_from union select ends_at from public.pokejam_ads where state = 'paid' and ends_at > p_from order by 1 loop
    if public.pokejam_ad_peak(c, c + len) < spots
       and not exists (select 1 from public.pokejam_ads where state = 'paid' and wallet = p_wallet and starts_at < c + len and ends_at > c) then
      return c;
    end if;
  end loop;
  return p_from;
end $$;

-- A wanted start, or now: never in the past, at most 60 days ahead.
create or replace function public.pokejam_ad_start(p_start timestamptz)
returns timestamptz language plpgsql stable set search_path = public as $$
begin
  if p_start is null or p_start < now() then return now(); end if;
  if p_start > now() + interval '60 days' then raise exception 'pick a start within 60 days'; end if;
  return p_start;
end $$;

-- What a plan costs and when it would run if booked now (for this wallet, if given).
create or replace function public.pokejam_ad_quote(p_plan text, p_start timestamptz, p_wallet text default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  h int := public.pokejam_ad_hours(p_plan);
  want timestamptz;
  s timestamptz;
begin
  if h is null then raise exception 'unknown plan'; end if;
  want := public.pokejam_ad_start(p_start);
  s := public.pokejam_ad_next_open(want, h * 3600, coalesce(p_wallet, ''));
  return jsonb_build_object('plan', p_plan, 'hours', h, 'price', public.pokejam_ad_price(p_plan)::text,
    'starts_at', s, 'ends_at', s + make_interval(hours => h), 'moved', s > want + interval '1 minute');
end $$;

create or replace function public.pokejam_ad_view(a public.pokejam_ads)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object('id', a.id, 'code', a.code, 'wallet', a.wallet, 'text', a.text, 'theme', a.theme, 'plan', a.plan,
    'hours', a.hours, 'price', a.price::text, 'state', a.state, 'wants_start', a.wants_start, 'starts_at', a.starts_at,
    'ends_at', a.ends_at, 'moved', a.moved, 'burn_sig', a.burn_sig, 'burned', a.burned::text, 'paid_at', a.paid_at,
    'blockhash', a.blockhash, 'created_at', a.created_at, 'extra_of', a.extra_of, 'replaces', a.replaces,
    'replaced_by', a.replaced_by, 'removed_reason', a.removed_reason, 'removed_left', a.removed_left,
    'banned', exists (select 1 from public.pokejam_ad_bans b where b.wallet = a.wallet));
$$;

-- ---------- booking and paying ----------

create or replace function public.pokejam_ad_create(p_wallet text, p_text text, p_theme text, p_plan text, p_start timestamptz,
  p_expect numeric default null, p_blockhash text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  t text := public.pokejam_ad_clean(p_text);
  why text := public.pokejam_ad_verdict(p_text);
  h int := public.pokejam_ad_hours(p_plan);
  price numeric := public.pokejam_ad_price(p_plan);
  a public.pokejam_ads;
begin
  if public.pokejam_ad_cfg('ads_paused', 'false') = 'true' then raise exception 'ad sales are paused'; end if;
  if p_wallet is null or p_wallet !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' then raise exception 'not a Solana wallet address'; end if;
  if exists (select 1 from public.pokejam_ad_bans where wallet = p_wallet) then raise exception 'this wallet is banned from advertising'; end if;
  if why is not null then raise exception 'ad text not allowed (%)', why; end if;
  if h is null then raise exception 'unknown plan'; end if;
  if p_expect is not null and p_expect <> price then raise exception 'price changed: % now', price; end if;
  if (select count(*) from public.pokejam_ads where wallet = p_wallet and state = 'pending' and created_at > now() - interval '1 hour') >= 10 then
    raise exception 'too many unpaid bookings: try again in a few minutes';
  end if;
  insert into public.pokejam_ads(code, wallet, text, theme, plan, hours, price, wants_start, blockhash)
  values (encode(extensions.gen_random_bytes(6), 'hex'), p_wallet, t, p_theme, p_plan, h, price, public.pokejam_ad_start(p_start), p_blockhash)
  returning * into a;
  return public.pokejam_ad_view(a);
end $$;

-- A checked burn naming booking p_id pays for airtime. Idempotent for the same signature; a signature pays once.
--   pending booking         → its run: burned × the plan's hours ÷ the locked price, from the first opening
--   already paid or removed → an extra run of the same ad for this burn, straight after (removed: kept as time to
--                             replace, since the text came down)
--   under a minute's worth  → recorded as dust (only a hand-crafted burn can be that small)
--   banned wallet           → recorded, and down for good
create or replace function public.pokejam_ad_pay(p_id uuid, p_sig text, p_burned numeric, p_burner text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  a public.pokejam_ads;
  dup public.pokejam_ads;
  secs int;
  want timestamptz;
  s timestamptz;
  banned boolean;
begin
  -- One payment at a time, so two burns can't both take the last spot.
  perform pg_advisory_xact_lock(hashtext('pokejam_ads'));
  select * into dup from public.pokejam_ads where burn_sig = p_sig;
  if found then
    if dup.id = p_id or dup.extra_of = p_id then return public.pokejam_ad_view(dup); end if;
    raise exception 'burn already used';
  end if;
  select * into a from public.pokejam_ads where id = p_id for update;
  if not found then raise exception 'no such booking'; end if;
  if p_burned is null or p_burned <= 0 then raise exception 'nothing was burned'; end if;
  secs := least(floor(p_burned * a.hours * 3600 / a.price), 366 * 86400)::int;
  banned := exists (select 1 from public.pokejam_ad_bans where wallet = a.wallet);
  if a.state <> 'pending' then
    -- Another burn for the same ad: its own run, as a new row.
    insert into public.pokejam_ads(code, wallet, text, theme, plan, hours, price, wants_start, extra_of)
    values (encode(extensions.gen_random_bytes(6), 'hex'), a.wallet, a.text, a.theme, a.plan, a.hours, a.price, now(), a.id)
    returning * into a;
  end if;
  if secs < 60 then
    update public.pokejam_ads set state = 'dust', burn_sig = p_sig, burned = p_burned, burner = p_burner, paid_at = now()
    where id = a.id returning * into a;
    return public.pokejam_ad_view(a);
  end if;
  want := greatest(a.wants_start, now());
  s := public.pokejam_ad_next_open(want, secs, a.wallet);
  update public.pokejam_ads set state = 'paid', burn_sig = p_sig, burned = p_burned, burner = p_burner, paid_at = now(),
    starts_at = s, ends_at = s + make_interval(secs => secs), moved = s > want + interval '1 minute'
  where id = a.id returning * into a;
  -- An extra burn for an ad whose text came down, or any burn from a banned wallet, doesn't put it back up.
  if banned or (a.extra_of is not null and exists (select 1 from public.pokejam_ads o where o.id = a.extra_of and o.state = 'removed')) then
    update public.pokejam_ads set state = 'removed', removed_at = now(), removed_left = secs,
      removed_reason = case when banned then 'wallet banned' else (select removed_reason from public.pokejam_ads where id = a.extra_of) end
    where id = a.id returning * into a;
  end if;
  return public.pokejam_ad_view(a);
end $$;

create or replace function public.pokejam_ad_get(p_id uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select public.pokejam_ad_view(a) from public.pokejam_ads a where a.id = p_id;
$$;

create or replace function public.pokejam_ad_by_code(p_code text)
returns jsonb language sql stable security definer set search_path = public as $$
  select public.pokejam_ad_view(a) from public.pokejam_ads a where a.code = p_code;
$$;

-- A wallet's ads from the last 60 days (and anything still to run), newest first.
create or replace function public.pokejam_ad_mine(p_wallet text)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(public.pokejam_ad_view(a) order by a.created_at desc), '[]')
  from (select * from public.pokejam_ads where wallet = p_wallet and (created_at > now() - interval '60 days' or ends_at > now())
        and not (state = 'pending' and created_at < now() - interval '1 day')
        order by created_at desc limit 50) a;
$$;

-- Unpaid bookings from the last day, for the sweeper's look through each wallet's history.
create or replace function public.pokejam_ad_unsettled(p_limit int)
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(public.pokejam_ad_view(a) order by a.created_at desc), '[]')
  from (select * from public.pokejam_ads where state = 'pending' and created_at > now() - interval '1 day'
        order by created_at desc limit greatest(1, least(p_limit, 50))) a;
$$;

-- ---------- moderation ----------

-- Take an ad down; its spot frees up. The advertiser keeps the time it had left, to replace the text with, unless
-- the wallet is banned (p_ban), which also takes down every other ad it has and refuses it from now on.
create or replace function public.pokejam_ad_remove(p_id uuid, p_reason text, p_ban boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare a public.pokejam_ads;
begin
  perform pg_advisory_xact_lock(hashtext('pokejam_ads'));
  select * into a from public.pokejam_ads where id = p_id;
  if not found or a.state <> 'paid' then raise exception 'no paid ad with that id'; end if;
  if p_ban then
    insert into public.pokejam_ad_bans(wallet, reason) values (a.wallet, left(coalesce(p_reason, ''), 500))
    on conflict (wallet) do update set reason = excluded.reason, at = now();
  end if;
  update public.pokejam_ads set state = 'removed', removed_at = now(), removed_reason = left(coalesce(p_reason, ''), 500),
    removed_left = greatest(0, extract(epoch from ends_at - greatest(now(), starts_at)))::int
  where state = 'paid' and ends_at > now() and (id = p_id or (p_ban and wallet = a.wallet));
  select * into a from public.pokejam_ads where id = p_id;
  return public.pokejam_ad_view(a);
end $$;

-- The advertiser's new text for a removed ad (the Edge Function checked their wallet's signature): it runs for the
-- time that was left, from the first opening.
create or replace function public.pokejam_ad_replace(p_id uuid, p_text text, p_theme text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  a public.pokejam_ads;
  n public.pokejam_ads;
  why text := public.pokejam_ad_verdict(p_text);
  s timestamptz;
begin
  perform pg_advisory_xact_lock(hashtext('pokejam_ads'));
  select * into a from public.pokejam_ads where id = p_id for update;
  if not found or a.state <> 'removed' then raise exception 'only an ad that was taken down can be replaced'; end if;
  if a.replaced_by is not null then raise exception 'this ad was already replaced'; end if;
  if exists (select 1 from public.pokejam_ad_bans where wallet = a.wallet) then raise exception 'this wallet is banned from advertising'; end if;
  if coalesce(a.removed_left, 0) < 60 then raise exception 'no time left to replace'; end if;
  if why is not null then raise exception 'ad text not allowed (%)', why; end if;
  if p_theme not in ('gold', 'fire', 'water', 'grass', 'electric', 'psychic', 'ghost', 'ice') then raise exception 'pick a colour'; end if;
  s := public.pokejam_ad_next_open(now(), a.removed_left, a.wallet);
  insert into public.pokejam_ads(code, wallet, text, theme, plan, hours, price, wants_start, state, starts_at, ends_at, moved, burned, paid_at, replaces)
  values (encode(extensions.gen_random_bytes(6), 'hex'), a.wallet, public.pokejam_ad_clean(p_text), p_theme, a.plan, a.hours, a.price, now(),
    'paid', s, s + make_interval(secs => a.removed_left), s > now() + interval '1 minute', 0, now(), a.id)
  returning * into n;
  update public.pokejam_ads set replaced_by = n.id where id = a.id;
  return public.pokejam_ad_view(n);
end $$;

-- A viewer flags an ad for moderators. Reports never take an ad down by themselves (that would let a crowd grief a
-- paid ad); they only put it at the top of the moderators' list. Returns how many different people have reported it
-- now, or 0 when this reporter already had.
create or replace function public.pokejam_ad_report(p_id uuid, p_reporter text, p_reason text)
returns int language plpgsql security definer set search_path = public as $$
begin
  if not exists (select 1 from public.pokejam_ads where id = p_id and state = 'paid') then raise exception 'no such ad on the board'; end if;
  insert into public.pokejam_ad_reports(ad_id, reporter, reason) values (p_id, p_reporter, p_reason) on conflict do nothing;
  if not found then return 0; end if;
  return (select count(*) from public.pokejam_ad_reports where ad_id = p_id);
end $$;

-- ---------- what the page and the game show ----------

-- The ads on the board now, when the next 14 days are booked, prices and totals.
create or replace function public.pokejam_ad_board()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'now', now(),
    'paused', public.pokejam_ad_cfg('ads_paused', 'false') = 'true',
    'spots', greatest(1, public.pokejam_ad_cfg('ad_spots', '3')::int),
    'prices', jsonb_build_object('hour', public.pokejam_ad_price('hour')::text, 'day', public.pokejam_ad_price('day')::text,
      'week', public.pokejam_ad_price('week')::text),
    'live', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'text', text, 'theme', theme, 'wallet', wallet,
        'starts_at', starts_at, 'ends_at', ends_at, 'burn_sig', burn_sig) order by starts_at, id)
      from public.pokejam_ads where state = 'paid' and starts_at <= now() and ends_at > now()), '[]'),
    'booked', coalesce((select jsonb_agg(jsonb_build_object('starts_at', starts_at, 'ends_at', ends_at) order by starts_at)
      from public.pokejam_ads where state = 'paid' and ends_at > now() and starts_at < now() + interval '14 days'), '[]'),
    'totals', (select jsonb_build_object('burned', coalesce(sum(burned), 0)::text, 'ads', count(*) filter (where extra_of is null),
        'advertisers', count(distinct wallet), 'hours', coalesce(round(sum(extract(epoch from ends_at - starts_at)) / 3600), 0))
      from public.pokejam_ads where burn_sig is not null)
  );
$$;

-- ---------- moderators (admin.html) ----------

-- Ads that ran, are running or will run in the last/next p_days, most reported first.
create or replace function public.pokejam_admin_ads(p_days int default 7)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.pokejam_require_admin();
  return coalesce((select jsonb_agg(x order by (x->>'reports')::int desc, x->>'starts_at' desc) from (
    select public.pokejam_ad_view(a) || jsonb_build_object(
      'reports', (select count(*) from public.pokejam_ad_reports r where r.ad_id = a.id),
      'reasons', (select jsonb_object_agg(q.reason, q.n) from (select reason, count(*) as n from public.pokejam_ad_reports r
                  where r.ad_id = a.id group by reason) q)) as x
    from public.pokejam_ads a
    where a.state in ('paid', 'removed') and a.ends_at > now() - make_interval(days => greatest(1, p_days))
      and a.starts_at < now() + make_interval(days => greatest(1, p_days))
  ) y), '[]');
end $$;

create or replace function public.pokejam_admin_ad_remove(p_id uuid, p_reason text, p_ban boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := public.pokejam_require_admin(); r jsonb;
begin
  r := public.pokejam_ad_remove(p_id, p_reason, p_ban);
  insert into public.pokejam_admin_log(admin, action, target, detail)
  values (me, case when p_ban then 'ad ban' else 'ad remove' end, p_id, format('%s: %s', r->>'text', left(coalesce(p_reason, ''), 200)));
  return r;
end $$;

create or replace function public.pokejam_admin_ad_bans()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.pokejam_require_admin();
  return coalesce((select jsonb_agg(jsonb_build_object('wallet', wallet, 'reason', reason, 'at', at) order by at desc) from public.pokejam_ad_bans), '[]');
end $$;

create or replace function public.pokejam_admin_ad_unban(p_wallet text)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := public.pokejam_require_admin();
begin
  delete from public.pokejam_ad_bans where wallet = p_wallet;
  insert into public.pokejam_admin_log(admin, action, detail) values (me, 'ad unban', p_wallet);
end $$;

-- ---------- the devnet faucet ----------

-- True (and recorded) when this wallet hasn't claimed in the last day.
create or replace function public.pokejam_ad_faucet_claim(p_wallet text)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  insert into public.pokejam_ad_faucet(wallet, last_at) values (p_wallet, now())
  on conflict (wallet) do update set last_at = now() where public.pokejam_ad_faucet.last_at < now() - interval '1 day';
  return found;
end $$;

-- Give a claim back when the faucet's transaction didn't land.
create or replace function public.pokejam_ad_faucet_undo(p_wallet text)
returns void language sql security definer set search_path = public as $$
  delete from public.pokejam_ad_faucet where wallet = p_wallet;
$$;

do $$
declare f text;
begin
  foreach f in array array[
    'pokejam_ad_cfg(text, text)', 'pokejam_ad_set_cfg(text, text)', 'pokejam_ad_hours(text)', 'pokejam_ad_price(text)',
    'pokejam_ad_allow(text, int, int)', 'pokejam_ad_clean(text)', 'pokejam_ad_verdict(text)',
    'pokejam_ad_peak(timestamptz, timestamptz)', 'pokejam_ad_next_open(timestamptz, int, text)', 'pokejam_ad_start(timestamptz)',
    'pokejam_ad_quote(text, timestamptz, text)', 'pokejam_ad_view(public.pokejam_ads)',
    'pokejam_ad_create(text, text, text, text, timestamptz, numeric, text)', 'pokejam_ad_pay(uuid, text, numeric, text)',
    'pokejam_ad_get(uuid)', 'pokejam_ad_by_code(text)', 'pokejam_ad_mine(text)', 'pokejam_ad_unsettled(int)',
    'pokejam_ad_remove(uuid, text, boolean)', 'pokejam_ad_replace(uuid, text, text)', 'pokejam_ad_report(uuid, text, text)',
    'pokejam_ad_board()', 'pokejam_ad_faucet_claim(text)', 'pokejam_ad_faucet_undo(text)'
  ] loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
  -- Moderators call these from admin.html with their own session; each checks pokejam_admins.
  foreach f in array array['pokejam_admin_ads(int)', 'pokejam_admin_ad_remove(uuid, text, boolean)', 'pokejam_admin_ad_bans()',
    'pokejam_admin_ad_unban(text)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
