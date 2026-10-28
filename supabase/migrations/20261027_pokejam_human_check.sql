-- PokeJam online: a Cloudflare Turnstile check before a player can make or join an online match (issue #20).
-- Shared gauntlet-legends project: pokejam_* only.
--
-- The pokejam-human Edge Function verifies a Turnstile token with Cloudflare (Siteverify, TURNSTILE_SECRET_KEY)
-- and grants the player a short pass. While `require_human` is on, quick match, making a room and joining one
-- refuse a player without a valid pass ("human check needed"; the client runs the check and tries again).
-- It's off until kungFuDOOM turns it on, once the keys are set:
--   update public.pokejam_config set value = 'true' where key = 'require_human';

create table if not exists public.pokejam_config (
  key text primary key,
  value jsonb not null
);
alter table public.pokejam_config enable row level security;
revoke all on public.pokejam_config from anon, authenticated, public;
insert into public.pokejam_config(key, value) values ('require_human', 'false') on conflict (key) do nothing;

create table if not exists public.pokejam_human (
  user_id uuid primary key references auth.users(id) on delete cascade,
  until timestamptz not null,
  granted_at timestamptz not null default now()
);
alter table public.pokejam_human enable row level security;
revoke all on public.pokejam_human from anon, authenticated, public;

create or replace function public.pokejam_human_required()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((select value = 'true'::jsonb from public.pokejam_config where key = 'require_human'), false);
$$;

-- True when the check is off, or the player has a pass that hasn't run out.
create or replace function public.pokejam_human_ok(p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select not public.pokejam_human_required()
    or exists (select 1 from public.pokejam_human where user_id = p_user and until > now());
$$;

-- Service role (the pokejam-human function, after Cloudflare said yes): a pass for p_minutes (1 to 60).
create or replace function public.pokejam_grant_human(p_user uuid, p_minutes int)
returns timestamptz language sql security definer set search_path = public as $$
  insert into public.pokejam_human(user_id, until) values (p_user, now() + make_interval(mins => greatest(1, least(p_minutes, 60))))
    on conflict (user_id) do update set until = excluded.until, granted_at = now()
  returning until;
$$;

-- For the client: is the check on, and until when is my pass good?
create or replace function public.pokejam_human_status()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('required', public.pokejam_human_required(),
    'until', (select until from public.pokejam_human where user_id = auth.uid()));
$$;

-- ---------- matchmaking, with the check (otherwise as in 20261025) ----------

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
  select * into other from public.pokejam_queue o
    where o.queue = p_queue and o.user_id <> me and o.joined_at > now() - interval '2 minutes' and abs(o.mmr - my.mmr) <= win
      and not public.pokejam_blocked_pair(me, o.user_id) and not public.pokejam_banned(o.user_id)
    order by abs(o.mmr - my.mmr), o.joined_at limit 1 for update skip locked;
  if other.user_id is null then return null; end if;
  insert into public.pokejam_matches(queue, host, guest, host_mmr, guest_mmr, seed, quarter_len)
    values (p_queue, other.user_id, me, other.mmr, my.mmr, public.pokejam_new_seed(), 120) returning id into mid;
  delete from public.pokejam_queue where user_id in (me, other.user_id);
  return mid;
end $$;

create or replace function public.pokejam_create_room(p_quarter_len int default 120)
returns text language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); code text; m int;
begin
  if me is null then raise exception 'not signed in'; end if;
  if public.pokejam_banned(me) then raise exception 'You are suspended from online play for now.'; end if;
  if not public.pokejam_human_ok(me) then raise exception 'human check needed'; end if;
  if not public.pokejam_rate_ok('room', 10, interval '10 minutes') then raise exception 'Slow down: too many rooms. Try again in a few minutes.'; end if;
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

create or replace function public.pokejam_join_room(p_code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); mid uuid; m int; r public.pokejam_matches;
begin
  if me is null then raise exception 'not signed in'; end if;
  if public.pokejam_banned(me) then raise exception 'You are suspended from online play for now.'; end if;
  if not public.pokejam_human_ok(me) then raise exception 'human check needed'; end if;
  if not public.pokejam_rate_ok('join', 15, interval '10 minutes') then raise exception 'Slow down: too many room codes tried. Try again in a few minutes.'; end if;
  select mmr into m from public.pokejam_profiles where id = me;
  if m is null then raise exception 'no profile'; end if;
  select * into r from public.pokejam_matches
    where room_code = upper(btrim(p_code)) and status = 'waiting' and host <> me and created_at > now() - interval '30 minutes'
    for update;
  if r.id is null or public.pokejam_blocked_pair(me, r.host) then return null; end if;
  update public.pokejam_matches set guest = me, guest_mmr = m, status = 'active' where id = r.id returning id into mid;
  return mid;
end $$;

revoke all on function public.pokejam_human_required(), public.pokejam_human_ok(uuid), public.pokejam_grant_human(uuid, int),
  public.pokejam_human_status() from public, anon, authenticated;
grant execute on function public.pokejam_human_status() to authenticated;
grant execute on function public.pokejam_grant_human(uuid, int) to service_role;
