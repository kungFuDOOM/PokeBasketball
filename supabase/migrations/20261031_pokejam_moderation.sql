-- PokeJam online: the moderation page (admin.html). Shared gauntlet-legends project: pokejam_* only.
--
-- Moderators are real (email) Supabase accounts listed in pokejam_admins; the page signs them in and every call
-- here checks that list, so a player who finds the page gets nothing. Every action is written to
-- pokejam_admin_log. Add a moderator (SQL editor, as the owner):
--   insert into public.pokejam_admins(user_id, note) select id, 'kungFuDOOM' from auth.users where email = '…';

create table if not exists public.pokejam_admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  note text,
  added_at timestamptz not null default now()
);
alter table public.pokejam_admins enable row level security;
revoke all on public.pokejam_admins from anon, authenticated, public;

create table if not exists public.pokejam_admin_log (
  id bigserial primary key,
  admin uuid not null references auth.users(id) on delete cascade,
  action text not null,
  target uuid,
  detail text,
  at timestamptz not null default now()
);
alter table public.pokejam_admin_log enable row level security;
revoke all on public.pokejam_admin_log from anon, authenticated, public;
revoke all on sequence public.pokejam_admin_log_id_seq from anon, authenticated, public;

create or replace function public.pokejam_is_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.pokejam_admins where user_id = auth.uid());
$$;

create or replace function public.pokejam_require_admin()
returns uuid language plpgsql stable security definer set search_path = public as $$
begin
  if not public.pokejam_is_admin() then raise exception 'moderators only'; end if;
  return auth.uid();
end $$;

-- Reported players over the last p_days, most-reported first: who, how many different opponents reported them,
-- for what, the latest notes, and whether they're suspended now.
create or replace function public.pokejam_admin_reports(p_days int default 7)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.pokejam_require_admin();
  return coalesce((
    select jsonb_agg(row_to_json(x) order by x.reporters desc, x.last_at desc) from (
      select r.reported as user_id, p.trainer_name as name,
        count(distinct r.reporter) as reporters, count(*) as reports,
        (select jsonb_object_agg(s.reason, s.n) from (select q3.reason, count(*) as n from public.pokejam_reports q3
           where q3.reported = r.reported and q3.created_at > now() - make_interval(days => greatest(1, p_days)) group by q3.reason) s) as reasons,
        (select jsonb_agg(jsonb_build_object('reason', q.reason, 'note', q.note, 'at', q.created_at, 'from', rp.trainer_name) order by q.created_at desc)
           from (select * from public.pokejam_reports q2 where q2.reported = r.reported and q2.created_at > now() - make_interval(days => p_days)
                 order by q2.created_at desc limit 8) q
           left join public.pokejam_profiles rp on rp.id = q.reporter) as latest,
        max(r.created_at) as last_at,
        (select until from public.pokejam_bans b where b.user_id = r.reported and b.until > now()) as banned_until
      from public.pokejam_reports r
      left join public.pokejam_profiles p on p.id = r.reported
      where r.created_at > now() - make_interval(days => greatest(1, p_days))
      group by r.reported, p.trainer_name
      limit 200
    ) x), '[]'::jsonb);
end $$;

-- Everyone suspended or banned right now.
create or replace function public.pokejam_admin_bans()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.pokejam_require_admin();
  return coalesce((select jsonb_agg(jsonb_build_object('user_id', b.user_id, 'name', p.trainer_name, 'until', b.until, 'reason', b.reason,
      'auto', b.auto, 'since', b.created_at) order by b.created_at desc)
    from public.pokejam_bans b left join public.pokejam_profiles p on p.id = b.user_id where b.until > now()), '[]'::jsonb);
end $$;

-- Suspend for p_hours (0 or less: permanently, which is 100 years), lift a suspension, or reset a name.
create or replace function public.pokejam_admin_ban(p_user uuid, p_hours int, p_reason text)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := public.pokejam_require_admin();
begin
  perform public.pokejam_ban(p_user, case when p_hours <= 0 then 876000 else p_hours end, left(coalesce(p_reason, ''), 500));
  insert into public.pokejam_admin_log(admin, action, target, detail) values (me, 'ban', p_user, format('%s h: %s', p_hours, left(p_reason, 200)));
end $$;

create or replace function public.pokejam_admin_unban(p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := public.pokejam_require_admin();
begin
  perform public.pokejam_unban(p_user);
  insert into public.pokejam_admin_log(admin, action, target) values (me, 'unban', p_user);
end $$;

create or replace function public.pokejam_admin_reset_name(p_user uuid)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := public.pokejam_require_admin(); old text;
begin
  select trainer_name into old from public.pokejam_profiles where id = p_user;
  update public.pokejam_profiles set trainer_name = 'Trainer', updated_at = now() where id = p_user;
  insert into public.pokejam_admin_log(admin, action, target, detail) values (me, 'reset name', p_user, old);
end $$;

-- What moderators did, newest first.
create or replace function public.pokejam_admin_history(p_limit int default 50)
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.pokejam_require_admin();
  return coalesce((select jsonb_agg(jsonb_build_object('at', l.at, 'action', l.action, 'detail', l.detail, 'target', p.trainer_name,
      'by', a.note) order by l.at desc)
    from (select * from public.pokejam_admin_log order by at desc limit greatest(1, least(p_limit, 500))) l
    left join public.pokejam_profiles p on p.id = l.target
    left join public.pokejam_admins a on a.user_id = l.admin), '[]'::jsonb);
end $$;

revoke all on function public.pokejam_is_admin(), public.pokejam_require_admin(), public.pokejam_admin_reports(int),
  public.pokejam_admin_bans(), public.pokejam_admin_ban(uuid, int, text), public.pokejam_admin_unban(uuid),
  public.pokejam_admin_reset_name(uuid), public.pokejam_admin_history(int) from public, anon, authenticated;
grant execute on function public.pokejam_is_admin(), public.pokejam_admin_reports(int), public.pokejam_admin_bans(),
  public.pokejam_admin_ban(uuid, int, text), public.pokejam_admin_unban(uuid), public.pokejam_admin_reset_name(uuid),
  public.pokejam_admin_history(int) to authenticated;
