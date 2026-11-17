-- Click counter for paid ticker ads (live board). The page reports a click to the pokejam-ads-live Edge Function
-- (action 'click'), which calls pokejam_live_ad_click with a salted hash of the caller's IP, the same hash the report
-- and rate-limit calls use: the raw IP is never stored. Everything is service-role only, apart from the moderators'
-- pokejam_admin_ad_clicks for admin.html (gated by pokejam_require_admin, like the other admin stats).
--
-- Dedupe: the same ip_hash clicking the same ad again within 30 seconds counts once.

create table if not exists public.pokejam_ad_clicks (
  id bigserial primary key,
  -- The live booking that was clicked; kept (null) if the booking row is ever deleted.
  ad_id uuid references public.pokejam_live_ads(id) on delete set null,
  ad_url text not null check (char_length(ad_url) <= 300),
  link_domain text,
  clicked_at timestamptz not null default now(),
  ip_hash text,
  referrer text check (char_length(referrer) <= 300)
);
create index if not exists pokejam_ad_clicks_ad on public.pokejam_ad_clicks (ad_id, ip_hash, clicked_at desc);
create index if not exists pokejam_ad_clicks_at on public.pokejam_ad_clicks (clicked_at);
alter table public.pokejam_ad_clicks enable row level security;
revoke all on public.pokejam_ad_clicks from anon, authenticated, public;

-- Records a click on a paid ad that is on the board. True when it counted, false when it was a repeat or not a live ad.
create or replace function public.pokejam_live_ad_click(p_id uuid, p_url text, p_ip_hash text, p_referrer text default null)
returns boolean language plpgsql security definer set search_path = public as $$
declare u text := left(coalesce(p_url, ''), 300); dom text;
begin
  if p_id is null or u !~* '^https://[a-z0-9.-]+\.[a-z]{2,}(/|\?|#|:|$)' then return false; end if;
  if not exists (select 1 from public.pokejam_live_ads where id = p_id and state = 'paid' and ends_at > now()) then return false; end if;
  dom := lower(substring(u from '^https://([^/?#:]+)'));
  -- Serialize the same caller + ad so two simultaneous clicks can't both pass the 30 second check.
  perform pg_advisory_xact_lock(hashtextextended(coalesce(p_ip_hash, '') || ':' || p_id::text, 0));
  if exists (select 1 from public.pokejam_ad_clicks where ad_id = p_id and ip_hash is not distinct from p_ip_hash
             and clicked_at > now() - interval '30 seconds') then return false; end if;
  insert into public.pokejam_ad_clicks(ad_id, ad_url, link_domain, ip_hash, referrer)
  values (p_id, u, dom, left(p_ip_hash, 64), nullif(left(coalesce(p_referrer, ''), 300), ''));
  return true;
end $$;

-- Moderators: clicks per ad domain (and the ad texts that ran it): total, last 24 hours, last 7 days.
create or replace function public.pokejam_admin_ad_clicks()
returns jsonb language plpgsql stable security definer set search_path = public as $$
begin
  perform public.pokejam_require_admin();
  return coalesce((select jsonb_agg(x order by (x->>'total')::int desc, x->>'domain') from (
    select jsonb_build_object(
      'domain', coalesce(c.link_domain, '(unknown)'),
      'ads', (select coalesce(jsonb_agg(distinct a.text), '[]') from public.pokejam_live_ads a
              where a.id in (select ad_id from public.pokejam_ad_clicks k where k.link_domain is not distinct from c.link_domain)),
      'total', count(*),
      'last_24h', count(*) filter (where c.clicked_at > now() - interval '24 hours'),
      'last_7d', count(*) filter (where c.clicked_at > now() - interval '7 days')) as x
    from public.pokejam_ad_clicks c group by c.link_domain
  ) y), '[]');
end $$;

do $$
begin
  revoke all on function public.pokejam_live_ad_click(uuid, text, text, text) from public, anon, authenticated;
  grant execute on function public.pokejam_live_ad_click(uuid, text, text, text) to service_role;
  revoke all on function public.pokejam_admin_ad_clicks() from public, anon;
  grant execute on function public.pokejam_admin_ad_clicks() to authenticated;
end $$;
