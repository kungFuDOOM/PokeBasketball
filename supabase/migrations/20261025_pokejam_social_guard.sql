-- PokeJam Social: anti-griefing (before Stage 1 goes to players). Shared gauntlet-legends project: only pokejam_*
-- objects, plus RLS policies scoped to pokejam match topics on realtime.messages.
--
-- 1. The server picks each match's seed and quarter length, so neither player can stack the game. Both clients
--    derive both rosters from the seed (src/multiplayer/shared/roster.ts) and take names from the server.
-- 2. Trainer names are cleaned on the server: a safe character set, no invisible or direction-flipping
--    characters, no slurs (leetspeak included) and no impersonating staff. A rejected name becomes "Trainer".
-- 3. Rate limits on matchmaking, rooms (wrong room codes count, so codes can't be guessed), name changes and reports.
-- 4. Bans (admin, service role), set by hand or automatically when 5 different opponents report a player in 24 hours.
-- 5. Players can report and block an opponent. Quick match never pairs two players when either blocked the other,
--    and a blocked player can't join the blocker's room.
-- 6. Match channels are private: only the two players can read or send on realtime topic pokejam:match:<id>.

-- ---------- 1. server-picked seed and quarter length ----------

alter table public.pokejam_matches
  add column if not exists seed bigint,
  add column if not exists quarter_len int not null default 120;
alter table public.pokejam_matches drop constraint if exists pokejam_matches_quarter_len;
alter table public.pokejam_matches add constraint pokejam_matches_quarter_len check (quarter_len in (60, 120));

-- A uniformly random 32-bit seed.
create or replace function public.pokejam_new_seed()
returns bigint language sql volatile set search_path = public as $$
  select ('x' || encode(extensions.gen_random_bytes(4), 'hex'))::bit(32)::bigint;
$$;

-- ---------- 2. trainer names ----------

-- Lowercase letters only, with common look-alike swaps undone: what a filter should compare.
create or replace function public.pokejam_name_skeleton(p text)
returns text language sql immutable set search_path = public as $$
  select regexp_replace(
    translate(lower(coalesce(p, '')), '013457@$!|àáâãäåèéêëìíîïòóôõöùúûüýÿçñ', 'oieastasiiaaaaaaeeeeiiiiooooouuuuyycn'),
    '[^a-z]', '', 'g');
$$;

-- A word as a pattern that also catches it stretched ("niiigg"): every letter may repeat.
create or replace function public.pokejam_word_pattern(p_word text)
returns text language sql immutable set search_path = public as $$
  select regexp_replace(p_word, '(.)', '\1+', 'g');
$$;

create or replace function public.pokejam_name_blocked(p text)
returns boolean language sql immutable set search_path = public as $$
  with t as (
    -- Innocent words that contain a blocked root (the "Scunthorpe problem") are taken out before the check.
    select regexp_replace(public.pokejam_name_skeleton(p), '(scunthorpe|penistone|therapist|shiitake|pussycat|pussywillow|cockatoo|cockatiel|hancock|peacock|dickens)', '', 'g') as k,
      array(select public.pokejam_name_skeleton(x) from regexp_split_to_table(coalesce(p, ''), '[ ._''!-]+') as x
            where public.pokejam_name_skeleton(x) <> '') as words
  )
  select exists (
    -- Slurs and the worst words: blocked anywhere in the name, spaces and look-alikes removed.
    select 1 from t, unnest(array['nigg', 'faggot', 'fagot', 'kike', 'tranny', 'retard', 'cunt', 'whore', 'rapist',
      'hitler', 'kkk', 'molest', 'wetback', 'beaner', 'porn', 'dildo', 'jizz', 'pussy', 'penis', 'vagina',
      'fuck', 'shit', 'bitch']) as w(root)
    where t.k ~ public.pokejam_word_pattern(w.root)
  ) or exists (
    -- Words that are also inside ordinary names ("Raccoon", "Grape", "Nigel", "Peacock"), and staff, the game and
    -- its partners (no impersonation): blocked as a whole word, or as the whole name run together.
    select 1 from t, unnest(t.words || t.k) as n(word), unnest(array['niger', 'fag', 'spic', 'spick', 'chink', 'gook',
      'coon', 'rape', 'pedo', 'nazi', 'dyke', 'slut', 'cock', 'dick', 'ass', 'sex', 'semen', 'anal', 'cum', 'tits', 'nigga',
      'admin', 'administrator', 'moderator', 'mod', 'staff', 'support', 'official', 'system', 'pokejam', 'pokejamofficial',
      'kungfudoom', 'thepaypay', 'collectorcrypt']) as w(word)
    where n.word ~ ('^' || public.pokejam_word_pattern(w.word) || '$')
  );
$$;

-- The name the server keeps: letters (accented too), digits, spaces and . - _ ' ! only; 1 to 20 characters.
-- Anything blocked, or nothing left, is "Trainer".
create or replace function public.pokejam_clean_name(p text)
returns text language plpgsql immutable set search_path = public as $$
declare n text;
begin
  n := regexp_replace(coalesce(p, ''), '[^A-Za-z0-9À-ÖØ-öø-ÿ .''_!-]', '', 'g');
  n := btrim(regexp_replace(n, ' {2,}', ' ', 'g'));
  n := left(n, 20);
  n := btrim(n);
  if n = '' or public.pokejam_name_blocked(n) then return 'Trainer'; end if;
  return n;
end $$;

update public.pokejam_profiles set trainer_name = public.pokejam_clean_name(trainer_name)
  where trainer_name is distinct from public.pokejam_clean_name(trainer_name);

-- ---------- 3. rate limits ----------

create table if not exists public.pokejam_rate (
  user_id uuid not null references auth.users(id) on delete cascade,
  action text not null,
  window_start timestamptz not null default now(),
  n int not null default 0,
  primary key (user_id, action)
);
alter table public.pokejam_rate enable row level security;
revoke all on public.pokejam_rate from anon, authenticated, public;

-- Count one `action` for the caller; false once they've done it p_max times in the current window.
create or replace function public.pokejam_rate_ok(p_action text, p_max int, p_window interval)
returns boolean language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); r public.pokejam_rate;
begin
  if me is null then return false; end if;
  insert into public.pokejam_rate(user_id, action, window_start, n) values (me, p_action, now(), 1)
    on conflict (user_id, action) do update set
      window_start = case when pokejam_rate.window_start < now() - p_window then now() else pokejam_rate.window_start end,
      n = case when pokejam_rate.window_start < now() - p_window then 1 else pokejam_rate.n + 1 end
    returning * into r;
  return r.n <= p_max;
end $$;

-- ---------- 4. bans ----------

create table if not exists public.pokejam_bans (
  user_id uuid primary key references auth.users(id) on delete cascade,
  until timestamptz not null,
  reason text,
  auto boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.pokejam_bans enable row level security;
revoke all on public.pokejam_bans from anon, authenticated, public;

create or replace function public.pokejam_banned(p_user uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.pokejam_bans where user_id = p_user and until > now());
$$;

-- Admin (service role): ban a player for p_hours (they're taken out of the queue at once), or lift a ban.
create or replace function public.pokejam_ban(p_user uuid, p_hours int, p_reason text default null)
returns void language plpgsql security definer set search_path = public as $$
begin
  insert into public.pokejam_bans(user_id, until, reason, auto) values (p_user, now() + make_interval(hours => greatest(1, p_hours)), left(p_reason, 500), false)
    on conflict (user_id) do update set until = excluded.until, reason = excluded.reason, auto = false, created_at = now();
  delete from public.pokejam_queue where user_id = p_user;
  update public.pokejam_matches set status = 'void', finished_at = now() where host = p_user and status = 'waiting';
end $$;

create or replace function public.pokejam_unban(p_user uuid)
returns void language sql security definer set search_path = public as $$
  delete from public.pokejam_bans where user_id = p_user;
$$;

-- ---------- 5. reports and blocks ----------

create table if not exists public.pokejam_reports (
  id bigserial primary key,
  reporter uuid not null references auth.users(id) on delete cascade,
  reported uuid not null references auth.users(id) on delete cascade,
  match_id uuid not null references public.pokejam_matches(id) on delete cascade,
  reason text not null check (reason in ('name', 'cheating', 'quitting', 'other')),
  note text check (char_length(note) <= 200),
  created_at timestamptz not null default now(),
  unique (reporter, match_id)
);
create index if not exists pokejam_reports_reported_idx on public.pokejam_reports(reported, created_at);
alter table public.pokejam_reports enable row level security;
revoke all on public.pokejam_reports from anon, authenticated, public;
revoke all on sequence public.pokejam_reports_id_seq from anon, authenticated, public;

create table if not exists public.pokejam_blocks (
  user_id uuid not null references auth.users(id) on delete cascade,
  blocked uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, blocked),
  check (user_id <> blocked)
);
alter table public.pokejam_blocks enable row level security;
revoke all on public.pokejam_blocks from anon, authenticated, public;
grant select on public.pokejam_blocks to authenticated;
drop policy if exists "pokejam own blocks" on public.pokejam_blocks;
create policy "pokejam own blocks" on public.pokejam_blocks for select to authenticated using (user_id = (select auth.uid()));

create or replace function public.pokejam_blocked_pair(a uuid, b uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.pokejam_blocks where (user_id = a and blocked = b) or (user_id = b and blocked = a));
$$;

-- Report the other player in a match you played. One report per match; 5 different reporters in 24 hours ban
-- the player for 24 hours (a person reviews it). Returns true when the report was taken.
create or replace function public.pokejam_report_player(p_match uuid, p_reason text, p_note text default null)
returns boolean language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); m public.pokejam_matches; them uuid; n int;
begin
  if me is null then raise exception 'not signed in'; end if;
  if p_reason not in ('name', 'cheating', 'quitting', 'other') then raise exception 'bad reason'; end if;
  select * into m from public.pokejam_matches where id = p_match;
  if m.id is null or me not in (m.host, m.guest) or m.guest is null then raise exception 'not in this match'; end if;
  if not public.pokejam_rate_ok('report', 20, interval '1 day') then raise exception 'Too many reports today.'; end if;
  them := case when me = m.host then m.guest else m.host end;
  insert into public.pokejam_reports(reporter, reported, match_id, reason, note)
    values (me, them, m.id, p_reason, left(nullif(btrim(p_note), ''), 200))
    on conflict (reporter, match_id) do nothing;
  if not found then return false; end if;
  select count(distinct reporter) into n from public.pokejam_reports where reported = them and created_at > now() - interval '24 hours';
  if n >= 5 and not public.pokejam_banned(them) then
    insert into public.pokejam_bans(user_id, until, reason, auto) values (them, now() + interval '24 hours', 'auto: reported by 5 players in 24 hours', true)
      on conflict (user_id) do update set until = excluded.until, reason = excluded.reason, auto = true, created_at = now();
    delete from public.pokejam_queue where user_id = them;
  end if;
  return true;
end $$;

-- Block the other player in a match you played: you'll never be matched again.
create or replace function public.pokejam_block_player(p_match uuid)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); m public.pokejam_matches;
begin
  if me is null then raise exception 'not signed in'; end if;
  select * into m from public.pokejam_matches where id = p_match;
  if m.id is null or me not in (m.host, m.guest) or m.guest is null then raise exception 'not in this match'; end if;
  insert into public.pokejam_blocks(user_id, blocked) values (me, case when me = m.host then m.guest else m.host end)
    on conflict do nothing;
end $$;

create or replace function public.pokejam_unblock_player(p_user uuid)
returns void language sql security definer set search_path = public as $$
  delete from public.pokejam_blocks where user_id = auth.uid() and blocked = p_user;
$$;

-- ---------- the player RPCs, with the guards ----------

-- The server keeps a clean name. Changing it is rate-limited (setting the same name again is free).
create or replace function public.pokejam_ensure_profile(p_name text default null)
returns public.pokejam_profiles language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); r public.pokejam_profiles; clean text;
begin
  if me is null then raise exception 'not signed in'; end if;
  clean := case when nullif(btrim(coalesce(p_name, '')), '') is null then null else public.pokejam_clean_name(p_name) end;
  select * into r from public.pokejam_profiles where id = me;
  if r.id is null then
    insert into public.pokejam_profiles(id, trainer_name) values (me, coalesce(clean, 'Trainer')) returning * into r;
    return r;
  end if;
  if clean is null or clean = r.trainer_name then return r; end if;
  if not public.pokejam_rate_ok('rename', 6, interval '1 hour') then return r; end if;
  update public.pokejam_profiles set trainer_name = clean, updated_at = now() where id = me returning * into r;
  return r;
end $$;

create or replace function public.pokejam_find_match(p_queue text)
returns uuid language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); my public.pokejam_profiles; q public.pokejam_queue; other public.pokejam_queue; mid uuid; win int;
begin
  if me is null then raise exception 'not signed in'; end if;
  if p_queue not in ('social','ranked') then raise exception 'bad queue'; end if;
  if public.pokejam_banned(me) then raise exception 'You are suspended from online play for now.'; end if;
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

-- The room's host picks the quarter length (1 or 2 minutes); the server picks the seed.
drop function if exists public.pokejam_create_room();
create or replace function public.pokejam_create_room(p_quarter_len int default 120)
returns text language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); code text; m int;
begin
  if me is null then raise exception 'not signed in'; end if;
  if public.pokejam_banned(me) then raise exception 'You are suspended from online play for now.'; end if;
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

-- Null when there's no open room with that code (and for a blocked player, so a block can't be probed). Every try
-- counts toward the limit, so guessing codes gets nowhere: 15 tries in 10 minutes against 30 bits of code.
create or replace function public.pokejam_join_room(p_code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); mid uuid; m int; r public.pokejam_matches;
begin
  if me is null then raise exception 'not signed in'; end if;
  if public.pokejam_banned(me) then raise exception 'You are suspended from online play for now.'; end if;
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

-- Who is in a match (participants only), and the game the server picked for it.
create or replace function public.pokejam_match_info(p_match uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', m.id, 'queue', m.queue, 'status', m.status, 'host', m.host, 'guest', m.guest,
    'host_name', hp.trainer_name, 'guest_name', gp.trainer_name, 'seed', m.seed, 'quarter_len', m.quarter_len)
  from public.pokejam_matches m
  join public.pokejam_profiles hp on hp.id = m.host
  left join public.pokejam_profiles gp on gp.id = m.guest
  where m.id = p_match and auth.uid() in (m.host, m.guest);
$$;

-- ---------- 6. private match channels ----------

-- Is the caller one of the two players in the active match this topic belongs to? Every other topic (other apps on
-- this project) is false without being parsed, so no topic can make this policy error.
create or replace function public.pokejam_channel_ok(p_topic text)
returns boolean language sql stable security definer set search_path = public as $$
  select case when p_topic ~ '^pokejam:match:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then exists (
    select 1 from public.pokejam_matches m
    where m.id = substr(p_topic, 15)::uuid and (select auth.uid()) in (m.host, m.guest) and m.status = 'active'
  ) else false end;
$$;

-- Only on projects with Realtime authorization (Supabase has the table; a bare Postgres doesn't).
do $$
begin
  if exists (select 1 from information_schema.tables where table_schema = 'realtime' and table_name = 'messages') then
    execute 'drop policy if exists "pokejam match players read" on realtime.messages';
    execute 'drop policy if exists "pokejam match players send" on realtime.messages';
    execute $p$create policy "pokejam match players read" on realtime.messages for select to authenticated using (
      public.pokejam_channel_ok(realtime.topic()))$p$;
    execute $p$create policy "pokejam match players send" on realtime.messages for insert to authenticated with check (
      public.pokejam_channel_ok(realtime.topic()))$p$;
  end if;
end $$ ;

-- ---------- grants ----------

revoke all on function public.pokejam_new_seed(), public.pokejam_name_skeleton(text), public.pokejam_word_pattern(text),
  public.pokejam_name_blocked(text), public.pokejam_clean_name(text), public.pokejam_rate_ok(text, int, interval),
  public.pokejam_banned(uuid), public.pokejam_ban(uuid, int, text), public.pokejam_unban(uuid), public.pokejam_blocked_pair(uuid, uuid),
  public.pokejam_report_player(uuid, text, text), public.pokejam_block_player(uuid), public.pokejam_unblock_player(uuid),
  public.pokejam_ensure_profile(text), public.pokejam_find_match(text), public.pokejam_create_room(int), public.pokejam_join_room(text),
  public.pokejam_match_info(uuid), public.pokejam_channel_ok(text)
  from public, anon, authenticated;
grant execute on function public.pokejam_ensure_profile(text), public.pokejam_find_match(text), public.pokejam_create_room(int),
  public.pokejam_join_room(text), public.pokejam_match_info(uuid), public.pokejam_report_player(uuid, text, text),
  public.pokejam_block_player(uuid), public.pokejam_unblock_player(uuid),
  -- The channel policies run as the player, so they need this one.
  public.pokejam_channel_ok(text)
  to authenticated;
grant execute on function public.pokejam_ban(uuid, int, text), public.pokejam_unban(uuid) to service_role;
