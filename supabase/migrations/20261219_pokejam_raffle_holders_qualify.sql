-- Weekly raffle: a linked wallet that holds PJAM gets entries with no challenges.
-- Holder entries for one balance are floor(min(balance, pjam_counted_cap) / pjam_per_entry). Defaults: 1,000,000 per
-- entry, 5,000,000 counted, so 5 entries. Each balance in the draw payload is capped on its own, then the counts add.
-- Challenge entries are unchanged: finish every weekly challenge for 1 entry, plus up to bonus_cap grind entries.
-- Under the step, or with no wallet, only the challenge path counts. The two totals add.
-- Wallets counted: pokejam_linked_wallets, and the Solana address of a Phantom sign-in (auth.identities provider 'web3',
-- identity_data.custom_claims.address). Additive: only create or replace of raffle functions. NOT applied by the repo.
-- Guests are still left out. The seed and the winner pick are unchanged.

-- Adds pjam_counted_cap. A missing or wild value falls back to 5,000,000, same as src/raffle/entries.ts.
create or replace function public.pokejam_raffle_cfg_value(p jsonb)
returns jsonb language plpgsql immutable as $$
declare j jsonb := coalesce(p, '{}'::jsonb); n int; per numeric; mint text; raw text;
begin
  if jsonb_typeof(j) is distinct from 'object' then j := '{}'::jsonb; end if;
  raw := j->>'offline_games';
  n := case when raw ~ '^[0-9]{1,9}$' then raw::int else null end;
  j := jsonb_set(j, '{offline_games}', to_jsonb(case when n is null or n < 1 or n > 100 then 3 else n end));
  raw := j->>'online_games';
  n := case when raw ~ '^[0-9]{1,9}$' then raw::int else null end;
  j := jsonb_set(j, '{online_games}', to_jsonb(case when n is null or n < 1 or n > 100 then 3 else n end));
  raw := j->>'social';
  n := case when raw ~ '^[0-9]{1,9}$' then raw::int else null end;
  j := jsonb_set(j, '{social}', to_jsonb(case when n is null or n < 1 or n > 20 then 1 else n end));
  raw := j->>'rank_steps';
  n := case when raw ~ '^[0-9]{1,9}$' then raw::int else null end;
  j := jsonb_set(j, '{rank_steps}', to_jsonb(case when n is null or n < 1 or n > 24 then 1 else n end));
  raw := j->>'pjam_per_entry';
  per := case when raw ~ '^[0-9]{1,16}$' then raw::numeric else null end;
  j := jsonb_set(j, '{pjam_per_entry}', to_jsonb(case when per is null or per < 1 or per > 1000000000000000 then 1000000 else per::bigint end));
  raw := j->>'pjam_counted_cap';
  per := case when raw ~ '^[0-9]{1,16}$' then raw::numeric else null end;
  j := jsonb_set(j, '{pjam_counted_cap}', to_jsonb(case when per is null or per < 1 or per > 1000000000000000 then 5000000 else per::bigint end));
  mint := j->>'pjam_mint';
  if mint is null or mint !~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' then mint := 'GQe9QiBBV4G6bRUCxx2JgKrzT7G7RD17FJquBWgVpump'; end if;
  j := jsonb_set(j, '{pjam_mint}', to_jsonb(mint));
  raw := j->>'grind_online_per_entry';
  n := case when raw ~ '^[0-9]{1,9}$' then raw::int else null end;
  j := jsonb_set(j, '{grind_online_per_entry}', to_jsonb(case when n is null or n < 1 or n > 100 then 10 else n end));
  raw := j->>'grind_wins_per_entry';
  n := case when raw ~ '^[0-9]{1,9}$' then raw::int else null end;
  j := jsonb_set(j, '{grind_wins_per_entry}', to_jsonb(case when n is null or n < 1 or n > 100 then 3 else n end));
  raw := j->>'bonus_cap';
  n := case when raw ~ '^[0-9]{1,9}$' then raw::int else null end;
  j := jsonb_set(j, '{bonus_cap}', to_jsonb(case when n is null or n < 0 or n > 20 then 5 else n end));
  return jsonb_build_object(
    'offline_games', (j->>'offline_games')::int,
    'online_games', (j->>'online_games')::int,
    'social', (j->>'social')::int,
    'rank_steps', (j->>'rank_steps')::int,
    'pjam_per_entry', (j->>'pjam_per_entry')::bigint,
    'pjam_counted_cap', (j->>'pjam_counted_cap')::bigint,
    'pjam_mint', j->>'pjam_mint',
    'grind_online_per_entry', (j->>'grind_online_per_entry')::int,
    'grind_wins_per_entry', (j->>'grind_wins_per_entry')::int,
    'bonus_cap', (j->>'bonus_cap')::int);
end $$;

-- Valid Solana wallets for a player: the linked one first, then any Phantom sign-in address. Service role only.
-- auth.identities is queried only when that table exists, so a database without Supabase auth still applies this.
create or replace function public.pokejam_raffle_wallets(p_user uuid)
returns text[] language plpgsql stable security definer set search_path = public as $$
declare out text[];
begin
  if to_regclass('auth.identities') is not null then
    select coalesce(array_agg(w order by ord, w), '{}') into out from (
      select w, min(ord) as ord from (
        select l.wallet as w, 0 as ord from public.pokejam_linked_wallets l where l.user_id = p_user
        union all
        select i.identity_data->'custom_claims'->>'address', 1 from auth.identities i
          where i.user_id = p_user and i.provider = 'web3'
      ) x where w ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' group by w
    ) s;
  else
    select coalesce(array_agg(l.wallet order by l.wallet), '{}') into out
      from public.pokejam_linked_wallets l
      where l.user_id = p_user and l.wallet ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$';
  end if;
  return coalesce(out, '{}');
end $$;

-- Everyone who might qualify: players with activity in the week, plus anyone with a wallet, since a holder needs no
-- activity. Guests left out. The edge function reads balances for these wallets.
create or replace function public.pokejam_raffle_candidates(p_week date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare a timestamptz := (p_week::timestamp at time zone 'America/Los_Angeles');
  b timestamptz := public.pokejam_raffle_week_end(p_week);
  ids uuid[];
begin
  select coalesce(array_agg(distinct user_id), '{}') into ids from (
    select m.host as user_id from public.pokejam_matches m
      where m.status = 'done' and m.finished_at >= a and m.finished_at < b and m.host is not null
    union
    select m.guest from public.pokejam_matches m
      where m.status = 'done' and m.finished_at >= a and m.finished_at < b and m.guest is not null
    union
    select e.user_id from public.pokejam_raffle_events e where e.created_at >= a and e.created_at < b
    union
    select rm.host_id from public.pokejam_ranked_matches rm
      where rm.created_at >= a and rm.created_at < b and rm.host_event in ('promoted', 'zenith')
    union
    select rm.guest_id from public.pokejam_ranked_matches rm
      where rm.created_at >= a and rm.created_at < b and rm.guest_event in ('promoted', 'zenith')
    union
    select l.user_id from public.pokejam_linked_wallets l
  ) u;
  if to_regclass('auth.identities') is not null then
    select coalesce(array_agg(distinct user_id), '{}') into ids from (
      select unnest(ids) as user_id
      union
      select i.user_id from auth.identities i where i.provider = 'web3'
    ) s;
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object('user_id', u.user_id, 'wallet', w[1], 'wallets', to_jsonb(w)) order by u.user_id)
    from unnest(coalesce(ids, '{}')) as u(user_id)
    cross join lateral (select public.pokejam_raffle_wallets(u.user_id) as w) ww
    where coalesce((select au.is_anonymous from auth.users au where au.id = u.user_id), false) = false
      and exists (select 1 from public.pokejam_profiles p where p.id = u.user_id)
  ), '[]'::jsonb);
end $$;

create or replace function public.pokejam_raffle_score(
  p_offline int, p_online int, p_wins int, p_social int, p_shares int, p_rank int, p_zenith boolean,
  p_whole bigint, p_cfg jsonb)
returns jsonb language plpgsql immutable as $$
declare c jsonb := public.pokejam_raffle_cfg_value(p_cfg);
  off int := (c->>'offline_games')::int; onl int := (c->>'online_games')::int;
  soc int := (c->>'social')::int; rnk int := (c->>'rank_steps')::int;
  per bigint := (c->>'pjam_per_entry')::bigint;
  counted bigint := (c->>'pjam_counted_cap')::bigint;
  g_games int := (c->>'grind_online_per_entry')::int; g_wins int := (c->>'grind_wins_per_entry')::int;
  cap int := (c->>'bonus_cap')::int;
  v_off int := greatest(coalesce(p_offline, 0), 0); v_on int := greatest(coalesce(p_online, 0), 0);
  v_wins int := greatest(coalesce(p_wins, 0), 0); v_social int := greatest(coalesce(p_social, 0), 0) + greatest(coalesce(p_shares, 0), 0);
  v_rank int := greatest(coalesce(p_rank, 0), 0); v_zenith boolean := coalesce(p_zenith, false);
  v_rank_done boolean; v_base boolean; v_grind int; v_holder int; v_bonus int; v_whole bigint := greatest(coalesce(p_whole, 0), 0);
  v_used bigint;
begin
  v_rank_done := v_zenith or v_rank >= rnk;
  v_base := v_off >= off and v_on >= onl and v_social >= soc and v_rank_done;
  v_grind := least(greatest(0, v_on - onl) / g_games, v_wins / g_wins);
  v_used := least(v_whole, greatest(coalesce(counted, 0), 0));
  v_holder := case when v_used <= 0 or per <= 0 then 0 when v_used / per > 2147483647 then 2147483647 else (v_used / per)::int end;
  v_bonus := case when v_base then least(cap, v_grind) else 0 end;
  return jsonb_build_object(
    'base', v_base, 'grind', v_grind, 'holder', v_holder, 'bonus', v_bonus,
    'total', (case when v_base then 1 + v_bonus else 0 end) + v_holder,
    'social_have', v_social, 'rank_done', v_rank_done,
    'offline', jsonb_build_object('have', v_off, 'need', off, 'done', v_off >= off),
    'online', jsonb_build_object('have', v_on, 'need', onl, 'done', v_on >= onl),
    'social', jsonb_build_object('have', v_social, 'need', soc, 'done', v_social >= soc),
    'rank', jsonb_build_object('have', v_rank, 'need', rnk, 'done', v_rank_done, 'zenith', v_zenith));
end $$;


create or replace function public.pokejam_raffle_me()
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare me uuid := auth.uid(); w date := public.pokejam_raffle_week_start(); cfg jsonb := public.pokejam_raffle_cfg();
  counts jsonb; score jsonb; wallet text; last jsonb;
begin
  if me is null or coalesce(auth.jwt() ->> 'is_anonymous', 'false') = 'true'
     or not exists (select 1 from public.pokejam_profiles where id = me) then
    score := public.pokejam_raffle_score(0, 0, 0, 0, 0, 0, false, 0, cfg);
    return jsonb_build_object('signed_in', false, 'week_start', w, 'resets_at', public.pokejam_raffle_week_end(w),
      'config', cfg, 'counts', jsonb_build_object('offline', 0, 'online', 0, 'online_wins', 0, 'social_matches', 0, 'shares', 0, 'rank_steps', 0, 'zenith', false),
      'score', score, 'wallet', null, 'last_draw', null);
  end if;
  counts := public.pokejam_raffle_counts_for(me, w);
  score := public.pokejam_raffle_score(
    (counts->>'offline')::int, (counts->>'online')::int, (counts->>'online_wins')::int,
    (counts->>'social_matches')::int, (counts->>'shares')::int, (counts->>'rank_steps')::int,
    (counts->>'zenith')::boolean, 0, cfg);
  wallet := (public.pokejam_raffle_wallets(me))[1];
  select jsonb_build_object('week_start', d.week_start, 'won', d.winner_id = me, 'entries', coalesce((
      select (e->>'entries')::int from jsonb_array_elements(d.snapshot->'entrants') e where e->>'user_id' = me::text limit 1), 0),
      'total', d.total_entries)
    into last
    from public.pokejam_raffle_draws d where d.week_start < w order by d.week_start desc limit 1;
  return jsonb_build_object('signed_in', true, 'week_start', w, 'resets_at', public.pokejam_raffle_week_end(w),
    'config', cfg, 'counts', counts, 'score', score, 'wallet', wallet, 'last_draw', last);
end $$;


-- One balance, or an array of balances. Each one is capped inside pokejam_raffle_score, then the holder counts add.
-- The challenge total is scored with a zero balance so it is not counted twice.
create or replace function public.pokejam_raffle_balance_holder(p_bal jsonb, p_cfg jsonb)
returns jsonb language plpgsql immutable as $$
declare i int; raw text; whole bigint; one int; holder int := 0; sum_whole bigint := 0; n int;
begin
  if p_bal is null or jsonb_typeof(p_bal) = 'null' then
    return jsonb_build_object('holder', 0, 'whole', 0);
  end if;
  if jsonb_typeof(p_bal) = 'array' then
    n := coalesce(jsonb_array_length(p_bal), 0);
    for i in 0 .. n - 1 loop
      raw := p_bal->>i;
      whole := case when raw ~ '^[0-9]{1,16}$' then least(raw::bigint, 1000000000000000) else 0 end;
      sum_whole := sum_whole + whole;
      one := (public.pokejam_raffle_score(0, 0, 0, 0, 0, 0, false, whole, p_cfg)->>'holder')::int;
      holder := holder + coalesce(one, 0);
    end loop;
    return jsonb_build_object('holder', holder, 'whole', sum_whole);
  end if;
  raw := case when jsonb_typeof(p_bal) = 'string' then p_bal#>>'{}' else trim(both '"' from p_bal::text) end;
  whole := case when raw ~ '^[0-9]{1,16}$' then least(raw::bigint, 1000000000000000) else 0 end;
  one := (public.pokejam_raffle_score(0, 0, 0, 0, 0, 0, false, whole, p_cfg)->>'holder')::int;
  return jsonb_build_object('holder', coalesce(one, 0), 'whole', whole);
end $$;


create or replace function public.pokejam_raffle_entrants(p_week date, p_balances jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare a timestamptz := (p_week::timestamp at time zone 'America/Los_Angeles');
  b timestamptz := public.pokejam_raffle_week_end(p_week);
  cfg jsonb := public.pokejam_raffle_cfg();
  out jsonb := '[]'::jsonb; r record; counts jsonb; score jsonb; nm text; held jsonb; holder int; whole bigint;
begin
  for r in select (c->>'user_id')::uuid as user_id from jsonb_array_elements(public.pokejam_raffle_candidates(p_week)) c order by 1
  loop
    counts := public.pokejam_raffle_counts_for(r.user_id, p_week);
    held := public.pokejam_raffle_balance_holder(p_balances -> r.user_id::text, cfg);
    holder := coalesce((held->>'holder')::int, 0);
    whole := coalesce((held->>'whole')::bigint, 0);
    score := public.pokejam_raffle_score(
      (counts->>'offline')::int, (counts->>'online')::int, (counts->>'online_wins')::int,
      (counts->>'social_matches')::int, (counts->>'shares')::int, (counts->>'rank_steps')::int,
      (counts->>'zenith')::boolean, 0, cfg);
    score := score || jsonb_build_object('holder', holder, 'total', coalesce((score->>'total')::int, 0) + holder);
    if coalesce((score->>'total')::int, 0) > 0 then
      select coalesce(nullif(un.username, ''), pr.trainer_name, 'Trainer') into nm
        from public.pokejam_profiles pr
        left join public.pokejam_usernames un on un.user_id = pr.id
        where pr.id = r.user_id;
      out := out || jsonb_build_array(jsonb_build_object(
        'user_id', r.user_id, 'name', coalesce(nm, 'Trainer'),
        'wallet', (public.pokejam_raffle_wallets(r.user_id))[1],
        'whole_tokens', whole::text,
        'offline', (counts->>'offline')::int, 'online', (counts->>'online')::int,
        'online_wins', (counts->>'online_wins')::int, 'social', (counts->>'social_matches')::int + (counts->>'shares')::int,
        'rank_steps', (counts->>'rank_steps')::int, 'zenith', (counts->>'zenith')::boolean,
        'grind', (score->>'grind')::int, 'holder', (score->>'holder')::int, 'entries', (score->>'total')::int));
    end if;
  end loop;
  return out;
end $$;


create or replace function public.pokejam_raffle_draw_prep(p_week date)
returns jsonb language plpgsql security definer set search_path = public as $$
declare cfg jsonb := public.pokejam_raffle_cfg();
begin
  if p_week is null or not public.pokejam_raffle_is_monday(p_week) then
    return jsonb_build_object('ok', false, 'code', 'bad_week');
  end if;
  if public.pokejam_raffle_draw_json(p_week) is not null then
    return jsonb_build_object('ok', true, 'already', true, 'week_start', p_week, 'mint', cfg->>'pjam_mint',
      'draw', public.pokejam_raffle_draw_json(p_week));
  end if;
  if now() < public.pokejam_raffle_week_end(p_week) then
    return jsonb_build_object('ok', false, 'code', 'open', 'week_start', p_week, 'mint', cfg->>'pjam_mint');
  end if;
  return jsonb_build_object('ok', true, 'already', false, 'week_start', p_week, 'mint', cfg->>'pjam_mint',
    'qualifiers', public.pokejam_raffle_candidates(p_week));
end $$;

revoke all on function public.pokejam_raffle_wallets(uuid), public.pokejam_raffle_candidates(date),
  public.pokejam_raffle_balance_holder(jsonb, jsonb) from public, anon, authenticated;
revoke all on function public.pokejam_raffle_score(int, int, int, int, int, int, boolean, bigint, jsonb),
  public.pokejam_raffle_me(), public.pokejam_raffle_entrants(date, jsonb), public.pokejam_raffle_draw_prep(date)
  from public, anon, authenticated;
grant execute on function public.pokejam_raffle_me() to authenticated;
grant execute on function public.pokejam_raffle_draw_prep(date) to service_role;
