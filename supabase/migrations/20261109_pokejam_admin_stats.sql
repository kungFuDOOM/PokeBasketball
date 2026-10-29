-- PokeJam: a private stats panel for the moderation page (admin.html). Shared gauntlet-legends project: pokejam_* only.
-- Safe to run again; adds one function and changes nothing else. Moderators only (same check as 20261031).
--
-- Only ONLINE games are on the server, so these numbers leave out solo, vs CPU and franchise games.
-- A "game" is a match that started: it has a guest (a room still waiting for one is not counted). "Today" is the
-- America/Los_Angeles calendar day. "Alive" is a heartbeat from 20261106 within the last 60 s (clients beat every 30 s).
create or replace function public.pokejam_admin_stats()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  day0 timestamptz := date_trunc('day', now() at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles';
  r jsonb;
begin
  perform public.pokejam_require_admin();
  with g as (select * from public.pokejam_matches where guest is not null),
  p as (select host as u, created_at from g union all select guest, created_at from g),
  live as (select * from g where status = 'active'
             and (coalesce(host_alive, '-infinity') > now() - interval '60 seconds' or coalesce(guest_alive, '-infinity') > now() - interval '60 seconds')),
  lp as (select host as u from live where coalesce(host_alive, '-infinity') > now() - interval '60 seconds'
         union select guest from live where coalesce(guest_alive, '-infinity') > now() - interval '60 seconds')
  select jsonb_build_object(
    'players_today', (select count(distinct u) from p where created_at >= day0),
    'players_7d', (select count(distinct u) from p where created_at >= now() - interval '7 days'),
    'players_all', (select count(distinct u) from p),
    'profiles_all', (select count(*) from public.pokejam_profiles),
    'games_today', (select count(*) from g where created_at >= day0),
    'games_today_finished', (select count(*) from g where created_at >= day0 and status = 'done'),
    'games_all', (select count(*) from g),
    'games_all_finished', (select count(*) from g where status = 'done'),
    'playing_now_matches', (select count(*) from live),
    'playing_now_players', (select count(*) from lp),
    'queue_now', (select count(*) from public.pokejam_queue where last_seen > now() - interval '15 seconds'),
    'today_starts', day0,
    'generated_at', now()) into r;
  return r;
end $$;

revoke all on function public.pokejam_admin_stats() from public, anon, authenticated;
grant execute on function public.pokejam_admin_stats() to authenticated;
