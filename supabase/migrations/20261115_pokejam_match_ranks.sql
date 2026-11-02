-- Ranked: the two players' public rank for the match screens (name cards show each player's rank badge).
-- Additive: one new function, nothing existing is replaced. Same checks as pokejam_match_usernames: signed in, and only a
-- player in the match may ask. Returns public rank info only (no ids beyond the side, no emails, no points or shield state):
--   { host: {status, placements_played, placements_total, div_idx, tier, division},
--     guest: { ... } }
-- status: 'ranked' (div_idx 0..24, tier and division set; division is null for Zenith), 'placing' (placements_played of
-- placements_total), or 'unranked' (no ranked row this season).
create or replace function public.pokejam_match_ranks(p_match uuid)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare me uuid := auth.uid(); m public.pokejam_matches; s public.pokejam_seasons;
begin
  if me is null then raise exception 'not signed in'; end if;
  select * into m from public.pokejam_matches where id = p_match;
  if m.id is null or me not in (m.host, m.guest) then raise exception 'not in this match'; end if;
  s := public.pokejam_ranked_season();
  return jsonb_build_object(
    'host', public.pokejam_match_rank_of(m.host, s.id),
    'guest', public.pokejam_match_rank_of(m.guest, s.id));
end $$;

-- Helper: one player's public rank in a season. Internal: not callable by clients (only by pokejam_match_ranks).
create or replace function public.pokejam_match_rank_of(p_user uuid, p_season int)
returns jsonb language plpgsql stable security definer set search_path = public as $$
declare p public.pokejam_ranked_profiles;
begin
  if p_user is null then return jsonb_build_object('status', 'unranked'); end if;
  select * into p from public.pokejam_ranked_profiles where user_id = p_user and season_id = p_season;
  if p.user_id is null then return jsonb_build_object('status', 'unranked'); end if;
  if p.status = 'placing' then
    return jsonb_build_object('status', 'placing', 'placements_played', p.placements_played, 'placements_total', 5);
  end if;
  return jsonb_build_object('status', 'ranked', 'placements_played', 5, 'placements_total', 5, 'div_idx', p.div_idx,
    'tier', public.pokejam_ranked_tier_name(p.div_idx), 'division', public.pokejam_ranked_division(p.div_idx));
end $$;

revoke execute on function public.pokejam_match_ranks(uuid), public.pokejam_match_rank_of(uuid, int) from public, anon, authenticated;
grant execute on function public.pokejam_match_ranks(uuid) to authenticated;
