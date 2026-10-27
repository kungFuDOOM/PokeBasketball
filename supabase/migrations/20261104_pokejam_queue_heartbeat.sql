-- PokeJam online: no more ghosts in the queue, and leaving cleans up after itself. Shared gauntlet-legends project:
-- pokejam_* only. Safe to run again. Every RPC keeps its name, arguments and result, so older clients (pokejam-test,
-- Ranked too) work unchanged: they already poll pokejam_find_match every 2 s, which is now their heartbeat.
--
-- - pokejam_queue.last_seen: every search poll refreshes it, and quick match only pairs players seen in the last
--   15 seconds. A player who locked the phone or closed the tab used to stay matchable for 2 minutes. (This also
--   replaces the 2-minute limit on joined_at, which stopped anyone who had searched for 2 minutes from being found.)
-- - pokejam_leave_queue also calls off a quick Social match the server made for me in the last 2 minutes that I never
--   opened (a cancelled search or a closed tab, between two polls), so the other player isn't left waiting.
-- - pokejam_close_room also calls off a room a friend has joined if the host never opened its draft.
-- - pokejam_room_state: what happened to my room (the host polls it instead of pokejam_room_match), so the host
--   learns the room was closed or ran out instead of waiting for ever.
-- - Matchmaking runs the abandoned-match cleanup (20261103) at most once a minute.

alter table public.pokejam_queue add column if not exists last_seen timestamptz not null default now();
create index if not exists pokejam_queue_seen_idx on public.pokejam_queue(queue, last_seen);

create or replace function public.pokejam_find_match(p_queue text)
returns uuid language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); my public.pokejam_profiles; q public.pokejam_queue; other public.pokejam_queue; mid uuid; win int;
begin
  if me is null then raise exception 'not signed in'; end if;
  if p_queue not in ('social','ranked') then raise exception 'bad queue'; end if;
  if public.pokejam_banned(me) then raise exception 'You are suspended from online play for now.'; end if;
  if not public.pokejam_human_ok(me) then raise exception 'human check needed'; end if;
  -- The client polls every 2 s; 60 a minute leaves room for a retry or two.
  if not public.pokejam_rate_ok('find', 60, interval '1 minute') then raise exception 'Slow down: too many matchmaking requests.'; end if;
  perform public.pokejam_cleanup_maybe();
  select id into mid from public.pokejam_matches where status = 'active' and me in (host, guest) and queue = p_queue
    and created_at > now() - interval '2 minutes' and room_code is null order by created_at desc limit 1;
  if mid is not null then delete from public.pokejam_queue where user_id = me; return mid; end if;
  select * into my from public.pokejam_profiles where id = me;
  if my.id is null then raise exception 'no profile'; end if;
  -- Every poll is a heartbeat.
  insert into public.pokejam_queue(user_id, queue, mmr, last_seen) values (me, p_queue, my.mmr, now())
    on conflict (user_id) do update set queue = excluded.queue, last_seen = now(),
      joined_at = case when pokejam_queue.queue = excluded.queue then pokejam_queue.joined_at else now() end
    returning * into q;
  win := least(1000, 100 + 25 * extract(epoch from now() - q.joined_at)::int);
  select * into other from public.pokejam_queue o
    where o.queue = p_queue and o.user_id <> me and o.last_seen > now() - interval '15 seconds' and abs(o.mmr - my.mmr) <= win
      and not public.pokejam_blocked_pair(me, o.user_id) and not public.pokejam_banned(o.user_id)
    order by abs(o.mmr - my.mmr), o.joined_at limit 1 for update skip locked;
  if other.user_id is null then return null; end if;
  insert into public.pokejam_matches(queue, host, guest, host_mmr, guest_mmr, seed, quarter_len)
    values (p_queue, other.user_id, me, other.mmr, my.mmr, public.pokejam_new_seed(), 120) returning id into mid;
  delete from public.pokejam_queue where user_id in (me, other.user_id);
  return mid;
end $$;

-- As in 20261027, plus the cleanup on the way.
create or replace function public.pokejam_create_room(p_quarter_len int default 120)
returns text language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); code text; m int;
begin
  if me is null then raise exception 'not signed in'; end if;
  if public.pokejam_banned(me) then raise exception 'You are suspended from online play for now.'; end if;
  if not public.pokejam_human_ok(me) then raise exception 'human check needed'; end if;
  if not public.pokejam_rate_ok('room', 10, interval '10 minutes') then raise exception 'Slow down: too many rooms. Try again in a few minutes.'; end if;
  perform public.pokejam_cleanup_maybe();
  select mmr into m from public.pokejam_profiles where id = me;
  if m is null then raise exception 'no profile'; end if;
  update public.pokejam_matches set status = 'void' where host = me and status = 'waiting';
  loop
    code := upper(substr(translate(encode(extensions.gen_random_bytes(6), 'base64'), '+/=0O1I', 'XYZ'), 1, 6));
    exit when length(code) = 6 and not exists (select 1 from public.pokejam_matches where room_code = code);
  end loop;
  insert into public.pokejam_matches(queue, host, host_mmr, room_code, status, seed, quarter_len)
    values ('social', me, m, code, 'waiting', public.pokejam_new_seed(), case when p_quarter_len = 60 then 60 else 120 end);
  return code;
end $$;

create or replace function public.pokejam_leave_queue()
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  delete from public.pokejam_queue where user_id = me;
  -- A quick Social match made for me since my last poll, that I never opened: call it off (Ranked is untouched).
  update public.pokejam_matches m set status = 'void', finished_at = now()
    where me in (m.host, m.guest) and m.queue = 'social' and m.status = 'active' and m.room_code is null
      and m.created_at > now() - interval '2 minutes'
      and not exists (select 1 from public.pokejam_drafts d where d.match_id = m.id
                      and (case when me = m.host then d.host_seen else d.guest_seen end) is not null);
end $$;

-- Host cancels a room: nobody joined yet, or a friend joined but the host never opened the draft.
create or replace function public.pokejam_close_room(p_code text)
returns void language sql security definer set search_path = public as $$
  update public.pokejam_matches m set status = 'void', finished_at = now()
  where m.room_code = upper(trim(p_code)) and m.host = auth.uid()
    and (m.status = 'waiting' or (m.status = 'active' and not exists (
      select 1 from public.pokejam_drafts d where d.match_id = m.id and d.host_seen is not null)));
$$;

-- Host of a room: has my friend joined ('match' is set), is it still open, or is it over ('void', 'done', or
-- 'expired' when nobody joined for 30 minutes)? Null if I have no room with this code.
create or replace function public.pokejam_room_state(p_code text)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'match', case when m.status = 'active' and m.guest is not null then m.id end,
    'status', case when m.status = 'waiting' and m.created_at < now() - interval '30 minutes' then 'expired' else m.status end)
  from public.pokejam_matches m
  where m.room_code = upper(trim(p_code)) and m.host = auth.uid();
$$;

revoke all on function public.pokejam_find_match(text), public.pokejam_create_room(int), public.pokejam_leave_queue(),
  public.pokejam_close_room(text), public.pokejam_room_state(text) from public, anon, authenticated;
grant execute on function public.pokejam_find_match(text), public.pokejam_create_room(int), public.pokejam_leave_queue(),
  public.pokejam_close_room(text), public.pokejam_room_state(text) to authenticated;
