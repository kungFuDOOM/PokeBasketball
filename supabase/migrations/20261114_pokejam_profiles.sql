-- PokeJam usernames and the Ranked username requirement (PR 4). Shared gauntlet-legends project: pokejam_* only.
-- Additive and safe to run again: new tables and functions, plus one `create or replace` of the Ranked queue path
-- (pokejam_ranked_find, the 20261113 body with one added check). Nothing dropped, no existing table altered.
-- NOT applied by the repo; the owner runs it by hand in the Supabase SQL editor.
--
-- A username is the public name Ranked shows (post-match screen, opponent, profile). It is separate from the free-form
-- "trainer_name" (team name) that Social and offline use.
--   - 3 to 16 characters, letters, digits and underscore only, at least one letter.
--   - Unique ignoring case (unique index on lower(username)).
--   - Not reserved (admin, system, ...), not staff-like (contains admin, mod, staff, ...), not profane.
--   - Guests (anonymous sessions) cannot have one. First pick is free, then one change per 30 days.
--   - Written only by pokejam_set_username (the player) or pokejam_admin_force_rename (a moderator). No direct writes.
--   - Emails and wallet addresses are never stored here or returned by these functions.
-- The filter below mirrors src/multiplayer/ranked/username.ts. The word lists are in src/multiplayer/ranked/nameFilterData.json
-- (obscenity 0.4.x English dataset, MIT) and the seed block is generated from it by scripts/gen-name-filter-sql.mjs; a test
-- (supabase/tests/usernames.test.ts) fails if the two drift apart.

-- ---------- tables ----------
create table if not exists public.pokejam_usernames (
  user_id uuid primary key references public.pokejam_profiles(id) on delete cascade,
  username text check (username is null or username ~ '^[A-Za-z0-9_]{3,16}$'),
  changed_at timestamptz,            -- last pick or change; the 30-day wait counts from here
  flagged boolean not null default false,   -- a moderator renamed or reset this name
  flagged_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists pokejam_usernames_lower on public.pokejam_usernames (lower(username));

alter table public.pokejam_usernames enable row level security;
revoke all on public.pokejam_usernames from anon, authenticated, public;
-- Public fields only: who and what name. changed_at / flagged stay private.
grant select (user_id, username) on public.pokejam_usernames to authenticated;
drop policy if exists "pokejam usernames readable by signed-in players" on public.pokejam_usernames;
create policy "pokejam usernames readable by signed-in players" on public.pokejam_usernames
  for select to authenticated using (username is not null);

-- The blocklist and its allowlist. Server only (no policies, no grants); generated below.
create table if not exists public.pokejam_name_blocklist (
  kind text not null check (kind in ('severe', 'mild', 'allow', 'reserved', 'impersonation', 'impersonation_allow')),
  term text not null check (term ~ '^[a-z]+$'),
  primary key (kind, term)
);
alter table public.pokejam_name_blocklist enable row level security;
revoke all on public.pokejam_name_blocklist from anon, authenticated, public;

-- ---------- normalising ----------
-- Repeated letters collapsed: "fuuuck" -> "fuck".
create or replace function public.pokejam_name_collapse(p text)
returns text language sql immutable set search_path = public as $$
  select regexp_replace(p, '(.)\1+', '\1', 'g')
$$;

-- Lowercase, look-alike characters mapped (0 o, 3 e, 4 a, 5 s, 7 t, 8 b, @ a, $ s, ! i; 1 is either i or l, so two results),
-- everything that is not a letter removed (underscores and the other digits). Repeats are NOT collapsed here.
create or replace function public.pokejam_name_skels(p text)
returns text[] language sql immutable set search_path = public as $$
  select array(select distinct regexp_replace(replace(translate(lower(coalesce(p, '')), '034578@$!', 'oeastbasi'), '1', v), '[^a-z]', '', 'g')
               from unnest(array['i', 'l']) as v)
$$;

-- A mild term as a regex: every run of a letter must be at least as long as in the term ("ass" -> ^a+s{2,}$, so "assss"
-- matches and "as" does not).
create or replace function public.pokejam_name_mild_rx(p text)
returns text language sql immutable set search_path = public as $$
  select '^' || string_agg(m[2] || '{' || length(m[1]) || ',}', '' order by n) || '$'
  from regexp_matches(p, '((.)\2*)', 'g') with ordinality as t(m, n)
$$;

-- Removes every allowlisted word (longest first) from an already collapsed string, leaving a space so the pieces can't join.
create or replace function public.pokejam_name_strip_allow(s text, p_kind text)
returns text language plpgsql stable set search_path = public as $$
declare r record; o text := s;
begin
  for r in select term from public.pokejam_name_blocklist where kind = p_kind order by length(term) desc, term loop
    o := replace(o, r.term, ' ');
  end loop;
  return o;
end $$;

create or replace function public.pokejam_name_mild_hit(k text)
returns boolean language sql stable set search_path = public as $$
  select k <> '' and exists (select 1 from public.pokejam_name_blocklist b where b.kind = 'mild' and k ~ public.pokejam_name_mild_rx(b.term))
$$;

-- null when the name is fine, else a code: length, charset, reserved, impersonation, profanity.
create or replace function public.pokejam_name_check(p text)
returns text language plpgsql stable set search_path = public as $$
declare k text; s text; seg text;
begin
  if p is null or char_length(p) < 3 or char_length(p) > 16 then return 'length'; end if;
  if p !~ '^[A-Za-z0-9_]+$' or p !~ '[A-Za-z]' then return 'charset'; end if;
  foreach k in array public.pokejam_name_skels(p) loop
    if exists (select 1 from public.pokejam_name_blocklist b where b.kind = 'reserved' and b.term = public.pokejam_name_collapse(k)) then return 'reserved'; end if;
  end loop;
  foreach k in array public.pokejam_name_skels(p) loop
    s := public.pokejam_name_strip_allow(public.pokejam_name_collapse(k), 'impersonation_allow');
    if exists (select 1 from public.pokejam_name_blocklist b where b.kind = 'impersonation' and position(b.term in s) > 0) then return 'impersonation'; end if;
  end loop;
  foreach k in array public.pokejam_name_skels(p) loop
    s := public.pokejam_name_strip_allow(public.pokejam_name_collapse(k), 'allow');
    if exists (select 1 from public.pokejam_name_blocklist b where b.kind = 'severe' and position(b.term in s) > 0) then return 'profanity'; end if;
    if public.pokejam_name_mild_hit(k) then return 'profanity'; end if;
  end loop;
  foreach seg in array string_to_array(lower(p), '_') loop
    foreach k in array public.pokejam_name_skels(seg) loop
      if public.pokejam_name_mild_hit(k) then return 'profanity'; end if;
    end loop;
  end loop;
  return null;
end $$;

-- ---------- player RPCs ----------
-- Pick or change my username. Errors are 'username:<code>' (client maps them to text): signin, length, charset, reserved,
-- impersonation, profanity, taken, cooldown:<days>.
create or replace function public.pokejam_set_username(p_name text)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); err text; cur public.pokejam_usernames;
begin
  if me is null then raise exception 'not signed in'; end if;
  if coalesce(auth.jwt() ->> 'is_anonymous', 'false') = 'true' then raise exception 'username:signin'; end if;
  err := public.pokejam_name_check(p_name);
  if err is not null then raise exception 'username:%', err; end if;
  insert into public.pokejam_profiles(id) values (me) on conflict (id) do nothing;
  insert into public.pokejam_usernames(user_id) values (me) on conflict (user_id) do nothing;
  select * into cur from public.pokejam_usernames where user_id = me for update;
  if cur.username = p_name then return jsonb_build_object('username', cur.username); end if;
  if cur.username is not null and cur.changed_at is not null and cur.changed_at > now() - interval '30 days' then
    raise exception 'username:cooldown:%', ceil(extract(epoch from (cur.changed_at + interval '30 days' - now())) / 86400)::int;
  end if;
  if exists (select 1 from public.pokejam_usernames u where lower(u.username) = lower(p_name) and u.user_id <> me) then
    raise exception 'username:taken';
  end if;
  begin
    update public.pokejam_usernames set username = p_name, changed_at = now(), updated_at = now() where user_id = me;
  exception when unique_violation then
    raise exception 'username:taken';
  end;
  return jsonb_build_object('username', p_name);
end $$;

-- My username and when I may change it (null = now). A guest has none.
create or replace function public.pokejam_my_username()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare me uuid := auth.uid(); cur public.pokejam_usernames; nxt timestamptz;
begin
  if me is null then raise exception 'not signed in'; end if;
  select * into cur from public.pokejam_usernames where user_id = me;
  if cur.username is null then return jsonb_build_object('username', null, 'next_change_at', null); end if;
  nxt := cur.changed_at + interval '30 days';
  return jsonb_build_object('username', cur.username, 'next_change_at', case when nxt > now() then nxt else null end);
end $$;

-- The two players' usernames in a match I am in (null for a player without one).
create or replace function public.pokejam_match_usernames(p_match uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare me uuid := auth.uid(); m public.pokejam_matches;
begin
  if me is null then raise exception 'not signed in'; end if;
  select * into m from public.pokejam_matches where id = p_match;
  if m.id is null or me not in (m.host, m.guest) then raise exception 'not in this match'; end if;
  return jsonb_build_object(
    'host', (select u.username from public.pokejam_usernames u where u.user_id = m.host),
    'guest', (select u.username from public.pokejam_usernames u where u.user_id = m.guest));
end $$;

-- ---------- moderator RPC ----------
-- Force a new name on a player (validated like any other), or reset it (p_name null: they pick again, free). The name is
-- flagged and the 30-day wait restarts, so they can't swap straight back. Logged in pokejam_admin_log.
create or replace function public.pokejam_admin_force_rename(p_user uuid, p_name text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := public.pokejam_require_admin(); err text; old text;
begin
  if not exists (select 1 from public.pokejam_profiles where id = p_user) then raise exception 'player not found'; end if;
  if p_name is not null then
    err := public.pokejam_name_check(p_name);
    if err is not null then raise exception 'username:%', err; end if;
    if exists (select 1 from public.pokejam_usernames u where lower(u.username) = lower(p_name) and u.user_id <> p_user) then
      raise exception 'username:taken';
    end if;
  end if;
  insert into public.pokejam_usernames(user_id) values (p_user) on conflict (user_id) do nothing;
  select username into old from public.pokejam_usernames where user_id = p_user for update;
  begin
    update public.pokejam_usernames set username = p_name, changed_at = case when p_name is null then null else now() end,
      flagged = true, flagged_at = now(), updated_at = now() where user_id = p_user;
  exception when unique_violation then
    raise exception 'username:taken';
  end;
  insert into public.pokejam_admin_log(admin, action, target, detail)
    values (me, 'force rename', p_user, coalesce(old, '(none)') || ' -> ' || coalesce(p_name, '(reset)'));
  return jsonb_build_object('username', p_name);
end $$;

-- ---------- Ranked needs a username ----------
-- The Ranked path of pokejam_find_match: the 20261113 body plus the username check right after the sign-in check.
create or replace function public.pokejam_ranked_find(me uuid)
returns uuid language plpgsql security definer set search_path = public as $$
declare sn public.pokejam_seasons; p public.pokejam_ranked_profiles; q public.pokejam_queue; other public.pokejam_queue;
        mid uuid; r record; score int; win int; last_opp uuid;
begin
  perform public.pokejam_ranked_require_member();
  if not exists (select 1 from public.pokejam_usernames u where u.user_id = me and u.username is not null) then
    raise exception 'username:required';
  end if;
  sn := public.pokejam_ranked_season();
  -- Searching again with a Ranked game I had opened means I left it.
  for r in select m.id from public.pokejam_matches m
      where m.queue = 'ranked' and m.status = 'active' and m.guest is not null and me in (m.host, m.guest)
        and m.created_at > now() - interval '2 hours'
        and (case when me = m.host then m.host_alive else m.guest_alive end) < now() - interval '10 seconds' loop
    perform public.pokejam_leave_match(r.id);
  end loop;
  -- A pairing I haven't opened yet is news to me.
  select m.id into mid from public.pokejam_matches m
    where m.status = 'active' and me in (m.host, m.guest) and m.queue = 'ranked'
      and m.created_at > now() - interval '2 minutes' and m.room_code is null
      and (case when me = m.host then m.host_alive else m.guest_alive end) is null
    order by m.created_at desc limit 1;
  if mid is not null then delete from public.pokejam_queue where user_id = me; return mid; end if;
  select * into p from public.pokejam_ranked_profiles where user_id = me and season_id = sn.id;
  if p.cooldown_until is not null and p.cooldown_until > now() then
    raise exception 'ranked cooldown: % seconds left', ceil(extract(epoch from p.cooldown_until - now()))::int;
  end if;
  score := case when p.user_id is null then public.pokejam_ranked_seed(public.pokejam_ranked_last_final(me))
    when p.status = 'placing' then p.seed_score
    else public.pokejam_ranked_ladder(p.div_idx, case when p.div_idx = 24 and p.last_game_at is not null
      then public.pokejam_ranked_zenith_decay(p.points, floor(extract(epoch from (now() - p.last_game_at)) / 86400)::int) else p.points end) end;
  insert into public.pokejam_queue(user_id, queue, mmr, last_seen) values (me, 'ranked', score, now())
    on conflict (user_id) do update set queue = excluded.queue, mmr = excluded.mmr, last_seen = now(),
      joined_at = case when pokejam_queue.queue = excluded.queue then pokejam_queue.joined_at else now() end
    returning * into q;
  win := public.pokejam_ranked_window(extract(epoch from now() - q.joined_at)::int);
  select case when x.host = me then x.guest else x.host end into last_opp from public.pokejam_matches x
    where x.queue = 'ranked' and x.guest is not null and x.status in ('active','done') and me in (x.host, x.guest)
      and x.created_at > now() - interval '1 hour'
    order by x.created_at desc limit 1;
  select * into other from public.pokejam_queue o
    where o.queue = 'ranked' and o.user_id <> me and o.last_seen > now() - interval '15 seconds'
      and abs(o.mmr - score) <= win and public.pokejam_ranked_pair_ok(score, o.mmr)
      and not public.pokejam_blocked_pair(me, o.user_id) and not public.pokejam_banned(o.user_id)
      and o.user_id is distinct from last_opp
      and not exists (select 1 from public.pokejam_ranked_profiles cp where cp.user_id = o.user_id and cp.season_id = sn.id
                      and cp.cooldown_until > now()) -- a row left from before the cooldown started
      and (select count(*) from public.pokejam_matches x where x.queue = 'ranked' and x.guest is not null
             and x.status in ('active','done') and x.created_at > now() - interval '24 hours'
             and ((x.host = me and x.guest = o.user_id) or (x.host = o.user_id and x.guest = me))) < 3
    order by abs(o.mmr - score), o.joined_at limit 1 for update skip locked;
  if other.user_id is null then return null; end if;
  insert into public.pokejam_matches(queue, host, guest, host_mmr, guest_mmr, seed, quarter_len)
    values ('ranked', other.user_id, me, other.mmr, score, public.pokejam_new_seed(), 120) returning id into mid;
  delete from public.pokejam_queue where user_id in (me, other.user_id);
  return mid;
end $$;

-- ---------- privileges ----------
revoke all on function
  public.pokejam_name_collapse(text), public.pokejam_name_skels(text), public.pokejam_name_mild_rx(text),
  public.pokejam_name_strip_allow(text, text), public.pokejam_name_mild_hit(text), public.pokejam_name_check(text),
  public.pokejam_set_username(text), public.pokejam_my_username(), public.pokejam_match_usernames(uuid),
  public.pokejam_admin_force_rename(uuid, text), public.pokejam_ranked_find(uuid)
  from public, anon, authenticated;
grant execute on function public.pokejam_set_username(text), public.pokejam_my_username(), public.pokejam_match_usernames(uuid),
  public.pokejam_admin_force_rename(uuid, text)
  to authenticated;

-- ---------- word lists (generated) ----------
-- BEGIN GENERATED
-- Source: src/multiplayer/ranked/nameFilterData.json (obscenity 0.4.6 English dataset (MIT), derived from cuss (MIT). Regenerate with scripts/import-name-wordlist.mjs; see docs/third-party-wordlist.md.)
-- Regenerate: node scripts/gen-name-filter-sql.mjs. Mild terms are stored as written (matched with pokejam_name_mild_rx);
-- every other kind is stored with repeated letters collapsed, like the names it is compared with.
delete from public.pokejam_name_blocklist;
insert into public.pokejam_name_blocklist(kind, term)
  select v.kind, case when v.kind = 'mild' then v.term else public.pokejam_name_collapse(v.term) end
  from (values
  ('severe', 'abeed'),
  ('severe', 'africoon'),
  ('severe', 'arabush'),
  ('severe', 'beaner'),
  ('severe', 'bestiality'),
  ('severe', 'bitch'),
  ('severe', 'blowjob'),
  ('severe', 'boonga'),
  ('severe', 'buttplug'),
  ('severe', 'chingchong'),
  ('severe', 'chink'),
  ('severe', 'cunt'),
  ('severe', 'deepthroat'),
  ('severe', 'dick'),
  ('severe', 'dildo'),
  ('severe', 'doggystyle'),
  ('severe', 'doublepenetration'),
  ('severe', 'dyke'),
  ('severe', 'ejaculate'),
  ('severe', 'fag'),
  ('severe', 'fellatio'),
  ('severe', 'fggot'),
  ('severe', 'fingerbang'),
  ('severe', 'fistin'),
  ('severe', 'fisting'),
  ('severe', 'fuck'),
  ('severe', 'gangbang'),
  ('severe', 'handjob'),
  ('severe', 'hitler'),
  ('severe', 'jizz'),
  ('severe', 'kike'),
  ('severe', 'lubejob'),
  ('severe', 'masterbate'),
  ('severe', 'masturbate'),
  ('severe', 'molest'),
  ('severe', 'negro'),
  ('severe', 'nigga'),
  ('severe', 'nigger'),
  ('severe', 'orgasm'),
  ('severe', 'penis'),
  ('severe', 'piss'),
  ('severe', 'pussy'),
  ('severe', 'rapist'),
  ('severe', 'retard'),
  ('severe', 'shit'),
  ('severe', 'slut'),
  ('severe', 'spastic'),
  ('severe', 'tranny'),
  ('severe', 'vagina'),
  ('severe', 'wetback'),
  ('severe', 'whore'),
  ('mild', 'abo'),
  ('mild', 'anal'),
  ('mild', 'anus'),
  ('mild', 'arse'),
  ('mild', 'ass'),
  ('mild', 'bastard'),
  ('mild', 'bich'),
  ('mild', 'bollocks'),
  ('mild', 'boob'),
  ('mild', 'cock'),
  ('mild', 'cocks'),
  ('mild', 'cuck'),
  ('mild', 'cum'),
  ('mild', 'dck'),
  ('mild', 'felch'),
  ('mild', 'fk'),
  ('mild', 'fuk'),
  ('mild', 'hentai'),
  ('mild', 'hooker'),
  ('mild', 'incest'),
  ('mild', 'jerkoff'),
  ('mild', 'nig'),
  ('mild', 'nigs'),
  ('mild', 'orgies'),
  ('mild', 'orgy'),
  ('mild', 'pnis'),
  ('mild', 'porn'),
  ('mild', 'prick'),
  ('mild', 'prn'),
  ('mild', 'rape'),
  ('mild', 'scat'),
  ('mild', 'semen'),
  ('mild', 'sex'),
  ('mild', 'tiddies'),
  ('mild', 'tit'),
  ('mild', 'tities'),
  ('mild', 'tits'),
  ('mild', 'titt'),
  ('mild', 'trany'),
  ('mild', 'turd'),
  ('mild', 'twat'),
  ('mild', 'wank'),
  ('allow', 'analabos'),
  ('allow', 'analagous'),
  ('allow', 'analav'),
  ('allow', 'analog'),
  ('allow', 'analy'),
  ('allow', 'arsen'),
  ('allow', 'assem'),
  ('allow', 'assen'),
  ('allow', 'asser'),
  ('allow', 'assess'),
  ('allow', 'asset'),
  ('allow', 'assev'),
  ('allow', 'assoc'),
  ('allow', 'assoi'),
  ('allow', 'benedick'),
  ('allow', 'cockney'),
  ('allow', 'cuckoo'),
  ('allow', 'dickens'),
  ('allow', 'dickerson'),
  ('allow', 'dickety'),
  ('allow', 'dickey'),
  ('allow', 'dickinson'),
  ('allow', 'dickory'),
  ('allow', 'dickson'),
  ('allow', 'fagan'),
  ('allow', 'fagin'),
  ('allow', 'gasma'),
  ('allow', 'janus'),
  ('allow', 'manus'),
  ('allow', 'montenegro'),
  ('allow', 'negron'),
  ('allow', 'negroni'),
  ('allow', 'nigam'),
  ('allow', 'nigeria'),
  ('allow', 'nigerian'),
  ('allow', 'penistone'),
  ('allow', 'pissarro'),
  ('allow', 'porgy'),
  ('allow', 'pussycat'),
  ('allow', 'pussywillow'),
  ('allow', 'rapper'),
  ('allow', 'retardant'),
  ('allow', 'scunthorpe'),
  ('allow', 'shiitake'),
  ('allow', 'shitake'),
  ('allow', 'snigger'),
  ('allow', 'stoneground'),
  ('allow', 'tetanus'),
  ('allow', 'turducken'),
  ('allow', 'twattle'),
  ('allow', 'uranus'),
  ('allow', 'winegrow'),
  ('reserved', 'admin'),
  ('reserved', 'administrator'),
  ('reserved', 'anonymous'),
  ('reserved', 'bot'),
  ('reserved', 'ceo'),
  ('reserved', 'cpu'),
  ('reserved', 'cryptodoom'),
  ('reserved', 'deleted'),
  ('reserved', 'dev'),
  ('reserved', 'developer'),
  ('reserved', 'false'),
  ('reserved', 'founder'),
  ('reserved', 'gamefreak'),
  ('reserved', 'gm'),
  ('reserved', 'guest'),
  ('reserved', 'help'),
  ('reserved', 'info'),
  ('reserved', 'kungfudoom'),
  ('reserved', 'mod'),
  ('reserved', 'moderator'),
  ('reserved', 'mods'),
  ('reserved', 'nan'),
  ('reserved', 'nintendo'),
  ('reserved', 'none'),
  ('reserved', 'null'),
  ('reserved', 'official'),
  ('reserved', 'owner'),
  ('reserved', 'player'),
  ('reserved', 'pokebasketball'),
  ('reserved', 'pokejam'),
  ('reserved', 'pokemon'),
  ('reserved', 'ranked'),
  ('reserved', 'root'),
  ('reserved', 'security'),
  ('reserved', 'server'),
  ('reserved', 'social'),
  ('reserved', 'staff'),
  ('reserved', 'support'),
  ('reserved', 'system'),
  ('reserved', 'test'),
  ('reserved', 'trainer'),
  ('reserved', 'true'),
  ('reserved', 'undefined'),
  ('reserved', 'unknown'),
  ('impersonation', 'admin'),
  ('impersonation', 'cryptodoom'),
  ('impersonation', 'kungfudoom'),
  ('impersonation', 'mod'),
  ('impersonation', 'moderator'),
  ('impersonation', 'official'),
  ('impersonation', 'pokejam'),
  ('impersonation', 'staff'),
  ('impersonation', 'support'),
  ('impersonation_allow', 'accommodate'),
  ('impersonation_allow', 'commodity'),
  ('impersonation_allow', 'commodore'),
  ('impersonation_allow', 'modal'),
  ('impersonation_allow', 'model'),
  ('impersonation_allow', 'modem'),
  ('impersonation_allow', 'moderate'),
  ('impersonation_allow', 'moderation'),
  ('impersonation_allow', 'modern'),
  ('impersonation_allow', 'modest'),
  ('impersonation_allow', 'modify'),
  ('impersonation_allow', 'modish'),
  ('impersonation_allow', 'module'),
  ('impersonation_allow', 'modulo'),
  ('impersonation_allow', 'moody'),
  ('impersonation_allow', 'staffan'),
  ('impersonation_allow', 'stafford')
  ) as v(kind, term)
  on conflict do nothing;
-- END GENERATED
