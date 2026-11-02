-- PokeJam online: the judge queue, in shadow mode (anti-cheat PR 7). Shared gauntlet-legends project: pokejam_* only.
-- Additive: one new table, two triggers, three functions, one defaulted column on pokejam_match_verdicts.
--
-- Every Ranked match that ends gets one job. The pokejam-judge-worker Edge Function claims one job per run, replays the
-- match from its uploads and saves the verdict. Shadow mode: nothing here touches a rating, a winner or a match status.
-- The admin panel compares verdicts with what the players reported, and that data decides when the judge may decide.
--
-- When a job is ready: both uploads are in, or 90 s after the last report or the end of the match. Until then the
-- players may still be uploading.

create table if not exists public.pokejam_judge_jobs (
  match_id uuid primary key references public.pokejam_matches(id) on delete cascade,
  -- Why the match needs judging, as known when it was last updated. Informational in shadow mode. 'every', 'resync' and
  -- 'desync' are not set yet: PR 8 and PR 10 add those triggers.
  reason text not null check (reason in ('every','disagree','one_sided','resync','desync','report')),
  state text not null default 'pending' check (state in ('pending','running','done','failed')),
  ready_at timestamptz not null,
  attempts int not null default 0,
  locked_until timestamptz,
  claimed_at timestamptz,
  -- Saved progress for a judge that can't finish in one run. Unused: PR 5 measured one run to be enough.
  checkpoint jsonb,
  -- A late upload may reopen a finished job until then: 10 minutes after a finish with an 'incomplete' verdict or none.
  rejudge_until timestamptz,
  -- This run must replace the existing verdict: a late upload reopened the job.
  rejudge boolean not null default false,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
alter table public.pokejam_judge_jobs enable row level security;
revoke all on public.pokejam_judge_jobs from anon, authenticated, public;

create index if not exists pokejam_judge_jobs_ready on public.pokejam_judge_jobs (ready_at) where state in ('pending', 'running');

-- True on every verdict until the judge's verdicts decide results (PR 8).
alter table public.pokejam_match_verdicts add column if not exists shadow boolean not null default true;

-- A report or the end of a Ranked match: make the job, or push back one still waiting so the deadline is 90 s after the
-- LAST report. Host-only reports get a verdict through this too: nothing else ever settles them.
create or replace function public.pokejam_judge_enqueue()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  why text := case
    when new.host_report is not null and new.guest_report is not null and new.host_report <> new.guest_report then 'disagree'
    when new.host_report is not null or new.guest_report is not null then 'report'
    else 'one_sided' end;
  ready timestamptz := case
    when (select count(*) from public.pokejam_match_evidence e where e.match_id = new.id) >= 2 then now()
    else now() + interval '90 seconds' end;
begin
  insert into public.pokejam_judge_jobs as j(match_id, reason, ready_at) values (new.id, why, ready)
    on conflict (match_id) do update set reason = excluded.reason, ready_at = excluded.ready_at where j.state = 'pending';
  return null;
end $$;

drop trigger if exists pokejam_judge_enqueue on public.pokejam_matches;
create trigger pokejam_judge_enqueue
  after update of host_report, guest_report, status on public.pokejam_matches
  for each row when (new.queue = 'ranked' and (
    old.host_report is distinct from new.host_report
    or old.guest_report is distinct from new.guest_report
    or (old.status = 'active' and new.status in ('done', 'void'))))
  execute function public.pokejam_judge_enqueue();

-- An upload arrived. Both in: no reason to wait. Job already finished without a usable verdict: judge it again. A second
-- run is bounded, because each player can only upload once. Attempts restart so an earlier failure can't use up this run.
create or replace function public.pokejam_judge_upload()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.pokejam_judge_jobs set ready_at = now()
    where match_id = new.match_id and state = 'pending' and ready_at > now()
      and (select count(*) from public.pokejam_match_evidence e where e.match_id = new.match_id) >= 2;
  update public.pokejam_judge_jobs
    set state = 'pending', ready_at = now(), rejudge = true, rejudge_until = null, attempts = 0, finished_at = null
    where match_id = new.match_id and state = 'done' and rejudge_until > now();
  return null;
end $$;

drop trigger if exists pokejam_judge_upload on public.pokejam_match_evidence;
create trigger pokejam_judge_upload after insert on public.pokejam_match_evidence
  for each row execute function public.pokejam_judge_upload();

revoke all on function public.pokejam_judge_enqueue(), public.pokejam_judge_upload() from public, anon, authenticated;

-- Service role (the worker): lease up to p_n ready jobs for 2 minutes. A run that dies leaves the lease to expire, and
-- the job is claimed again until its 5 attempts are used up. Jobs with no uploads are closed here without using a run:
-- with one match per run, games nobody uploaded for (a dodge, say) must not hold up games that can be judged.
create or replace function public.pokejam_judge_claim(p_n int default 1)
returns setof public.pokejam_judge_jobs language plpgsql security definer set search_path = public as $$
begin
  update public.pokejam_judge_jobs set state = 'failed', finished_at = now(), locked_until = null
    where attempts >= 5 and (state = 'pending' or (state = 'running' and locked_until < now()));
  update public.pokejam_judge_jobs j set state = 'done', finished_at = now(), rejudge_until = now() + interval '10 minutes'
    where j.state = 'pending' and j.ready_at <= now()
      and not exists (select 1 from public.pokejam_match_evidence e where e.match_id = j.match_id);
  return query
    with c as (
      select j.match_id from public.pokejam_judge_jobs j
      where j.attempts < 5 and ((j.state = 'pending' and j.ready_at <= now()) or (j.state = 'running' and j.locked_until < now()))
      order by j.ready_at, j.match_id
      limit greatest(coalesce(p_n, 1), 0)
      for update skip locked)
    update public.pokejam_judge_jobs j
      set state = 'running', attempts = j.attempts + 1, locked_until = now() + interval '2 minutes', claimed_at = now()
      from c where j.match_id = c.match_id
      returning j.*;
end $$;

-- Service role (the worker): a run ended. Returns the job's new state, or null when there is no such job. A job that
-- isn't running is left alone: the run's lease had expired and another run took over.
--   p_ok true:  done, and open to a late upload for 10 minutes if the verdict is 'incomplete' or there is none. If an
--               upload arrived during that run (too late for it to read), judge again straight away.
--   p_ok false: back in the queue after a minute, or failed once the attempts are used up.
create or replace function public.pokejam_judge_finish(p_match uuid, p_ok boolean, p_checkpoint jsonb default null)
returns text language plpgsql security definer set search_path = public as $$
declare j public.pokejam_judge_jobs; verdict text; open_to_late boolean;
begin
  select * into j from public.pokejam_judge_jobs where match_id = p_match for update;
  if j.match_id is null then return null; end if;
  if j.state <> 'running' then return j.state; end if;
  if not coalesce(p_ok, false) then
    update public.pokejam_judge_jobs set
        state = case when j.attempts >= 5 then 'failed' else 'pending' end,
        ready_at = now() + interval '1 minute', locked_until = null, checkpoint = coalesce(p_checkpoint, checkpoint),
        finished_at = case when j.attempts >= 5 then now() end
      where match_id = p_match returning * into j;
    return j.state;
  end if;
  select v.status into verdict from public.pokejam_match_verdicts v where v.match_id = p_match;
  open_to_late := verdict is null or verdict = 'incomplete';
  if open_to_late and exists (select 1 from public.pokejam_match_evidence e where e.match_id = p_match and e.created_at > j.claimed_at) then
    update public.pokejam_judge_jobs set state = 'pending', ready_at = now(), rejudge = true, locked_until = null, attempts = 0
      where match_id = p_match returning * into j;
    return j.state;
  end if;
  update public.pokejam_judge_jobs set state = 'done', finished_at = now(), locked_until = null, rejudge = false,
      checkpoint = coalesce(p_checkpoint, checkpoint),
      rejudge_until = case when open_to_late then now() + interval '10 minutes' end
    where match_id = p_match returning * into j;
  return j.state;
end $$;

revoke all on function public.pokejam_judge_claim(int), public.pokejam_judge_finish(uuid, boolean, jsonb) from public, anon, authenticated;
grant execute on function public.pokejam_judge_claim(int), public.pokejam_judge_finish(uuid, boolean, jsonb) to service_role;

-- Moderators: does the judge agree with the players? Ranked shadow verdicts, per Pacific day the verdict was made
-- (newest first, p_days 1-90, today included) and per the HOST's browser engine, since the host's snapshots are what a
-- guest adopts on a resync. 'unknown': the host's client sent no net stats, or an older client's row.
--   n              verdicts; final_n / incomplete_n / forfeit_n / invalid_n split them by status
--   agree_n, disagree_n  final verdicts whose winner equals / differs from the match's winner. Worked out here, not
--                  read from the stored `agrees`: a job can run before the second report settles the match, and a void
--                  match has no winner, so it counts as neither.
--   agree_rate     agree_n / (agree_n + disagree_n)
--   resync_matches, resync_disagree_n  matches where the players' stats add up to resyncs > 0, and those that disagree
-- backlog: jobs by state, the age in seconds of the oldest ready job (null if none), and `unjudged`, jobs of the period
-- that ended with no verdict, mostly games nobody uploaded for.
create or replace function public.pokejam_admin_judge_shadow(p_days int default 7)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare
  n int := greatest(1, least(coalesce(p_days, 7), 90));
  today date := (now() at time zone 'America/Los_Angeles')::date;
begin
  perform public.pokejam_require_admin();
  return jsonb_build_object(
    'rows', coalesce((
      with v as (
        select (x.judged_at at time zone 'America/Los_Angeles')::date as day, x.status,
          coalesce((select s.browser_engine from public.pokejam_match_net_stats s where s.match_id = m.id and s.user_id = m.host), 'unknown') as engine,
          case when x.status = 'final' and x.winner_side is not null and m.winner is not null
            then (case x.winner_side when 0 then m.host else m.guest end) = m.winner end as agree,
          coalesce((select sum(s.resyncs) from public.pokejam_match_net_stats s where s.match_id = m.id), 0) > 0 as resynced
        from public.pokejam_match_verdicts x join public.pokejam_matches m on m.id = x.match_id
        where x.shadow and m.queue = 'ranked' and (x.judged_at at time zone 'America/Los_Angeles')::date > today - n)
      select jsonb_agg(r order by r.day desc, r.browser_engine) from (
        select day, engine as browser_engine, count(*) as n,
          count(*) filter (where status = 'final') as final_n,
          count(*) filter (where status = 'incomplete') as incomplete_n,
          count(*) filter (where status = 'forfeit') as forfeit_n,
          count(*) filter (where status = 'invalid') as invalid_n,
          count(*) filter (where agree) as agree_n,
          count(*) filter (where not agree) as disagree_n,
          round((count(*) filter (where agree))::numeric / nullif(count(agree), 0), 3) as agree_rate,
          count(*) filter (where resynced) as resync_matches,
          count(*) filter (where resynced and not agree) as resync_disagree_n
        from v group by day, engine) r), '[]'::jsonb),
    'backlog', (
      select jsonb_build_object(
        'pending', count(*) filter (where j.state = 'pending'),
        'running', count(*) filter (where j.state = 'running'),
        'failed', count(*) filter (where j.state = 'failed'),
        'oldest_ready_s', round(extract(epoch from now() - min(j.ready_at) filter (where j.state = 'pending' and j.ready_at <= now()))),
        'unjudged', count(*) filter (where j.state = 'done' and (j.created_at at time zone 'America/Los_Angeles')::date > today - n
          and not exists (select 1 from public.pokejam_match_verdicts x where x.match_id = j.match_id)))
      from public.pokejam_judge_jobs j));
end $$;

revoke all on function public.pokejam_admin_judge_shadow(int) from public, anon, authenticated;
grant execute on function public.pokejam_admin_judge_shadow(int) to authenticated;
