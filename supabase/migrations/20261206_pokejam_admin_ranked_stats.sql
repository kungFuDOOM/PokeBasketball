-- PokeJam: Ranked numbers for the moderation page (admin.html). Shared gauntlet-legends project: pokejam_* only.
-- Additive and safe to run again: two moderator RPCs, one pure helper, and one index. Nothing is dropped, no existing
-- table or row changes, and no RLS policy is loosened. Moderators only (the same pokejam_require_admin check as 20261031).
--
-- pokejam_admin_ranked_stats: the Stats "Ranked" block.
--   "Today" is the America/Los_Angeles calendar day, as in pokejam_admin_stats. 7 and 30 days are rolling windows.
--   A match is a row in pokejam_ranked_matches (scored, forfeit, leave, or void). Players are the distinct hosts and guests
--   of those matches. A new profile is a pokejam_ranked_profiles row whose first scored match in that season falls in the
--   window; a row that has never been scored counts from updated_at (the insert time, until the first game moves it).
--   Queue time before the first scored match is not stored. Ranks are the nine tiers in src/ranked/rank.ts (Bronze …
--   Prism … Pokémon Master, then Zenith), current season, status = 'ranked' only. Shields used are ledger rows with
--   reason 'use' (each one removes one shield). Packs are pokejam_shield_purchases with status 'paid'.
-- pokejam_admin_ranked_players: the Ranked tab. Current season (or the latest, if none is active), highest ladder score
--   first. The wallet is the public Solana address on the web3 identity (auth.identities), never an email, a key, or
--   user_metadata. Shortening is done in the page.

create index if not exists pokejam_ranked_matches_created on public.pokejam_ranked_matches (created_at);

-- Public Solana address inside one identity_data blob, or null. Same order as src/wallet/phantom.ts getSolanaAddress.
-- No table access. Not granted: only the moderator RPC below calls it.
create or replace function public.pokejam_admin_solana_addr(p jsonb)
returns text
language sql
immutable
set search_path = public
as $addr$
  select s.c
  from unnest(array[
    case when p #>> '{custom_claims,chain}' is null or p #>> '{custom_claims,chain}' = 'solana'
         then p #>> '{custom_claims,address}' end,
    case when p ->> 'chain' is null or p ->> 'chain' = 'solana' then p ->> 'address' end,
    case when p ->> 'chain' is null or p ->> 'chain' = 'solana' then p ->> 'wallet_address' end,
    (regexp_match(coalesce(p ->> 'sub', ''), '^web3:solana:([1-9A-HJ-NP-Za-km-z]{32,44})$'))[1],
    (regexp_match(coalesce(p ->> 'provider_id', ''), '^web3:solana:([1-9A-HJ-NP-Za-km-z]{32,44})$'))[1]
  ]) as s(c)
  where s.c ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$'
  limit 1
$addr$;

create or replace function public.pokejam_admin_ranked_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  day0 timestamptz := date_trunc('day', now() at time zone 'America/Los_Angeles') at time zone 'America/Los_Angeles';
  today date := (now() at time zone 'America/Los_Angeles')::date;
  -- The older of "30 rolling days" and the start of the 30th Pacific day. A 25-hour DST day can push that start
  -- just past now() - 30 days, so the day table and the rolling window share one index range.
  bound timestamptz := least(now() - interval '30 days', (today - 29)::timestamp at time zone 'America/Los_Angeles');
  r jsonb;
begin
  perform public.pokejam_require_admin();
  with m as (
    select created_at, reason, host_id, guest_id,
           (created_at at time zone 'America/Los_Angeles')::date as pt
    from public.pokejam_ranked_matches
    where created_at >= bound
  ),
  sides as (
    select created_at, pt, host_id as uid from m
    union all
    select created_at, pt, guest_id from m
  ),
  win as (
    select
      count(*) filter (where created_at >= day0)::int as matches_1,
      count(*) filter (where created_at >= now() - interval '7 days')::int as matches_7,
      count(*) filter (where created_at >= now() - interval '30 days')::int as matches_30,
      count(*) filter (where created_at >= day0 and reason = 'forfeit')::int as forfeits_1,
      count(*) filter (where created_at >= now() - interval '7 days' and reason = 'forfeit')::int as forfeits_7,
      count(*) filter (where created_at >= now() - interval '30 days' and reason = 'forfeit')::int as forfeits_30,
      count(*) filter (where created_at >= day0 and reason = 'leave')::int as leaves_1,
      count(*) filter (where created_at >= now() - interval '7 days' and reason = 'leave')::int as leaves_7,
      count(*) filter (where created_at >= now() - interval '30 days' and reason = 'leave')::int as leaves_30,
      count(*) filter (where created_at >= day0 and reason = 'void')::int as voids_1,
      count(*) filter (where created_at >= now() - interval '7 days' and reason = 'void')::int as voids_7,
      count(*) filter (where created_at >= now() - interval '30 days' and reason = 'void')::int as voids_30
    from m
  ),
  pl as (
    select
      count(distinct uid) filter (where created_at >= day0)::int as players_1,
      count(distinct uid) filter (where created_at >= now() - interval '7 days')::int as players_7,
      count(distinct uid) filter (where created_at >= now() - interval '30 days')::int as players_30
    from sides
  ),
  born as (
    select least(p.updated_at, coalesce(f.first_at, p.updated_at)) as at
    from public.pokejam_ranked_profiles p
    left join (
      select season_id, user_id, min(created_at) as first_at
      from (
        select season_id, host_id as user_id, created_at from public.pokejam_ranked_matches
        union all
        select season_id, guest_id, created_at from public.pokejam_ranked_matches
      ) pm
      group by season_id, user_id
    ) f on f.season_id = p.season_id and f.user_id = p.user_id
  ),
  np as (
    select
      count(*) filter (where at >= day0)::int as n1,
      count(*) filter (where at >= now() - interval '7 days')::int as n7,
      count(*) filter (where at >= now() - interval '30 days')::int as n30
    from born
  ),
  used as (
    select
      coalesce(sum(greatest(-delta, 0)) filter (where created_at >= day0), 0)::int as u1,
      coalesce(sum(greatest(-delta, 0)) filter (where created_at >= now() - interval '7 days'), 0)::int as u7,
      coalesce(sum(greatest(-delta, 0)) filter (where created_at >= now() - interval '30 days'), 0)::int as u30
    from public.pokejam_shield_ledger
    where reason = 'use' and created_at >= bound
  ),
  packs as (
    select
      count(*) filter (where created_at >= day0)::int as p1,
      count(*) filter (where created_at >= now() - interval '7 days')::int as p7,
      count(*) filter (where created_at >= now() - interval '30 days')::int as p30,
      coalesce(sum(units) filter (where created_at >= day0), 0)::int as units_1,
      coalesce(sum(units) filter (where created_at >= now() - interval '7 days'), 0)::int as units_7,
      coalesce(sum(units) filter (where created_at >= now() - interval '30 days'), 0)::int as units_30
    from public.pokejam_shield_purchases
    where status = 'paid' and created_at >= bound
  ),
  days as (
    select d.day,
      count(m.created_at)::int as matches,
      (select count(distinct s.uid)::int from sides s where s.pt = d.day) as players,
      count(m.created_at) filter (where m.reason = 'forfeit')::int as forfeits,
      count(m.created_at) filter (where m.reason = 'leave')::int as leaves,
      count(m.created_at) filter (where m.reason = 'void')::int as voids
    from (select (today - k)::date as day from generate_series(0, 29) k) d
    left join m on m.pt = d.day
    group by d.day
  ),
  cur as (
    select * from public.pokejam_seasons
    order by (status = 'active') desc, number desc
    limit 1
  ),
  dist as (
    select t.ord, t.name, count(p.user_id)::int as players
    from (values
      (0, 'Bronze'), (1, 'Silver'), (2, 'Gold'), (3, 'Platinum'), (4, 'Diamond'),
      (5, 'Prism'), (6, 'Eclipse'), (7, 'Pokémon Master'), (8, 'Zenith')
    ) as t(ord, name)
    left join public.pokejam_ranked_profiles p
      on p.season_id = (select id from cur)
     and p.status = 'ranked'
     and (case when p.div_idx >= 24 then 8 else p.div_idx / 3 end) = t.ord
    group by t.ord, t.name
  ),
  top as (
    select p.user_id,
      coalesce(nullif(u.username, ''), pr.trainer_name) as name,
      p.div_idx, p.points,
      public.pokejam_ranked_ladder(p.div_idx, p.points) as rating,
      p.wins, p.losses
    from public.pokejam_ranked_profiles p
    left join public.pokejam_usernames u on u.user_id = p.user_id
    left join public.pokejam_profiles pr on pr.id = p.user_id
    where p.season_id = (select id from cur) and p.status = 'ranked'
    order by rating desc, p.wins desc, p.user_id
    limit 10
  ),
  prev as (
    select s.number, s.ends_at,
      (select count(*)::int from public.pokejam_ranked_season_results r where r.season_id = s.id) as players
    from public.pokejam_seasons s
    where s.status = 'closed'
    order by s.number desc
    limit 1
  )
  select jsonb_build_object(
    'd1', jsonb_build_object(
      'matches', win.matches_1, 'players', pl.players_1, 'new_profiles', np.n1,
      'forfeits', win.forfeits_1, 'leaves', win.leaves_1, 'voids', win.voids_1,
      'shields_used', used.u1, 'shield_packs', packs.p1, 'shield_units', packs.units_1),
    'd7', jsonb_build_object(
      'matches', win.matches_7, 'players', pl.players_7, 'new_profiles', np.n7,
      'forfeits', win.forfeits_7, 'leaves', win.leaves_7, 'voids', win.voids_7,
      'shields_used', used.u7, 'shield_packs', packs.p7, 'shield_units', packs.units_7),
    'd30', jsonb_build_object(
      'matches', win.matches_30, 'players', pl.players_30, 'new_profiles', np.n30,
      'forfeits', win.forfeits_30, 'leaves', win.leaves_30, 'voids', win.voids_30,
      'shields_used', used.u30, 'shield_packs', packs.p30, 'shield_units', packs.units_30),
    'days', coalesce((select jsonb_agg(jsonb_build_object(
        'day', d.day, 'matches', d.matches, 'players', d.players,
        'forfeits', d.forfeits, 'leaves', d.leaves, 'voids', d.voids) order by d.day desc) from days d), '[]'::jsonb),
    'ranks', coalesce((select jsonb_agg(jsonb_build_object('tier', dist.name, 'players', dist.players) order by dist.ord) from dist), '[]'::jsonb),
    'season', (select jsonb_build_object(
        'id', c.id, 'number', c.number, 'status', c.status, 'starts_at', c.starts_at, 'ends_at', c.ends_at,
        'length_weeks', c.length_weeks,
        'ranked', (select count(*)::int from public.pokejam_ranked_profiles p where p.season_id = c.id and p.status = 'ranked'),
        'placing', (select count(*)::int from public.pokejam_ranked_profiles p where p.season_id = c.id and p.status = 'placing'))
      from cur c),
    'previous_season', (select jsonb_build_object('number', prev.number, 'ends_at', prev.ends_at, 'players', prev.players) from prev),
    'top', coalesce((select jsonb_agg(jsonb_build_object(
        'user_id', t.user_id, 'name', t.name, 'div_idx', t.div_idx, 'points', t.points,
        'rating', t.rating, 'wins', t.wins, 'losses', t.losses) order by t.rating desc, t.wins desc, t.user_id) from top t), '[]'::jsonb),
    'shields_held', coalesce((select sum(i.count)::int from public.pokejam_shield_inventory i), 0),
    'today_starts', day0,
    'generated_at', now()
  ) into r
  from win, pl, np, used, packs;
  return r;
end
$fn$;

-- p_limit is clamped to 1..500. Returns the season header plus the players, so the tab still says which season it is
-- when the stats block failed to load.
create or replace function public.pokejam_admin_ranked_players(p_limit int default 200)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $fn$
declare
  lim int := greatest(1, least(coalesce(p_limit, 200), 500));
  sid int;
  s_number int;
  s_status text;
  wallets jsonb := '{}'::jsonb;
  players jsonb;
begin
  perform public.pokejam_require_admin();
  select s.id, s.number, s.status into sid, s_number, s_status
  from public.pokejam_seasons s
  order by (s.status = 'active') desc, s.number desc
  limit 1;
  if sid is null then
    return jsonb_build_object('season_number', null, 'season_status', null, 'players', '[]'::jsonb);
  end if;
  -- auth.identities is Supabase's table. Tests and a database without it get a null wallet, not an error.
  if to_regclass('auth.identities') is not null then
    begin
      execute $q$
        select coalesce(jsonb_object_agg(w.user_id, w.wallet), '{}'::jsonb)
        from (
          select s.user_id::text as user_id, min(s.addr) as wallet
          from (
            select i.user_id, public.pokejam_admin_solana_addr(i.identity_data) as addr
            from auth.identities i
            where i.provider = 'web3'
              and i.user_id in (select p.user_id from public.pokejam_ranked_profiles p where p.season_id = $1)
          ) s
          where s.addr is not null
          group by s.user_id
        ) w
      $q$ into wallets using sid;
    exception
      when undefined_table or undefined_column then
        wallets := '{}'::jsonb;
    end;
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
      'user_id', x.user_id,
      'name', x.name,
      'wallet', x.wallet,
      'status', x.status,
      'div_idx', x.div_idx,
      'points', x.points,
      'placements_played', x.placements_played,
      'rating', x.rating,
      'wins', x.wins,
      'losses', x.losses,
      'matches', x.wins + x.losses,
      'last_game_at', x.last_game_at,
      'shields', x.shields,
      'flags', x.flags,
      'banned_until', x.banned_until
    ) order by x.rating desc, x.wins desc, x.user_id), '[]'::jsonb)
  into players
  from (
    select p.user_id,
      coalesce(nullif(u.username, ''), pr.trainer_name) as name,
      wallets ->> (p.user_id::text) as wallet,
      p.status, p.div_idx, p.points, p.placements_played,
      public.pokejam_ranked_ladder(p.div_idx, p.points) as rating,
      p.wins, p.losses, p.last_game_at,
      coalesce(inv.count, 0) as shields,
      coalesce(f.flag_n, 0) as flags,
      b.until as banned_until
    from public.pokejam_ranked_profiles p
    left join public.pokejam_usernames u on u.user_id = p.user_id
    left join public.pokejam_profiles pr on pr.id = p.user_id
    left join public.pokejam_shield_inventory inv on inv.user_id = p.user_id
    left join public.pokejam_bans b on b.user_id = p.user_id and b.until > now()
    left join (
      select jf.user_id, count(*)::int as flag_n
      from public.pokejam_judge_flags jf
      where jf.user_id is not null
      group by jf.user_id
    ) f on f.user_id = p.user_id
    where p.season_id = sid
    order by public.pokejam_ranked_ladder(p.div_idx, p.points) desc, p.wins desc, p.user_id
    limit lim
  ) x;
  return jsonb_build_object('season_number', s_number, 'season_status', s_status, 'players', players);
end
$fn$;

revoke all on function public.pokejam_admin_solana_addr(jsonb),
  public.pokejam_admin_ranked_stats(), public.pokejam_admin_ranked_players(int)
  from public, anon, authenticated;
grant execute on function public.pokejam_admin_ranked_stats(), public.pokejam_admin_ranked_players(int) to authenticated;
