-- PokeJam online: stored verdicts from the winner check (judge() in src/multiplayer/shared/winnerCheck.ts).
-- Shared gauntlet-legends project: pokejam_* only.
--
-- The pokejam-judge Edge Function replays a match from its uploads (pokejam_match_evidence) and saves the result
-- here with pokejam_record_verdict, one row per match (judging again overwrites it). Uploads are pruned after
-- 30 days (20261029); verdicts are not, so the moderation page keeps its cheat-check tags. Players can't read
-- verdicts; only the service role (and admin RPCs) can.

create table if not exists public.pokejam_match_verdicts (
  match_id uuid primary key references public.pokejam_matches(id) on delete cascade,
  status text not null check (status in ('final','incomplete','forfeit','invalid')),
  -- judge side: 0 = host, 1 = guest
  winner_side smallint check (winner_side in (0, 1)),
  -- the side caught signing two versions of a frame (status 'forfeit'), as a player id
  cheater uuid,
  -- the judge's winner, as a player id, equals pokejam_matches.winner; null when either winner is null
  agrees boolean,
  score_host int,
  score_guest int,
  ticks int,
  notes text,
  judged_at timestamptz not null default now()
);
alter table public.pokejam_match_verdicts enable row level security;
revoke all on public.pokejam_match_verdicts from anon, authenticated, public;

-- Service role (the pokejam-judge function): save the judge's verdict for a match, replacing any earlier one.
-- Sides are the judge's (0 = host, 1 = guest); this maps them to player ids from the match row. Returns the row.
create or replace function public.pokejam_record_verdict(p_match uuid, p_status text, p_winner_side int, p_cheater_side int,
  p_score_host int, p_score_guest int, p_ticks int, p_notes text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare m public.pokejam_matches; v public.pokejam_match_verdicts; win uuid;
begin
  select * into m from public.pokejam_matches where id = p_match;
  if m.id is null then raise exception 'no such match'; end if;
  if p_status is null or p_status not in ('final','incomplete','forfeit','invalid') then raise exception 'bad status'; end if;
  if p_winner_side is not null and p_winner_side not in (0, 1) then raise exception 'bad side'; end if;
  if p_cheater_side is not null and p_cheater_side not in (0, 1) then raise exception 'bad side'; end if;
  win := case p_winner_side when 0 then m.host when 1 then m.guest end;
  insert into public.pokejam_match_verdicts as t(match_id, status, winner_side, cheater, agrees, score_host, score_guest, ticks, notes, judged_at)
    values (p_match, p_status, p_winner_side,
      case p_cheater_side when 0 then m.host when 1 then m.guest end,
      case when win is null or m.winner is null then null else win = m.winner end,
      p_score_host, p_score_guest, p_ticks, left(p_notes, 4000), now())
    on conflict (match_id) do update set status = excluded.status, winner_side = excluded.winner_side, cheater = excluded.cheater,
      agrees = excluded.agrees, score_host = excluded.score_host, score_guest = excluded.score_guest, ticks = excluded.ticks,
      notes = excluded.notes, judged_at = excluded.judged_at
    returning * into v;
  return to_jsonb(v);
end $$;

revoke all on function public.pokejam_record_verdict(uuid, text, int, int, int, int, int, text) from public, anon, authenticated;
grant execute on function public.pokejam_record_verdict(uuid, text, int, int, int, int, int, text) to service_role;
