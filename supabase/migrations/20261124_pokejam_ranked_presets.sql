-- PokeJam Ranked: preset teams A-F with a blind pick (src/multiplayer/ranked/presets.ts).
-- Additive and safe to re-run: new tables are "if not exists", the seed is "on conflict do nothing" and every
-- function is "create or replace". Nothing is dropped or deleted.
--
-- Flow: once a ranked match is found, both players call pokejam_ranked_pick(match, preset) (first pick wins) and poll
-- pokejam_ranked_pick_state(match), which only ever shows the caller's own pick. 20 seconds after the match was
-- created, a missing pick is filled with a random preset (auto = true). When both picks exist, pokejam_match_info
-- returns the two preset rosters as host_roster / guest_roster; before that they are null for ranked matches, and the
-- client refuses to build a ranked game without them (no random-team fallback any more).
--
-- Scoring: pokejam_report_result and pokejam_ranked_report_score now refuse a ranked match without 2 pick rows.
--
-- Judge note: the winner check (judge() over the evidence of 20261028, src/multiplayer/shared/winnerCheck.ts) is
-- TypeScript and is not an Edge Function in supabase/functions/. Wherever it runs, it must build its MatchSetup
-- (rosters) from pokejam_match_info, never from the setup inside client-submitted evidence.
--
-- Keep the seed rows below in step with RANKED_PRESETS (presetsMigration.test.ts checks it).

create table if not exists public.pokejam_ranked_presets (
  id text primary key check (id in ('A', 'B', 'C', 'D', 'E', 'F')),
  name text not null,
  dex int[5] not null check (array_length(dex, 1) = 5) -- PG, SG, SF, PF, C
);

insert into public.pokejam_ranked_presets (id, name, dex) values
  ('A', 'Night Furnace', array[78, 229, 94, 9, 208]),
  ('B', 'Jungle Fury', array[254, 392, 475, 115, 130]),
  ('C', 'Iron Bloom', array[135, 142, 212, 31, 3]),
  ('D', 'Fang & Fist', array[571, 448, 612, 62, 697]),
  ('E', 'Sky Hammers', array[169, 959, 257, 628, 465]),
  ('F', 'Dragon Mind', array[65, 123, 635, 373, 473])
on conflict do nothing;

alter table public.pokejam_ranked_presets enable row level security;
drop policy if exists pokejam_ranked_presets_read on public.pokejam_ranked_presets;
create policy pokejam_ranked_presets_read on public.pokejam_ranked_presets for select to authenticated using (true);

create table if not exists public.pokejam_ranked_picks (
  match_id uuid not null references public.pokejam_matches(id),
  user_id uuid not null,
  preset_id text not null references public.pokejam_ranked_presets(id),
  auto boolean not null default false,
  picked_at timestamptz not null default now(),
  primary key (match_id, user_id)
);

-- No policies: clients never read or write picks directly, only through the functions below.
alter table public.pokejam_ranked_picks enable row level security;

-- The preset ids, for the client to cross-check against its own list.
create or replace function public.pokejam_ranked_presets()
returns jsonb language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('id', p.id, 'name', p.name, 'dex', to_jsonb(p.dex)) order by p.id), '[]'::jsonb)
  from public.pokejam_ranked_presets p;
$$;

-- Fill the missing picks of an overdue match with a random preset. Internal.
create or replace function public.pokejam_ranked_pick_settle(p_match uuid)
returns void language plpgsql security definer set search_path = public as $$
declare m public.pokejam_matches; u uuid;
begin
  select * into m from public.pokejam_matches where id = p_match;
  if m.id is null or m.queue <> 'ranked' or m.guest is null or m.created_at > now() - interval '20 seconds' then return; end if;
  foreach u in array array[m.host, m.guest] loop
    insert into public.pokejam_ranked_picks (match_id, user_id, preset_id, auto)
      values (m.id, u, (select id from public.pokejam_ranked_presets order by random() limit 1), true)
      on conflict (match_id, user_id) do nothing;
  end loop;
end $$;

-- My blind pick. First pick wins; a repeat call is a no-op.
create or replace function public.pokejam_ranked_pick(p_match uuid, p_preset text)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); m public.pokejam_matches;
begin
  if me is null then raise exception 'not signed in'; end if;
  perform public.pokejam_ranked_require_member();
  select * into m from public.pokejam_matches where id = p_match;
  if m.id is null or m.queue <> 'ranked' or me not in (m.host, m.guest) or m.guest is null then raise exception 'not in this match'; end if;
  if m.status <> 'active' then raise exception 'match not active'; end if;
  if not exists (select 1 from public.pokejam_ranked_presets where id = p_preset) then raise exception 'unknown preset'; end if;
  insert into public.pokejam_ranked_picks (match_id, user_id, preset_id) values (p_match, me, p_preset)
    on conflict (match_id, user_id) do nothing;
end $$;

-- My pick and whether both have picked. The opponent's pick is never returned here (it shows up in match info).
create or replace function public.pokejam_ranked_pick_state(p_match uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); m public.pokejam_matches; mine text; n int;
begin
  if me is null then raise exception 'not signed in'; end if;
  select * into m from public.pokejam_matches where id = p_match;
  if m.id is null or m.queue <> 'ranked' or me not in (m.host, m.guest) or m.guest is null then raise exception 'not in this match'; end if;
  perform public.pokejam_ranked_pick_settle(m.id);
  select preset_id into mine from public.pokejam_ranked_picks where match_id = m.id and user_id = me;
  select count(*) into n from public.pokejam_ranked_picks where match_id = m.id and user_id in (m.host, m.guest);
  return jsonb_build_object('mine', mine, 'done', n >= 2,
    'deadline_s', greatest(0, ceil(extract(epoch from (m.created_at + interval '20 seconds' - now()))))::int);
end $$;

-- A player's preset roster for a ranked match, once both picks exist (null before). Internal.
create or replace function public.pokejam_ranked_roster(p_match uuid, p_user uuid)
returns int[] language sql stable security definer set search_path = public as $$
  select p.dex from public.pokejam_ranked_picks k join public.pokejam_ranked_presets p on p.id = k.preset_id
  where k.match_id = p_match and k.user_id = p_user
    and (select count(*) from public.pokejam_ranked_picks k2 where k2.match_id = p_match) >= 2;
$$;

-- Raise unless both players of a ranked match have a pick row. Internal.
create or replace function public.pokejam_ranked_require_picks(p_match uuid)
returns void language plpgsql security definer set search_path = public as $$
declare m public.pokejam_matches;
begin
  select * into m from public.pokejam_matches where id = p_match;
  if m.id is null or m.queue <> 'ranked' then return; end if;
  if (select count(*) from public.pokejam_ranked_picks where match_id = m.id and user_id in (m.host, m.guest)) < 2 then
    raise exception 'ranked match has no preset picks';
  end if;
end $$;

-- As 20261101, plus ranked rosters from the two preset picks (null until both have picked).
create or replace function public.pokejam_match_info(p_match uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', m.id, 'queue', m.queue, 'status', m.status, 'host', m.host, 'guest', m.guest,
    'host_name', hp.trainer_name, 'guest_name', gp.trainer_name, 'seed', m.seed, 'quarter_len', m.quarter_len,
    'host_key', m.host_key, 'guest_key', m.guest_key,
    'host_roster', case when m.queue = 'ranked' then public.pokejam_ranked_roster(m.id, m.host)
      else (select public.pokejam_draft_roster(d.picks, 0) from public.pokejam_drafts d where d.match_id = m.id and d.done) end,
    'guest_roster', case when m.queue = 'ranked' then public.pokejam_ranked_roster(m.id, m.guest)
      else (select public.pokejam_draft_roster(d.picks, 1) from public.pokejam_drafts d where d.match_id = m.id and d.done) end)
  from public.pokejam_matches m
  join public.pokejam_profiles hp on hp.id = m.host
  left join public.pokejam_profiles gp on gp.id = m.guest
  where m.id = p_match and auth.uid() in (m.host, m.guest);
$$;

-- As 20261113, plus: a ranked match needs both preset picks.
create or replace function public.pokejam_ranked_report_score(p_match uuid, p_host_score int, p_guest_score int)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); m public.pokejam_matches;
begin
  if me is null then raise exception 'not signed in'; end if;
  perform public.pokejam_ranked_require_member();
  if p_host_score is null or p_guest_score is null or p_host_score not between 0 and 300 or p_guest_score not between 0 and 300
     or p_host_score = p_guest_score then raise exception 'bad score'; end if;
  select * into m from public.pokejam_matches where id = p_match;
  if m.id is null or m.queue <> 'ranked' or me not in (m.host, m.guest) or m.guest is null then raise exception 'not in this match'; end if;
  if m.status = 'done' or m.status = 'void' then return; end if; -- too late to change anything
  perform public.pokejam_ranked_require_picks(m.id);
  insert into public.pokejam_ranked_scores(match_id, user_id, host_score, guest_score) values (p_match, me, p_host_score, p_guest_score)
    on conflict (match_id, user_id) do nothing;
end $$;

-- As 20261113, plus: a ranked match needs both preset picks before it can be reported.
create or replace function public.pokejam_report_result(p_match uuid, p_host_won boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); m public.pokejam_matches; final boolean; res jsonb;
begin
  select * into m from public.pokejam_matches where id = p_match for update;
  if m.id is null or me is null or me not in (m.host, m.guest) then raise exception 'not in this match'; end if;
  if m.queue = 'ranked' then perform public.pokejam_ranked_require_member(); end if;
  if m.status = 'done' then return jsonb_build_object('status','done','winner',m.winner); end if;
  if m.status <> 'active' or m.guest is null then raise exception 'match not active'; end if;
  if m.queue = 'ranked' then perform public.pokejam_ranked_require_picks(m.id); end if;
  if m.created_at < now() - interval '2 hours' then
    update public.pokejam_matches set status = 'void' where id = m.id; return jsonb_build_object('status','void');
  end if;
  if me = m.host then
    update public.pokejam_matches set host_report = p_host_won, host_reported_at = coalesce(host_reported_at, now()) where id = m.id returning * into m;
  else
    update public.pokejam_matches set guest_report = p_host_won where id = m.id returning * into m;
  end if;
  if m.host_report is not null and m.guest_report is not null then
    if m.host_report <> m.guest_report then
      update public.pokejam_matches set status = 'void', finished_at = now() where id = m.id;
      return jsonb_build_object('status','void','reason','reports disagree');
    end if;
    final := m.host_report;
  elsif m.host_report is not null and m.guest_report is null and me = m.host and m.host_reported_at < now() - interval '120 seconds' then
    final := m.host_report;
  else
    return jsonb_build_object('status','pending');
  end if;
  update public.pokejam_matches set status = 'done', finished_at = now(),
    winner = case when final then m.host else m.guest end where id = m.id;
  if m.queue = 'ranked' then
    res := public.pokejam_ranked_apply(m.id);
  end if;
  return jsonb_build_object('status','done','winner', case when final then m.host else m.guest end,
    'rank', public.pokejam_ranked_player_view(case when me = m.host then res->'host' else res->'guest' end));
end $$;

revoke all on function public.pokejam_ranked_pick_settle(uuid), public.pokejam_ranked_roster(uuid, uuid),
  public.pokejam_ranked_require_picks(uuid) from public, anon, authenticated;
revoke all on function public.pokejam_ranked_presets(), public.pokejam_ranked_pick(uuid, text),
  public.pokejam_ranked_pick_state(uuid), public.pokejam_match_info(uuid),
  public.pokejam_ranked_report_score(uuid, int, int), public.pokejam_report_result(uuid, boolean) from public, anon, authenticated;
grant execute on function public.pokejam_ranked_presets(), public.pokejam_ranked_pick(uuid, text),
  public.pokejam_ranked_pick_state(uuid), public.pokejam_match_info(uuid),
  public.pokejam_ranked_report_score(uuid, int, int), public.pokejam_report_result(uuid, boolean) to authenticated;
