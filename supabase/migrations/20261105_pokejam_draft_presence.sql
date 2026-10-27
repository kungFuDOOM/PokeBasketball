-- PokeJam Social draft: knows when the match is over, and waits for both players. Shared gauntlet-legends project:
-- pokejam_* only. Safe to run again. Same RPCs, same arguments; the view only gains a field, so older clients work.
--
-- - The draft view now says the match's 'status'. When the other player left (the match is 'void'), the draft stops:
--   no more auto picks, nobody is marked as seen, a pick is refused ("the match is over"). The client then shows
--   "opponent left" instead of finishing the draft and failing to join a channel the match no longer allows.
-- - The pick clock starts when both players have opened the draft. Until then (a room's host still in another app
--   sending the code) nobody gets random picks; the waiting player's client decides how long to wait.

create or replace function public.pokejam_draft_state(p_match uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); m public.pokejam_matches; side int; d public.pokejam_drafts; first_look boolean; other_seen timestamptz;
        pool_per_pos constant int := 6; pick_s constant int := 12; intro_s constant int := 3;
begin
  if me is null then raise exception 'not signed in'; end if;
  select * into m from public.pokejam_matches where id = p_match;
  if m.id is null or me not in (m.host, m.guest) or m.guest is null then raise exception 'not in this match'; end if;
  if m.queue <> 'social' then raise exception 'no draft for this match'; end if;
  side := case when me = m.host then 0 else 1 end;
  if m.status <> 'active' then
    select * into d from public.pokejam_drafts where match_id = m.id;
    if d.match_id is null then raise exception 'the match is over'; end if;
    return public.pokejam_draft_view(d, side) || jsonb_build_object('status', m.status);
  end if;
  insert into public.pokejam_drafts(match_id, pool, first, deadline)
    select m.id, array(select r.dex from (select dex, pos, row_number() over (partition by pos order by random()) as k from public.pokejam_mons) r
                       where r.k <= pool_per_pos order by r.pos, r.dex),
      (random() < 0.5)::int, now() + make_interval(secs => intro_s + pick_s)
    on conflict (match_id) do nothing;
  select * into d from public.pokejam_drafts where match_id = m.id for update;
  first_look := (case when side = 0 then d.host_seen else d.guest_seen end) is null;
  other_seen := case when side = 0 then d.guest_seen else d.host_seen end;
  update public.pokejam_drafts set
    host_seen = case when side = 0 then now() else host_seen end,
    guest_seen = case when side = 1 then now() else guest_seen end,
    -- Until both are here, the first pick's clock stands still (it restarts in full when the second player arrives).
    deadline = case when not done and jsonb_array_length(picks) = 0 and (first_look or other_seen is null)
                    then now() + make_interval(secs => intro_s + pick_s) else deadline end
  where match_id = m.id;
  d := public.pokejam_draft_settle(m.id);
  return public.pokejam_draft_view(d, side) || jsonb_build_object('status', m.status);
end $$;

create or replace function public.pokejam_draft_pick(p_match uuid, p_dex int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); m public.pokejam_matches; side int; d public.pokejam_drafts; ppos text; pick_s constant int := 12;
begin
  if me is null then raise exception 'not signed in'; end if;
  select * into m from public.pokejam_matches where id = p_match;
  if m.id is null or me not in (m.host, m.guest) or m.guest is null then raise exception 'not in this match'; end if;
  if m.status <> 'active' then raise exception 'the match is over'; end if;
  side := case when me = m.host then 0 else 1 end;
  d := public.pokejam_draft_settle(m.id);
  if d.match_id is null then raise exception 'no draft for this match'; end if;
  if d.done then raise exception 'the draft is over'; end if;
  if public.pokejam_draft_side(d.first, jsonb_array_length(d.picks)) <> side then raise exception 'not your turn'; end if;
  if not (p_dex = any(d.pool)) then raise exception 'not in the pool'; end if;
  if exists (select 1 from jsonb_array_elements(d.picks) x where (x->>'dex')::int = p_dex) then raise exception 'already picked'; end if;
  select pos into ppos from public.pokejam_mons where dex = p_dex;
  if exists (select 1 from jsonb_array_elements(d.picks) x where (x->>'side')::int = side and x->>'pos' = ppos) then
    raise exception 'you already have a %', ppos;
  end if;
  update public.pokejam_drafts set
    picks = picks || jsonb_build_array(jsonb_build_object('side', side, 'dex', p_dex, 'pos', ppos, 'auto', false)),
    deadline = now() + make_interval(secs => pick_s),
    done = jsonb_array_length(picks) + 1 >= 10,
    host_seen = case when side = 0 then now() else host_seen end,
    guest_seen = case when side = 1 then now() else guest_seen end
  where match_id = m.id returning * into d;
  return public.pokejam_draft_view(d, side) || jsonb_build_object('status', m.status);
end $$;

revoke all on function public.pokejam_draft_state(uuid), public.pokejam_draft_pick(uuid, int) from public, anon, authenticated;
grant execute on function public.pokejam_draft_state(uuid), public.pokejam_draft_pick(uuid, int) to authenticated;
