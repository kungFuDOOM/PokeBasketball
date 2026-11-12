-- Weekly raffle: holders qualify without challenges.
-- A player whose connected wallet holds at least pjam_per_entry (1,000,000) whole PJAM at draw time gets the base entry
-- with no challenges. Their holder bonus (1 per 1M, shared cap with grind) still applies. Under 1M, or with no wallet, a
-- player still needs every weekly challenge, and keeps the grind bonus.
-- Wallets counted: pokejam_linked_wallets, and the Solana address of a Phantom sign-in (auth.identities provider 'web3',
-- identity_data.custom_claims.address). Additive: only create or replace of raffle functions. NOT applied by the repo.
-- Guests are still left out. The seed and the winner pick are unchanged.

-- Valid Solana wallets for a player: the linked one first, then any Phantom sign-in address. Service role only.
create or replace function public.pokejam_raffle_wallets(p_user uuid)
returns text[] language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(w order by ord, w), '{}'::text[]) from (
    select w, min(ord) as ord from (
      select l.wallet as w, 0 as ord from public.pokejam_linked_wallets l where l.user_id = p_user
      union all
      select i.identity_data->'custom_claims'->>'address', 1 from auth.identities i
        where i.user_id = p_user and i.provider = 'web3'
    ) x where w ~ '^[1-9A-HJ-NP-Za-km-z]{32,44}$' group by w
  ) s;
$$;

-- Everyone who might qualify: players with activity in the week, plus anyone with a wallet, since a holder needs no
-- activity. Guests left out. The edge function reads balances for these wallets.
create or replace function public.pokejam_raffle_candidates(p_week date)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare a timestamptz := (p_week::timestamp at time zone 'America/Los_Angeles');
  b timestamptz := public.pokejam_raffle_week_end(p_week);
begin
  return coalesce((
    select jsonb_agg(jsonb_build_object('user_id', u.user_id, 'wallet', w[1], 'wallets', to_jsonb(w)) order by u.user_id)
    from (
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
      union
      select i.user_id from auth.identities i where i.provider = 'web3'
    ) u
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
  g_games int := (c->>'grind_online_per_entry')::int; g_wins int := (c->>'grind_wins_per_entry')::int;
  cap int := (c->>'bonus_cap')::int;
  v_off int := greatest(coalesce(p_offline, 0), 0); v_on int := greatest(coalesce(p_online, 0), 0);
  v_wins int := greatest(coalesce(p_wins, 0), 0); v_social int := greatest(coalesce(p_social, 0), 0) + greatest(coalesce(p_shares, 0), 0);
  v_rank int := greatest(coalesce(p_rank, 0), 0); v_zenith boolean := coalesce(p_zenith, false);
  v_rank_done boolean; v_base boolean; v_grind int; v_holder int; v_bonus int; v_whole bigint := greatest(coalesce(p_whole, 0), 0);
begin
  v_rank_done := v_zenith or v_rank >= rnk;
  v_base := (v_off >= off and v_on >= onl and v_social >= soc and v_rank_done) or (per > 0 and v_whole >= per);
  v_grind := least(greatest(0, v_on - onl) / g_games, v_wins / g_wins);
  v_holder := case when v_whole <= 0 or per <= 0 then 0 when v_whole / per > 2147483647 then 2147483647 else (v_whole / per)::int end;
  v_bonus := least(cap, v_grind + v_holder);
  return jsonb_build_object(
    'base', v_base, 'grind', v_grind, 'holder', v_holder, 'bonus', v_bonus,
    'total', case when v_base then 1 + v_bonus else 0 end,
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


create or replace function public.pokejam_raffle_entrants(p_week date, p_balances jsonb default '{}'::jsonb)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare a timestamptz := (p_week::timestamp at time zone 'America/Los_Angeles');
  b timestamptz := public.pokejam_raffle_week_end(p_week);
  cfg jsonb := public.pokejam_raffle_cfg();
  out jsonb := '[]'::jsonb; r record; counts jsonb; score jsonb; raw text; whole bigint; nm text;
begin
  for r in select (c->>'user_id')::uuid as user_id from jsonb_array_elements(public.pokejam_raffle_candidates(p_week)) c order by 1
  loop
    counts := public.pokejam_raffle_counts_for(r.user_id, p_week);
    raw := p_balances ->> r.user_id::text;
    whole := case when raw ~ '^[0-9]{1,16}$' then least(raw::bigint, 1000000000000000) else 0 end;
    score := public.pokejam_raffle_score(
      (counts->>'offline')::int, (counts->>'online')::int, (counts->>'online_wins')::int,
      (counts->>'social_matches')::int, (counts->>'shares')::int, (counts->>'rank_steps')::int,
      (counts->>'zenith')::boolean, whole, cfg);
    if coalesce((score->>'base')::boolean, false) then
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

revoke all on function public.pokejam_raffle_wallets(uuid), public.pokejam_raffle_candidates(date) from public, anon, authenticated;
revoke all on function public.pokejam_raffle_score(int, int, int, int, int, int, boolean, bigint, jsonb),
  public.pokejam_raffle_me(), public.pokejam_raffle_entrants(date, jsonb), public.pokejam_raffle_draw_prep(date)
  from public, anon, authenticated;
grant execute on function public.pokejam_raffle_me() to authenticated;
grant execute on function public.pokejam_raffle_draw_prep(date) to service_role;
