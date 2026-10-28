-- PokeJam Social: a new search never hands back a match the player already left. Shared gauntlet-legends project:
-- pokejam_* only. Safe to run again. pokejam_find_match keeps its name, argument, result and grants, so older clients
-- (pokejam-test, Ranked too) work unchanged.
--
-- Why: find_match returns the caller's own fresh 'active' match, which is how a queued player learns the other one
-- paired with them. A player whose tab was closed or crashed mid-game still had that match 'active' (until the
-- heartbeat cleanup, 3-5 minutes later), so their next quick search was handed the dead match: "NO CONNECTION".
--
-- - A match counts as opened by me once I have looked at its draft (pokejam_drafts.<my side>_seen) or sent a game
--   heartbeat. A paired-but-unopened match is still returned, exactly as before.
-- - find_match never returns a match I opened. The client never resumes a game through find_match (it has no match id
--   argument), so a search from a player with an opened match means they left it.
-- - Such a match is voided like pokejam_leave_match does it (status 'void', finished_at), so the opponent sees
--   "Opponent left". Only the caller's own Social matches whose last sign of life from the caller is over 10 seconds
--   old: the margin keeps a late retry of an old poll from voiding a game that has just opened.
-- - Other players' matches are never touched, and matches with a null heartbeat (older clients) of other players
--   keep the rules of 20261103/20261106. A match of an older client with no draft row can't be told apart from a
--   fresh pairing and is still returned for up to 2 minutes, as before.

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

revoke all on function public.pokejam_find_match(text) from public, anon, authenticated;
grant execute on function public.pokejam_find_match(text) to authenticated;
