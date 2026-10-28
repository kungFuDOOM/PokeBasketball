-- PokeJam Social: a quick draft between the two players before the match (issue #28). Shared gauntlet-legends
-- project: pokejam_* only.
--
-- The server runs it, so neither client can make up a roster:
-- - pokejam_mons is the game's list of Pokemon and positions (src/data/pokemon.ts; a test keeps the two in sync).
-- - Each Social match gets a pool of 6 random Pokemon per position, and a coin flip for who picks first.
-- - Snake order, ten picks: A B B A A B B A A B. Each player takes one Pokemon per position, and a Pokemon one player
--   takes is gone for the other.
-- - Each pick has 12 seconds. When time runs out, the server makes a random legal pick for that player (so a player
--   who drops gets random picks). Turns are settled whenever either player checks in: there's no timer job.
-- - The finished picks are the match's rosters: pokejam_match_info returns them, and host, guest and the winner
--   check all build the game from them.
-- Ranked and Pack Battles don't draft (Ranked rolls balanced teams from the seed, #29).

create table if not exists public.pokejam_mons (
  dex int primary key,
  pos text not null check (pos in ('PG', 'SG', 'SF', 'PF', 'C'))
);
alter table public.pokejam_mons enable row level security;
revoke all on public.pokejam_mons from anon, authenticated, public;

insert into public.pokejam_mons(dex, pos) values
  (1,'SG'), (2,'SG'), (3,'C'), (4,'PG'), (5,'SG'), (6,'SF'), (7,'PG'), (8,'PG'), (9,'PF'), (10,'PG'), (11,'C'), (12,'SG'),
  (13,'PG'), (14,'C'), (15,'SG'), (16,'PG'), (17,'SF'), (18,'SF'), (19,'PG'), (20,'PG'), (21,'PG'), (22,'SF'), (23,'PF'), (24,'SF'),
  (25,'PG'), (26,'PG'), (27,'SF'), (28,'PF'), (29,'SG'), (30,'SF'), (31,'PF'), (32,'SG'), (33,'SG'), (34,'PF'), (35,'SG'), (36,'PF'),
  (37,'PG'), (38,'PG'), (39,'SF'), (40,'SF'), (41,'SG'), (42,'SF'), (43,'SF'), (44,'SG'), (45,'PF'), (46,'SF'), (47,'PF'), (48,'SF'),
  (49,'SG'), (50,'PG'), (51,'PG'), (52,'PG'), (53,'PG'), (54,'PG'), (55,'SG'), (56,'PG'), (57,'SG'), (58,'SG'), (59,'SF'), (60,'PG'),
  (61,'SG'), (62,'PF'), (63,'PG'), (64,'SG'), (65,'PG'), (66,'PF'), (67,'PF'), (68,'PF'), (69,'SG'), (70,'SG'), (71,'SF'), (72,'PG'),
  (73,'SF'), (74,'SF'), (75,'PF'), (76,'PF'), (77,'SG'), (78,'PG'), (79,'PF'), (80,'PF'), (81,'SG'), (82,'SG'), (83,'SG'), (84,'SF'),
  (85,'SF'), (86,'SF'), (87,'C'), (88,'PF'), (89,'C'), (90,'SG'), (91,'C'), (92,'SG'), (93,'SG'), (94,'SF'), (95,'C'), (96,'SG'),
  (97,'PF'), (98,'SF'), (99,'PF'), (100,'PG'), (101,'PG'), (102,'SG'), (103,'C'), (104,'SF'), (105,'SG'), (106,'SF'), (107,'SG'), (108,'C'),
  (109,'SG'), (110,'C'), (111,'PF'), (112,'PF'), (113,'PF'), (114,'SF'), (115,'PF'), (116,'SG'), (117,'SF'), (118,'PG'), (119,'PF'), (120,'PG'),
  (121,'PG'), (122,'PF'), (123,'SG'), (124,'PG'), (125,'PG'), (126,'SF'), (127,'PF'), (128,'SF'), (129,'PG'), (130,'C'), (131,'C'), (132,'SG'),
  (133,'PG'), (134,'SF'), (135,'PG'), (136,'PF'), (137,'SG'), (138,'SG'), (139,'PF'), (140,'SG'), (141,'SF'), (142,'SG'), (143,'C'), (144,'SF'),
  (145,'SF'), (146,'SF'), (147,'SF'), (148,'PF'), (149,'C'), (150,'SF'), (151,'PG'), (152,'SG'), (153,'SF'), (154,'C'), (155,'PG'), (156,'SG'),
  (157,'SF'), (158,'SG'), (159,'SF'), (160,'SF'), (161,'SF'), (162,'SF'), (163,'SG'), (164,'SF'), (165,'PG'), (166,'PG'), (167,'SF'), (168,'PF'),
  (169,'PG'), (170,'PG'), (171,'PF'), (172,'PG'), (173,'SF'), (174,'SF'), (175,'SF'), (176,'PG'), (177,'PG'), (178,'SG'), (179,'SG'), (180,'SG'),
  (181,'PF'), (182,'SG'), (183,'PG'), (184,'PF'), (185,'PF'), (186,'SG'), (187,'PG'), (188,'PG'), (189,'PG'), (190,'PG'), (191,'SF'), (192,'SF'),
  (193,'SG'), (194,'SF'), (195,'C'), (196,'SG'), (197,'SF'), (198,'SG'), (199,'C'), (200,'PG'), (201,'SG'), (202,'C'), (203,'SF'), (204,'SF'),
  (205,'C'), (206,'SF'), (207,'SF'), (208,'C'), (209,'SF'), (210,'PF'), (211,'SG'), (212,'SF'), (213,'C'), (214,'PF'), (215,'PG'), (216,'SG'),
  (217,'PF'), (218,'SF'), (219,'SF'), (220,'SG'), (221,'PF'), (222,'SG'), (223,'SG'), (224,'SF'), (225,'SG'), (226,'C'), (227,'PF'), (228,'PG'),
  (229,'SG'), (230,'SG'), (231,'SF'), (232,'PF'), (233,'SG'), (234,'SF'), (235,'SF'), (236,'SG'), (237,'PF'), (238,'PG'), (239,'PG'), (240,'SG'),
  (241,'PF'), (242,'C'), (243,'SG'), (244,'C'), (245,'C'), (246,'SG'), (247,'PF'), (248,'C'), (249,'C'), (250,'C'), (251,'PG'), (254,'PG'),
  (257,'SF'), (260,'PF'), (282,'PG'), (310,'PG'), (350,'PF'), (373,'PF'), (376,'C'), (380,'SF'), (381,'SF'), (382,'C'), (383,'PF'), (384,'PF'),
  (392,'SG'), (405,'SF'), (437,'C'), (445,'PF'), (448,'SG'), (454,'SF'), (461,'PG'), (462,'PF'), (464,'C'), (465,'C'), (466,'PF'), (468,'PG'),
  (470,'SF'), (473,'C'), (475,'SF'), (530,'SF'), (534,'PF'), (553,'C'), (571,'PG'), (609,'SF'), (612,'SF'), (635,'SF'), (637,'SF')
on conflict (dex) do update set pos = excluded.pos;

create table if not exists public.pokejam_drafts (
  match_id uuid primary key references public.pokejam_matches(id) on delete cascade,
  pool int[] not null,
  first smallint not null check (first in (0, 1)),
  -- [{side, dex, pos, auto}] in pick order.
  picks jsonb not null default '[]'::jsonb,
  deadline timestamptz not null,
  host_seen timestamptz,
  guest_seen timestamptz,
  done boolean not null default false,
  created_at timestamptz not null default now()
);
alter table public.pokejam_drafts enable row level security;
revoke all on public.pokejam_drafts from anon, authenticated, public;

-- Who makes the i-th pick (0-based): snake order from whoever goes first.
create or replace function public.pokejam_draft_side(p_first int, p_i int)
returns int language sql immutable set search_path = public as $$
  select p_first # (case p_i % 4 when 0 then 0 when 1 then 1 when 2 then 1 else 0 end);
$$;

-- A side's five picks as Pokedex numbers, in position order PG, SG, SF, PF, C.
create or replace function public.pokejam_draft_roster(p_picks jsonb, p_side int)
returns int[] language sql immutable set search_path = public as $$
  select array_agg((p->>'dex')::int order by array_position(array['PG', 'SG', 'SF', 'PF', 'C'], p->>'pos'))
  from jsonb_array_elements(p_picks) p where (p->>'side')::int = p_side;
$$;

-- Make the overdue picks: for every turn whose time ran out, a random legal pick for that player. Each auto pick
-- moves the clock on by one pick's time from the old deadline, so a long absence makes several at once.
create or replace function public.pokejam_draft_settle(p_match uuid)
returns public.pokejam_drafts language plpgsql security definer set search_path = public as $$
declare d public.pokejam_drafts; side int; pick record; pick_s constant int := 12;
begin
  select * into d from public.pokejam_drafts where match_id = p_match for update;
  while d.match_id is not null and not d.done and d.deadline <= now() loop
    side := public.pokejam_draft_side(d.first, jsonb_array_length(d.picks));
    select m.dex, m.pos into pick from unnest(d.pool) as p(dex) join public.pokejam_mons m on m.dex = p.dex
      where not exists (select 1 from jsonb_array_elements(d.picks) x where (x->>'dex')::int = m.dex)
        and not exists (select 1 from jsonb_array_elements(d.picks) x where (x->>'side')::int = side and x->>'pos' = m.pos)
      order by random() limit 1;
    update public.pokejam_drafts set
      picks = picks || jsonb_build_array(jsonb_build_object('side', side, 'dex', pick.dex, 'pos', pick.pos, 'auto', true)),
      deadline = deadline + make_interval(secs => pick_s),
      done = jsonb_array_length(picks) + 1 >= 10
    where match_id = p_match returning * into d;
  end loop;
  return d;
end $$;

-- The draft as one player sees it.
create or replace function public.pokejam_draft_view(d public.pokejam_drafts, p_side int)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'pool', (select jsonb_agg(jsonb_build_object('dex', m.dex, 'pos', m.pos) order by array_position(array['PG', 'SG', 'SF', 'PF', 'C'], m.pos), m.dex)
             from unnest(d.pool) as p(dex) join public.pokejam_mons m on m.dex = p.dex),
    'first', d.first, 'picks', d.picks, 'done', d.done, 'me', p_side,
    'turn', jsonb_array_length(d.picks),
    'on_turn', case when d.done then null else public.pokejam_draft_side(d.first, jsonb_array_length(d.picks)) end,
    'seconds_left', case when d.done then 0 else greatest(0, extract(epoch from d.deadline - now())) end,
    'opponent_seen_ago', extract(epoch from now() - case when p_side = 0 then d.guest_seen else d.host_seen end));
$$;

-- Players: the draft for my Social match (it starts the first time either player asks). Also says I'm still here.
create or replace function public.pokejam_draft_state(p_match uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); m public.pokejam_matches; side int; d public.pokejam_drafts;
        pool_per_pos constant int := 6; pick_s constant int := 12; intro_s constant int := 3;
begin
  if me is null then raise exception 'not signed in'; end if;
  select * into m from public.pokejam_matches where id = p_match;
  if m.id is null or me not in (m.host, m.guest) or m.guest is null then raise exception 'not in this match'; end if;
  if m.queue <> 'social' then raise exception 'no draft for this match'; end if;
  side := case when me = m.host then 0 else 1 end;
  if m.status = 'active' then
    insert into public.pokejam_drafts(match_id, pool, first, deadline)
      select m.id, array(select r.dex from (select dex, pos, row_number() over (partition by pos order by random()) as k from public.pokejam_mons) r
                         where r.k <= pool_per_pos order by r.pos, r.dex),
        (random() < 0.5)::int, now() + make_interval(secs => intro_s + pick_s)
      on conflict (match_id) do nothing;
  end if;
  if side = 0 then update public.pokejam_drafts set host_seen = now() where match_id = m.id;
  else update public.pokejam_drafts set guest_seen = now() where match_id = m.id; end if;
  d := public.pokejam_draft_settle(m.id);
  if d.match_id is null then raise exception 'no draft for this match'; end if;
  return public.pokejam_draft_view(d, side);
end $$;

-- Players: make my pick. The next player then gets the full 12 seconds.
create or replace function public.pokejam_draft_pick(p_match uuid, p_dex int)
returns jsonb language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid(); m public.pokejam_matches; side int; d public.pokejam_drafts; ppos text; pick_s constant int := 12;
begin
  if me is null then raise exception 'not signed in'; end if;
  select * into m from public.pokejam_matches where id = p_match;
  if m.id is null or me not in (m.host, m.guest) or m.guest is null then raise exception 'not in this match'; end if;
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
  return public.pokejam_draft_view(d, side);
end $$;

-- Match info now includes the drafted rosters once the draft is done (null for undrafted matches).
create or replace function public.pokejam_match_info(p_match uuid)
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object('id', m.id, 'queue', m.queue, 'status', m.status, 'host', m.host, 'guest', m.guest,
    'host_name', hp.trainer_name, 'guest_name', gp.trainer_name, 'seed', m.seed, 'quarter_len', m.quarter_len,
    'host_key', m.host_key, 'guest_key', m.guest_key,
    'host_roster', (select public.pokejam_draft_roster(d.picks, 0) from public.pokejam_drafts d where d.match_id = m.id and d.done),
    'guest_roster', (select public.pokejam_draft_roster(d.picks, 1) from public.pokejam_drafts d where d.match_id = m.id and d.done))
  from public.pokejam_matches m
  join public.pokejam_profiles hp on hp.id = m.host
  left join public.pokejam_profiles gp on gp.id = m.guest
  where m.id = p_match and auth.uid() in (m.host, m.guest);
$$;

revoke all on function public.pokejam_draft_side(int, int), public.pokejam_draft_roster(jsonb, int), public.pokejam_draft_settle(uuid),
  public.pokejam_draft_view(public.pokejam_drafts, int), public.pokejam_draft_state(uuid), public.pokejam_draft_pick(uuid, int)
  from public, anon, authenticated;
grant execute on function public.pokejam_draft_state(uuid), public.pokejam_draft_pick(uuid, int) to authenticated;
