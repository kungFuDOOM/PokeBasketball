-- PokeJam Social: an in-game heartbeat, so a game both players have closed is called off in minutes, not an hour;
-- and stale queue rows are removed. Shared gauntlet-legends project: pokejam_* only. Safe to run again. No RPC changes
-- its name, arguments or result, so older clients (pokejam-test, Ranked) work unchanged and keep the old rules.
--
-- - pokejam_matches.host_alive / guest_alive: set by pokejam_match_alive, which a new client calls every 30 s while
--   its game runs (from the end of the draft until the game ends). Older clients never call it, so these stay null.
-- - pokejam_cleanup_matches (20261103) also voids an active Social match where BOTH players have sent a heartbeat and
--   NEITHER has for 3 minutes (6 beats missed by each). Either side still beating keeps the match; a match with a
--   player on an older client (a null column) keeps the 60-minute rule. A game that is really on has both players
--   beating; a player who loses the other one for 15 s ends the game and leaves the match anyway.
-- - pokejam_queue rows not refreshed for 2 minutes are deleted. A searching client refreshes its row every 2 s and
--   quick match ignores rows older than 15 s, so these are only leftovers from closed tabs.

alter table public.pokejam_matches add column if not exists host_alive timestamptz;
alter table public.pokejam_matches add column if not exists guest_alive timestamptz;

-- I'm still in this game. Returns the match's status (null if it isn't mine). Writes at most every 10 s per player.
create or replace function public.pokejam_match_alive(p_match uuid)
returns text language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); st text;
begin
  if me is null then raise exception 'not signed in'; end if;
  update public.pokejam_matches m set
    host_alive = case when me = m.host then now() else m.host_alive end,
    guest_alive = case when me = m.guest then now() else m.guest_alive end
  where m.id = p_match and m.queue = 'social' and m.status = 'active' and me in (m.host, m.guest)
    and coalesce(case when me = m.host then m.host_alive else m.guest_alive end, '-infinity') < now() - interval '10 seconds';
  select status into st from public.pokejam_matches where id = p_match and me in (host, guest);
  return st;
end $$;

-- As in 20261103, plus the heartbeat rule and the stale queue rows. Still returns the number of matches voided.
create or replace function public.pokejam_cleanup_matches()
returns int language plpgsql security definer set search_path = public as $$
declare n int;
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
  delete from public.pokejam_queue where last_seen < now() - interval '2 minutes';
  return n;
end $$;

revoke all on function public.pokejam_match_alive(uuid), public.pokejam_cleanup_matches() from public, anon, authenticated;
grant execute on function public.pokejam_match_alive(uuid) to authenticated;
grant execute on function public.pokejam_cleanup_matches() to service_role;
