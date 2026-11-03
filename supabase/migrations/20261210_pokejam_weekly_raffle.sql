-- PokeJam weekly challenges and the free Pokémon card raffle (issue #104).
-- Shared gauntlet-legends project: pokejam_* only. Additive. Safe to run again. Nothing dropped.
-- NOT applied by the repo. The owner runs it by hand. No cron: a moderator draws the winner after the week ends.
-- NET_VERSION and the netcode are untouched. The Rank Shield weekly challenge (pokejam_weekly_*) is a different week
-- (Monday 00:00 UTC) and is not changed here.
--
-- Week: Monday 00:00 America/Los_Angeles through the next Monday 00:00.
-- Base entry: finish every challenge (offline games played, online games finished, one social action, one rank climb).
-- Bonus: 1 per 1,000,000 whole PJAM in the linked wallet at draw time, plus a grind of extra online games and wins.
-- Holder and grind bonus entries add together and then cap (default 5, so 6 total). Amounts live in pokejam_config key 'raffle'.
-- The draw seed is generated in this database. The edge function only supplies whole-token balances it read from Solana.
-- No payment, no shipping address, no prize is sent from here.

insert into public.pokejam_config(key, value) values ('raffle', jsonb_build_object(
  'offline_games', 3,
  'online_games', 3,
  'social', 1,
  'rank_steps', 1,
  'pjam_per_entry', 1000000,
  'pjam_mint', 'GQe9QiBBV4G6bRUCxx2JgKrzT7G7RD17FJquBWgVpump',
  'grind_online_per_entry', 10,
  'grind_wins_per_entry', 3,
  'bonus_cap', 5
)) on conflict (key) do nothing;

-- A played offline game or a share, for a signed-in account. Not the anonymous device log.
create table if not exists public.pokejam_raffle_events (
  id bigserial primary key,
  user_id uuid not null references public.pokejam_profiles(id) on delete cascade,
  kind text not null check (kind in ('offline', 'share')),
  mode text check (mode is null or mode in ('quick', 'franchise', 'season_draft')),
  created_at timestamptz not null default now()
);
create index if not exists pokejam_raffle_events_user on public.pokejam_raffle_events (user_id, created_at desc);

-- One drawing per week. The snapshot is the entry list the seed was applied to.
create table if not exists public.pokejam_raffle_draws (
  week_start date primary key,
  drawn_at timestamptz not null default now(),
  drawn_by uuid,
  seed bytea not null,
  total_entries int not null check (total_entries >= 0),
  winner_id uuid,
  snapshot jsonb not null
);

create index if not exists pokejam_matches_done_finished on public.pokejam_matches (finished_at) where status = 'done';

alter table public.pokejam_raffle_events enable row level security;
alter table public.pokejam_raffle_draws enable row level security;
revoke all on public.pokejam_raffle_events, public.pokejam_raffle_draws from anon, authenticated, public;
revoke all on sequence public.pokejam_raffle_events_id_seq from anon, authenticated, public;

-- ---------- config ----------
-- Digits only, then clamp. A bad value becomes the default. Mirrors src/raffle/entries.ts clampConfig.
create or replace function public.pokejam_raffle_cfg_value(p jsonb)
returns jsonb language plpgsql immutable as $$
declare j jsonb := coalesce(p, '{}'::jsonb); n int; per numeric; mint text; raw text;
begin
  if jsonb_typeof(j) is distinct from 'object' then j := '{}'::jsonb; end if;
  raw := j->>'offline_games';
  n := case when raw ~ '^[0-9]{1,9}$' then raw::int else null end;
  j := jsonb_set(j, '{offline_games}', to_jsonb(case when n is null or n < 1 or n > 100 then 3 else n end));
  raw := j->>'online_games';
  n := case when raw ~ '^[0-9]{1,9}$' then raw::int else null end;
  j := jsonb_set(j, '{online_games}', to_jsonb(case when n is null or n < 1 or n > 100 then 3 else n end));
  raw := j->>'social';
  n := case when raw ~ '^[0-9]{1,9}$' then raw::int else null end;
  j := jsonb_set(j, '{social}', to_jsonb(case when n is null or n < 1 or n > 20 then 1 else n end));
  raw := j->>'rank_steps';
  n := case when raw ~ '^[0-9]{1,9}$' then raw::int else null end;
  j := jsonb_set(j, '{rank_steps}', to_jsonb(case when n is null or n < 1 or n > 24 then 1 else n end));
  raw := j->>'pjam_per_entry';
  per := case when raw ~ '^[0-9]{1,16}$' then raw::numeric else null end;
  j := jsonb_set(j, '{pjam_per_entry}', to_jsonb(case when per is null or per < 1 or per > 1000000000000000 then 1000000 else per::bigint end));
  mint := j->>'pjam_mint';
  if mint is null or mint !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' then mint := 'GQe9QiBBV4G6bRUCxx2JgKrzT7G7RD17FJquBWgVpump'; end if;
  j := jsonb_set(j, '{pjam_mint}', to_jsonb(mint));
  raw := j->>'grind_online_per_entry';
  n := case when raw ~ '^[0-9]{1,9}$' then raw::int else null end;
  j := jsonb_set(j, '{grind_online_per_entry}', to_jsonb(case when n is null or n < 1 or n > 100 then 10 else n end));
  raw := j->>'grind_wins_per_entry';
  n := case when raw ~ '^[0-9]{1,9}$' then raw::int else null end;
  j := jsonb_set(j, '{grind_wins_per_entry}', to_jsonb(case when n is null or n < 1 or n > 100 then 3 else n end));
  raw := j->>'bonus_cap';
  n := case when raw ~ '^[0-9]{1,9}$' then raw::int else null end;
  j := jsonb_set(j, '{bonus_cap}', to_jsonb(case when n is null or n < 0 or n > 20 then 5 else n end));
  return jsonb_build_object(
    'offline_games', (j->>'offline_games')::int,
    'online_games', (j->>'online_games')::int,
    'social', (j->>'social')::int,
    'rank_steps', (j->>'rank_steps')::int,
    'pjam_per_entry', (j->>'pjam_per_entry')::bigint,
    'pjam_mint', j->>'pjam_mint',
    'grind_online_per_entry', (j->>'grind_online_per_entry')::int,
    'grind_wins_per_entry', (j->>'grind_wins_per_entry')::int,
    'bonus_cap', (j->>'bonus_cap')::int);
end $$;

create or replace function public.pokejam_raffle_cfg()
returns jsonb language sql stable security definer set search_path = public as $$
  select public.pokejam_raffle_cfg_value(coalesce((select value from public.pokejam_config where key = 'raffle'), '{}'::jsonb));
$$;

-- Monday 00:00 America/Los_Angeles of the week containing p_at. date_trunc('week') is Monday.
create or replace function public.pokejam_raffle_week_start(p_at timestamptz default now())
returns date language sql stable as $$
  select (date_trunc('week', p_at at time zone 'America/Los_Angeles'))::date
$$;

create or replace function public.pokejam_raffle_week_end(p_week date)
returns timestamptz language sql stable as $$
  select ((p_week + 7)::timestamp at time zone 'America/Los_Angeles')
$$;

-- Noon Pacific, so a date is judged inside its own civil day.
create or replace function public.pokejam_raffle_is_monday(p_week date)
returns boolean language sql stable as $$
  select p_week = public.pokejam_raffle_week_start((p_week::timestamp at time zone 'America/Los_Angeles') + interval '12 hours')
$$;

-- ---------- entry maths (mirrors src/raffle/entries.ts scoreRaffle) ----------
create or replace function public.pokejam_raffle_score(
  p_offline int, p_online int, p_wins int, p_social int, p_shares int, p_rank int, p_zenith boolean,
  p_whole bigint, p_cfg jsonb)
returns jsonb language plpgsql immutable as $$
declare c jsonb := public.pokejam_raffle_cfg_value(p_cfg);
  off int := (c->>'offline_games')::int; onl int := (c->>'online_games')::int;
  soc int := (c->>'social')::int; rnk int := (c->>'rank_steps')::int;
  per bigint := (c->>'pjam_per_entry')::bigint;
  g_games int := (c->>'grind_online_per_entry')::int; g_wins int := (c->>'grind_wins_per_entry')::int;
  cap int := (c->>'bonus_cap')::int;
  v_off int := greatest(coalesce(p_offline, 0), 0); v_on int := greatest(coalesce(p_online, 0), 0);
  v_wins int := greatest(coalesce(p_wins, 0), 0); v_social int := greatest(coalesce(p_social, 0), 0) + greatest(coalesce(p_shares, 0), 0);
  v_rank int := greatest(coalesce(p_rank, 0), 0); v_zenith boolean := coalesce(p_zenith, false);
  v_rank_done boolean; v_base boolean; v_grind int; v_holder int; v_bonus int; v_whole bigint := greatest(coalesce(p_whole, 0), 0);
begin
  v_rank_done := v_zenith or v_rank >= rnk;
  v_base := v_off >= off and v_on >= onl and v_social >= soc and v_rank_done;
  v_grind := least(greatest(0, v_on - onl) / g_games, v_wins / g_wins);
  v_holder := case when v_whole <= 0 or per <= 0 then 0 when v_whole / per > 2147483647 then 2147483647 else (v_whole / per)::int end;
  v_bonus := least(cap, v_grind + v_holder);
  return jsonb_build_object(
    'base', v_base, 'grind', v_grind, 'holder', v_holder, 'bonus', v_bonus,
    'total', case when v_base then 1 + v_bonus else 0 end,
    'social_have', v_social, 'rank_done', v_rank_done,
    'offline', jsonb_build_object('have', v_off, 'need', off, 'done', v_off >= off),
    'online', jsonb_build_object('have', v_on, 'need', onl, 'done', v_on >= onl),
    'social', jsonb_build_object('have', v_social, 'need', soc, 'done', v_social >= soc),
    'rank', jsonb_build_object('have', v_rank, 'need', rnk, 'done', v_rank_done, 'zenith', v_zenith));
end $$;

-- Unsigned first 8 bytes of the seed, modulo total. Mirrors raffleTicket in src/raffle/entries.ts.
create or replace function public.pokejam_raffle_ticket(p_seed bytea, p_total bigint)
returns bigint language sql immutable as $$
  select ((
      get_byte(p_seed, 0)::numeric * 72057594037927936
    + get_byte(p_seed, 1)::numeric * 281474976710656
    + get_byte(p_seed, 2)::numeric * 1099511627776
    + get_byte(p_seed, 3)::numeric * 4294967296
    + get_byte(p_seed, 4)::numeric * 16777216
    + get_byte(p_seed, 5)::numeric * 65536
    + get_byte(p_seed, 6)::numeric * 256
    + get_byte(p_seed, 7)::numeric
  ) % p_total::numeric)::bigint
$$;

-- ---------- one player's counts for a week, from rows the server already has ----------
create or replace function public.pokejam_raffle_counts_for(p_user uuid, p_week date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare a timestamptz := (p_week::timestamp at time zone 'America/Los_Angeles');
  b timestamptz := public.pokejam_raffle_week_end(p_week);
  v_off int; v_on int; v_wins int; v_social int; v_shares int; v_rank int; v_zenith boolean;
begin
  select count(*)::int into v_off from public.pokejam_raffle_events e
    where e.user_id = p_user and e.kind = 'offline' and e.created_at >= a and e.created_at < b;
  select count(*)::int,
         count(*) filter (where m.winner = p_user)::int,
         count(*) filter (where m.queue = 'social')::int
    into v_on, v_wins, v_social
    from public.pokejam_matches m
    where m.status = 'done' and m.finished_at >= a and m.finished_at < b and p_user in (m.host, m.guest);
  select count(*)::int into v_shares from public.pokejam_raffle_events e
    where e.user_id = p_user and e.kind = 'share' and e.created_at >= a and e.created_at < b;
  select count(*)::int into v_rank from (
    select 1 from public.pokejam_ranked_matches r
      where r.created_at >= a and r.created_at < b and r.host_id = p_user and r.host_event in ('promoted', 'zenith')
    union all
    select 1 from public.pokejam_ranked_matches r
      where r.created_at >= a and r.created_at < b and r.guest_id = p_user and r.guest_event in ('promoted', 'zenith')
  ) s;
  select exists (
    select 1 from public.pokejam_ranked_profiles p
    join public.pokejam_seasons s on s.id = p.season_id and s.status = 'active'
    where p.user_id = p_user and p.div_idx >= 24
  ) into v_zenith;
  return jsonb_build_object('offline', v_off, 'online', v_on, 'online_wins', v_wins,
    'social_matches', v_social, 'shares', v_shares, 'rank_steps', v_rank, 'zenith', v_zenith);
end $$;

create or replace function public.pokejam_raffle_signed_in()
returns uuid language plpgsql stable security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then return null; end if;
  if coalesce(auth.jwt() ->> 'is_anonymous', 'false') = 'true' then return null; end if;
  if not exists (select 1 from public.pokejam_profiles where id = me) then return null; end if;
  return me;
end $$;

-- One played offline game. The client does not send a count. Sim and watch are not offered this call.
create or replace function public.pokejam_raffle_note_offline(p_mode text)
returns boolean language plpgsql security definer set search_path = public as $$
declare me uuid := public.pokejam_raffle_signed_in(); n int;
begin
  if me is null then raise exception 'Sign in to count weekly challenges.'; end if;
  if coalesce(p_mode, '') not in ('quick', 'franchise', 'season_draft') then return false; end if;
  if exists (select 1 from public.pokejam_raffle_events
      where user_id = me and kind = 'offline' and created_at > now() - interval '60 seconds') then return false; end if;
  select count(*)::int into n from public.pokejam_raffle_events
    where user_id = me and kind = 'offline' and created_at > now() - interval '1 day';
  if n >= 40 then return false; end if;
  insert into public.pokejam_raffle_events(user_id, kind, mode) values (me, 'offline', p_mode);
  return true;
end $$;

-- One share action this week, up to the social goal. Playing a social match is counted from pokejam_matches instead.
create or replace function public.pokejam_raffle_note_share()
returns boolean language plpgsql security definer set search_path = public as $$
declare me uuid := public.pokejam_raffle_signed_in(); w date := public.pokejam_raffle_week_start();
  a timestamptz := (w::timestamp at time zone 'America/Los_Angeles'); b timestamptz := public.pokejam_raffle_week_end(w);
  goal int; n int;
begin
  if me is null then raise exception 'Sign in to count weekly challenges.'; end if;
  goal := (public.pokejam_raffle_cfg()->>'social')::int;
  select count(*)::int into n from public.pokejam_raffle_events
    where user_id = me and kind = 'share' and created_at >= a and created_at < b;
  if n >= goal then return false; end if;
  if exists (select 1 from public.pokejam_raffle_events
      where user_id = me and kind = 'share' and created_at > now() - interval '10 minutes') then return false; end if;
  insert into public.pokejam_raffle_events(user_id, kind) values (me, 'share');
  return true;
end $$;

create or replace function public.pokejam_raffle_me()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare me uuid := auth.uid(); w date := public.pokejam_raffle_week_start(); cfg jsonb := public.pokejam_raffle_cfg();
  counts jsonb; score jsonb; wallet text; last jsonb;
begin
  if me is null or coalesce(auth.jwt() ->> 'is_anonymous', 'false') = 'true'
     or not exists (select 1 from public.pokejam_profiles where id = me) then
    score := public.pokejam_raffle_score(0, 0, 0, 0, 0, 0, false, 0, cfg);
    return jsonb_build_object('signed_in', false, 'week_start', w, 'resets_at', public.pokejam_raffle_week_end(w),
      'config', cfg, 'counts', jsonb_build_object('offline', 0, 'online', 0, 'online_wins', 0, 'social_matches', 0, 'shares', 0, 'rank_steps', 0, 'zenith', false),
      'score', score, 'wallet', null, 'last_draw', null);
  end if;
  counts := public.pokejam_raffle_counts_for(me, w);
  score := public.pokejam_raffle_score(
    (counts->>'offline')::int, (counts->>'online')::int, (counts->>'online_wins')::int,
    (counts->>'social_matches')::int, (counts->>'shares')::int, (counts->>'rank_steps')::int,
    (counts->>'zenith')::boolean, 0, cfg);
  wallet := public.pokejam_linked_wallet(me);
  select jsonb_build_object('week_start', d.week_start, 'won', d.winner_id = me, 'entries', coalesce((
      select (e->>'entries')::int from jsonb_array_elements(d.snapshot->'entrants') e where e->>'user_id' = me::text limit 1), 0),
      'total', d.total_entries)
    into last
    from public.pokejam_raffle_draws d where d.week_start < w order by d.week_start desc limit 1;
  return jsonb_build_object('signed_in', true, 'week_start', w, 'resets_at', public.pokejam_raffle_week_end(w),
    'config', cfg, 'counts', counts, 'score', score, 'wallet', wallet, 'last_draw', last);
end $$;

-- Qualifiers for a closed or open week. p_balances maps user id to whole PJAM tokens (text digits). Missing means 0.
-- Guests (auth.users.is_anonymous) are left out. Ordered by user id, which is the draw order.
create or replace function public.pokejam_raffle_entrants(p_week date, p_balances jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare a timestamptz := (p_week::timestamp at time zone 'America/Los_Angeles');
  b timestamptz := public.pokejam_raffle_week_end(p_week);
  cfg jsonb := public.pokejam_raffle_cfg();
  out jsonb := '[]'::jsonb; r record; counts jsonb; score jsonb; raw text; whole bigint; nm text;
begin
  for r in
    select u.user_id from (
      select m.host as user_id from public.pokejam_matches m
        where m.status = 'done' and m.finished_at >= a and m.finished_at < b and m.host is not null
      union
      select m.guest from public.pokejam_matches m
        where m.status = 'done' and m.finished_at >= a and m.finished_at < b and m.guest is not null
      union
      select e.user_id from public.pokejam_raffle_events e where e.created_at >= a and e.created_at < b
      union
      select rm.host_id from public.pokejam_ranked_matches rm
        where rm.created_at >= a and rm.created_at < b and rm.host_event in ('promoted', 'zenith')
      union
      select rm.guest_id from public.pokejam_ranked_matches rm
        where rm.created_at >= a and rm.created_at < b and rm.guest_event in ('promoted', 'zenith')
    ) u
    where coalesce((select au.is_anonymous from auth.users au where au.id = u.user_id), false) = false
    order by u.user_id
  loop
    counts := public.pokejam_raffle_counts_for(r.user_id, p_week);
    raw := p_balances ->> r.user_id::text;
    whole := case when raw ~ '^[0-9]{1,16}$' then least(raw::bigint, 1000000000000000) else 0 end;
    score := public.pokejam_raffle_score(
      (counts->>'offline')::int, (counts->>'online')::int, (counts->>'online_wins')::int,
      (counts->>'social_matches')::int, (counts->>'shares')::int, (counts->>'rank_steps')::int,
      (counts->>'zenith')::boolean, whole, cfg);
    if coalesce((score->>'base')::boolean, false) then
      select coalesce(nullif(un.username, ''), pr.trainer_name, 'Trainer') into nm
        from public.pokejam_profiles pr
        left join public.pokejam_usernames un on un.user_id = pr.id
        where pr.id = r.user_id;
      out := out || jsonb_build_array(jsonb_build_object(
        'user_id', r.user_id, 'name', coalesce(nm, 'Trainer'),
        'wallet', public.pokejam_linked_wallet(r.user_id),
        'whole_tokens', whole::text,
        'offline', (counts->>'offline')::int, 'online', (counts->>'online')::int,
        'online_wins', (counts->>'online_wins')::int, 'social', (counts->>'social_matches')::int + (counts->>'shares')::int,
        'rank_steps', (counts->>'rank_steps')::int, 'zenith', (counts->>'zenith')::boolean,
        'grind', (score->>'grind')::int, 'holder', (score->>'holder')::int, 'entries', (score->>'total')::int));
    end if;
  end loop;
  return out;
end $$;

create or replace function public.pokejam_raffle_draw_json(p_week date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare d public.pokejam_raffle_draws; nm text;
begin
  select * into d from public.pokejam_raffle_draws where week_start = p_week;
  if d.week_start is null then return null; end if;
  select e->>'name' into nm from jsonb_array_elements(d.snapshot->'entrants') e where e->>'user_id' = d.winner_id::text limit 1;
  return jsonb_build_object('week_start', d.week_start, 'drawn_at', d.drawn_at, 'winner_id', d.winner_id,
    'winner_name', nm, 'total_entries', d.total_entries, 'seed', encode(d.seed, 'hex'),
    'ticket', d.snapshot->>'ticket', 'algorithm', d.snapshot->>'algorithm', 'snapshot', d.snapshot);
end $$;

-- What the edge function reads before it asks Solana for balances. Service role only.
create or replace function public.pokejam_raffle_draw_prep(p_week date)
returns jsonb language plpgsql security definer set search_path = public as $$
declare cfg jsonb := public.pokejam_raffle_cfg();
begin
  if p_week is null or not public.pokejam_raffle_is_monday(p_week) then
    return jsonb_build_object('ok', false, 'code', 'bad_week');
  end if;
  if public.pokejam_raffle_draw_json(p_week) is not null then
    return jsonb_build_object('ok', true, 'already', true, 'week_start', p_week, 'mint', cfg->>'pjam_mint',
      'draw', public.pokejam_raffle_draw_json(p_week));
  end if;
  if now() < public.pokejam_raffle_week_end(p_week) then
    return jsonb_build_object('ok', false, 'code', 'open', 'week_start', p_week, 'mint', cfg->>'pjam_mint');
  end if;
  return jsonb_build_object('ok', true, 'already', false, 'week_start', p_week, 'mint', cfg->>'pjam_mint',
    'qualifiers', coalesce((
      select jsonb_agg(jsonb_build_object('user_id', e->>'user_id', 'wallet', e->>'wallet') order by e->>'user_id')
      from jsonb_array_elements(public.pokejam_raffle_entrants(p_week, '{}'::jsonb)) e), '[]'::jsonb));
end $$;

-- Records the draw. p_balances is whole tokens per user id, read by the edge function. The seed is made here unless a
-- test passes p_seed (32 bytes). The edge function does not pass a seed, so it cannot choose the winner.
create or replace function public.pokejam_raffle_commit_draw(p_week date, p_balances jsonb, p_admin uuid default null, p_seed bytea default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare cfg jsonb := public.pokejam_raffle_cfg(); entrants jsonb; v_seed bytea; v_total int := 0; v_ticket bigint;
  v_acc int := 0; v_winner uuid; i int; n int; snap jsonb; existing jsonb;
begin
  perform pg_advisory_xact_lock(hashtext('pokejam-raffle'), hashtext(p_week::text));
  if p_week is null or not public.pokejam_raffle_is_monday(p_week) then
    return jsonb_build_object('ok', false, 'code', 'bad_week');
  end if;
  existing := public.pokejam_raffle_draw_json(p_week);
  if existing is not null then return jsonb_build_object('ok', true, 'already', true, 'draw', existing); end if;
  if now() < public.pokejam_raffle_week_end(p_week) then
    return jsonb_build_object('ok', false, 'code', 'open', 'week_start', p_week);
  end if;
  if p_seed is null then v_seed := extensions.gen_random_bytes(32);
  elsif octet_length(p_seed) <> 32 then return jsonb_build_object('ok', false, 'code', 'bad_seed');
  else v_seed := p_seed; end if;
  entrants := public.pokejam_raffle_entrants(p_week, coalesce(p_balances, '{}'::jsonb));
  n := coalesce(jsonb_array_length(entrants), 0);
  for i in 0 .. n - 1 loop
    v_total := v_total + coalesce((entrants->i->>'entries')::int, 0);
  end loop;
  if v_total > 0 then
    v_ticket := public.pokejam_raffle_ticket(v_seed, v_total::bigint);
    for i in 0 .. n - 1 loop
      v_acc := v_acc + coalesce((entrants->i->>'entries')::int, 0);
      if v_ticket < v_acc then v_winner := (entrants->i->>'user_id')::uuid; exit; end if;
    end loop;
  end if;
  snap := jsonb_build_object('algorithm', 'uint64be-mod-v1', 'config', cfg, 'ticket', v_ticket, 'total_entries', v_total, 'entrants', entrants);
  insert into public.pokejam_raffle_draws(week_start, drawn_by, seed, total_entries, winner_id, snapshot)
    values (p_week, p_admin, v_seed, v_total, v_winner, snap);
  if p_admin is not null and exists (select 1 from auth.users where id = p_admin) then
    insert into public.pokejam_admin_log(admin, action, target, detail)
      values (p_admin, 'raffle-draw', v_winner, p_week::text || ' total ' || v_total::text);
  end if;
  return jsonb_build_object('ok', true, 'already', false, 'draw', public.pokejam_raffle_draw_json(p_week));
end $$;

create or replace function public.pokejam_admin_raffle(p_which text default 'current')
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare w date; which text := case when p_which = 'previous' then 'previous' else 'current' end;
begin
  perform public.pokejam_require_admin();
  w := public.pokejam_raffle_week_start(case when which = 'previous' then now() - interval '7 days' else now() end);
  return jsonb_build_object('which', which, 'week_start', w, 'resets_at', public.pokejam_raffle_week_end(w),
    'open', now() < public.pokejam_raffle_week_end(w), 'config', public.pokejam_raffle_cfg(),
    'entrants', public.pokejam_raffle_entrants(w, '{}'::jsonb), 'draw', public.pokejam_raffle_draw_json(w));
end $$;

revoke all on function public.pokejam_raffle_cfg_value(jsonb), public.pokejam_raffle_cfg(),
  public.pokejam_raffle_week_start(timestamptz), public.pokejam_raffle_week_end(date), public.pokejam_raffle_is_monday(date),
  public.pokejam_raffle_score(int, int, int, int, int, int, boolean, bigint, jsonb),
  public.pokejam_raffle_ticket(bytea, bigint), public.pokejam_raffle_counts_for(uuid, date), public.pokejam_raffle_signed_in(),
  public.pokejam_raffle_note_offline(text), public.pokejam_raffle_note_share(), public.pokejam_raffle_me(),
  public.pokejam_raffle_entrants(date, jsonb), public.pokejam_raffle_draw_json(date), public.pokejam_raffle_draw_prep(date),
  public.pokejam_raffle_commit_draw(date, jsonb, uuid, bytea), public.pokejam_admin_raffle(text)
  from public, anon, authenticated;

grant execute on function public.pokejam_raffle_note_offline(text), public.pokejam_raffle_note_share(), public.pokejam_raffle_me() to authenticated;
grant execute on function public.pokejam_admin_raffle(text) to authenticated;
grant execute on function public.pokejam_raffle_draw_prep(date), public.pokejam_raffle_commit_draw(date, jsonb, uuid, bytea) to service_role;
