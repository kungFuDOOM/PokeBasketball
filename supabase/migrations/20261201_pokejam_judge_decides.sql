-- PokeJam online: the judge decides disputed Ranked matches (anti-cheat PR 8). Shared gauntlet-legends project: pokejam_* only.
-- Additive and off by default: nothing changes for players until the owner runs
--   update public.pokejam_config set value = 'true' where key = 'judge_authoritative';
-- Setting it back to 'false' is the kill switch: new disputes follow the old rules again, and the sweep settles matches
-- already waiting by the old rules within a minute. Turn it on only after the shadow data (PR 7) looks sane.
--
-- With the flag on, a Ranked match goes to `judging` instead of being voided or settled when the reports disagree, when
-- either player reports a resync, when only one player has reported for 120 s, or when the guest's game stops on a desync.
-- The worker replays it and pokejam_judge_apply carries out the verdict:
--   final       the replay's winner and score. A report that disagrees is flagged; if both reports agreed and were
--               wrong, only the host is flagged (the guest was shown the host's state).
--   forfeit     the player who signed two versions of a frame loses, and is flagged.
--   incomplete  see pokejam_judge_incomplete below; otherwise void.
--   invalid     the player whose upload caused it loses (at_fault, below). Otherwise, and with no verdict: agreeing
--               reports count, anything else is void, and the match is flagged for moderators.
-- An upload is at fault when it can't be read, or carries a different engine version from the other upload (or is the only
-- upload and doesn't match the judge). The engine version isn't signed, so it must never buy a loser a void.
--
-- Deploying an engine bump: turn the flag off until the matches in play have ended. A lone upload from a game played on
-- the old engine can't be told from a fake one.

insert into public.pokejam_config(key, value) values ('judge_authoritative', 'false'), ('judge_timeout_s', '900')
  on conflict (key) do nothing;

alter table public.pokejam_matches drop constraint if exists pokejam_matches_status_check;
alter table public.pokejam_matches add constraint pokejam_matches_status_check
  check (status in ('waiting','active','judging','done','void'));
alter table public.pokejam_matches
  add column if not exists host_resyncs int,
  add column if not exists guest_resyncs int,
  add column if not exists judging_since timestamptz,
  add column if not exists desync_by uuid;

-- The player whose upload made the match unjudgeable or was ignored as a fake. Null: nobody.
alter table public.pokejam_match_verdicts add column if not exists at_fault uuid;

-- Who and what a moderator should look at. A flag is a note for a person, not a penalty.
create table if not exists public.pokejam_judge_flags (
  id bigint generated always as identity primary key,
  match_id uuid not null references public.pokejam_matches(id) on delete cascade,
  user_id uuid, -- null: about the match, not a player
  reason text not null check (reason in ('report_mismatch','equivocation','bad_upload','false_report','desync_void','invalid_verdict','no_verdict')),
  detail text,
  created_at timestamptz not null default now(),
  reviewed boolean not null default false
);
create unique index if not exists pokejam_judge_flags_once on public.pokejam_judge_flags (match_id, coalesce(user_id, '00000000-0000-0000-0000-000000000000'), reason);
create index if not exists pokejam_judge_flags_recent on public.pokejam_judge_flags (created_at desc);
alter table public.pokejam_judge_flags enable row level security;
revoke all on public.pokejam_judge_flags from anon, authenticated, public;

create or replace function public.pokejam_judge_on()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select value = 'true'::jsonb from public.pokejam_config where key = 'judge_authoritative'), false);
$$;

create or replace function public.pokejam_judge_flag(p_match uuid, p_user uuid, p_reason text, p_detail text default null)
returns void language sql security definer set search_path = public as $$
  insert into public.pokejam_judge_flags(match_id, user_id, reason, detail) values (p_match, p_user, p_reason, p_detail)
    on conflict do nothing;
$$;

-- Moves an active match to `judging` and makes sure a job will run for it: a job that already ended (a shadow run before
-- the dispute showed up) is judged again, so the verdict sees every upload.
create or replace function public.pokejam_judge_begin(p_match uuid, p_reason text, p_by uuid default null)
returns void language plpgsql security definer set search_path = public as $$
declare ready timestamptz := case
    when (select count(*) from public.pokejam_match_evidence e where e.match_id = p_match) >= 2 then now()
    else now() + interval '90 seconds' end;
begin
  update public.pokejam_matches set status = 'judging', judging_since = now(), desync_by = p_by where id = p_match and status = 'active';
  if not found then return; end if;
  insert into public.pokejam_judge_jobs as j(match_id, reason, ready_at) values (p_match, p_reason, ready)
    on conflict (match_id) do update set reason = excluded.reason,
      ready_at = case when j.state = 'running' then j.ready_at else excluded.ready_at end,
      rejudge = j.rejudge or j.state in ('done', 'failed'),
      attempts = case when j.state in ('done', 'failed') then 0 else j.attempts end,
      rejudge_until = case when j.state in ('done', 'failed') then null else j.rejudge_until end,
      finished_at = case when j.state in ('done', 'failed') then null else j.finished_at end,
      state = case when j.state in ('done', 'failed') then 'pending' else j.state end;
end $$;

-- The result, plus my resync count. Base: the 20261124 body.
drop function if exists public.pokejam_report_result(uuid, boolean);
create function public.pokejam_report_result(p_match uuid, p_host_won boolean, p_resyncs int default 0)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); m public.pokejam_matches; final boolean; res jsonb; judged boolean;
        n int := least(greatest(coalesce(p_resyncs, 0), 0), 1000);
begin
  select * into m from public.pokejam_matches where id = p_match for update;
  if m.id is null or me is null or me not in (m.host, m.guest) then raise exception 'not in this match'; end if;
  if m.queue = 'ranked' then perform public.pokejam_ranked_require_member(); end if;
  if m.status = 'done' then return jsonb_build_object('status','done','winner',m.winner); end if;
  if m.status = 'judging' then -- kept for the judge's flags; a report already made can't change now
    if me = m.host then
      update public.pokejam_matches set host_report = coalesce(host_report, p_host_won), host_reported_at = coalesce(host_reported_at, now()),
        host_resyncs = greatest(coalesce(host_resyncs, 0), n) where id = m.id;
    else
      update public.pokejam_matches set guest_report = coalesce(guest_report, p_host_won),
        guest_resyncs = greatest(coalesce(guest_resyncs, 0), n) where id = m.id;
    end if;
    return jsonb_build_object('status','judging');
  end if;
  if m.status <> 'active' or m.guest is null then raise exception 'match not active'; end if;
  if m.queue = 'ranked' then perform public.pokejam_ranked_require_picks(m.id); end if;
  if m.created_at < now() - interval '2 hours' then
    update public.pokejam_matches set status = 'void' where id = m.id; return jsonb_build_object('status','void');
  end if;
  if me = m.host then
    update public.pokejam_matches set host_report = p_host_won, host_reported_at = coalesce(host_reported_at, now()), host_resyncs = n where id = m.id returning * into m;
  else
    update public.pokejam_matches set guest_report = p_host_won, guest_resyncs = n where id = m.id returning * into m;
  end if;
  judged := m.queue = 'ranked' and public.pokejam_judge_on();
  if judged and m.host_report is not null and m.guest_report is not null and m.host_report <> m.guest_report then
    perform public.pokejam_judge_begin(m.id, 'disagree');
    return jsonb_build_object('status','judging');
  end if;
  -- The guest is the honest side of the snapshot cheat, so its count can be trusted as a trigger. A cheater can only add
  -- triggers, which costs one judge run.
  if judged and coalesce(m.host_resyncs, 0) + coalesce(m.guest_resyncs, 0) > 0 then
    perform public.pokejam_judge_begin(m.id, 'resync');
    return jsonb_build_object('status','judging');
  end if;
  if m.host_report is not null and m.guest_report is not null then
    if m.host_report <> m.guest_report then
      update public.pokejam_matches set status = 'void', finished_at = now() where id = m.id;
      return jsonb_build_object('status','void','reason','reports disagree');
    end if;
    final := m.host_report;
  elsif not judged and m.host_report is not null and m.guest_report is null and me = m.host and m.host_reported_at < now() - interval '120 seconds' then
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
revoke all on function public.pokejam_report_result(uuid, boolean, int) from public, anon;
grant execute on function public.pokejam_report_result(uuid, boolean, int) to authenticated;

-- Base: the 20261117 body. With a score from the judge, that is the margin; otherwise the players' matching reports.
drop function if exists public.pokejam_ranked_apply(uuid, text, uuid, boolean);
create function public.pokejam_ranked_apply(p_match uuid, p_reason text default 'score',
  p_leaver uuid default null, p_dodge boolean default false, p_host_score int default null, p_guest_score int default null)
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
  perform set_config('pokejam.shield_match', p_match::text, true);

  if p_reason = 'score' then
    v_winner := m.winner;
    if v_winner is null then raise exception 'match has no winner'; end if;
    if p_host_score is not null and p_guest_score is not null and p_host_score <> p_guest_score then
      hs := p_host_score; gs := p_guest_score; -- the judge's replay, not what the players claimed
    else
      select x.host_score, x.guest_score into hs, gs
        from public.pokejam_ranked_scores x join public.pokejam_ranked_scores y
          on y.match_id = x.match_id and y.user_id = m.guest and y.host_score = x.host_score and y.guest_score = x.guest_score
        where x.match_id = p_match and x.user_id = m.host;
    end if;
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
  perform set_config('pokejam.shield_match', '', true);

  v_res := jsonb_build_object('season', s.number, 'reason', p_reason, 'winner', v_winner, 'dodge', p_dodge,
    'host', hres, 'guest', gres);
  insert into public.pokejam_ranked_matches(match_id, season_id, host_id, guest_id, winner, reason, margin_share,
      host_before, host_after, host_delta, host_event, guest_before, guest_after, guest_delta, guest_event, result,
      host_shield_saved, guest_shield_saved)
    values (p_match, s.id, m.host, m.guest, v_winner, case when p_reason = 'forfeit' then 'forfeit' else p_reason end,
      case when v_known then v_diff::numeric / v_total end,
      (hres->>'before')::int, (hres->>'after')::int, (hres->>'delta')::int, hres->>'event',
      (gres->>'before')::int, (gres->>'after')::int, (gres->>'delta')::int, gres->>'event', v_res,
      case when (hres#>>'{shield,used}')::boolean then (hres#>>'{shield,saved}')::int end,
      case when (gres#>>'{shield,used}')::boolean then (gres#>>'{shield,saved}')::int end)
    on conflict (match_id) do nothing;
  delete from public.pokejam_shield_armed where user_id in (m.host, m.guest);
  if p_reason = 'score' then
    perform public.pokejam_weekly_progress(m.host, p_match, v_winner = m.host);
    perform public.pokejam_weekly_progress(m.guest, p_match, v_winner = m.guest);
  end if;
  return v_res;
end $$;
revoke all on function public.pokejam_ranked_apply(uuid, text, uuid, boolean, int, int) from public, anon, authenticated;

-- The guest's game stopped on a desync (too many resyncs, or a snapshot that doesn't fit). That used to read as the guest
-- quitting, handing a cheating host the win. Only a guest can hit it, because only a guest adopts snapshots, so a host's
-- call is refused. A player who has already gone silent can't escape a forfeit through it either. Refused, or with the
-- flag off, the match stays active and the caller falls back to claiming a forfeit, as before.
create or replace function public.pokejam_ranked_desync(p_match uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); m public.pokejam_matches;
begin
  if me is null then raise exception 'not signed in'; end if;
  perform public.pokejam_ranked_require_member();
  select * into m from public.pokejam_matches where id = p_match for update;
  if m.id is null or m.queue <> 'ranked' or me not in (m.host, m.guest) or m.guest is null then raise exception 'not in this match'; end if;
  if m.status <> 'active' then return jsonb_build_object('status', m.status, 'winner', m.winner); end if;
  if not public.pokejam_judge_on() or me <> m.guest or m.guest_alive is null or m.guest_alive < now() - interval '45 seconds' then
    return jsonb_build_object('status', 'active');
  end if;
  perform public.pokejam_judge_begin(m.id, 'desync', me);
  return jsonb_build_object('status', 'judging');
end $$;
revoke all on function public.pokejam_ranked_desync(uuid) from public, anon;
grant execute on function public.pokejam_ranked_desync(uuid) to authenticated;

-- Ends a judging match with this player losing, as a leaver ('leave') or a cheater ('forfeit').
create or replace function public.pokejam_judge_lose(m public.pokejam_matches, p_loser uuid, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
begin
  update public.pokejam_matches set status = 'done', finished_at = now(),
    winner = case when p_loser = m.host then m.guest else m.host end where id = m.id;
  perform public.pokejam_ranked_apply(m.id, p_reason, p_loser, false);
end $$;

-- The old rules: agreeing reports count, anything else is void. A lone report counts for nothing here, because nothing
-- backs it up.
create or replace function public.pokejam_judge_old_rules(m public.pokejam_matches)
returns void language plpgsql security definer set search_path = public as $$
begin
  if m.host_report is not null and m.host_report = m.guest_report then
    update public.pokejam_matches set status = 'done', finished_at = now(),
      winner = case when m.host_report then m.host else m.guest end where id = m.id;
    perform public.pokejam_ranked_apply(m.id);
  else
    update public.pokejam_matches set status = 'void', finished_at = now() where id = m.id;
  end if;
end $$;

-- The evidence stops before the buzzer. Who is to blame, in order; if nobody, null and the match is void.
--  1. The player whose upload was thrown out as a fake.
--  2. The only player who reported. A report means "the game reached the buzzer", and no log shows that. Reporting mid-game
--     and walking away is how a loser would use this, so it goes before the heartbeat rule: the opponent stops sending
--     heartbeats soon after the game stops, and must not be blamed for that.
--  3. A player with no report who went quiet (45 s, as for a forfeit) before judging began. Measured from judging_since, so
--     closing the tab while waiting for the verdict is not leaving.
--  4. A player with no report and no upload, gone by now, whose signed frames stop at least 8 frames (the input delay)
--     before the other's. Frames alone can't convict: a cheater can sign extra frames of their own afterwards and hold
--     back the opponent's. Someone who uploaded or is still here was not the one who disappeared.
create or replace function public.pokejam_judge_incomplete(m public.pokejam_matches, v public.pokejam_match_verdicts)
returns uuid language plpgsql stable security definer set search_path = public as $$
declare host_quiet boolean; guest_quiet boolean; behind uuid;
begin
  if v.at_fault is not null then return v.at_fault; end if;
  if (m.host_report is null) <> (m.guest_report is null) then
    return case when m.host_report is not null then m.host else m.guest end;
  end if;
  if m.host_report is null and m.guest_report is null then
    host_quiet := m.host_alive is not null and m.host_alive < m.judging_since - interval '45 seconds';
    guest_quiet := m.guest_alive is not null and m.guest_alive < m.judging_since - interval '45 seconds';
    if host_quiet and guest_quiet then return null; end if;
    if host_quiet then return m.host; end if;
    if guest_quiet then return m.guest; end if;
    behind := case when coalesce(v.last_frame_host, 0) + 8 <= coalesce(v.last_frame_guest, 0) then m.host
      when coalesce(v.last_frame_guest, 0) + 8 <= coalesce(v.last_frame_host, 0) then m.guest end;
    if behind is not null
      and coalesce(case when behind = m.host then m.host_alive else m.guest_alive end, '-infinity') < now() - interval '45 seconds'
      and not exists (select 1 from public.pokejam_match_evidence e where e.match_id = m.id and e.user_id = behind) then
      return behind;
    end if;
  end if;
  return null;
end $$;

-- Service role (the worker and the sweep): carry out the match's verdict. Reads the stored verdict, so it doesn't matter who
-- judged it or whether an earlier run died before getting here. A match that isn't judging is left alone, so this can run
-- any number of times. With no verdict, or with the flag off, the old rules apply.
create or replace function public.pokejam_judge_apply(p_match uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.pokejam_matches; v public.pokejam_match_verdicts; win uuid; loser uuid; hw boolean; resynced boolean;
begin
  select * into m from public.pokejam_matches where id = p_match for update;
  if m.id is null then return null; end if;
  if m.status <> 'judging' then return jsonb_build_object('status', m.status, 'winner', m.winner, 'applied', false); end if;
  select * into v from public.pokejam_match_verdicts where match_id = p_match;
  if not public.pokejam_judge_on() then
    perform public.pokejam_judge_old_rules(m);
  elsif v.match_id is null then
    perform public.pokejam_judge_flag(m.id, null, 'no_verdict', 'old rules applied: no usable verdict in time');
    perform public.pokejam_judge_old_rules(m);
  else
    if v.at_fault is not null then
      perform public.pokejam_judge_flag(m.id, v.at_fault, 'bad_upload', left(v.notes, 500));
    end if;
    win := case v.winner_side when 0 then m.host when 1 then m.guest end;
    if v.status = 'final' and win is not null then
      hw := v.winner_side = 0;
      resynced := coalesce(m.host_resyncs, 0) + coalesce(m.guest_resyncs, 0) > 0 or m.desync_by is not null;
      if m.host_report is not null and m.host_report = m.guest_report and m.host_report <> hw then
        if resynced then
          perform public.pokejam_judge_flag(m.id, m.host, 'report_mismatch', 'both reports were wrong after a resync: the guest saw the host''s state');
        end if;
      else
        if m.host_report is not null and m.host_report <> hw then perform public.pokejam_judge_flag(m.id, m.host, 'report_mismatch'); end if;
        if m.guest_report is not null and m.guest_report <> hw then perform public.pokejam_judge_flag(m.id, m.guest, 'report_mismatch'); end if;
      end if;
      update public.pokejam_matches set status = 'done', finished_at = now(), winner = win where id = m.id;
      perform public.pokejam_ranked_apply(m.id, 'score', null, false, v.score_host, v.score_guest);
    elsif v.status = 'forfeit' and v.cheater in (m.host, m.guest) then
      perform public.pokejam_judge_flag(m.id, v.cheater, 'equivocation', left(v.notes, 500));
      perform public.pokejam_judge_lose(m, v.cheater, 'forfeit');
    elsif v.status = 'incomplete' then
      loser := public.pokejam_judge_incomplete(m, v);
      if loser is not null then
        if v.at_fault is null and (m.host_report is null) <> (m.guest_report is null) then
          perform public.pokejam_judge_flag(m.id, loser, 'false_report', 'reported a result, but the log stops before the buzzer');
        end if;
        perform public.pokejam_judge_lose(m, loser, 'leave');
      else
        if m.desync_by is not null then
          perform public.pokejam_judge_flag(m.id, m.desync_by, 'desync_void', 'stopped the game on a desync; the match was voided');
        end if;
        update public.pokejam_matches set status = 'void', finished_at = now() where id = m.id;
      end if;
    elsif v.at_fault is not null then
      perform public.pokejam_judge_lose(m, v.at_fault, 'forfeit');
    else
      perform public.pokejam_judge_flag(m.id, null, 'invalid_verdict', left(v.notes, 500));
      perform public.pokejam_judge_old_rules(m);
    end if;
    update public.pokejam_match_verdicts set shadow = false where match_id = p_match;
  end if;
  select * into m from public.pokejam_matches where id = p_match;
  return jsonb_build_object('status', m.status, 'winner', m.winner, 'applied', true);
end $$;

-- Every minute, and from the cleanup. Needs no Edge Function, so a worker that's down can't keep ratings waiting.
--  * One report for 120 s: to the judge. The other player would have reported by now. Driven from here because nothing
--    calls pokejam_report_result a second time, and the job was created by that first report.
--  * The job ended but the match is still judging (a dispute that showed up while the run was finishing): apply its verdict.
--  * Older than judge_timeout_s: apply whatever there is, which with no verdict means the old rules.
--  * Flag off: nothing starts, and anything still judging is settled by the old rules.
create or replace function public.pokejam_judge_sweep()
returns int language plpgsql security definer set search_path = public as $$
declare r record; n int := 0; on_ boolean := public.pokejam_judge_on();
  timeout_s numeric := coalesce((select (value #>> '{}')::numeric from public.pokejam_config where key = 'judge_timeout_s'), 900);
begin
  if on_ then
    for r in select m.id from public.pokejam_matches m join public.pokejam_judge_jobs j on j.match_id = m.id
        where m.queue = 'ranked' and m.status = 'active' and (m.host_report is null) <> (m.guest_report is null)
          and j.created_at < now() - interval '120 seconds'
        for update of m skip locked loop
      perform public.pokejam_judge_begin(r.id, 'one_sided');
      n := n + 1;
    end loop;
  end if;
  for r in select m.id from public.pokejam_matches m
      where m.status = 'judging' and (not on_ or m.judging_since < now() - make_interval(secs => timeout_s::double precision)
        or (exists (select 1 from public.pokejam_judge_jobs j where j.match_id = m.id and j.state = 'done')
            and exists (select 1 from public.pokejam_match_verdicts v where v.match_id = m.id)))
      for update of m skip locked loop
    perform public.pokejam_judge_apply(r.id);
    n := n + 1;
  end loop;
  return n;
end $$;

revoke all on function public.pokejam_judge_on(), public.pokejam_judge_flag(uuid, uuid, text, text), public.pokejam_judge_begin(uuid, text, uuid),
  public.pokejam_judge_lose(public.pokejam_matches, uuid, text), public.pokejam_judge_old_rules(public.pokejam_matches),
  public.pokejam_judge_incomplete(public.pokejam_matches, public.pokejam_match_verdicts),
  public.pokejam_judge_apply(uuid), public.pokejam_judge_sweep() from public, anon, authenticated;
grant execute on function public.pokejam_judge_apply(uuid), public.pokejam_judge_sweep() to service_role;

-- Base: the 20261112 body, plus the sweep.
create or replace function public.pokejam_cleanup_matches()
returns int language plpgsql security definer set search_path = public as $$
declare n int; k int := 0; r record;
begin
  with stale as (
    select m.id from public.pokejam_matches m
    left join public.pokejam_drafts d on d.match_id = m.id
    where m.queue = 'social' and (
      (m.status = 'waiting' and m.created_at < now() - interval '30 minutes')
      or (m.status = 'active' and m.created_at < now() - interval '60 minutes')
      or (m.status = 'active' and d.match_id is not null and not d.done
          and greatest(d.created_at, d.host_seen, d.guest_seen) < now() - interval '2 minutes')
      or (m.status = 'active' and m.host_alive is not null and m.guest_alive is not null
          and greatest(m.host_alive, m.guest_alive) < now() - interval '3 minutes'))
    for update of m skip locked
  )
  update public.pokejam_matches m set status = 'void', finished_at = now() from stale where m.id = stale.id;
  get diagnostics n = row_count;
  for r in select m.id from public.pokejam_matches m
      where m.queue = 'ranked' and m.status = 'active' and m.guest is not null and m.created_at < now() - interval '45 seconds'
      for update of m skip locked loop
    if public.pokejam_ranked_settle(r.id, null) is not null then k := k + 1; end if;
  end loop;
  delete from public.pokejam_queue where last_seen < now() - interval '2 minutes';
  perform public.pokejam_judge_sweep();
  return n + k;
end $$;

-- Base: the 20261128 body, plus who is at fault.
drop function if exists public.pokejam_record_verdict(uuid, text, int, int, int, int, int, text, int, int);
create function public.pokejam_record_verdict(p_match uuid, p_status text, p_winner_side int, p_cheater_side int,
  p_score_host int, p_score_guest int, p_ticks int, p_notes text, p_last_host int default null, p_last_guest int default null, p_fault_user uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.pokejam_matches; v public.pokejam_match_verdicts; win uuid;
begin
  select * into m from public.pokejam_matches where id = p_match;
  if m.id is null then raise exception 'no such match'; end if;
  if p_status is null or p_status not in ('final','incomplete','forfeit','invalid') then raise exception 'bad status'; end if;
  if p_winner_side is not null and p_winner_side not in (0, 1) then raise exception 'bad side'; end if;
  if p_cheater_side is not null and p_cheater_side not in (0, 1) then raise exception 'bad side'; end if;
  win := case p_winner_side when 0 then m.host when 1 then m.guest end;
  insert into public.pokejam_match_verdicts as t(match_id, status, winner_side, cheater, agrees, score_host, score_guest, ticks, notes, judged_at, last_frame_host, last_frame_guest, at_fault)
    values (p_match, p_status, p_winner_side,
      case p_cheater_side when 0 then m.host when 1 then m.guest end,
      case when win is null or m.winner is null then null else win = m.winner end,
      p_score_host, p_score_guest, p_ticks, left(p_notes, 4000), now(), p_last_host, p_last_guest,
      case when p_fault_user in (m.host, m.guest) then p_fault_user end)
    on conflict (match_id) do update set status = excluded.status, winner_side = excluded.winner_side, cheater = excluded.cheater,
      agrees = excluded.agrees, score_host = excluded.score_host, score_guest = excluded.score_guest, ticks = excluded.ticks,
      notes = excluded.notes, judged_at = excluded.judged_at, last_frame_host = excluded.last_frame_host, last_frame_guest = excluded.last_frame_guest, at_fault = excluded.at_fault
    returning * into v;
  return to_jsonb(v);
end $$;
revoke all on function public.pokejam_record_verdict(uuid, text, int, int, int, int, int, text, int, int, uuid) from public, anon, authenticated;
grant execute on function public.pokejam_record_verdict(uuid, text, int, int, int, int, int, text, int, int, uuid) to service_role;

-- A match in judging still counts as played. Base: the 20261127 body.
create or replace function public.pokejam_ranked_find(me uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare sn public.pokejam_seasons; p public.pokejam_ranked_profiles; q public.pokejam_queue; other public.pokejam_queue;
        mid uuid; r record; score int; win int; last_opp uuid; flip boolean;
begin
  perform public.pokejam_ranked_require_member();
  if not exists (select 1 from public.pokejam_usernames u where u.user_id = me and u.username is not null) then
    raise exception 'username:required';
  end if;
  sn := public.pokejam_ranked_season();
  -- Searching again with a Ranked game I had opened means I left it.
  for r in select m.id from public.pokejam_matches m
      where m.queue = 'ranked' and m.status = 'active' and m.guest is not null and me in (m.host, m.guest)
        and m.created_at > now() - interval '2 hours'
        and (case when me = m.host then m.host_alive else m.guest_alive end) < now() - interval '10 seconds' loop
    perform public.pokejam_leave_match(r.id);
  end loop;
  -- A pairing I haven't opened yet is news to me.
  select m.id into mid from public.pokejam_matches m
    where m.status = 'active' and me in (m.host, m.guest) and m.queue = 'ranked'
      and m.created_at > now() - interval '2 minutes' and m.room_code is null
      and (case when me = m.host then m.host_alive else m.guest_alive end) is null
    order by m.created_at desc limit 1;
  if mid is not null then delete from public.pokejam_queue where user_id = me; return mid; end if;
  select * into p from public.pokejam_ranked_profiles where user_id = me and season_id = sn.id;
  if p.cooldown_until is not null and p.cooldown_until > now() then
    raise exception 'ranked cooldown: % seconds left', ceil(extract(epoch from p.cooldown_until - now()))::int;
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
      and not exists (select 1 from public.pokejam_ranked_profiles cp where cp.user_id = o.user_id and cp.season_id = sn.id
                      and cp.cooldown_until > now()) -- a row left from before the cooldown started
      and (select count(*) from public.pokejam_matches x where x.queue = 'ranked' and x.guest is not null
             and x.status in ('active','judging','done') and x.created_at > now() - interval '24 hours'
             and ((x.host = me and x.guest = o.user_id) or (x.host = o.user_id and x.guest = me))) < 3
    order by abs(o.mmr - score), o.joined_at limit 1 for update skip locked;
  if other.user_id is null then return null; end if;
  flip := random() < 0.5; -- true: the player who queued first hosts
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

-- A player waiting for the verdict may still send a heartbeat. Base: the 20261111 body.
create or replace function public.pokejam_match_alive(p_match uuid)
returns text language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); st text;
begin
  if me is null then raise exception 'not signed in'; end if;
  update public.pokejam_matches m set
    host_alive = case when me = m.host then now() else m.host_alive end,
    guest_alive = case when me = m.guest then now() else m.guest_alive end
  where m.id = p_match and m.queue in ('social','ranked') and m.status in ('active', 'judging') and me in (m.host, m.guest)
    and coalesce(case when me = m.host then m.host_alive else m.guest_alive end, '-infinity') < now() - interval '10 seconds';
  select status into st from public.pokejam_matches where id = p_match and me in (host, guest);
  return st;
end $$;

-- The shield stays locked while a match is judged: arming one after seeing "checking the result" would dodge the verdict.
-- Base: the 20261117 body.
create or replace function public.pokejam_shield_arm_state(p_user uuid, out o_armed boolean, out o_locked boolean)
language plpgsql security definer set search_path = public as $$
declare a timestamptz; m record;
begin
  o_armed := false; o_locked := false;
  select armed_at into a from public.pokejam_shield_armed where user_id = p_user;
  select x.status, x.created_at into m from public.pokejam_matches x
    where x.queue = 'ranked' and x.guest is not null and p_user in (x.host, x.guest) and x.created_at >= coalesce(a, '-infinity')
    order by x.created_at desc limit 1;
  -- Locked while a ranked match is on, armed or not (nobody can arm after seeing who they got).
  o_locked := m.created_at is not null and m.status in ('active', 'judging') and m.created_at > now() - interval '2 hours';
  if a is null then return; end if;
  if m.created_at is null or o_locked then o_armed := true; return; end if;
  delete from public.pokejam_shield_armed where user_id = p_user;
end $$;

-- Moderators: the judge's flags, newest first (p_days 1-90).
create or replace function public.pokejam_admin_judge_flags(p_days int default 7)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare n int := greatest(1, least(coalesce(p_days, 7), 90));
begin
  perform public.pokejam_require_admin();
  return coalesce((select jsonb_agg(r order by r.created_at desc, r.id desc) from (
    select f.id, f.match_id, f.user_id, u.username, f.reason, f.detail, f.created_at, f.reviewed
      from public.pokejam_judge_flags f left join public.pokejam_usernames u on u.user_id = f.user_id
      where f.created_at > now() - make_interval(days => n)
      order by f.created_at desc limit 200) r), '[]'::jsonb);
end $$;
revoke all on function public.pokejam_admin_judge_flags(int) from public, anon, authenticated;
grant execute on function public.pokejam_admin_judge_flags(int) to authenticated;

-- The sweep needs no Edge Function, only pg_cron.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('pokejam-judge-sweep') where exists (select 1 from cron.job where jobname = 'pokejam-judge-sweep');
    perform cron.schedule('pokejam-judge-sweep', '* * * * *', 'select public.pokejam_judge_sweep()');
  else
    raise notice 'pokejam-judge-sweep not scheduled: pg_cron is not enabled.';
  end if;
end $$;
