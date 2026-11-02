-- PokeJam: a coin flip picks the host of a queue match, in Ranked and Social (anti-cheat PR 2).
-- Until now the player who queued first always hosted, so a modified client could choose to be host by queueing and
-- waiting. Additive and safe to re-run: both functions are "create or replace", which keeps their grants. Private
-- rooms (pokejam_create_room) are unchanged: whoever made the room still hosts.
--
-- Nothing else depends on queue order: lookups use "me in (host, guest)" and heartbeats are per side. The Social draft
-- has its own coin flip for who picks first (pokejam_drafts.first), so the host gets no draft advantage.

-- The Ranked path of pokejam_find_match: the 20261114 body, with a coin flip for the host.
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

-- As 20261112, with a coin flip for the host.
create or replace function public.pokejam_find_match(p_queue text)
returns uuid language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); my public.pokejam_profiles; q public.pokejam_queue; other public.pokejam_queue; mid uuid; win int; flip boolean;
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
  flip := random() < 0.5; -- true: the player who queued first hosts
  insert into public.pokejam_matches(queue, host, guest, host_mmr, guest_mmr, seed, quarter_len)
    values (p_queue,
      case when flip then other.user_id else me end,
      case when flip then me else other.user_id end,
      case when flip then other.mmr else my.mmr end,
      case when flip then my.mmr else other.mmr end,
      public.pokejam_new_seed(), 120) returning id into mid;
  delete from public.pokejam_queue where user_id in (me, other.user_id);
  return mid;
end $$;
