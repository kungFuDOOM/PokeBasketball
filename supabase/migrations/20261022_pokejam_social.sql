-- PokeJam Stage 1 (Social online play). Shared gauntlet-legends project: only pokejam_* objects are touched.

-- A room-code match is always Social, so it can never feed the rating RPCs.
alter table public.pokejam_matches drop constraint if exists pokejam_matches_room_is_social;
alter table public.pokejam_matches add constraint pokejam_matches_room_is_social check (room_code is null or queue = 'social');

-- Quick match: only hand back a pairing from the queue the caller is searching (a fresh Ranked pairing must never
-- be returned to a Social search, or the "social" game would be rated).
create or replace function public.pokejam_find_match(p_queue text)
returns uuid language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); my public.pokejam_profiles; q public.pokejam_queue; other public.pokejam_queue; mid uuid; win int;
begin
  if me is null then raise exception 'not signed in'; end if;
  if p_queue not in ('social','ranked') then raise exception 'bad queue'; end if;
  select id into mid from public.pokejam_matches where status = 'active' and me in (host, guest) and queue = p_queue
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

-- Who is in a match (participants only): ids, trainer names, queue and status.
create or replace function public.pokejam_match_info(p_match uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', m.id, 'queue', m.queue, 'status', m.status, 'host', m.host, 'guest', m.guest,
    'host_name', hp.trainer_name, 'guest_name', gp.trainer_name)
  from public.pokejam_matches m
  join public.pokejam_profiles hp on hp.id = m.host
  left join public.pokejam_profiles gp on gp.id = m.guest
  where m.id = p_match and auth.uid() in (m.host, m.guest);
$$;

-- Host of a "Play a friend" room: has my friend joined yet? Returns the match id once they have, else null.
create or replace function public.pokejam_room_match(p_code text)
returns uuid language sql stable security definer set search_path = public as $$
  select id from public.pokejam_matches
  where room_code = upper(trim(p_code)) and host = auth.uid() and status = 'active' and guest is not null;
$$;

-- Leave a Social match or room without a result (quit, disconnect, cancelled room). Ranked matches are untouched.
create or replace function public.pokejam_leave_match(p_match uuid)
returns void language sql security definer set search_path = public as $$
  update public.pokejam_matches set status = 'void', finished_at = now()
  where id = p_match and queue = 'social' and status in ('waiting','active') and auth.uid() in (host, guest);
$$;

-- Host cancels a room nobody has joined yet.
create or replace function public.pokejam_close_room(p_code text)
returns void language sql security definer set search_path = public as $$
  update public.pokejam_matches set status = 'void', finished_at = now()
  where room_code = upper(trim(p_code)) and host = auth.uid() and status = 'waiting';
$$;

revoke all on function public.pokejam_match_info(uuid), public.pokejam_room_match(text), public.pokejam_leave_match(uuid),
  public.pokejam_close_room(text) from public, anon, authenticated;
grant execute on function public.pokejam_match_info(uuid), public.pokejam_room_match(text), public.pokejam_leave_match(uuid),
  public.pokejam_close_room(text) to authenticated;
