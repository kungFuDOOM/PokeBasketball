-- PokeJam: per-match net stats for cost and resyncs (anti-cheat plan PR 1). Shared gauntlet-legends project: pokejam_* only.
-- Additive and safe to run again: new columns on pokejam_match_net_stats (20261108), all with defaults, so older
-- clients' inserts keep working, plus one moderators-only RPC (same check as 20261031).
--
-- Rows are self-reported by each player's client: fine for estimating cost, never used to judge anyone.
-- browser_engine 'unknown' = a row from an older client that did not report the new fields (kept apart from 'other').

alter table public.pokejam_match_net_stats
  add column if not exists sent_realtime int not null default 0 check (sent_realtime between 0 and 10000000),
  add column if not exists sent_direct int not null default 0 check (sent_direct between 0 and 10000000),
  add column if not exists realtime_inputs int not null default 0 check (realtime_inputs between 0 and 10000000),
  add column if not exists received int not null default 0 check (received between 0 and 10000000),
  add column if not exists dropped int not null default 0 check (dropped between 0 and 10000000),
  add column if not exists resyncs int not null default 0 check (resyncs between 0 and 100000),
  add column if not exists browser_engine text not null default 'unknown'
    check (browser_engine in ('blink', 'gecko', 'webkit', 'other', 'unknown'));

-- Per Pacific day, newest first, for the last p_days days (1-90, today included):
--   matches          online matches that started (have a guest), by the match's created_at day
--   stat_rows        net-stats rows for those matches (each match can have up to 2, one per player)
--   coverage         stat_rows / (2 * matches); match_coverage = matches with at least one row / matches
--   reporting_rows   rows from clients that send the new fields (browser_engine <> 'unknown'); the per-match
--                    message figures and avg_resyncs use only these, so old clients' zeros don't deflate them
--   fallback_rate    share of rows that leaned on the Realtime fallback for inputs
--   rt_msgs_per_match  Realtime messages sent per match by both players: sum(sent_realtime) / reporting_rows * 2,
--                    which scales up matches where only one side reported. Undercounts a little: setup, signalling
--                    and presence traffic is not in sent_realtime.
--   rt_msgs_billed   rt_msgs_per_match * 2 (Supabase Realtime bills a broadcast once sent and once received)
--   turn_bytes_est   estimate of TURN relay bytes from the rows that went through a relay (relay_protocol <> 'unknown'):
--                    sum(sent_direct) * turn_msg_bytes * 2 (a relayed packet passes the relay in and out).
--                    turn_msg_bytes is a constant (about 60 B input batch + 28 B DTLS/SCTP/UDP), returned so it can be tuned.
--   engines          rows per browser engine; avg_resyncs, resync_matches (matches whose rows add up to resyncs > 0)
-- A day without matches returns zeros and nulls, never a divide-by-zero error.
create or replace function public.pokejam_admin_net_cost(p_days int default 7)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  turn_msg_bytes constant int := 88;
  n int := greatest(1, least(coalesce(p_days, 7), 90));
  today date := (now() at time zone 'America/Los_Angeles')::date;
begin
  perform public.pokejam_require_admin();
  return coalesce((
    with days as (select (today - k)::date as day from generate_series(0, n - 1) k),
    m as (select id, (created_at at time zone 'America/Los_Angeles')::date as day from public.pokejam_matches
          where guest is not null and (created_at at time zone 'America/Los_Angeles')::date > today - n),
    s as (select m.day, x.* from m join public.pokejam_match_net_stats x on x.match_id = m.id),
    per_match as (select day, match_id, sum(resyncs) as resyncs from s group by day, match_id),
    agg as (
      select d.day,
        (select count(*) from m where m.day = d.day) as matches,
        (select count(*) from s where s.day = d.day) as stat_rows,
        (select count(*) from per_match p where p.day = d.day) as matches_with_row,
        (select count(*) from s where s.day = d.day and s.browser_engine <> 'unknown') as reporting_rows,
        (select count(*) from s where s.day = d.day and s.used_realtime_fallback) as fallback_rows,
        (select coalesce(sum(s.sent_realtime), 0) from s where s.day = d.day and s.browser_engine <> 'unknown') as sent_rt,
        (select coalesce(sum(s.sent_direct::bigint), 0) from s where s.day = d.day and s.relay_protocol <> 'unknown') as sent_relayed,
        (select coalesce(sum(s.resyncs), 0) from s where s.day = d.day and s.browser_engine <> 'unknown') as resyncs,
        (select count(*) from per_match p where p.day = d.day and p.resyncs > 0) as resync_matches,
        (select jsonb_build_object(
           'blink', count(*) filter (where s.browser_engine = 'blink'), 'gecko', count(*) filter (where s.browser_engine = 'gecko'),
           'webkit', count(*) filter (where s.browser_engine = 'webkit'), 'other', count(*) filter (where s.browser_engine = 'other'),
           'unknown', count(*) filter (where s.browser_engine = 'unknown'))
         from s where s.day = d.day) as engines
      from days d)
    select jsonb_agg(jsonb_build_object(
        'day', a.day,
        'matches', a.matches,
        'stat_rows', a.stat_rows,
        'reporting_rows', a.reporting_rows,
        'coverage', round(a.stat_rows::numeric / nullif(2 * a.matches, 0), 3),
        'match_coverage', round(a.matches_with_row::numeric / nullif(a.matches, 0), 3),
        'fallback_rate', round(a.fallback_rows::numeric / nullif(a.stat_rows, 0), 3),
        'rt_msgs_per_match', round(a.sent_rt::numeric / nullif(a.reporting_rows, 0) * 2, 1),
        'rt_msgs_billed', round(a.sent_rt::numeric / nullif(a.reporting_rows, 0) * 4, 1),
        'turn_bytes_est', a.sent_relayed * turn_msg_bytes * 2,
        'turn_msg_bytes', turn_msg_bytes,
        'engines', a.engines,
        'avg_resyncs', round(a.resyncs::numeric / nullif(a.reporting_rows, 0), 3),
        'resync_matches', a.resync_matches)
      order by a.day desc)
    from agg a), '[]'::jsonb);
end $$;

revoke all on function public.pokejam_admin_net_cost(int) from public, anon, authenticated;
grant execute on function public.pokejam_admin_net_cost(int) to authenticated;
