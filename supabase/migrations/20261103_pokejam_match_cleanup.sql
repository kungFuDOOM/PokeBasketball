-- PokeJam Social: call off abandoned matches. Shared gauntlet-legends project: pokejam_* only (plus one pg_cron job
-- named pokejam-cleanup-matches, if pg_cron is enabled). Safe to run again.
--
-- A player who closes the tab or crashes never calls pokejam_leave_match, so their Social match stayed 'active'
-- forever (the 32-client load test left 15 of 16 that way). pokejam_cleanup_matches voids them, conservatively, so a
-- game in progress is never touched:
-- - a Social draft that never finished and that neither player has looked at for 2 minutes (both clients poll the
--   draft every 0.7 s while it runs, and wait at most 2 minutes for a player who hasn't shown up);
-- - any Social match still 'active' an hour after it was made. A whole game is far shorter: the draft is at most
--   3 + 10 x 12 s, plus up to 2 minutes waiting for a room's host, joining the channel at most 55 s, and a game with
--   2-minute quarters runs 513-538 s of game time from tip-off to the final buzzer (measured on the engine), plus
--   one minute per overtime. An hour is more than three times the longest of these;
-- - a room nobody joined for 30 minutes (pokejam_join_room refuses those already).
-- Ranked matches are never touched here: they keep their own 2-hour rule in pokejam_report_result.
-- Matches are voided exactly like pokejam_leave_match does it (status 'void', finished_at), so no result or rating
-- logic changes.

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
          and greatest(d.created_at, d.host_seen, d.guest_seen) < now() - interval '2 minutes'))
    for update of m skip locked
  )
  update public.pokejam_matches m set status = 'void', finished_at = now() from stale where m.id = stale.id;
  get diagnostics n = row_count;
  return n;
end $$;

-- When the cleanup last ran (so matchmaking can run it at most once a minute).
create table if not exists public.pokejam_jobs (
  name text primary key,
  ran_at timestamptz not null
);
alter table public.pokejam_jobs enable row level security;
revoke all on public.pokejam_jobs from anon, authenticated, public;
insert into public.pokejam_jobs(name, ran_at) values ('cleanup', '-infinity') on conflict (name) do nothing;

-- Matchmaking calls this on the way: the cleanup runs if it hasn't for a minute. A caller that finds another one
-- running it skips it instead of waiting.
create or replace function public.pokejam_cleanup_maybe()
returns void language plpgsql security definer set search_path = public as $$
begin
  perform 1 from public.pokejam_jobs where name = 'cleanup' and ran_at < now() - interval '1 minute' for update skip locked;
  if not found then return; end if;
  update public.pokejam_jobs set ran_at = now() where name = 'cleanup';
  perform public.pokejam_cleanup_matches();
end $$;

revoke all on function public.pokejam_cleanup_matches(), public.pokejam_cleanup_maybe() from public, anon, authenticated;
grant execute on function public.pokejam_cleanup_matches() to service_role;

-- And every 5 minutes where pg_cron is enabled, for the quiet hours when nobody is matchmaking.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('pokejam-cleanup-matches') where exists (select 1 from cron.job where jobname = 'pokejam-cleanup-matches');
    perform cron.schedule('pokejam-cleanup-matches', '*/5 * * * *', 'select public.pokejam_cleanup_matches()');
  end if;
end $$;
