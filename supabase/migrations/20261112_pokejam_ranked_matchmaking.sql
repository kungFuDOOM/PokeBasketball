-- PokeJam Ranked, Season 1 matchmaking and leavers (docs/ranked-plan.md sections 7 and 8.2, PR 2). Shared gauntlet-legends
-- project: pokejam_* only. Additive and safe to run again: only `create or replace`, nothing dropped, no table changes.
-- Social behaviour is untouched: pokejam_find_match keeps its name, argument, result and grants and its Social path is
-- the 20261107 body unchanged; the Ranked path is one early branch into pokejam_ranked_find.
--
-- - Ranked queue: pokejam_queue.mmr holds the player's ladder score (div_idx * 100 + points; the seed while placing; Zenith
--   2400 + points). The allowed gap widens with the time in the queue (pokejam_ranked_window). Hard rules: Eclipse and
--   above never meet anyone more than 3 tiers away, a Bronze player never meets Platinum or higher, the same two players
--   are not paired twice in a row and at most 3 times in 24 h. Banned / blocked pairs and the 15 s heartbeat as before.
-- - Cooldown: a profile whose cooldown_until is in the future cannot search; find_match raises 'ranked cooldown: N seconds
--   left' (the 0/5/15/60 minute ladder is written by pokejam_ranked_player_update since PR 1).
-- - Searching again while holding a Ranked match I had opened (a game heartbeat) means I left it: it is a leave.
-- - Leaving: after the first game heartbeat it is a forfeit. Before it, within 30 s of the pairing, it is a dodge (max-cost
--   loss for me, nothing for the other player, match void). Later than that with nobody having connected it is a failed
--   connection and costs nobody anything (a stayer whose opponent never showed gives up at the 40 s connect timeout).
-- - Silence: pokejam_ranked_settle decides a stale Ranked match from the two heartbeats. A player silent for 45 s with
--   no result reported forfeits; a player who never sent one while the other is playing, 90 s after the pairing, dodged;
--   both silent: void, nothing changes. Used by the stayer's pokejam_ranked_forfeit and by the cleanup sweep. Scoring goes
--   through pokejam_ranked_apply, whose primary key makes it once-only, and the match row is locked, so no double score.

-- ---------- pure helpers ----------
-- Allowed ladder-score gap after s seconds in the queue: 100 up to 10 s, +15/s to 400 at 30 s, +10/s to 700 at 60 s, then 900.
create or replace function public.pokejam_ranked_window(p_secs int)
returns int language sql immutable as $$
  select case when p_secs < 10 then 100 when p_secs < 30 then least(400, 100 + 15 * (p_secs - 10))
    when p_secs < 60 then least(700, 400 + 10 * (p_secs - 30)) else 900 end $$;

-- The hard pairing rules between two ladder scores.
create or replace function public.pokejam_ranked_pair_ok(a int, b int)
returns boolean language sql immutable as $$
  select not (least(a, b) / 100 / 3 = 0 and public.pokejam_ranked_tier_idx(greatest(a, b) / 100) >= 3)
     and not (public.pokejam_ranked_tier_idx(greatest(a, b) / 100) >= 5 -- Eclipse (tier 5) and above
              and public.pokejam_ranked_tier_idx(greatest(a, b) / 100) - public.pokejam_ranked_tier_idx(least(a, b) / 100) > 3) $$;

-- ---------- stale matches ----------
-- What the heartbeats say about an active Ranked match. caller (the player asking, who is alive by definition) may be null.
-- 'none', 'void' (both silent), or 'forfeit_host' / 'forfeit_guest' / 'dodge_host' / 'dodge_guest' (the player named lost).
create or replace function public.pokejam_ranked_verdict(m public.pokejam_matches, p_caller uuid default null)
returns text language plpgsql stable as $$
declare sh boolean; sg boolean; rep boolean;
begin
  if m.queue <> 'ranked' or m.status <> 'active' or m.guest is null then return 'none'; end if;
  -- A reported result is a finished game, not silence; a caller who reported a loss can't claim a win.
  if p_caller is not null then
    rep := case when p_caller = m.host then m.host_report else m.guest_report end; -- "the host won", as reported
    if rep is not null and rep <> (p_caller = m.host) then return 'none'; end if;
  end if;
  sh := m.host_report is null and m.host is distinct from p_caller
    and case when m.host_alive is null then m.created_at < now() - interval '90 seconds' else m.host_alive < now() - interval '45 seconds' end;
  sg := m.guest_report is null and m.guest is distinct from p_caller
    and case when m.guest_alive is null then m.created_at < now() - interval '90 seconds' else m.guest_alive < now() - interval '45 seconds' end;
  -- The other side reported (and is gone): leave that to the report rules, don't second-guess a result.
  if p_caller is null and (m.host_report is not null or m.guest_report is not null) then return 'none'; end if;
  if sh and sg then return 'void'; end if;
  if sh then return case when m.host_alive is null then 'dodge_host' else 'forfeit_host' end; end if;
  if sg then return case when m.guest_alive is null then 'dodge_guest' else 'forfeit_guest' end; end if;
  return 'none';
end $$;

-- Settles a Ranked match whose heartbeats went quiet (see pokejam_ranked_verdict). Internal. Returns null when there is
-- nothing to settle, else {status, winner, verdict, res}.
create or replace function public.pokejam_ranked_settle(p_match uuid, p_caller uuid default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.pokejam_matches; v text; leaver uuid; res jsonb;
begin
  select * into m from public.pokejam_matches where id = p_match for update;
  if m.id is null then return null; end if;
  v := public.pokejam_ranked_verdict(m, p_caller);
  if v = 'none' then return null; end if;
  if v = 'void' then
    update public.pokejam_matches set status = 'void', finished_at = now() where id = m.id;
    return jsonb_build_object('status', 'void', 'winner', null, 'verdict', v, 'res', null);
  end if;
  leaver := case when v like '%host' then m.host else m.guest end;
  if v like 'dodge%' then
    update public.pokejam_matches set status = 'void', finished_at = now() where id = m.id;
    res := public.pokejam_ranked_apply(m.id, 'leave', leaver, true);
    return jsonb_build_object('status', 'void', 'winner', null, 'verdict', v, 'res', res);
  end if;
  update public.pokejam_matches set status = 'done', finished_at = now(),
    winner = case when leaver = m.host then m.guest else m.host end where id = m.id;
  res := public.pokejam_ranked_apply(m.id, 'forfeit', leaver, false);
  return jsonb_build_object('status', 'done', 'winner', case when leaver = m.host then m.guest else m.host end, 'verdict', v, 'res', res);
end $$;

-- The stayer claims the win once the other player's heartbeat has been silent for 45 s (or they never showed, after 90 s).
-- Replaces 20261111: same name, argument and result shape.
create or replace function public.pokejam_ranked_forfeit(p_match uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); m public.pokejam_matches; s jsonb;
begin
  if me is null then raise exception 'not signed in'; end if;
  select * into m from public.pokejam_matches where id = p_match for update;
  if m.id is null or m.queue <> 'ranked' or me not in (m.host, m.guest) or m.guest is null then raise exception 'not in this match'; end if;
  if m.status = 'done' then return jsonb_build_object('status', 'done', 'winner', m.winner); end if;
  if m.status <> 'active' then return jsonb_build_object('status', m.status); end if;
  s := public.pokejam_ranked_settle(m.id, me);
  if s is null then return jsonb_build_object('status', 'active'); end if;
  if s->>'status' = 'done' then
    return jsonb_build_object('status', 'done', 'winner', s->'winner', 'rank', public.pokejam_ranked_player_view(
      case when me = m.host then s->'res'->'host' else s->'res'->'guest' end));
  end if;
  return jsonb_build_object('status', s->>'status');
end $$;

-- As 20261106, plus Ranked matches: a silent player forfeits, both silent voids. Social rules unchanged. Still returns
-- the number of matches called off.
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
  return n + k;
end $$;

-- ---------- leaving ----------
-- As 20261111, except: with no game heartbeat from anyone, a Ranked leave later than 30 s after the pairing is a failed
-- connection (the match is voided, nobody is charged); within 30 s it is a dodge as before.
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
    if m.created_at > now() - interval '30 seconds' then
      perform public.pokejam_ranked_apply(m.id, 'leave', me, true);
    end if;
  end if;
end $$;

-- ---------- matchmaking ----------
-- The Ranked path of pokejam_find_match (the caller has passed the ban, human, rate and cleanup checks and holds the
-- per-player lock). Returns the match id once paired, else null; raises 'ranked cooldown: N seconds left' during a cooldown.
create or replace function public.pokejam_ranked_find(me uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare sn public.pokejam_seasons; p public.pokejam_ranked_profiles; q public.pokejam_queue; other public.pokejam_queue;
        mid uuid; r record; score int; win int; last_opp uuid;
begin
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
    where x.queue = 'ranked' and x.guest is not null and x.status in ('active','done') and me in (x.host, x.guest)
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
             and x.status in ('active','done') and x.created_at > now() - interval '24 hours'
             and ((x.host = me and x.guest = o.user_id) or (x.host = o.user_id and x.guest = me))) < 3
    order by abs(o.mmr - score), o.joined_at limit 1 for update skip locked;
  if other.user_id is null then return null; end if;
  insert into public.pokejam_matches(queue, host, guest, host_mmr, guest_mmr, seed, quarter_len)
    values ('ranked', other.user_id, me, other.mmr, score, public.pokejam_new_seed(), 120) returning id into mid;
  delete from public.pokejam_queue where user_id in (me, other.user_id);
  return mid;
end $$;

-- As 20261107; the only change is the early hand-off to pokejam_ranked_find for the Ranked queue.
create or replace function public.pokejam_find_match(p_queue text)
returns uuid language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); my public.pokejam_profiles; q public.pokejam_queue; other public.pokejam_queue; mid uuid; win int;
begin
  if me is null then raise exception 'not signed in'; end if;
  if p_queue not in ('social','ranked') then raise exception 'bad queue'; end if;
  if public.pokejam_banned(me) then raise exception 'You are suspended from online play for now.'; end if;
  if not public.pokejam_human_ok(me) then raise exception 'human check needed'; end if;
  -- The client polls every 2 s; 60 a minute leaves room for a retry or two.
  if not public.pokejam_rate_ok('find', 60, interval '1 minute') then raise exception 'Slow down: too many matchmaking requests.'; end if;
  perform public.pokejam_cleanup_maybe();
  -- One search request per player at a time, so a retried poll can't race the next one into two matches.
  perform pg_advisory_xact_lock(hashtext('pokejam_find:' || me::text));
  -- Searching again means I left any Social match I had opened: call it off so the opponent isn't left in it.
  update public.pokejam_matches m set status = 'void', finished_at = now()
    where m.queue = 'social' and m.status = 'active' and me in (m.host, m.guest)
      and exists (select 1 from public.pokejam_drafts d where d.match_id = m.id
                  and greatest(case when me = m.host then d.host_seen else d.guest_seen end,
                               case when me = m.host then m.host_alive else m.guest_alive end) < now() - interval '10 seconds');
  if p_queue = 'ranked' then return public.pokejam_ranked_find(me); end if;
  -- Only a pairing I haven't opened yet is news to me.
  select m.id into mid from public.pokejam_matches m
    where m.status = 'active' and me in (m.host, m.guest) and m.queue = p_queue
      and m.created_at > now() - interval '2 minutes' and m.room_code is null
      and not exists (select 1 from public.pokejam_drafts d where d.match_id = m.id
                      and (case when me = m.host then d.host_seen else d.guest_seen end) is not null)
      and (case when me = m.host then m.host_alive else m.guest_alive end) is null
    order by m.created_at desc limit 1;
  if mid is not null then delete from public.pokejam_queue where user_id = me; return mid; end if;
  select * into my from public.pokejam_profiles where id = me;
  if my.id is null then raise exception 'no profile'; end if;
  -- Every poll is a heartbeat.
  insert into public.pokejam_queue(user_id, queue, mmr, last_seen) values (me, p_queue, my.mmr, now())
    on conflict (user_id) do update set queue = excluded.queue, last_seen = now(),
      joined_at = case when pokejam_queue.queue = excluded.queue then pokejam_queue.joined_at else now() end
    returning * into q;
  win := least(1000, 100 + 25 * extract(epoch from now() - q.joined_at)::int);
  select * into other from public.pokejam_queue o
    where o.queue = p_queue and o.user_id <> me and o.last_seen > now() - interval '15 seconds' and abs(o.mmr - my.mmr) <= win
      and not public.pokejam_blocked_pair(me, o.user_id) and not public.pokejam_banned(o.user_id)
    order by abs(o.mmr - my.mmr), o.joined_at limit 1 for update skip locked;
  if other.user_id is null then return null; end if;
  insert into public.pokejam_matches(queue, host, guest, host_mmr, guest_mmr, seed, quarter_len)
    values (p_queue, other.user_id, me, other.mmr, my.mmr, public.pokejam_new_seed(), 120) returning id into mid;
  delete from public.pokejam_queue where user_id in (me, other.user_id);
  return mid;
end $$;

-- ---------- privileges ----------
revoke all on function
  public.pokejam_ranked_window(int), public.pokejam_ranked_pair_ok(int,int),
  public.pokejam_ranked_verdict(public.pokejam_matches,uuid), public.pokejam_ranked_settle(uuid,uuid),
  public.pokejam_ranked_forfeit(uuid), public.pokejam_cleanup_matches(), public.pokejam_leave_match(uuid),
  public.pokejam_ranked_find(uuid), public.pokejam_find_match(text)
  from public, anon, authenticated;
grant execute on function public.pokejam_ranked_forfeit(uuid), public.pokejam_leave_match(uuid), public.pokejam_find_match(text)
  to authenticated;
grant execute on function public.pokejam_cleanup_matches() to service_role;
