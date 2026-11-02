-- PokeJam online: the judge builds a match's setup from the server's row, never from the uploads (anti-cheat PR 4).
-- Shared gauntlet-legends project: pokejam_* only. Additive: one new service-role function, two nullable columns, and
-- pokejam_record_verdict gains two optional arguments, so an Edge Function deployed before this keeps working.

-- Service role (the judge): what both players built the game from. pokejam_match_info can't serve here, because it
-- filters on auth.uid(), which is null for the service role. Same query and same roster logic without that filter,
-- plus the names the client shows: usernames in Ranked (pokejam_match_usernames also needs auth.uid()), trainer names
-- in Social. Rosters are null until both presets are picked (Ranked) or the draft is done (Social). Null: no such match.
create or replace function public.pokejam_match_setup(p_match uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', m.id, 'queue', m.queue, 'status', m.status, 'host', m.host, 'guest', m.guest,
    'host_name', case when m.queue = 'ranked' then coalesce((select u.username from public.pokejam_usernames u where u.user_id = m.host), 'Player') else hp.trainer_name end,
    'guest_name', case when m.queue = 'ranked' then coalesce((select u.username from public.pokejam_usernames u where u.user_id = m.guest), 'Player') else gp.trainer_name end,
    'seed', m.seed, 'quarter_len', m.quarter_len,
    'host_key', m.host_key, 'guest_key', m.guest_key,
    'host_roster', case when m.queue = 'ranked' then public.pokejam_ranked_roster(m.id, m.host)
      else (select public.pokejam_draft_roster(d.picks, 0) from public.pokejam_drafts d where d.match_id = m.id and d.done) end,
    'guest_roster', case when m.queue = 'ranked' then public.pokejam_ranked_roster(m.id, m.guest)
      else (select public.pokejam_draft_roster(d.picks, 1) from public.pokejam_drafts d where d.match_id = m.id and d.done) end)
  from public.pokejam_matches m
  left join public.pokejam_profiles hp on hp.id = m.host
  left join public.pokejam_profiles gp on gp.id = m.guest
  where m.id = p_match;
$$;

revoke all on function public.pokejam_match_setup(uuid) from public, anon, authenticated;
grant execute on function public.pokejam_match_setup(uuid) to service_role;

-- The last frame of each side's unbroken run of signed frames (Verdict.lastFrame), to see who went silent first.
-- Null on verdicts saved before this.
alter table public.pokejam_match_verdicts
  add column if not exists last_frame_host int check (last_frame_host >= 0),
  add column if not exists last_frame_guest int check (last_frame_guest >= 0);

-- As 20261122, plus the last frames. The 8-argument version goes first: two overloads with defaults would make the
-- call ambiguous ("function is not unique"). Its callers still resolve here through the defaults.
drop function if exists public.pokejam_record_verdict(uuid, text, int, int, int, int, int, text);

create or replace function public.pokejam_record_verdict(p_match uuid, p_status text, p_winner_side int, p_cheater_side int,
  p_score_host int, p_score_guest int, p_ticks int, p_notes text, p_last_host int default null, p_last_guest int default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.pokejam_matches; v public.pokejam_match_verdicts; win uuid;
begin
  select * into m from public.pokejam_matches where id = p_match;
  if m.id is null then raise exception 'no such match'; end if;
  if p_status is null or p_status not in ('final','incomplete','forfeit','invalid') then raise exception 'bad status'; end if;
  if p_winner_side is not null and p_winner_side not in (0, 1) then raise exception 'bad side'; end if;
  if p_cheater_side is not null and p_cheater_side not in (0, 1) then raise exception 'bad side'; end if;
  win := case p_winner_side when 0 then m.host when 1 then m.guest end;
  insert into public.pokejam_match_verdicts as t(match_id, status, winner_side, cheater, agrees, score_host, score_guest, ticks, notes, judged_at, last_frame_host, last_frame_guest)
    values (p_match, p_status, p_winner_side,
      case p_cheater_side when 0 then m.host when 1 then m.guest end,
      case when win is null or m.winner is null then null else win = m.winner end,
      p_score_host, p_score_guest, p_ticks, left(p_notes, 4000), now(), p_last_host, p_last_guest)
    on conflict (match_id) do update set status = excluded.status, winner_side = excluded.winner_side, cheater = excluded.cheater,
      agrees = excluded.agrees, score_host = excluded.score_host, score_guest = excluded.score_guest, ticks = excluded.ticks,
      notes = excluded.notes, judged_at = excluded.judged_at, last_frame_host = excluded.last_frame_host, last_frame_guest = excluded.last_frame_guest
    returning * into v;
  return to_jsonb(v);
end $$;

revoke all on function public.pokejam_record_verdict(uuid, text, int, int, int, int, int, text, int, int) from public, anon, authenticated;
grant execute on function public.pokejam_record_verdict(uuid, text, int, int, int, int, int, text, int, int) to service_role;
