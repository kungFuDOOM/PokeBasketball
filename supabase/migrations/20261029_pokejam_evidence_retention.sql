-- PokeJam online: keep signed evidence only where it's needed, and not forever. Shared gauntlet-legends project:
-- pokejam_* only (plus one pg_cron job named pokejam-prune-evidence, if pg_cron is enabled).
--
-- An upload is about 0.5 MB per player per game. Social matches are neither rated nor paid, so nothing ever
-- judges them: the client doesn't collect evidence for them, and the server now refuses Social uploads, so a
-- modified client can't fill the database either. Ranked (and Pack Battles, when it moves here) keep theirs for
-- EVIDENCE_DAYS, long enough to judge and to review a dispute; pokejam_prune_evidence deletes older uploads.

-- Upload my evidence for a rated match I played (once; later uploads are ignored). True when it was stored;
-- false for a Social match (kept nowhere).
create or replace function public.pokejam_submit_evidence(p_match uuid, p_evidence text)
returns boolean language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); m public.pokejam_matches;
begin
  if me is null then raise exception 'not signed in'; end if;
  select * into m from public.pokejam_matches where id = p_match;
  if m.id is null or me not in (m.host, m.guest) or m.created_at < now() - interval '6 hours' then raise exception 'not in this match'; end if;
  if m.queue = 'social' then return false; end if;
  if p_evidence is null or p_evidence not like 'gz1:%' or octet_length(p_evidence) > 4000000 then raise exception 'bad evidence'; end if;
  insert into public.pokejam_match_evidence(match_id, user_id, evidence) values (p_match, me, p_evidence)
    on conflict (match_id, user_id) do nothing;
  return found;
end $$;

-- Service role (daily): delete uploads older than p_days (default 30). Returns how many were deleted.
create or replace function public.pokejam_prune_evidence(p_days int default 30)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from public.pokejam_match_evidence where created_at < now() - make_interval(days => greatest(1, p_days));
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.pokejam_prune_evidence(int) from public, anon, authenticated;
grant execute on function public.pokejam_prune_evidence(int) to service_role;

-- Run it daily at 04:20 UTC where pg_cron is enabled (otherwise schedule it however the project runs jobs).
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('pokejam-prune-evidence') where exists (select 1 from cron.job where jobname = 'pokejam-prune-evidence');
    perform cron.schedule('pokejam-prune-evidence', '20 4 * * *', 'select public.pokejam_prune_evidence(30)');
  end if;
end $$;
