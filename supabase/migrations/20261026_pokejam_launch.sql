-- PokeJam online launch: the direct (WebRTC, TURN-relayed) link. Shared gauntlet-legends project: pokejam_* only.
--
-- The pokejam-ice Edge Function asks this, as the player, before handing out short-lived TURN credentials: only
-- the two players in an active match get them, a few times per 10 minutes, so the relay can't be farmed.
create or replace function public.pokejam_ice_ok(p_match uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null or public.pokejam_banned(me) then return false; end if;
  if not exists (select 1 from public.pokejam_matches m where m.id = p_match and me in (m.host, m.guest)
      and m.status = 'active' and m.created_at > now() - interval '3 hours') then return false; end if;
  return public.pokejam_rate_ok('ice', 6, interval '10 minutes');
end $$;

revoke all on function public.pokejam_ice_ok(uuid) from public, anon, authenticated;
grant execute on function public.pokejam_ice_ok(uuid) to authenticated;
