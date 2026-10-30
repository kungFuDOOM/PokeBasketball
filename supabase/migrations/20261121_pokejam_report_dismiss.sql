-- Moderation page: Dismiss. A moderator can clear a player's open reports without deleting them: dismissed_at and
-- dismissed_by are set, the player leaves the Reported list until someone reports them again, and dismissed reports
-- no longer count toward the 5-reporter auto-ban (an admin judged them invalid). Additive; same signatures and
-- grants for pokejam_admin_reports (body from 20261116) and pokejam_report_player (body from 20261025).

alter table public.pokejam_reports
  add column if not exists dismissed_at timestamptz,
  add column if not exists dismissed_by uuid references auth.users(id);
create index if not exists pokejam_reports_open_idx on public.pokejam_reports(reported) where dismissed_at is null;

-- Clear every open report on p_user. Logged; returns how many reports were cleared.
create or replace function public.pokejam_admin_dismiss(p_user uuid)
returns int language plpgsql security definer set search_path = public as $$
declare me uuid := public.pokejam_require_admin(); n int;
begin
  update public.pokejam_reports set dismissed_at = now(), dismissed_by = me where reported = p_user and dismissed_at is null;
  get diagnostics n = row_count;
  insert into public.pokejam_admin_log(admin, action, target, detail) values (me, 'dismiss reports', p_user, n::text);
  return n;
end $$;

create or replace function public.pokejam_admin_reports(p_days int default 7)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.pokejam_require_admin();
  return coalesce((
    select jsonb_agg(row_to_json(x) order by x.reporters desc, x.last_at desc) from (
      select r.reported as user_id, p.trainer_name as name,
        count(distinct r.reporter) as reporters, count(*) as reports,
        (select jsonb_object_agg(s.reason, s.n) from (select q3.reason, count(*) as n from public.pokejam_reports q3
           where q3.reported = r.reported and q3.created_at > now() - make_interval(days => greatest(1, p_days)) and q3.dismissed_at is null group by q3.reason) s) as reasons,
        (select jsonb_agg(jsonb_build_object('reason', q.reason, 'note', q.note, 'at', q.created_at, 'from', rp.trainer_name, 'from_id', q.reporter) order by q.created_at desc)
           from (select * from public.pokejam_reports q2 where q2.reported = r.reported and q2.created_at > now() - make_interval(days => p_days) and q2.dismissed_at is null
                 order by q2.created_at desc limit 8) q
           left join public.pokejam_profiles rp on rp.id = q.reporter) as latest,
        max(r.created_at) as last_at,
        (select until from public.pokejam_bans b where b.user_id = r.reported and b.until > now()) as banned_until
      from public.pokejam_reports r
      left join public.pokejam_profiles p on p.id = r.reported
      where r.created_at > now() - make_interval(days => greatest(1, p_days)) and r.dismissed_at is null
      group by r.reported, p.trainer_name
      limit 200
    ) x), '[]'::jsonb);
end $$;

-- Report the other player in a match you played. One report per match; 5 different reporters in 24 hours (open
-- reports only) ban the player for 24 hours (a person reviews it). Returns true when the report was taken.
create or replace function public.pokejam_report_player(p_match uuid, p_reason text, p_note text default null)
returns boolean language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); m public.pokejam_matches; them uuid; n int;
begin
  if me is null then raise exception 'not signed in'; end if;
  if p_reason not in ('name', 'cheating', 'quitting', 'other') then raise exception 'bad reason'; end if;
  select * into m from public.pokejam_matches where id = p_match;
  if m.id is null or me not in (m.host, m.guest) or m.guest is null then raise exception 'not in this match'; end if;
  if not public.pokejam_rate_ok('report', 20, interval '1 day') then raise exception 'Too many reports today.'; end if;
  them := case when me = m.host then m.guest else m.host end;
  insert into public.pokejam_reports(reporter, reported, match_id, reason, note)
    values (me, them, m.id, p_reason, left(nullif(btrim(p_note), ''), 200))
    on conflict (reporter, match_id) do nothing;
  if not found then return false; end if;
  select count(distinct reporter) into n from public.pokejam_reports where reported = them and created_at > now() - interval '24 hours' and dismissed_at is null;
  if n >= 5 and not public.pokejam_banned(them) then
    insert into public.pokejam_bans(user_id, until, reason, auto) values (them, now() + interval '24 hours', 'auto: reported by 5 players in 24 hours', true)
      on conflict (user_id) do update set until = excluded.until, reason = excluded.reason, auto = true, created_at = now();
    delete from public.pokejam_queue where user_id = them;
  end if;
  return true;
end $$;

revoke all on function public.pokejam_admin_dismiss(uuid), public.pokejam_admin_reports(int), public.pokejam_report_player(uuid, text, text)
  from public, anon, authenticated;
grant execute on function public.pokejam_admin_dismiss(uuid), public.pokejam_admin_reports(int), public.pokejam_report_player(uuid, text, text)
  to authenticated;
