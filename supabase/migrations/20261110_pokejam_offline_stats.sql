-- PokeJam: anonymous counts of OFFLINE games (Quick Play, franchise, Season Draft) for the moderators' Stats panel.
-- Shared gauntlet-legends project: pokejam_* only. Additive: one table and two new functions; nothing else changes.
--
-- The game (src/telemetry/offlineStats.ts) logs a game start, a game finish (played / watched / simmed) and a
-- finished season (how far the team went), tagged with a random id kept in the player's browser. No account, name
-- or IP is stored. Nobody can read or write the table directly; inserts go through pokejam_log_offline, which
-- validates every field and drops anything past its rate limits without an error.
-- playoff_round: 0 = missed the playoffs, 1 = semifinal, 2 = lost the final, 3 = champion.

create table if not exists public.pokejam_offline_events (
  id bigserial primary key,
  created_at timestamptz not null default now(),
  device_id uuid not null,
  event text not null check (event in ('start', 'finish', 'season')),
  mode text not null check (mode in ('quick', 'franchise', 'season_draft')),
  resolution text check (resolution in ('played', 'watched', 'simmed')),
  season int check (season between 0 and 1000),
  playoff_round int check (playoff_round between 0 and 10),
  meta jsonb check (meta is null or pg_column_size(meta) <= 1024)
);
create index if not exists pokejam_offline_events_created on public.pokejam_offline_events (created_at);
create index if not exists pokejam_offline_events_device on public.pokejam_offline_events (device_id, created_at);
alter table public.pokejam_offline_events enable row level security;
revoke all on public.pokejam_offline_events from public, anon, authenticated;
revoke all on sequence public.pokejam_offline_events_id_seq from public, anon, authenticated;

-- Anyone may log (the game is mostly played signed out). Limits, past which events are silently dropped:
-- 30 per device per 10 minutes, 300 per device per day, 20000 in total per hour.
create or replace function public.pokejam_log_offline(p_device uuid, p_event text, p_mode text, p_resolution text default null,
  p_season int default null, p_playoff_round int default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  if p_device is null or coalesce(p_event, '') not in ('start', 'finish', 'season')
     or coalesce(p_mode, '') not in ('quick', 'franchise', 'season_draft') then return; end if;
  if p_event = 'finish' and coalesce(p_resolution, '') not in ('played', 'watched', 'simmed') then return; end if;
  if (select count(*) from (select 1 from public.pokejam_offline_events
        where device_id = p_device and created_at > now() - interval '10 minutes' limit 30) x) >= 30 then return; end if;
  if (select count(*) from (select 1 from public.pokejam_offline_events
        where device_id = p_device and created_at > now() - interval '1 day' limit 300) x) >= 300 then return; end if;
  if (select count(*) from (select 1 from public.pokejam_offline_events
        where created_at > now() - interval '1 hour' limit 20000) x) >= 20000 then return; end if;
  insert into public.pokejam_offline_events(device_id, event, mode, resolution, season, playoff_round)
  values (p_device, p_event, p_mode,
    case when p_event = 'finish' then p_resolution end,
    case when p_event = 'season' and p_season is not null then least(greatest(p_season, 0), 1000) end,
    case when p_event = 'season' then least(greatest(coalesce(p_playoff_round, 0), 0), 10) end);
end $$;

-- Moderators only (same check as 20261031 / 20261109); "today" is the America/Los_Angeles day, as in pokejam_admin_stats.
create or replace function public.pokejam_admin_offline_stats()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  day0 timestamptz := date_trunc('day', now() at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles';
  r jsonb;
begin
  perform public.pokejam_require_admin();
  with e as (select * from public.pokejam_offline_events),
  t as (select * from e where created_at >= day0),
  by_mode as (select mode, count(*) filter (where event = 'start') as started, count(*) filter (where event = 'finish') as finished
              from e group by mode),
  by_mode_t as (select mode, count(*) filter (where event = 'start') as started, count(*) filter (where event = 'finish') as finished
                from t group by mode),
  seasons as (select mode, count(*) as seasons, count(*) filter (where playoff_round > 0) as playoffs,
                count(*) filter (where playoff_round >= 3) as titles from e where event = 'season' group by mode),
  seasons_t as (select mode, count(*) as seasons, count(*) filter (where playoff_round > 0) as playoffs,
                count(*) filter (where playoff_round >= 3) as titles from t where event = 'season' group by mode)
  select jsonb_build_object(
    'players_today', (select count(distinct device_id) from t),
    'players_7d', (select count(distinct device_id) from e where created_at >= now() - interval '7 days'),
    'players_all', (select count(distinct device_id) from e),
    'games_today', coalesce((select jsonb_object_agg(mode, jsonb_build_object('started', started, 'finished', finished)) from by_mode_t), '{}'),
    'games_all', coalesce((select jsonb_object_agg(mode, jsonb_build_object('started', started, 'finished', finished)) from by_mode), '{}'),
    'finish_today', jsonb_build_object('played', (select count(*) from t where event = 'finish' and resolution = 'played'),
      'watched', (select count(*) from t where event = 'finish' and resolution = 'watched'),
      'simmed', (select count(*) from t where event = 'finish' and resolution = 'simmed')),
    'finish_all', jsonb_build_object('played', (select count(*) from e where event = 'finish' and resolution = 'played'),
      'watched', (select count(*) from e where event = 'finish' and resolution = 'watched'),
      'simmed', (select count(*) from e where event = 'finish' and resolution = 'simmed')),
    'seasons_today', coalesce((select jsonb_object_agg(mode, jsonb_build_object('seasons', seasons, 'playoffs', playoffs, 'titles', titles)) from seasons_t), '{}'),
    'seasons_all', coalesce((select jsonb_object_agg(mode, jsonb_build_object('seasons', seasons, 'playoffs', playoffs, 'titles', titles)) from seasons), '{}'),
    'first_event_at', (select min(created_at) from e),
    'today_starts', day0,
    'generated_at', now()) into r;
  return r;
end $$;

revoke all on function public.pokejam_log_offline(uuid, text, text, text, int, int), public.pokejam_admin_offline_stats()
  from public, anon, authenticated;
grant execute on function public.pokejam_log_offline(uuid, text, text, text, int, int) to anon, authenticated;
grant execute on function public.pokejam_admin_offline_stats() to authenticated;
