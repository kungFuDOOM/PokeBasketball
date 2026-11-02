-- PokeJam online: run pokejam-judge-worker every minute (anti-cheat PR 7). Shared gauntlet-legends project: pokejam_* only.
-- Safe to run anywhere and to run again: it only schedules when pg_cron, pg_net and both vault secrets are there, and
-- otherwise says how to do it by hand. No key is stored in SQL; the job reads the vault each time it runs.
--
-- Vault secrets (the same service key as the Pack Battles workers, see supabase/functions/README.md):
--   pokejam_service_key    the service role key
--   pokejam_functions_url  e.g. https://<project ref>.supabase.co/functions/v1
--
-- An idle minute costs no Edge Function call: the job only posts when a job is ready. It can double-run; the lease in
-- pokejam_judge_claim handles that. Each run judges one match, so this tops out at 60 matches an hour; the admin panel's
-- backlog age shows when that stops being enough.
do $$
declare
  job text := $cron$
    select net.http_post(
      url := (select decrypted_secret from vault.decrypted_secrets where name = 'pokejam_functions_url') || '/pokejam-judge-worker',
      headers := jsonb_build_object('content-type', 'application/json',
        'authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'pokejam_service_key')),
      body := '{}'::jsonb,
      timeout_milliseconds := 60000)
    where exists (select 1 from public.pokejam_judge_jobs j
      where j.attempts < 5 and ((j.state = 'pending' and j.ready_at <= now()) or (j.state = 'running' and j.locked_until < now())))
  $cron$;
  ready boolean := false;
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') and exists (select 1 from pg_extension where extname = 'pg_net')
    and to_regclass('vault.decrypted_secrets') is not null then
    execute $q$select count(*) = 2 from vault.decrypted_secrets where name in ('pokejam_service_key', 'pokejam_functions_url')$q$ into ready;
  end if;
  if ready then
    perform cron.unschedule('pokejam-judge-worker') where exists (select 1 from cron.job where jobname = 'pokejam-judge-worker');
    perform cron.schedule('pokejam-judge-worker', '* * * * *', job);
  else
    raise notice 'pokejam-judge-worker not scheduled: it needs pg_cron, pg_net and the vault secrets pokejam_service_key and pokejam_functions_url. Add them, then run this migration again.';
  end if;
end $$;
