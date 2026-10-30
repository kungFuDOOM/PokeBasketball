-- Moderation page: each latest report entry also carries the reporter's id ('from_id'), so a moderator can act on a
-- reporter (for example one with a vulgar name). Same signature, admin check, grants and output as 20261031; only
-- 'from_id' is added to each entry of 'latest'. The page works without it (it hides the reporter buttons).

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
        (select jsonb_agg(jsonb_build_object('reason', q.reason, 'note', q.note, 'at', q.created_at, 'from', rp.trainer_name, 'from_id', q.reporter) order by q.created_at desc)
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

revoke all on function public.pokejam_admin_reports(int) from public, anon, authenticated;
grant execute on function public.pokejam_admin_reports(int) to authenticated;
