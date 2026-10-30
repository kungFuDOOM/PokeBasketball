-- Moderation page: cheat-check tags. pokejam_admin_reports (body from 20261121, so it keeps from_id and the dismiss
-- filter) also returns `checks` per reported player: one entry per distinct match among their open reports in the
-- p_days window, with whether the match has uploads (pokejam_match_evidence) and its stored verdict
-- (pokejam_match_verdicts, 20261122). status is null when the match has not been judged. Additive; same signature
-- and grants.

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
        (select jsonb_agg(jsonb_build_object('match_id', c.match_id, 'queue', m.queue,
             'has_evidence', exists (select 1 from public.pokejam_match_evidence e where e.match_id = c.match_id),
             'status', v.status, 'agrees', v.agrees, 'cheater_is_reported', v.cheater = r.reported) order by c.at desc)
           from (select q4.match_id, max(q4.created_at) as at from public.pokejam_reports q4
                 where q4.reported = r.reported and q4.created_at > now() - make_interval(days => greatest(1, p_days)) and q4.dismissed_at is null
                 group by q4.match_id) c
           join public.pokejam_matches m on m.id = c.match_id
           left join public.pokejam_match_verdicts v on v.match_id = c.match_id) as checks,
        max(r.created_at) as last_at,
        (select until from public.pokejam_bans b where b.user_id = r.reported and b.until > now()) as banned_until
      from public.pokejam_reports r
      left join public.pokejam_profiles p on p.id = r.reported
      where r.created_at > now() - make_interval(days => greatest(1, p_days)) and r.dismissed_at is null
      group by r.reported, p.trainer_name
      limit 200
    ) x), '[]'::jsonb);
end $$;

revoke all on function public.pokejam_admin_reports(int) from public, anon, authenticated;
grant execute on function public.pokejam_admin_reports(int) to authenticated;
