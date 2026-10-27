-- PokeJam online (test build). Shares the gauntlet-legends project: everything is prefixed pokejam_.
-- Clients get SELECT only (own/participant rows); every write goes through SECURITY DEFINER RPCs.

create table if not exists public.pokejam_profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  trainer_name text not null default 'Trainer' check (char_length(trainer_name) between 1 and 20),
  mmr int not null default 1000,
  placements int not null default 0,
  ladder int not null default 1000,
  shield int not null default 0,
  tier text,
  division text,
  rp int not null default 0,
  wins int not null default 0,
  losses int not null default 0,
  season int not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.pokejam_queue (
  user_id uuid primary key references public.pokejam_profiles(id) on delete cascade,
  queue text not null check (queue in ('social','ranked')),
  mmr int not null,
  joined_at timestamptz not null default now()
);

create table if not exists public.pokejam_matches (
  id uuid primary key default gen_random_uuid(),
  queue text not null check (queue in ('social','ranked')),
  host uuid not null references public.pokejam_profiles(id) on delete cascade,
  guest uuid references public.pokejam_profiles(id) on delete cascade,
  room_code text unique,
  status text not null default 'active' check (status in ('waiting','active','done','void')),
  host_mmr int not null,
  guest_mmr int,
  host_report boolean,   -- did the host say the host won?
  guest_report boolean,  -- did the guest say the host won?
  host_reported_at timestamptz,
  winner uuid,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index if not exists pokejam_matches_host_idx on public.pokejam_matches(host);
create index if not exists pokejam_matches_guest_idx on public.pokejam_matches(guest);

alter table public.pokejam_profiles enable row level security;
alter table public.pokejam_queue enable row level security;
alter table public.pokejam_matches enable row level security;

revoke all on public.pokejam_profiles, public.pokejam_queue, public.pokejam_matches from anon, authenticated, public;
grant select on public.pokejam_profiles, public.pokejam_matches, public.pokejam_queue to authenticated;

create policy "pokejam profiles readable by signed-in players" on public.pokejam_profiles
  for select to authenticated using (true);
create policy "pokejam own queue row" on public.pokejam_queue
  for select to authenticated using (user_id = (select auth.uid()));
create policy "pokejam match participants" on public.pokejam_matches
  for select to authenticated using ((select auth.uid()) in (host, guest));

-- ---------- rank rules: SQL port of src/multiplayer/rank.ts (keep constants in sync) ----------
-- START 1000, placements 5, K 64 placing / 24 ranked, shield 2,
-- Bronze 700 (floor), Silver 1000, Gold 1300, Platinum 1600, Diamond 1900 (100-MMR divisions III/II/I), Pokémon Master 2200+.
create or replace function public.pokejam_rank_view(p_ladder int, p_placements int,
  out tier text, out division text, out rp int)
language plpgsql immutable set search_path = public as $$
declare starts int[] := array[700,1000,1300,1600,1900,2200];
        names text[] := array['Bronze','Silver','Gold','Platinum','Diamond','Pokémon Master'];
        i int; base int; d int;
begin
  if p_placements < 5 then tier := null; division := null; rp := 0; return; end if;
  i := 1;
  for j in reverse 6..2 loop if p_ladder >= starts[j] then i := j; exit; end if; end loop;
  tier := names[i];
  if i = 6 then division := null; rp := p_ladder - 2200; return; end if;
  base := greatest(p_ladder, 700) - starts[i];
  d := least(2, base / 100);
  division := (array['III','II','I'])[d+1];
  rp := base - d*100;
end $$;

create or replace function public.pokejam_apply_rank(p_user uuid, p_opp int, p_won boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare s public.pokejam_profiles; v_placing boolean; k int; delta int; v record; nl int; ns int;
        v_before jsonb; v_after jsonb; ev text := null; bi int; ai int;
begin
  select * into s from public.pokejam_profiles where id = p_user for update;
  v_placing := s.placements < 5;
  k := case when v_placing then 64 else 24 end;
  delta := round(k * ((case when p_won then 1 else 0 end) - 1.0 / (1 + power(10, (p_opp - s.mmr) / 400.0))));
  select * into v from public.pokejam_rank_view(s.ladder, s.placements);
  v_before := jsonb_build_object('tier', v.tier, 'division', v.division, 'rp', v.rp, 'placements', s.placements);
  if v_placing then nl := s.mmr + delta; ns := 0; if s.placements + 1 = 5 then ev := 'placed'; end if;
  elsif p_won then nl := s.ladder + delta; ns := 0;
  elsif v.tier <> 'Pokémon Master' and v.rp + delta < 0 and s.ladder > 700 and s.shield < 2 then
    nl := s.ladder - v.rp; ns := s.shield + 1; ev := 'shielded';
  else nl := greatest(700, s.ladder + delta); ns := 0;
  end if;
  update public.pokejam_profiles set mmr = mmr + delta, placements = least(5, placements + 1), ladder = nl, shield = ns,
    wins = wins + (case when p_won then 1 else 0 end), losses = losses + (case when p_won then 0 else 1 end),
    updated_at = now() where id = p_user returning * into s;
  select * into v from public.pokejam_rank_view(s.ladder, s.placements);
  update public.pokejam_profiles set tier = v.tier, division = v.division, rp = v.rp where id = p_user;
  v_after := jsonb_build_object('tier', v.tier, 'division', v.division, 'rp', v.rp, 'placements', s.placements);
  if not v_placing and v_before->>'tier' is not null then
    bi := case when v_before->>'tier' = 'Pokémon Master' then 99 else 0 end + array_position(array['Bronze','Silver','Gold','Platinum','Diamond','Pokémon Master'], v_before->>'tier') * 3
          + coalesce(array_position(array['III','II','I'], v_before->>'division'), 0);
    ai := case when v_after->>'tier' = 'Pokémon Master' then 99 else 0 end + array_position(array['Bronze','Silver','Gold','Platinum','Diamond','Pokémon Master'], v_after->>'tier') * 3
          + coalesce(array_position(array['III','II','I'], v_after->>'division'), 0);
    if ai > bi then ev := 'promoted'; elsif ai < bi then ev := 'demoted'; end if;
  end if;
  return jsonb_build_object('before', v_before, 'after', v_after, 'mmrDelta', delta, 'event', ev);
end $$;

-- ---------- player RPCs ----------
create or replace function public.pokejam_ensure_profile(p_name text default null)
returns public.pokejam_profiles language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); r public.pokejam_profiles;
begin
  if me is null then raise exception 'not signed in'; end if;
  insert into public.pokejam_profiles(id, trainer_name) values (me, coalesce(nullif(left(trim(p_name),20),''),'Trainer'))
    on conflict (id) do update set trainer_name = coalesce(nullif(left(trim(p_name),20),''), pokejam_profiles.trainer_name)
    returning * into r;
  return r;
end $$;

-- Join (or keep polling) a queue. Returns a match id once paired. Window widens 100 MMR + 25/sec waited (max 1000).
create or replace function public.pokejam_find_match(p_queue text)
returns uuid language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); my public.pokejam_profiles; q public.pokejam_queue; other public.pokejam_queue; mid uuid; win int;
begin
  if me is null then raise exception 'not signed in'; end if;
  if p_queue not in ('social','ranked') then raise exception 'bad queue'; end if;
  -- Already paired by the other player?
  select id into mid from public.pokejam_matches where status = 'active' and me in (host, guest)
    and created_at > now() - interval '2 minutes' and room_code is null order by created_at desc limit 1;
  if mid is not null then delete from public.pokejam_queue where user_id = me; return mid; end if;
  select * into my from public.pokejam_profiles where id = me;
  if my.id is null then raise exception 'no profile'; end if;
  insert into public.pokejam_queue(user_id, queue, mmr) values (me, p_queue, my.mmr)
    on conflict (user_id) do update set queue = excluded.queue,
      joined_at = case when pokejam_queue.queue = excluded.queue then pokejam_queue.joined_at else now() end
    returning * into q;
  win := least(1000, 100 + 25 * extract(epoch from now() - q.joined_at)::int);
  select * into other from public.pokejam_queue
    where queue = p_queue and user_id <> me and joined_at > now() - interval '2 minutes' and abs(mmr - my.mmr) <= win
    order by abs(mmr - my.mmr), joined_at limit 1 for update skip locked;
  if other.user_id is null then return null; end if;
  insert into public.pokejam_matches(queue, host, guest, host_mmr, guest_mmr)
    values (p_queue, other.user_id, me, other.mmr, my.mmr) returning id into mid;
  delete from public.pokejam_queue where user_id in (me, other.user_id);
  return mid;
end $$;

create or replace function public.pokejam_leave_queue()
returns void language sql security definer set search_path = public as $$
  delete from public.pokejam_queue where user_id = auth.uid();
$$;

-- Social "Play a friend": host makes a 6-char code, friend joins with it.
create or replace function public.pokejam_create_room()
returns text language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); code text; m int;
begin
  if me is null then raise exception 'not signed in'; end if;
  select mmr into m from public.pokejam_profiles where id = me;
  if m is null then raise exception 'no profile'; end if;
  update public.pokejam_matches set status = 'void' where host = me and status = 'waiting';
  loop
    code := upper(substr(translate(encode(extensions.gen_random_bytes(6), 'base64'), '+/=0O1I', 'XYZ'), 1, 6));
    exit when length(code) = 6 and not exists (select 1 from public.pokejam_matches where room_code = code);
  end loop;
  insert into public.pokejam_matches(queue, host, host_mmr, room_code, status) values ('social', me, m, code, 'waiting');
  return code;
end $$;

create or replace function public.pokejam_join_room(p_code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); mid uuid; m int;
begin
  if me is null then raise exception 'not signed in'; end if;
  select mmr into m from public.pokejam_profiles where id = me;
  if m is null then raise exception 'no profile'; end if;
  update public.pokejam_matches set guest = me, guest_mmr = m, status = 'active'
    where room_code = upper(trim(p_code)) and status = 'waiting' and host <> me
      and created_at > now() - interval '30 minutes'
    returning id into mid;
  if mid is null then raise exception 'room not found'; end if;
  return mid;
end $$;

-- Each player reports whether the HOST won. Ranked rank changes only when both reports agree,
-- or the host's report stands alone after 120s (guest left) — sanity: match must be active and <2h old.
create or replace function public.pokejam_report_result(p_match uuid, p_host_won boolean)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); m public.pokejam_matches; final boolean; hr jsonb; gr jsonb;
begin
  select * into m from public.pokejam_matches where id = p_match for update;
  if m.id is null or me is null or me not in (m.host, m.guest) then raise exception 'not in this match'; end if;
  if m.status = 'done' then return jsonb_build_object('status','done','winner',m.winner); end if;
  if m.status <> 'active' or m.guest is null then raise exception 'match not active'; end if;
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
    hr := public.pokejam_apply_rank(m.host, m.guest_mmr, final);
    gr := public.pokejam_apply_rank(m.guest, m.host_mmr, not final);
  end if;
  return jsonb_build_object('status','done','winner', case when final then m.host else m.guest end,
    'rank', case when me = m.host then hr else gr end);
end $$;

-- The caller's own rank outcome for a finished match (the second reporter finalizes; the first polls this).
create or replace function public.pokejam_match_status(p_match uuid)
returns jsonb language sql security definer set search_path = public as $$
  select jsonb_build_object('status', status, 'winner', winner) from public.pokejam_matches
  where id = p_match and auth.uid() in (host, guest);
$$;

revoke all on function public.pokejam_rank_view(int,int), public.pokejam_apply_rank(uuid,int,boolean),
  public.pokejam_ensure_profile(text), public.pokejam_find_match(text), public.pokejam_leave_queue(),
  public.pokejam_create_room(), public.pokejam_join_room(text), public.pokejam_report_result(uuid,boolean),
  public.pokejam_match_status(uuid) from public, anon, authenticated;
grant execute on function public.pokejam_ensure_profile(text), public.pokejam_find_match(text), public.pokejam_leave_queue(),
  public.pokejam_create_room(), public.pokejam_join_room(text), public.pokejam_report_result(uuid,boolean),
  public.pokejam_match_status(uuid) to authenticated;
