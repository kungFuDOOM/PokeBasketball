-- Ranked quit bans. Additive. Shared gauntlet-legends project: pokejam_* only.
-- Replaces the rolling 5/15/60-minute cooldown with a persistent offence count. The max-cost
-- leaver loss (leaves_24h, heavy from the 3rd leave in 24 h) and the stayer's win are unchanged.
--
-- Ladder, counted on the leaver only, for a dodge or a forfeit (an explicit leave, a silence
-- forfeit, or the judge deciding they left). A void (both silent, or a failed connection) and
-- the player who stayed are not offences. A cheat forfeit (pokejam.cheat_forfeit = '1') is not
-- a quit. 1st offence: warning, no ban. 2nd: 15 minutes. 3rd: 1 day. 4th: 7 days. 5th and every
-- later offence: 14 days.
--
-- Decay: one offence is forgiven for every 14 days since the last offence with no new one.
-- Applied lazily (no cron) when the row is read or the next offence is recorded. A ban already
-- running is not shortened. The count is per player, not per season, and is not reset every 24 h.
--
-- pokejam_ranked_find refuses a ban with the existing 'ranked cooldown: N seconds left' error.
-- The client is not trusted. ban_until is mirrored onto the active season profile; the source
-- of truth is pokejam_ranked_quits so a season rollover cannot drop the ban.

alter table public.pokejam_ranked_profiles add column if not exists ban_until timestamptz;

create table if not exists public.pokejam_ranked_quits (
  user_id uuid primary key references public.pokejam_profiles(id) on delete cascade,
  offences int not null default 0 check (offences >= 0),
  last_offence_at timestamptz,
  ban_until timestamptz,
  updated_at timestamptz not null default now()
);
alter table public.pokejam_ranked_quits enable row level security;
revoke all on public.pokejam_ranked_quits from anon, authenticated, public;

-- Offences still on the record after forgiving one per full 14 days since the last offence.
create or replace function public.pokejam_ranked_quit_effective(p_offences int, p_last timestamptz, p_now timestamptz)
returns int language sql immutable as $$
  select greatest(0, coalesce(p_offences, 0) - case
    when p_last is null or coalesce(p_offences, 0) <= 0 or p_now is null then 0
    else greatest(0, floor(extract(epoch from (p_now - p_last)) / 1209600)::int) end) $$;

-- Ban length for an offence count that already includes the offence just recorded. 0 = warning.
create or replace function public.pokejam_ranked_quit_ban_for(p_offences int)
returns interval language sql immutable as $$
  select case when p_offences <= 1 then interval '0'
    when p_offences = 2 then interval '15 minutes'
    when p_offences = 3 then interval '1 day'
    when p_offences = 4 then interval '7 days'
    else interval '14 days' end $$;

-- Writes the decay. Does not clear a ban that is still running.
create or replace function public.pokejam_ranked_quit_decay(p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare q public.pokejam_ranked_quits; v_off int; v_periods int;
begin
  select * into q from public.pokejam_ranked_quits where user_id = p_user for update;
  if q.user_id is null or q.last_offence_at is null or q.offences <= 0 then return; end if;
  v_off := public.pokejam_ranked_quit_effective(q.offences, q.last_offence_at, now());
  if v_off >= q.offences then return; end if;
  v_periods := q.offences - v_off;
  update public.pokejam_ranked_quits set offences = v_off, updated_at = now(),
    last_offence_at = case when v_off = 0 then null else q.last_offence_at + make_interval(days => 14 * v_periods) end
    where user_id = p_user;
end $$;

-- Records one quit offence and sets the ban. Internal. Returns {offences, ban_until}.
create or replace function public.pokejam_ranked_quit_strike(p_user uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_off int; v_until timestamptz;
begin
  insert into public.pokejam_ranked_quits(user_id) values (p_user) on conflict (user_id) do nothing;
  perform public.pokejam_ranked_quit_decay(p_user);
  update public.pokejam_ranked_quits set offences = offences + 1, last_offence_at = now(), updated_at = now()
    where user_id = p_user returning offences into v_off;
  v_until := case when public.pokejam_ranked_quit_ban_for(v_off) > interval '0'
    then now() + public.pokejam_ranked_quit_ban_for(v_off) else null end;
  update public.pokejam_ranked_quits set ban_until = v_until, updated_at = now() where user_id = p_user;
  update public.pokejam_ranked_profiles set ban_until = v_until, cooldown_until = v_until, updated_at = now()
    where user_id = p_user and season_id = (select id from public.pokejam_seasons where status = 'active');
  return jsonb_build_object('offences', v_off, 'ban_until', v_until);
end $$;

-- When matchmaking must refuse this player. The later of the quit ban and any cooldown still on the profile.
create or replace function public.pokejam_ranked_ban_until(p_user uuid)
returns timestamptz language sql stable security definer set search_path = public as $$
  select max(t) from (
    select q.ban_until as t from public.pokejam_ranked_quits q where q.user_id = p_user and q.ban_until > now()
    union all
    select pr.ban_until from public.pokejam_ranked_profiles pr
      join public.pokejam_seasons s on s.id = pr.season_id and s.status = 'active'
      where pr.user_id = p_user and pr.ban_until > now()
    union all
    select pr.cooldown_until from public.pokejam_ranked_profiles pr
      join public.pokejam_seasons s on s.id = pr.season_id and s.status = 'active'
      where pr.user_id = p_user and pr.cooldown_until > now()
  ) u $$;

-- What pokejam_ranked_me tells the client, after decay. cooldown_until and ban_until are the same instant:
-- when Ranked matchmaking opens again, or null.
create or replace function public.pokejam_ranked_quit_public(p_user uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare q public.pokejam_ranked_quits; v_block timestamptz;
begin
  perform public.pokejam_ranked_quit_decay(p_user);
  select * into q from public.pokejam_ranked_quits where user_id = p_user;
  v_block := public.pokejam_ranked_ban_until(p_user);
  return jsonb_build_object(
    'quit_offences', public.pokejam_ranked_quit_effective(q.offences, q.last_offence_at, now()),
    'ban_until', v_block, 'cooldown_until', v_block, 'quit_at', q.last_offence_at,
    'quit_recent', q.last_offence_at is not null and q.last_offence_at > now() - interval '5 minutes');
end $$;

-- As 20261117. A real leave records a quit offence instead of the 5/15/60-minute cooldown.
-- leaves_24h, leaver_flagged and the heavy (max-cost) loss are unchanged.
create or replace function public.pokejam_ranked_player_update(p_user uuid, p_season int, p_won boolean, p_mode text,
  p_diff int, p_total int, p_opp_idx int, p_opp_score int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare p public.pokejam_ranked_profiles; st record; v_before int; v_after int; v_pts int; v_heavy boolean := false;
        v_leaves int; v_wstart timestamptz; v_flag boolean; v_w numeric; v_raw numeric; v_played int;
        v_shift int; v_start int; v_event text := null; v_streak int;
        o_div int; o_pts int; o_charge int; o_lsh int; o_delta int; o_event text;
        v_match uuid := nullif(current_setting('pokejam.shield_match', true), '')::uuid;
        v_armed boolean := false; v_used boolean := false; v_saved int := 0; v_res jsonb;
        v_struck boolean := false; v_ban_until timestamptz; v_quit jsonb := '{}'::jsonb;
begin
  select * into p from public.pokejam_ranked_profiles where user_id = p_user and season_id = p_season for update;
  v_leaves := p.leaves_24h; v_wstart := p.leave_window_start; v_flag := p.leaver_flagged;
  if p_mode = 'leave' then
    if v_wstart is null or now() - v_wstart > interval '24 hours' then v_leaves := 0; v_wstart := now(); end if;
    v_leaves := v_leaves + 1;
    v_heavy := v_leaves >= 3;
    v_flag := v_flag or v_leaves >= 4;
    if current_setting('pokejam.cheat_forfeit', true) is distinct from '1' then
      v_struck := true;
      v_quit := public.pokejam_ranked_quit_strike(p_user);
      v_ban_until := (v_quit->>'ban_until')::timestamptz;
    end if;
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
      cooldown_until = case when v_struck then v_ban_until else cooldown_until end,
      ban_until = case when v_struck then v_ban_until else ban_until end,
      last_game_at = now(), updated_at = now() where user_id = p_user and season_id = p_season;
    select * into p from public.pokejam_ranked_profiles where user_id = p_user and season_id = p_season;
    return jsonb_build_object('placing', true, 'event', v_event, 'placements_played', p.placements_played,
      'before', v_before, 'after', v_after, 'delta', case when v_event = 'placed' then v_shift else null end,
      'div_idx', p.div_idx, 'points', p.points) || v_quit;
  end if;

  v_pts := p.points;
  if p.div_idx = 24 and p.last_game_at is not null then
    v_pts := public.pokejam_ranked_zenith_decay(p.points, floor(extract(epoch from (now() - p.last_game_at)) / 86400)::int);
  end if;
  v_before := public.pokejam_ranked_ladder(p.div_idx, v_pts);
  select * into st from public.pokejam_ranked_step(p.div_idx, v_pts, p.shield_charge, p.losses_since_shield, p_won,
    p_diff, p_total, p_opp_idx, p_mode, v_heavy);
  o_div := st.o_div; o_pts := st.o_pts; o_charge := st.o_charge; o_lsh := st.o_lsh; o_delta := st.o_delta; o_event := st.o_event;
  if v_match is not null then
    v_armed := exists (select 1 from public.pokejam_shield_armed a join public.pokejam_matches mm on mm.id = v_match
                       where a.user_id = p_user and a.armed_at <= mm.created_at);
  end if;
  if v_armed and p_mode = 'score' and not p_won and p.div_idx < 24 and o_event is distinct from 'shielded' then
    v_saved := v_before - public.pokejam_ranked_ladder(o_div, o_pts);
    if v_saved > 0 and public.pokejam_shield_consume(p_user, v_match, v_saved) then
      v_used := true;
      o_div := p.div_idx; o_pts := v_pts; o_charge := p.shield_charge; o_lsh := p.losses_since_shield; o_delta := 0; o_event := null;
    else
      v_saved := 0;
    end if;
  end if;
  v_after := public.pokejam_ranked_ladder(o_div, o_pts);
  update public.pokejam_ranked_profiles set div_idx = o_div, points = o_pts, shield_charge = o_charge,
    losses_since_shield = o_lsh, wins = wins + (case when p_won then 1 else 0 end),
    losses = losses + (case when p_won then 0 else 1 end), streak = v_streak, peak_idx = greatest(peak_idx, o_div),
    leaves_24h = v_leaves, leave_window_start = v_wstart, leaver_flagged = v_flag,
    cooldown_until = case when v_struck then v_ban_until else cooldown_until end,
    ban_until = case when v_struck then v_ban_until else ban_until end,
    last_game_at = now(), updated_at = now() where user_id = p_user and season_id = p_season;
  v_res := jsonb_build_object('placing', false, 'event', o_event, 'placements_played', 5, 'before', v_before,
    'after', v_after, 'delta', o_delta, 'div_idx', o_div, 'points', o_pts) || v_quit;
  if v_armed then
    v_res := v_res || jsonb_build_object('shield', jsonb_build_object('armed', true, 'used', v_used, 'saved', v_saved));
  end if;
  return v_res;
end $$;

-- As 20261201. A cheat forfeit ('forfeit') is not a quit offence. A leave still is.
create or replace function public.pokejam_judge_lose(m public.pokejam_matches, p_loser uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.pokejam_matches set status = 'done', finished_at = now(),
    winner = case when p_loser = m.host then m.guest else m.host end where id = m.id;
  if p_reason = 'forfeit' then perform set_config('pokejam.cheat_forfeit', '1', true); end if;
  perform public.pokejam_ranked_apply(m.id, p_reason, p_loser, false);
  if p_reason = 'forfeit' then perform set_config('pokejam.cheat_forfeit', '', true); end if;
end $$;

-- As 20261201. A quit ban (or a cooldown still on the profile) cannot enter the Ranked queue,
-- and cannot be paired from a row left in the queue. Same error text as the old cooldown.
create or replace function public.pokejam_ranked_find(me uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare sn public.pokejam_seasons; p public.pokejam_ranked_profiles; q public.pokejam_queue; other public.pokejam_queue;
        mid uuid; r record; score int; win int; last_opp uuid; flip boolean; v_until timestamptz;
begin
  perform public.pokejam_ranked_require_member();
  if not exists (select 1 from public.pokejam_usernames u where u.user_id = me and u.username is not null) then
    raise exception 'username:required';
  end if;
  sn := public.pokejam_ranked_season();
  for r in select m.id from public.pokejam_matches m
      where m.queue = 'ranked' and m.status = 'active' and m.guest is not null and me in (m.host, m.guest)
        and m.created_at > now() - interval '2 hours'
        and (case when me = m.host then m.host_alive else m.guest_alive end) < now() - interval '10 seconds' loop
    perform public.pokejam_leave_match(r.id);
  end loop;
  select m.id into mid from public.pokejam_matches m
    where m.status = 'active' and me in (m.host, m.guest) and m.queue = 'ranked'
      and m.created_at > now() - interval '2 minutes' and m.room_code is null
      and (case when me = m.host then m.host_alive else m.guest_alive end) is null
    order by m.created_at desc limit 1;
  if mid is not null then delete from public.pokejam_queue where user_id = me; return mid; end if;
  select * into p from public.pokejam_ranked_profiles where user_id = me and season_id = sn.id;
  perform public.pokejam_ranked_quit_decay(me);
  v_until := public.pokejam_ranked_ban_until(me);
  if v_until is not null then
    raise exception 'ranked cooldown: % seconds left', ceil(extract(epoch from v_until - now()))::int;
  end if;
  score := case when p.user_id is null then public.pokejam_ranked_seed(public.pokejam_ranked_last_final(me))
    when p.status = 'placing' then p.seed_score
    else public.pokejam_ranked_ladder(p.div_idx, case when p.div_idx = 24 and p.last_game_at is not null
      then public.pokejam_ranked_zenith_decay(p.points, floor(extract(epoch from (now() - p.last_game_at)) / 86400)::int) else p.points end) end;
  insert into public.pokejam_queue(user_id, queue, mmr, last_seen) values (me, 'ranked', score, now())
    on conflict (user_id) do update set queue = excluded.queue, mmr = excluded.mmr, last_seen = now(),
      joined_at = case when pokejam_queue.queue = excluded.queue then pokejam_queue.joined_at else now() end
    returning * into q;
  win := public.pokejam_ranked_window(extract(epoch from now() - q.joined_at)::int);
  select case when x.host = me then x.guest else x.host end into last_opp from public.pokejam_matches x
    where x.queue = 'ranked' and x.guest is not null and x.status in ('active','judging','done') and me in (x.host, x.guest)
      and x.created_at > now() - interval '1 hour'
    order by x.created_at desc limit 1;
  select * into other from public.pokejam_queue o
    where o.queue = 'ranked' and o.user_id <> me and o.last_seen > now() - interval '15 seconds'
      and abs(o.mmr - score) <= win and public.pokejam_ranked_pair_ok(score, o.mmr)
      and not public.pokejam_blocked_pair(me, o.user_id) and not public.pokejam_banned(o.user_id)
      and o.user_id is distinct from last_opp
      and public.pokejam_ranked_ban_until(o.user_id) is null
      and (select count(*) from public.pokejam_matches x where x.queue = 'ranked' and x.guest is not null
             and x.status in ('active','judging','done') and x.created_at > now() - interval '24 hours'
             and ((x.host = me and x.guest = o.user_id) or (x.host = o.user_id and x.guest = me))) < 3
    order by abs(o.mmr - score), o.joined_at limit 1 for update skip locked;
  if other.user_id is null then return null; end if;
  flip := random() < 0.5;
  insert into public.pokejam_matches(queue, host, guest, host_mmr, guest_mmr, seed, quarter_len)
    values ('ranked',
      case when flip then other.user_id else me end,
      case when flip then me else other.user_id end,
      case when flip then other.mmr else score end,
      case when flip then score else other.mmr end,
      public.pokejam_new_seed(), 120) returning id into mid;
  delete from public.pokejam_queue where user_id in (me, other.user_id);
  return mid;
end $$;

-- As 20261117, plus the quit fields (quit_offences, ban_until, quit_at, quit_recent). cooldown_until is that ban.
create or replace function public.pokejam_ranked_me()
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); s public.pokejam_seasons; p public.pokejam_ranked_profiles; v_pts int; v_last int;
        v_out jsonb; v_sh jsonb; v_quit jsonb;
begin
  if me is null then raise exception 'not signed in'; end if;
  s := public.pokejam_ranked_season();
  select * into p from public.pokejam_ranked_profiles where user_id = me and season_id = s.id;
  v_last := public.pokejam_ranked_last_final(me);
  v_sh := public.pokejam_shield_status(me);
  v_quit := public.pokejam_ranked_quit_public(me);
  v_out := jsonb_build_object('season', s.number, 'starts_at', s.starts_at, 'ends_at', s.ends_at,
    'days_left', greatest(0, ceil(extract(epoch from (s.ends_at - now())) / 86400)::int), 'last_final_score', v_last,
    'shield_item_count', v_sh->'count', 'shield_item_armed', v_sh->'armed', 'shield_item_next_use', v_sh->'next_use_at',
    'shield_item_locked', v_sh->'locked', 'shield_item_block', v_sh->'arm_block');
  if p.user_id is null then
    return v_out || jsonb_build_object('status', 'placing', 'placements_played', 0, 'placements_left', 5, 'shield_charge', 1) || v_quit;
  end if;
  v_out := v_out || jsonb_build_object('status', p.status, 'shield_charge', p.shield_charge,
    'shield_losses_left', case when p.shield_charge = 0 then 3 - p.losses_since_shield end, 'leaves_24h', p.leaves_24h);
  if p.status = 'placing' then
    return v_out || jsonb_build_object('placements_played', p.placements_played, 'placements_left', 5 - p.placements_played) || v_quit;
  end if;
  v_pts := p.points;
  if p.div_idx = 24 and p.last_game_at is not null then
    v_pts := public.pokejam_ranked_zenith_decay(p.points, floor(extract(epoch from (now() - p.last_game_at)) / 86400)::int);
  end if;
  return v_out || jsonb_build_object('placements_played', 5, 'placements_left', 0, 'div_idx', p.div_idx, 'points', v_pts,
    'tier', public.pokejam_ranked_tier_name(p.div_idx), 'division', public.pokejam_ranked_division(p.div_idx),
    'zenith', p.div_idx = 24, 'peak_idx', p.peak_idx, 'wins', p.wins, 'losses', p.losses,
    'shield_active', p.div_idx <= 8) || v_quit;
end $$;

-- Effective offence count, computed (a stable report does not write the decay).
create or replace function public.pokejam_ranked_quit_shown(p_user uuid, out offences int, out ban_until timestamptz)
language sql stable security definer set search_path = public as $$
  select coalesce(public.pokejam_ranked_quit_effective(q.offences, q.last_offence_at, now()), 0),
         case when q.ban_until > now() then q.ban_until end
    from public.pokejam_ranked_quits q where q.user_id = p_user
  union all
  select 0, null where not exists (select 1 from public.pokejam_ranked_quits q where q.user_id = p_user)
  limit 1 $$;

-- Lifts a Ranked quit ban (a crash appeal). The offence count stays, so the next quit is the next step.
create or replace function public.pokejam_admin_clear_ranked_ban(p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := public.pokejam_require_admin(); v_off int; v_until timestamptz;
begin
  if p_user is null then raise exception 'bad player'; end if;
  select offences, ban_until into v_off, v_until from public.pokejam_ranked_quits where user_id = p_user for update;
  update public.pokejam_ranked_quits set ban_until = null, updated_at = now() where user_id = p_user;
  update public.pokejam_ranked_profiles set ban_until = null,
    cooldown_until = case when cooldown_until > now() then null else cooldown_until end,
    updated_at = now() where user_id = p_user;
  insert into public.pokejam_admin_log(admin, action, target, detail)
    values (me, 'clear ranked ban', p_user, format('offences %s; was until %s', coalesce(v_off, 0), coalesce(v_until::text, 'none')));
end $$;

-- As 20261123, plus quit_offences and ranked_ban_until on each reported player.
create or replace function public.pokejam_admin_reports(p_days int default 7)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.pokejam_require_admin();
  return coalesce((
    select jsonb_agg(row_to_json(x) order by x.reporters desc, x.last_at desc) from (
      select r.reported as user_id, p.trainer_name as name,
        count(distinct r.reporter) as reporters, count(*) as reports,
        (select jsonb_object_agg(s.reason, s.n) from (select q3.reason, count(*) as n from public.pokejam_reports q3
           where q3.reported = r.reported and q3.created_at > now() - make_interval(days => greatest(1, p_days)) and q3.dismissed_at is null group by q3.reason) s) as reasons,
        (select jsonb_agg(jsonb_build_object('reason', q.reason, 'note', q.note, 'at', q.created_at, 'from', rp.trainer_name, 'from_id', q.reporter) order by q.created_at desc)
           from (select * from public.pokejam_reports q2 where q2.reported = r.reported and q2.created_at > now() - make_interval(days => p_days) and q2.dismissed_at is null
                 order by q2.created_at desc limit 8) q
           left join public.pokejam_profiles rp on rp.id = q.reporter) as latest,
        (select jsonb_agg(jsonb_build_object('match_id', c.match_id, 'queue', m.queue,
             'has_evidence', exists (select 1 from public.pokejam_match_evidence e where e.match_id = c.match_id),
             'status', v.status, 'agrees', v.agrees, 'cheater_is_reported', v.cheater = r.reported) order by c.at desc)
           from (select q4.match_id, max(q4.created_at) as at from public.pokejam_reports q4
                 where q4.reported = r.reported and q4.created_at > now() - make_interval(days => greatest(1, p_days)) and q4.dismissed_at is null
                 group by q4.match_id) c
           join public.pokejam_matches m on m.id = c.match_id
           left join public.pokejam_match_verdicts v on v.match_id = c.match_id) as checks,
        max(r.created_at) as last_at,
        (select until from public.pokejam_bans b where b.user_id = r.reported and b.until > now()) as banned_until,
        (public.pokejam_ranked_quit_shown(r.reported)).offences as quit_offences,
        (public.pokejam_ranked_quit_shown(r.reported)).ban_until as ranked_ban_until
      from public.pokejam_reports r
      left join public.pokejam_profiles p on p.id = r.reported
      where r.created_at > now() - make_interval(days => greatest(1, p_days)) and r.dismissed_at is null
      group by r.reported, p.trainer_name
      limit 200
    ) x), '[]'::jsonb);
end $$;

-- As 20261031, plus the Ranked quit count and ban on each suspended player.
create or replace function public.pokejam_admin_bans()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.pokejam_require_admin();
  return coalesce((select jsonb_agg(jsonb_build_object('user_id', b.user_id, 'name', p.trainer_name, 'until', b.until, 'reason', b.reason,
      'auto', b.auto, 'since', b.created_at,
      'quit_offences', (public.pokejam_ranked_quit_shown(b.user_id)).offences,
      'ranked_ban_until', (public.pokejam_ranked_quit_shown(b.user_id)).ban_until) order by b.created_at desc)
    from public.pokejam_bans b left join public.pokejam_profiles p on p.id = b.user_id where b.until > now()), '[]'::jsonb);
end $$;

revoke all on function
  public.pokejam_ranked_quit_effective(int, timestamptz, timestamptz),
  public.pokejam_ranked_quit_ban_for(int),
  public.pokejam_ranked_quit_decay(uuid),
  public.pokejam_ranked_quit_strike(uuid),
  public.pokejam_ranked_ban_until(uuid),
  public.pokejam_ranked_quit_public(uuid),
  public.pokejam_ranked_quit_shown(uuid),
  public.pokejam_ranked_player_update(uuid, int, boolean, text, int, int, int, int),
  public.pokejam_judge_lose(public.pokejam_matches, uuid, text),
  public.pokejam_ranked_find(uuid),
  public.pokejam_ranked_me(),
  public.pokejam_admin_clear_ranked_ban(uuid),
  public.pokejam_admin_reports(int),
  public.pokejam_admin_bans()
  from public, anon, authenticated;
grant execute on function
  public.pokejam_ranked_me(),
  public.pokejam_admin_clear_ranked_ban(uuid),
  public.pokejam_admin_reports(int),
  public.pokejam_admin_bans()
  to authenticated;
