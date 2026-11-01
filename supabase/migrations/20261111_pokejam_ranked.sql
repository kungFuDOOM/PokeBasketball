-- PokeJam Ranked, Season 1 core (docs/ranked-plan.md, PR 1): seasons, per-season ranked profiles, server-side point
-- maths, and ranked-aware report/leave. Shared gauntlet-legends project: pokejam_* only. Additive and safe to run again.
-- Nothing is dropped; the test-build Elo columns on pokejam_profiles stay in place, unused.
--
-- The point maths (pokejam_ranked_step & co) mirrors src/ranked/rank.ts exactly: same constants, same integer
-- arithmetic. Keep the two in sync; supabase/tests/ranked.test.ts compares them case by case.
--
-- Clients get SELECT only (their own rows); every write goes through SECURITY DEFINER functions.
-- Scores: pokejam_report_result keeps its (match, host_won) signature, so the final scores arrive through a separate
-- call, pokejam_ranked_report_score. A score counts only when both players reported the same one and it agrees with the
-- winner; otherwise the match is scored as a photo finish (m = 0), never with an unverified margin.

-- ---------- tables ----------
create table if not exists public.pokejam_seasons (
  id int generated always as identity primary key,
  number int not null unique,
  starts_at timestamptz not null default now(),
  length_weeks int not null default 6 check (length_weeks between 1 and 52),
  -- Set by pokejam_ranked_open_season (a default can't see other columns, and timestamptz + interval is not immutable).
  ends_at timestamptz not null,
  status text not null default 'active' check (status in ('active','closed')),
  constraint pokejam_seasons_span check (ends_at > starts_at)
);
create unique index if not exists pokejam_seasons_one_active on public.pokejam_seasons(status) where status = 'active';

create table if not exists public.pokejam_ranked_profiles (
  user_id uuid not null references public.pokejam_profiles(id) on delete cascade,
  season_id int not null references public.pokejam_seasons(id) on delete cascade,
  status text not null default 'placing' check (status in ('placing','ranked')),
  div_idx int not null default 0 check (div_idx between 0 and 24),
  points int not null default 0 check (points >= 0),
  seed_score int not null default 0 check (seed_score between 0 and 1400),
  placement_raw numeric not null default 0,
  placements_played int not null default 0 check (placements_played between 0 and 5),
  shield_charge int not null default 1 check (shield_charge in (0,1)),
  losses_since_shield int not null default 0 check (losses_since_shield between 0 and 3),
  wins int not null default 0,
  losses int not null default 0,
  streak int not null default 0,
  peak_idx int not null default 0,
  leaves_24h int not null default 0,
  leave_window_start timestamptz,
  cooldown_until timestamptz,
  leaver_flagged boolean not null default false,
  last_game_at timestamptz,
  final_score int,
  updated_at timestamptz not null default now(),
  primary key (user_id, season_id)
);
create index if not exists pokejam_ranked_profiles_board on public.pokejam_ranked_profiles(season_id, status, div_idx desc, points desc);

create table if not exists public.pokejam_ranked_season_results (
  user_id uuid not null references public.pokejam_profiles(id) on delete cascade,
  season_id int not null references public.pokejam_seasons(id) on delete cascade,
  peak_idx int not null,
  final_score int not null,
  wins int not null,
  losses int not null,
  primary key (user_id, season_id)
);

-- The final scores both players reported for a ranked match (see the header).
create table if not exists public.pokejam_ranked_scores (
  match_id uuid not null references public.pokejam_matches(id) on delete cascade,
  user_id uuid not null references public.pokejam_profiles(id) on delete cascade,
  host_score int not null check (host_score between 0 and 300),
  guest_score int not null check (guest_score between 0 and 300),
  created_at timestamptz not null default now(),
  primary key (match_id, user_id)
);

-- One row per scored match; the primary key makes scoring idempotent. Before/after are ladder scores.
create table if not exists public.pokejam_ranked_matches (
  match_id uuid primary key references public.pokejam_matches(id) on delete cascade,
  season_id int not null references public.pokejam_seasons(id),
  host_id uuid not null,
  guest_id uuid not null,
  winner uuid,
  reason text not null check (reason in ('score','forfeit','leave','void')),
  margin_share numeric,
  host_before int, host_after int, host_delta int, host_event text,
  guest_before int, guest_after int, guest_delta int, guest_event text,
  result jsonb not null,
  created_at timestamptz not null default now()
);

alter table public.pokejam_seasons enable row level security;
alter table public.pokejam_ranked_profiles enable row level security;
alter table public.pokejam_ranked_season_results enable row level security;
alter table public.pokejam_ranked_scores enable row level security;
alter table public.pokejam_ranked_matches enable row level security;

revoke all on public.pokejam_seasons, public.pokejam_ranked_profiles, public.pokejam_ranked_season_results,
  public.pokejam_ranked_scores, public.pokejam_ranked_matches from anon, authenticated, public;
grant select on public.pokejam_seasons, public.pokejam_ranked_profiles, public.pokejam_ranked_season_results,
  public.pokejam_ranked_matches to authenticated;

drop policy if exists "pokejam seasons readable" on public.pokejam_seasons;
create policy "pokejam seasons readable" on public.pokejam_seasons for select to authenticated using (true);
drop policy if exists "pokejam own ranked profile" on public.pokejam_ranked_profiles;
create policy "pokejam own ranked profile" on public.pokejam_ranked_profiles for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "pokejam own season results" on public.pokejam_ranked_season_results;
create policy "pokejam own season results" on public.pokejam_ranked_season_results for select to authenticated using (user_id = (select auth.uid()));
drop policy if exists "pokejam ranked match participants" on public.pokejam_ranked_matches;
create policy "pokejam ranked match participants" on public.pokejam_ranked_matches for select to authenticated
  using ((select auth.uid()) in (host_id, guest_id));

-- ---------- pure helpers (SQL port of src/ranked/rank.ts) ----------
-- round(n / d) half-up for positive integers.
create or replace function public.pokejam_ranked_rdiv(n int, d int)
returns int language sql immutable as $$ select ((2 * n + d) / (2 * d))::int $$;

-- Tier 0..6 (Bronze .. Pokémon Master; Zenith counts as Pokémon Master). Eclipse spans six divisions, div_idx 15..20.
create or replace function public.pokejam_ranked_tier_idx(p_div int)
returns int language sql immutable as $$ select case when p_div >= 21 then 6 when p_div >= 15 then 5 else p_div / 3 end $$;

create or replace function public.pokejam_ranked_tier_name(p_div int)
returns text language sql immutable as $$
  select case when p_div >= 24 then 'Zenith'
    else (array['Bronze','Silver','Gold','Platinum','Diamond','Eclipse','Pokémon Master'])[public.pokejam_ranked_tier_idx(p_div) + 1] end $$;

-- 3 (lowest) .. 1 (highest), Eclipse 6 .. 1; null for Zenith.
create or replace function public.pokejam_ranked_division(p_div int)
returns int language sql immutable as $$
  select case when p_div >= 24 then null when p_div >= 21 then 24 - p_div when p_div >= 15 then 21 - p_div
    else 3 - (p_div % 3) end $$;

create or replace function public.pokejam_ranked_ladder(p_div int, p_points int)
returns int language sql immutable as $$ select case when p_div >= 24 then 2400 + p_points else p_div * 100 + p_points end $$;

create or replace function public.pokejam_ranked_zenith_decay(p_points int, p_idle_days int)
returns int language sql immutable as $$
  select case when p_idle_days < 7 then p_points
    else greatest(least(p_points, 50), p_points - 25 * (p_idle_days / 7)) end $$;

create or replace function public.pokejam_ranked_seed(p_last_final int)
returns int language sql immutable as $$ select case when p_last_final is null then 0 else greatest(0, least(1400, p_last_final - 600)) end $$;

-- One result applied to a ladder position (the TS applyResult). p_mode: 'score' | 'leave' | 'stay'.
create or replace function public.pokejam_ranked_step(p_div int, p_pts int, p_charge int, p_lsh int, p_won boolean,
  p_diff int, p_total int, p_opp int, p_mode text, p_heavy boolean,
  out o_div int, out o_pts int, out o_charge int, out o_lsh int, out o_delta int, out o_event text)
language plpgsql immutable as $$
declare t int := public.pokejam_ranked_tier_idx(p_div);
        w int := (array[30,27,25,24,23,21,20])[t + 1];
        l int := (array[19,19,19,20,20,21,22])[t + 1];
        diff int := case when p_total is null or p_total <= 0 then 0 else p_diff end;
        total int := case when p_total is null or p_total <= 0 then 1 else p_total end;
        adj int := greatest(-3, least(3, p_opp - p_div));
        x int; cost int; had int := p_charge;
begin
  o_div := p_div; o_pts := p_pts; o_charge := p_charge; o_lsh := p_lsh; o_event := null;
  if p_won then
    if p_mode = 'stay' then o_delta := public.pokejam_ranked_rdiv(4 * w, 5);
    else
      x := case when 2 * diff >= total then public.pokejam_ranked_rdiv(3 * w, 2)
                else public.pokejam_ranked_rdiv(w * (4 * total + 7 * diff), 5 * total) end;
      o_delta := greatest(public.pokejam_ranked_rdiv(4 * w, 5), least(public.pokejam_ranked_rdiv(3 * w, 2), x + adj));
    end if;
    o_pts := p_pts + o_delta;
    if p_div < 24 and o_pts >= 100 then
      if p_div = 23 then o_div := 24; o_pts := 100; o_event := 'zenith';
      else o_div := p_div + 1; o_pts := o_pts - 100; o_event := 'promoted'; end if;
    end if;
    return;
  end if;
  if p_mode = 'leave' then cost := case when p_heavy then public.pokejam_ranked_rdiv(5 * l, 4) else l end;
  else
    x := case when 4 * diff >= total then l else public.pokejam_ranked_rdiv(l * (3 * total + 8 * diff), 5 * total) end;
    cost := greatest(public.pokejam_ranked_rdiv(3 * l, 5), least(l, x - adj));
  end if;
  o_delta := -cost;
  o_pts := p_pts - cost;
  if o_pts < 0 then
    if p_div = 0 then o_pts := 0;
    elsif p_div = 24 then o_div := 23; o_pts := 75; o_event := 'demoted';
    elsif p_mode <> 'leave' and p_div <= 8 and had = 1 then o_pts := 0; o_charge := 0; o_lsh := 0; o_event := 'shielded';
    else o_div := p_div - 1; o_pts := 75; o_event := 'demoted'; end if;
  end if;
  if had = 0 then
    o_lsh := o_lsh + 1;
    if o_lsh >= 3 then o_charge := 1; o_lsh := 0; end if;
  end if;
end $$;

-- Placement weight w_i (the TS placementWeight). p_kind: 'score' | 'leave' | 'stay'.
create or replace function public.pokejam_ranked_placement_weight(p_kind text, p_diff int, p_total int, p_opp_score int, p_seed int)
returns numeric language sql immutable as $$
  select case p_kind when 'leave' then 1::numeric when 'stay' then 0.6::numeric
    else (0.6 + 0.4 * least(1::numeric, 4::numeric * (case when coalesce(p_total, 0) <= 0 then 0 else p_diff end)
                                          / (case when coalesce(p_total, 0) <= 0 then 1 else p_total end)))
         * (1 + greatest(-0.2, least(0.2, (p_opp_score - p_seed)::numeric / 1000))) end $$;

create or replace function public.pokejam_ranked_placement_shift(p_raw numeric)
returns int language sql immutable as $$ select greatest(-100, least(100, floor(20 * p_raw + 0.5)))::int $$;

-- ---------- seasons ----------
-- Closes the active season (final scores archived) and opens the next one. Internal: no auth check.
create or replace function public.pokejam_ranked_open_season_internal(p_length_weeks int default 6)
returns public.pokejam_seasons language plpgsql security definer set search_path = public as $$
declare a public.pokejam_seasons; s public.pokejam_seasons; v_start timestamptz := now(); v_len int := coalesce(p_length_weeks, 6);
begin
  if v_len < 1 or v_len > 52 then raise exception 'bad season length'; end if;
  perform pg_advisory_xact_lock(hashtext('pokejam_ranked_season'));
  select * into a from public.pokejam_seasons where status = 'active' for update;
  if a.id is not null then
    update public.pokejam_ranked_profiles set final_score = case when status = 'ranked'
        then public.pokejam_ranked_ladder(div_idx, points) else seed_score end
      where season_id = a.id;
    insert into public.pokejam_ranked_season_results(user_id, season_id, peak_idx, final_score, wins, losses)
      select user_id, season_id, peak_idx, final_score, wins, losses from public.pokejam_ranked_profiles where season_id = a.id
      on conflict (user_id, season_id) do update set peak_idx = excluded.peak_idx, final_score = excluded.final_score,
        wins = excluded.wins, losses = excluded.losses;
    update public.pokejam_seasons set status = 'closed' where id = a.id;
    -- A season that ran out hands over at its end; one closed early (or long overdue) starts now.
    if a.ends_at <= now() and a.ends_at + v_len * interval '1 week' > now() then v_start := a.ends_at; end if;
  end if;
  insert into public.pokejam_seasons(number, starts_at, length_weeks, ends_at, status)
    values (coalesce((select max(number) from public.pokejam_seasons), 0) + 1, v_start, v_len, v_start + v_len * interval '1 week', 'active')
    returning * into s;
  return s;
end $$;

-- Admin: close the active season (if any) and open the next one. Season 1 is the first call.
create or replace function public.pokejam_ranked_open_season(p_length_weeks int default 6)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.pokejam_seasons;
begin
  perform public.pokejam_require_admin();
  s := public.pokejam_ranked_open_season_internal(p_length_weeks);
  return jsonb_build_object('id', s.id, 'number', s.number, 'starts_at', s.starts_at, 'ends_at', s.ends_at, 'length_weeks', s.length_weeks);
end $$;

-- The active season; opens Season 1 if there is none and rolls over (same length) once the season has ended.
create or replace function public.pokejam_ranked_season()
returns public.pokejam_seasons language plpgsql security definer set search_path = public as $$
declare s public.pokejam_seasons;
begin
  select * into s from public.pokejam_seasons where status = 'active';
  if s.id is null then return public.pokejam_ranked_open_season_internal(6); end if;
  if now() > s.ends_at then return public.pokejam_ranked_open_season_internal(s.length_weeks); end if;
  return s;
end $$;

-- ---------- profiles ----------
-- Last archived final score (most recent season) -> this season's seed; null for a new player.
create or replace function public.pokejam_ranked_last_final(p_user uuid)
returns int language sql stable security definer set search_path = public as $$
  select r.final_score from public.pokejam_ranked_season_results r join public.pokejam_seasons s on s.id = r.season_id
  where r.user_id = p_user order by s.number desc limit 1 $$;

-- The player's row for the season, created on first use (placing, seeded) and locked.
create or replace function public.pokejam_ranked_profile_lock(p_user uuid, p_season int)
returns public.pokejam_ranked_profiles language plpgsql security definer set search_path = public as $$
declare p public.pokejam_ranked_profiles; v_seed int;
begin
  v_seed := public.pokejam_ranked_seed(public.pokejam_ranked_last_final(p_user));
  insert into public.pokejam_ranked_profiles(user_id, season_id, seed_score, div_idx, points, peak_idx)
    values (p_user, p_season, v_seed, v_seed / 100, v_seed % 100, v_seed / 100)
    on conflict (user_id, season_id) do nothing;
  select * into p from public.pokejam_ranked_profiles where user_id = p_user and season_id = p_season for update;
  return p;
end $$;

-- Applies one finished result to one player (locked by the caller). p_mode: 'score' | 'leave' | 'stay'.
-- Returns {placing, event, placements_played, before, after, delta, div_idx, points}.
create or replace function public.pokejam_ranked_player_update(p_user uuid, p_season int, p_won boolean, p_mode text,
  p_diff int, p_total int, p_opp_idx int, p_opp_score int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p public.pokejam_ranked_profiles; st record; v_before int; v_after int; v_pts int; v_heavy boolean := false;
        v_leaves int; v_wstart timestamptz; v_cool int := 0; v_flag boolean; v_w numeric; v_raw numeric; v_played int;
        v_shift int; v_start int; v_event text := null; v_streak int; v_div int; v_new_points int;
begin
  select * into p from public.pokejam_ranked_profiles where user_id = p_user and season_id = p_season for update;
  v_leaves := p.leaves_24h; v_wstart := p.leave_window_start; v_flag := p.leaver_flagged;
  if p_mode = 'leave' then
    if v_wstart is null or now() - v_wstart > interval '24 hours' then v_leaves := 0; v_wstart := now(); end if;
    v_leaves := v_leaves + 1;
    v_heavy := v_leaves >= 3;
    v_cool := case when v_leaves >= 4 then 60 when v_leaves = 3 then 15 when v_leaves = 2 then 5 else 0 end;
    v_flag := v_flag or v_leaves >= 4;
  end if;
  v_streak := case when p_mode = 'stay' then p.streak when p_won then greatest(p.streak, 0) + 1 else least(p.streak, 0) - 1 end;

  if p.status = 'placing' then
    v_w := public.pokejam_ranked_placement_weight(p_mode, p_diff, p_total, p_opp_score, p.seed_score);
    v_raw := p.placement_raw + case when p_won then v_w else -v_w end;
    v_played := p.placements_played + 1;
    v_before := p.seed_score;
    if v_played >= 5 then
      v_shift := public.pokejam_ranked_placement_shift(v_raw);
      v_start := greatest(0, least(2299, p.seed_score + v_shift));
      update public.pokejam_ranked_profiles set status = 'ranked', placement_raw = v_raw, placements_played = v_played,
        div_idx = v_start / 100, points = v_start % 100, peak_idx = v_start / 100, shield_charge = 1, losses_since_shield = 0
        where user_id = p_user and season_id = p_season;
      v_event := 'placed'; v_after := v_start;
    else
      update public.pokejam_ranked_profiles set placement_raw = v_raw, placements_played = v_played
        where user_id = p_user and season_id = p_season;
      v_after := v_before;
    end if;
    update public.pokejam_ranked_profiles set wins = wins + (case when p_won then 1 else 0 end),
      losses = losses + (case when p_won then 0 else 1 end), streak = v_streak, leaves_24h = v_leaves,
      leave_window_start = v_wstart, leaver_flagged = v_flag,
      cooldown_until = case when v_cool > 0 then now() + make_interval(mins => v_cool) else cooldown_until end,
      last_game_at = now(), updated_at = now() where user_id = p_user and season_id = p_season;
    select * into p from public.pokejam_ranked_profiles where user_id = p_user and season_id = p_season;
    return jsonb_build_object('placing', true, 'event', v_event, 'placements_played', p.placements_played,
      'before', v_before, 'after', v_after, 'delta', case when v_event = 'placed' then v_shift else null end,
      'div_idx', p.div_idx, 'points', p.points);
  end if;

  v_pts := p.points;
  if p.div_idx = 24 and p.last_game_at is not null then
    v_pts := public.pokejam_ranked_zenith_decay(p.points, floor(extract(epoch from (now() - p.last_game_at)) / 86400)::int);
  end if;
  v_before := public.pokejam_ranked_ladder(p.div_idx, v_pts);
  select * into st from public.pokejam_ranked_step(p.div_idx, v_pts, p.shield_charge, p.losses_since_shield, p_won,
    p_diff, p_total, p_opp_idx, p_mode, v_heavy);
  v_after := public.pokejam_ranked_ladder(st.o_div, st.o_pts);
  update public.pokejam_ranked_profiles set div_idx = st.o_div, points = st.o_pts, shield_charge = st.o_charge,
    losses_since_shield = st.o_lsh, wins = wins + (case when p_won then 1 else 0 end),
    losses = losses + (case when p_won then 0 else 1 end), streak = v_streak, peak_idx = greatest(peak_idx, st.o_div),
    leaves_24h = v_leaves, leave_window_start = v_wstart, leaver_flagged = v_flag,
    cooldown_until = case when v_cool > 0 then now() + make_interval(mins => v_cool) else cooldown_until end,
    last_game_at = now(), updated_at = now() where user_id = p_user and season_id = p_season;
  return jsonb_build_object('placing', false, 'event', st.o_event, 'placements_played', 5, 'before', v_before,
    'after', v_after, 'delta', st.o_delta, 'div_idx', st.o_div, 'points', st.o_pts);
end $$;

-- Scores a match exactly once. p_reason 'score' (winner from the match row), 'leave' / 'forfeit' (p_leaver lost, the
-- other player won at the minimum gain), or a dodge (p_dodge: only the dodger is changed, the match has no winner).
-- Repeat calls return the stored result. Internal.
create or replace function public.pokejam_ranked_apply(p_match uuid, p_reason text default 'score',
  p_leaver uuid default null, p_dodge boolean default false)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.pokejam_matches; s public.pokejam_seasons; v_prev jsonb; hp public.pokejam_ranked_profiles; gp public.pokejam_ranked_profiles;
        a uuid; b uuid; v_winner uuid; v_wscore int; v_lscore int; v_diff int := 0; v_total int := 1; v_known boolean := false;
        hs int; gs int; hres jsonb; gres jsonb; h_opp_idx int; g_opp_idx int; h_opp int; g_opp int; v_res jsonb;
begin
  select * into m from public.pokejam_matches where id = p_match for update;
  if m.id is null or m.queue <> 'ranked' or m.guest is null then raise exception 'not a ranked match'; end if;
  select result into v_prev from public.pokejam_ranked_matches where match_id = p_match;
  if v_prev is not null then return v_prev; end if;
  if p_reason not in ('score','leave','forfeit') then raise exception 'bad reason'; end if;
  if p_reason <> 'score' and (p_leaver is null or p_leaver not in (m.host, m.guest)) then raise exception 'bad leaver'; end if;
  s := public.pokejam_ranked_season();
  -- lock both profiles in a fixed order
  a := least(m.host, m.guest); b := greatest(m.host, m.guest);
  perform public.pokejam_ranked_profile_lock(a, s.id);
  perform public.pokejam_ranked_profile_lock(b, s.id);
  select * into hp from public.pokejam_ranked_profiles where user_id = m.host and season_id = s.id;
  select * into gp from public.pokejam_ranked_profiles where user_id = m.guest and season_id = s.id;
  -- an opponent's division as the adj input and their ladder score for placement weights (their seed while placing)
  h_opp_idx := case when gp.status = 'placing' then least(23, gp.seed_score / 100) else gp.div_idx end;
  g_opp_idx := case when hp.status = 'placing' then least(23, hp.seed_score / 100) else hp.div_idx end;
  h_opp := case when gp.status = 'placing' then gp.seed_score else public.pokejam_ranked_ladder(gp.div_idx, gp.points) end;
  g_opp := case when hp.status = 'placing' then hp.seed_score else public.pokejam_ranked_ladder(hp.div_idx, hp.points) end;

  if p_reason = 'score' then
    v_winner := m.winner;
    if v_winner is null then raise exception 'match has no winner'; end if;
    select x.host_score, x.guest_score into hs, gs
      from public.pokejam_ranked_scores x join public.pokejam_ranked_scores y
        on y.match_id = x.match_id and y.user_id = m.guest and y.host_score = x.host_score and y.guest_score = x.guest_score
      where x.match_id = p_match and x.user_id = m.host;
    if hs is not null and hs <= 300 and gs <= 300 then
      v_wscore := case when v_winner = m.host then hs else gs end;
      v_lscore := case when v_winner = m.host then gs else hs end;
      if v_wscore > v_lscore then v_diff := v_wscore - v_lscore; v_total := v_wscore + v_lscore; v_known := true; end if;
    end if;
    hres := public.pokejam_ranked_player_update(m.host, s.id, v_winner = m.host, 'score', v_diff, v_total, h_opp_idx, h_opp);
    gres := public.pokejam_ranked_player_update(m.guest, s.id, v_winner = m.guest, 'score', v_diff, v_total, g_opp_idx, g_opp);
  else
    v_winner := case when p_dodge then null when p_leaver = m.host then m.guest else m.host end;
    if p_leaver = m.host then
      hres := public.pokejam_ranked_player_update(m.host, s.id, false, 'leave', 0, 1, h_opp_idx, h_opp);
      if not p_dodge then gres := public.pokejam_ranked_player_update(m.guest, s.id, true, 'stay', 0, 1, g_opp_idx, g_opp); end if;
    else
      gres := public.pokejam_ranked_player_update(m.guest, s.id, false, 'leave', 0, 1, g_opp_idx, g_opp);
      if not p_dodge then hres := public.pokejam_ranked_player_update(m.host, s.id, true, 'stay', 0, 1, h_opp_idx, h_opp); end if;
    end if;
  end if;

  v_res := jsonb_build_object('season', s.number, 'reason', p_reason, 'winner', v_winner, 'dodge', p_dodge,
    'host', hres, 'guest', gres);
  insert into public.pokejam_ranked_matches(match_id, season_id, host_id, guest_id, winner, reason, margin_share,
      host_before, host_after, host_delta, host_event, guest_before, guest_after, guest_delta, guest_event, result)
    values (p_match, s.id, m.host, m.guest, v_winner, case when p_reason = 'forfeit' then 'forfeit' else p_reason end,
      case when v_known then v_diff::numeric / v_total end,
      (hres->>'before')::int, (hres->>'after')::int, (hres->>'delta')::int, hres->>'event',
      (gres->>'before')::int, (gres->>'after')::int, (gres->>'delta')::int, gres->>'event', v_res)
    on conflict (match_id) do nothing;
  return v_res;
end $$;

-- What a player may see of their own result: numbers are withheld while placing (until the placement result).
create or replace function public.pokejam_ranked_player_view(p_res jsonb)
returns jsonb language sql immutable as $$
  select case when p_res is null then null
    when (p_res->>'placing')::boolean and coalesce(p_res->>'event', '') <> 'placed'
      then jsonb_build_object('placing', true, 'placements_played', p_res->'placements_played', 'event', null)
    else p_res end $$;

-- ---------- player RPCs ----------
-- My final score for a ranked match; counts once the opponent reported the same score. Call before pokejam_report_result.
create or replace function public.pokejam_ranked_report_score(p_match uuid, p_host_score int, p_guest_score int)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); m public.pokejam_matches;
begin
  if me is null then raise exception 'not signed in'; end if;
  if p_host_score is null or p_guest_score is null or p_host_score not between 0 and 300 or p_guest_score not between 0 and 300
     or p_host_score = p_guest_score then raise exception 'bad score'; end if;
  select * into m from public.pokejam_matches where id = p_match;
  if m.id is null or m.queue <> 'ranked' or me not in (m.host, m.guest) or m.guest is null then raise exception 'not in this match'; end if;
  if m.status = 'done' or m.status = 'void' then return; end if; -- too late to change anything
  insert into public.pokejam_ranked_scores(match_id, user_id, host_score, guest_score) values (p_match, me, p_host_score, p_guest_score)
    on conflict (match_id, user_id) do nothing;
end $$;

-- The stayer claims the win once the other player's game heartbeat has been silent for 45 s.
create or replace function public.pokejam_ranked_forfeit(p_match uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); m public.pokejam_matches; other uuid; other_alive timestamptz; res jsonb;
begin
  if me is null then raise exception 'not signed in'; end if;
  select * into m from public.pokejam_matches where id = p_match for update;
  if m.id is null or m.queue <> 'ranked' or me not in (m.host, m.guest) or m.guest is null then raise exception 'not in this match'; end if;
  if m.status = 'done' then return jsonb_build_object('status', 'done', 'winner', m.winner); end if;
  if m.status <> 'active' then return jsonb_build_object('status', m.status); end if;
  other := case when me = m.host then m.guest else m.host end;
  other_alive := case when me = m.host then m.guest_alive else m.host_alive end;
  if other_alive is null or other_alive > now() - interval '45 seconds' then return jsonb_build_object('status', 'active'); end if;
  update public.pokejam_matches set status = 'done', finished_at = now(), winner = me where id = m.id;
  res := public.pokejam_ranked_apply(m.id, 'forfeit', other, false);
  return jsonb_build_object('status', 'done', 'winner', me, 'rank', public.pokejam_ranked_player_view(
    case when me = m.host then res->'host' else res->'guest' end));
end $$;

-- Ranked board for a season: qualified players (placed, >= 10 games), best first. Closed seasons are frozen in time.
create or replace function public.pokejam_ranked_board(p_season int)
returns table (pos int, user_id uuid, div_idx int, points int, updated_at timestamptz)
language sql stable security definer set search_path = public as $$
  with s as (select id, least(now(), ends_at) as at from public.pokejam_seasons where id = p_season),
  e as (
    select p.user_id, p.div_idx, p.updated_at,
      case when p.div_idx = 24 and p.last_game_at is not null
        then public.pokejam_ranked_zenith_decay(p.points, floor(extract(epoch from (s.at - p.last_game_at)) / 86400)::int)
        else p.points end as points
    from public.pokejam_ranked_profiles p join s on s.id = p.season_id
    where p.status = 'ranked' and p.wins + p.losses >= 10)
  select (row_number() over (order by e.div_idx desc, e.points desc, e.updated_at asc, e.user_id))::int, e.user_id, e.div_idx, e.points, e.updated_at from e;
$$;

create or replace function public.pokejam_ranked_season_pick(p_season int)
returns public.pokejam_seasons language sql stable security definer set search_path = public as $$
  select * from public.pokejam_seasons
  where (p_season is not null and number = p_season) or (p_season is null and status = 'active')
  order by number desc limit 1 $$;

-- Top 100 by ladder score (Zenith players on top, by Zenith points). p_season is a season number (default: current).
create or replace function public.pokejam_ranked_leaderboard(p_season int default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s public.pokejam_seasons;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  s := public.pokejam_ranked_season_pick(p_season);
  if s.id is null then return jsonb_build_object('season', null, 'rows', '[]'::jsonb); end if;
  return jsonb_build_object('season', s.number, 'rows', coalesce((
    select jsonb_agg(jsonb_build_object('rank', b.pos, 'name', pr.trainer_name, 'tier', public.pokejam_ranked_tier_name(b.div_idx),
      'division', public.pokejam_ranked_division(b.div_idx), 'div_idx', b.div_idx, 'points', b.points, 'zenith', b.div_idx = 24,
      'me', b.user_id = auth.uid()) order by b.pos)
    from public.pokejam_ranked_board(s.id) b join public.pokejam_profiles pr on pr.id = b.user_id where b.pos <= 100), '[]'::jsonb));
end $$;

-- My numeric position: {season, position, total}; position is null while I'm not on the board (placing or < 10 games).
create or replace function public.pokejam_ranked_my_position(p_season int default null)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare s public.pokejam_seasons; v_pos int; v_total int;
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  s := public.pokejam_ranked_season_pick(p_season);
  if s.id is null then return jsonb_build_object('season', null, 'position', null, 'total', 0); end if;
  select count(*)::int into v_total from public.pokejam_ranked_board(s.id);
  select b.pos into v_pos from public.pokejam_ranked_board(s.id) b where b.user_id = auth.uid();
  return jsonb_build_object('season', s.number, 'position', v_pos, 'total', v_total);
end $$;

-- My rank for the current season (rolls the season over if it has ended). While placing: progress only, no numbers.
create or replace function public.pokejam_ranked_me()
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); s public.pokejam_seasons; p public.pokejam_ranked_profiles; v_pts int; v_last int;
        v_out jsonb;
begin
  if me is null then raise exception 'not signed in'; end if;
  s := public.pokejam_ranked_season();
  select * into p from public.pokejam_ranked_profiles where user_id = me and season_id = s.id;
  v_last := public.pokejam_ranked_last_final(me);
  v_out := jsonb_build_object('season', s.number, 'starts_at', s.starts_at, 'ends_at', s.ends_at,
    'days_left', greatest(0, ceil(extract(epoch from (s.ends_at - now())) / 86400)::int), 'last_final_score', v_last);
  if p.user_id is null then
    return v_out || jsonb_build_object('status', 'placing', 'placements_played', 0, 'placements_left', 5, 'shield_charge', 1,
      'cooldown_until', null);
  end if;
  v_out := v_out || jsonb_build_object('status', p.status, 'shield_charge', p.shield_charge,
    'shield_losses_left', case when p.shield_charge = 0 then 3 - p.losses_since_shield end,
    'cooldown_until', case when p.cooldown_until > now() then p.cooldown_until end, 'leaves_24h', p.leaves_24h);
  if p.status = 'placing' then
    return v_out || jsonb_build_object('placements_played', p.placements_played, 'placements_left', 5 - p.placements_played);
  end if;
  v_pts := p.points;
  if p.div_idx = 24 and p.last_game_at is not null then
    v_pts := public.pokejam_ranked_zenith_decay(p.points, floor(extract(epoch from (now() - p.last_game_at)) / 86400)::int);
  end if;
  return v_out || jsonb_build_object('placements_played', 5, 'placements_left', 0, 'div_idx', p.div_idx, 'points', v_pts,
    'tier', public.pokejam_ranked_tier_name(p.div_idx), 'division', public.pokejam_ranked_division(p.div_idx),
    'zenith', p.div_idx = 24, 'peak_idx', p.peak_idx, 'wins', p.wins, 'losses', p.losses,
    'shield_active', p.div_idx <= 8);
end $$;

-- ---------- report / leave ----------
-- As 20261021, except: for a Ranked match the result is scored by pokejam_ranked_apply (the Elo ladder is retired).
-- Social behaviour and the reconciliation rules (both must agree; host alone after 120 s) are unchanged.
create or replace function public.pokejam_report_result(p_match uuid, p_host_won boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); m public.pokejam_matches; final boolean; res jsonb;
begin
  select * into m from public.pokejam_matches where id = p_match for update;
  if m.id is null or me is null or me not in (m.host, m.guest) then raise exception 'not in this match'; end if;
  if m.status = 'done' then return jsonb_build_object('status','done','winner',m.winner); end if;
  if m.status <> 'active' or m.guest is null then raise exception 'match not active'; end if;
  if m.created_at < now() - interval '2 hours' then
    update public.pokejam_matches set status = 'void' where id = m.id; return jsonb_build_object('status','void');
  end if;
  if me = m.host then
    update public.pokejam_matches set host_report = p_host_won, host_reported_at = coalesce(host_reported_at, now()) where id = m.id returning * into m;
  else
    update public.pokejam_matches set guest_report = p_host_won where id = m.id returning * into m;
  end if;
  if m.host_report is not null and m.guest_report is not null then
    if m.host_report <> m.guest_report then
      update public.pokejam_matches set status = 'void', finished_at = now() where id = m.id;
      return jsonb_build_object('status','void','reason','reports disagree');
    end if;
    final := m.host_report;
  elsif m.host_report is not null and m.guest_report is null and me = m.host and m.host_reported_at < now() - interval '120 seconds' then
    final := m.host_report;
  else
    return jsonb_build_object('status','pending');
  end if;
  update public.pokejam_matches set status = 'done', finished_at = now(),
    winner = case when final then m.host else m.guest end where id = m.id;
  if m.queue = 'ranked' then
    res := public.pokejam_ranked_apply(m.id);
  end if;
  return jsonb_build_object('status','done','winner', case when final then m.host else m.guest end,
    'rank', public.pokejam_ranked_player_view(case when me = m.host then res->'host' else res->'guest' end));
end $$;

-- Social: unchanged (void the match). Ranked: a waiting match is voided; after tip-off (a game heartbeat exists) leaving
-- is a forfeit (max-cost loss for me, minimum-gain win for the stayer); before tip-off it is a dodge (max-cost loss for
-- me, nothing for the other player, match void). Leaving after I already reported my result is not a leave.
create or replace function public.pokejam_leave_match(p_match uuid)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); m public.pokejam_matches; v_reported boolean;
begin
  select * into m from public.pokejam_matches where id = p_match for update;
  if m.id is null or me is null or me not in (m.host, m.guest) or m.status not in ('waiting','active') then return; end if;
  if m.queue = 'social' then
    update public.pokejam_matches set status = 'void', finished_at = now() where id = m.id;
    return;
  end if;
  if m.guest is null then
    update public.pokejam_matches set status = 'void', finished_at = now() where id = m.id;
    return;
  end if;
  v_reported := case when me = m.host then m.host_report is not null else m.guest_report is not null end;
  if v_reported then return; end if;
  if m.host_alive is not null or m.guest_alive is not null then
    update public.pokejam_matches set status = 'done', finished_at = now(),
      winner = case when me = m.host then m.guest else m.host end where id = m.id;
    perform public.pokejam_ranked_apply(m.id, 'leave', me, false);
  else
    update public.pokejam_matches set status = 'void', finished_at = now() where id = m.id;
    perform public.pokejam_ranked_apply(m.id, 'leave', me, true);
  end if;
end $$;

-- As 20261106, but a Ranked match takes the heartbeat too (it is how a forfeit is told from a dodge).
create or replace function public.pokejam_match_alive(p_match uuid)
returns text language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); st text;
begin
  if me is null then raise exception 'not signed in'; end if;
  update public.pokejam_matches m set
    host_alive = case when me = m.host then now() else m.host_alive end,
    guest_alive = case when me = m.guest then now() else m.guest_alive end
  where m.id = p_match and m.queue in ('social','ranked') and m.status = 'active' and me in (m.host, m.guest)
    and coalesce(case when me = m.host then m.host_alive else m.guest_alive end, '-infinity') < now() - interval '10 seconds';
  select status into st from public.pokejam_matches where id = p_match and me in (host, guest);
  return st;
end $$;

-- ---------- privileges ----------
revoke all on function
  public.pokejam_ranked_rdiv(int,int), public.pokejam_ranked_tier_idx(int), public.pokejam_ranked_tier_name(int),
  public.pokejam_ranked_division(int), public.pokejam_ranked_ladder(int,int), public.pokejam_ranked_zenith_decay(int,int),
  public.pokejam_ranked_seed(int),
  public.pokejam_ranked_step(int,int,int,int,boolean,int,int,int,text,boolean),
  public.pokejam_ranked_placement_weight(text,int,int,int,int), public.pokejam_ranked_placement_shift(numeric),
  public.pokejam_ranked_open_season_internal(int), public.pokejam_ranked_open_season(int), public.pokejam_ranked_season(),
  public.pokejam_ranked_last_final(uuid), public.pokejam_ranked_profile_lock(uuid,int),
  public.pokejam_ranked_player_update(uuid,int,boolean,text,int,int,int,int),
  public.pokejam_ranked_apply(uuid,text,uuid,boolean), public.pokejam_ranked_player_view(jsonb),
  public.pokejam_ranked_report_score(uuid,int,int), public.pokejam_ranked_forfeit(uuid),
  public.pokejam_ranked_board(int), public.pokejam_ranked_season_pick(int), public.pokejam_ranked_leaderboard(int),
  public.pokejam_ranked_my_position(int), public.pokejam_ranked_me(),
  public.pokejam_report_result(uuid,boolean), public.pokejam_leave_match(uuid), public.pokejam_match_alive(uuid)
  from public, anon, authenticated;
grant execute on function
  public.pokejam_ranked_open_season(int), public.pokejam_ranked_report_score(uuid,int,int), public.pokejam_ranked_forfeit(uuid),
  public.pokejam_ranked_leaderboard(int), public.pokejam_ranked_my_position(int), public.pokejam_ranked_me(),
  public.pokejam_report_result(uuid,boolean), public.pokejam_leave_match(uuid), public.pokejam_match_alive(uuid)
  to authenticated;
