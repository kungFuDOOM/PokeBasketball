-- PokeJam: crash reports from players' browsers (src/telemetry/errors.ts). Shared gauntlet-legends project:
-- pokejam_* only.
--
-- One row per distinct error per day, with a count, so a crash that hits every player is one row, not thousands.
-- Anyone can report (the game is mostly played signed out), so the function trims every field, never stores
-- more than MAX_A_DAY distinct errors a day, and players can't read anything back. The admin reads them with the
-- service role (or the moderation page).

create table if not exists public.pokejam_errors (
  fingerprint text not null,
  day date not null default current_date,
  count int not null default 1,
  message text not null,
  stack text,
  path text,
  build text,
  ua text,
  first_at timestamptz not null default now(),
  last_at timestamptz not null default now(),
  primary key (fingerprint, day)
);
alter table public.pokejam_errors enable row level security;
revoke all on public.pokejam_errors from anon, authenticated, public;

create or replace function public.pokejam_report_error(p_message text, p_stack text default null, p_path text default null,
  p_build text default null, p_ua text default null)
returns void language plpgsql security definer set search_path = public as $$
declare msg text := left(coalesce(nullif(btrim(p_message), ''), 'unknown error'), 300);
        st text := left(p_stack, 2000);
        -- The same error is the same message thrown from the same place (the stack's first line).
        fp text := md5(msg || '|' || coalesce(split_part(coalesce(st, ''), E'\n', 1), ''));
        max_a_day constant int := 2000;
begin
  update public.pokejam_errors set count = count + 1, last_at = now() where fingerprint = fp and day = current_date;
  if found then return; end if;
  if (select count(*) from public.pokejam_errors where day = current_date) >= max_a_day then return; end if;
  insert into public.pokejam_errors(fingerprint, message, stack, path, build, ua)
    values (fp, msg, st, left(p_path, 200), left(p_build, 40), left(p_ua, 200))
    on conflict (fingerprint, day) do update set count = pokejam_errors.count + 1, last_at = now();
end $$;

-- Admin (service role): the day's errors, most frequent first.
create or replace function public.pokejam_error_summary(p_days int default 1)
returns setof public.pokejam_errors language sql stable security definer set search_path = public as $$
  select * from public.pokejam_errors where day > current_date - greatest(1, p_days) order by count desc, last_at desc limit 200;
$$;

-- Old reports go after 30 days (the evidence prune job's schedule is reused if pg_cron is on).
create or replace function public.pokejam_prune_errors(p_days int default 30)
returns int language plpgsql security definer set search_path = public as $$
declare n int;
begin
  delete from public.pokejam_errors where day < current_date - greatest(1, p_days);
  get diagnostics n = row_count;
  return n;
end $$;

revoke all on function public.pokejam_report_error(text, text, text, text, text), public.pokejam_error_summary(int),
  public.pokejam_prune_errors(int) from public, anon, authenticated;
grant execute on function public.pokejam_report_error(text, text, text, text, text) to anon, authenticated;
grant execute on function public.pokejam_error_summary(int), public.pokejam_prune_errors(int) to service_role;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('pokejam-prune-errors') where exists (select 1 from cron.job where jobname = 'pokejam-prune-errors');
    perform cron.schedule('pokejam-prune-errors', '25 4 * * *', 'select public.pokejam_prune_errors(30)');
  end if;
end $$;
