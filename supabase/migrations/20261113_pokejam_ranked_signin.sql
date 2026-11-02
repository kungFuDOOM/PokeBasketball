-- PokeJam Ranked, sign-in and the late-dodge fix (docs/ranked-plan.md sections 8.2 and 9, PR 3). Shared gauntlet-legends
-- project: pokejam_* only. Additive and safe to run again: only `create or replace`, nothing dropped, no table changes.
-- NOT applied by the repo; the owner runs it by hand in the Supabase SQL editor (docs/ranked-signin.md).
--
-- 1. Ranked needs a real account. Supabase marks guest (anonymous) sessions with is_anonymous = true in the JWT; a player who
--    signed in with Google or a wallet (or linked one to their guest account) has it false. pokejam_ranked_require_member()
--    refuses guests, and is called first by the Ranked queue path and the Ranked report RPCs. Same names, arguments, results
--    and grants as before; the bodies are the 20261112 / 20261111 bodies plus the one check. Social and offline are untouched.
--    A missing claim counts as signed in (a service-role or test call has no JWT claims).
-- 2. The late dodge. 20261112 treated a leave later than 30 s after the pairing, with nobody having connected, as a failed
--    connection that costs nobody anything. A player who just waited out 30 s could dodge for free. Now the server asks who
--    turned up: a player "showed up" if they registered their evidence key (the client does it the moment it starts
--    connecting) or sent a game heartbeat. With no heartbeat from anyone:
--      - within 30 s of the pairing: a dodge for the leaver (as before);
--      - later, the leaver never showed up (the other did):   a dodge for the leaver (the late dodge, now penalised);
--      - later, the leaver showed up and the other did not:    the match is void, and the one who never showed up takes the
--        dodge (max-cost loss and a leave on their count); the stayer who gave up waiting loses nothing;
--      - later, both or neither showed up: a failed connection, void, nobody charged (can't tell who is at fault).
--    The stale-match sweep applies the same rule once the 90 s silence window has passed (pokejam_ranked_verdict).
--    Limit: the key is a client call, so a cheater who registers a key without connecting looks like they showed up.

-- ---------- sign-in ----------
create or replace function public.pokejam_ranked_require_member()
returns void language plpgsql stable security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'not signed in'; end if;
  if coalesce(auth.jwt() ->> 'is_anonymous', 'false') = 'true' then
    raise exception 'Ranked needs a signed-in account (Google or Phantom). Guests can still play Social.';
  end if;
end $$;

-- Ranked report: my final score. As 20261111 plus the sign-in check.
create or replace function public.pokejam_ranked_report_score(p_match uuid, p_host_score int, p_guest_score int)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); m public.pokejam_matches;
begin
  if me is null then raise exception 'not signed in'; end if;
  perform public.pokejam_ranked_require_member();
  if p_host_score is null or p_guest_score is null or p_host_score not between 0 and 300 or p_guest_score not between 0 and 300
     or p_host_score = p_guest_score then raise exception 'bad score'; end if;
  select * into m from public.pokejam_matches where id = p_match;
  if m.id is null or m.queue <> 'ranked' or me not in (m.host, m.guest) or m.guest is null then raise exception 'not in this match'; end if;
  if m.status = 'done' or m.status = 'void' then return; end if; -- too late to change anything
  insert into public.pokejam_ranked_scores(match_id, user_id, host_score, guest_score) values (p_match, me, p_host_score, p_guest_score)
    on conflict (match_id, user_id) do nothing;
end $$;

-- As 20261111; the only change is the sign-in check for a Ranked match (Social matches skip it).
create or replace function public.pokejam_report_result(p_match uuid, p_host_won boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); m public.pokejam_matches; final boolean; res jsonb;
begin
  select * into m from public.pokejam_matches where id = p_match for update;
  if m.id is null or me is null or me not in (m.host, m.guest) then raise exception 'not in this match'; end if;
  if m.queue = 'ranked' then perform public.pokejam_ranked_require_member(); end if;
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

-- As 20261112 plus the sign-in check.
create or replace function public.pokejam_ranked_forfeit(p_match uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); m public.pokejam_matches; s jsonb;
begin
  if me is null then raise exception 'not signed in'; end if;
  perform public.pokejam_ranked_require_member();
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

-- The Ranked path of pokejam_find_match: as 20261112 plus the sign-in check first (find_match itself is unchanged, so
-- Social is untouched and its ban / human / rate checks still run before this).
create or replace function public.pokejam_ranked_find(me uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare sn public.pokejam_seasons; p public.pokejam_ranked_profiles; q public.pokejam_queue; other public.pokejam_queue;
        mid uuid; r record; score int; win int; last_opp uuid;
begin
  perform public.pokejam_ranked_require_member();
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

-- ---------- the late dodge ----------
-- As 20261112, plus: when neither side ever sent a game heartbeat, a player who registered no key while the other did is
-- the dodger (the sweep reaches this once the 90 s window has passed).
create or replace function public.pokejam_ranked_verdict(m public.pokejam_matches, p_caller uuid default null)
returns text language plpgsql stable as $$
declare sh boolean; sg boolean; rep boolean;
begin
  if m.queue <> 'ranked' or m.status <> 'active' or m.guest is null then return 'none'; end if;
  if p_caller is not null then
    rep := case when p_caller = m.host then m.host_report else m.guest_report end;
    if rep is not null and rep <> (p_caller = m.host) then return 'none'; end if;
  end if;
  sh := m.host_report is null and m.host is distinct from p_caller
    and case when m.host_alive is null then m.created_at < now() - interval '90 seconds' else m.host_alive < now() - interval '45 seconds' end;
  sg := m.guest_report is null and m.guest is distinct from p_caller
    and case when m.guest_alive is null then m.created_at < now() - interval '90 seconds' else m.guest_alive < now() - interval '45 seconds' end;
  if p_caller is null and (m.host_report is not null or m.guest_report is not null) then return 'none'; end if;
  if sh and sg then
    if m.host_alive is null and m.guest_alive is null then
      if m.host_key is not null and m.guest_key is null then return 'dodge_guest'; end if;
      if m.guest_key is not null and m.host_key is null then return 'dodge_host'; end if;
    end if;
    return 'void';
  end if;
  if sh then return case when m.host_alive is null then 'dodge_host' else 'forfeit_host' end; end if;
  if sg then return case when m.guest_alive is null then 'dodge_guest' else 'forfeit_guest' end; end if;
  return 'none';
end $$;

-- As 20261112, except the no-heartbeat branch (see the header): who turned up decides who is charged.
create or replace function public.pokejam_leave_match(p_match uuid)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); m public.pokejam_matches; v_reported boolean; me_in boolean; other_in boolean; other uuid;
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
    return;
  end if;
  -- Nobody has started the game. Who turned up = who registered a key.
  other := case when me = m.host then m.guest else m.host end;
  me_in := (case when me = m.host then m.host_key else m.guest_key end) is not null;
  other_in := (case when me = m.host then m.guest_key else m.host_key end) is not null;
  update public.pokejam_matches set status = 'void', finished_at = now() where id = m.id;
  if m.created_at > now() - interval '30 seconds' or (not me_in and other_in) then
    perform public.pokejam_ranked_apply(m.id, 'leave', me, true); -- an early leave, or the late dodge: I never showed up
  elsif me_in and not other_in then
    perform public.pokejam_ranked_apply(m.id, 'leave', other, true); -- I waited, they never came: they dodged, I lose nothing
  end if; -- both showed up and the link failed: nobody is charged
end $$;

-- ---------- privileges ----------
revoke all on function
  public.pokejam_ranked_require_member(), public.pokejam_ranked_report_score(uuid,int,int), public.pokejam_report_result(uuid,boolean),
  public.pokejam_ranked_forfeit(uuid), public.pokejam_ranked_find(uuid), public.pokejam_ranked_verdict(public.pokejam_matches,uuid),
  public.pokejam_leave_match(uuid)
  from public, anon, authenticated;
grant execute on function public.pokejam_ranked_report_score(uuid,int,int), public.pokejam_report_result(uuid,boolean),
  public.pokejam_ranked_forfeit(uuid), public.pokejam_leave_match(uuid)
  to authenticated;
