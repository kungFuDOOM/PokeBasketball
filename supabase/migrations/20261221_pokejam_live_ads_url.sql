-- Optional click-through link for a booked live ad (first user: the Slabz booking). The page appends its own UTMs
-- (src/data/ads.ts withAdUtms), so store the BASE url only, e.g. https://slabz.com/ref/POKEJAM, with no utm_* in it.
-- Null means "no link": the page then falls back to a domain found in the ad text (adLinkUrl).
--
-- Adds nullable pokejam_live_ads.url (https only, a real hostname, no userinfo, 300 chars at most, the same shape
-- pokejam_ad_clicks.ad_url accepts), and replaces pokejam_live_ad_board() (20261204) and pokejam_live_ad_view() (20261205)
-- unchanged except that each live ad / booking now carries 'url'. Nothing about booking, burning or USDC changes.

alter table public.pokejam_live_ads add column if not exists url text;
alter table public.pokejam_live_ads drop constraint if exists pokejam_live_ads_url_check;
alter table public.pokejam_live_ads add constraint pokejam_live_ads_url_check check (
  url is null or (char_length(url) <= 300 and url ~* '^https://[a-z0-9.-]+\.[a-z]{2,}(/|\?|#|:|$)' and url !~ '[[:space:]]')
);

-- pokejam_live_ad_view (20261205) plus url.
create or replace function public.pokejam_live_ad_view(a public.pokejam_live_ads)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object('id', a.id, 'code', a.code, 'wallet', a.wallet, 'text', a.text, 'theme', a.theme, 'plan', a.plan,
    'hours', a.hours, 'pay_method', a.pay_method, 'price', a.price::text, 'state', a.state, 'wants_start', a.wants_start,
    'starts_at', a.starts_at, 'ends_at', a.ends_at, 'moved', a.moved, 'burn_sig', a.burn_sig, 'burned', a.burned::text,
    'credit_used', a.credit_used::text,
    'usdc_sig', a.usdc_sig, 'usdc_paid', a.usdc_paid::text, 'paid_at', a.paid_at,
    'blockhash', a.blockhash, 'created_at', a.created_at, 'extra_of', a.extra_of, 'replaces', a.replaces,
    'replaced_by', a.replaced_by, 'removed_reason', a.removed_reason, 'removed_left', a.removed_left,
    'url', a.url,
    'banned', exists (select 1 from public.pokejam_ad_bans b where b.wallet = a.wallet));
$$;

-- pokejam_live_ad_board (20261204) plus url on each live ad.
create or replace function public.pokejam_live_ad_board()
returns jsonb language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'now', now(),
    'paused', public.pokejam_live_ad_cfg('ads_paused', 'false') = 'true',
    'spots', greatest(1, public.pokejam_live_ad_cfg('ad_spots', '3')::int),
    -- What's on sale, in base units: the page draws its plans from this list.
    'plans', coalesce((select jsonb_agg(jsonb_build_object('method', method, 'plan', plan, 'hours', public.pokejam_live_ad_hours(plan),
        'amount', ((amount * 1000000)::numeric(39, 0))::text) order by method, public.pokejam_live_ad_hours(plan))
      from public.pokejam_live_ad_plans where enabled), '[]'),
    'live', coalesce((select jsonb_agg(jsonb_build_object('id', id, 'text', text, 'theme', theme, 'wallet', wallet,
        'starts_at', starts_at, 'ends_at', ends_at, 'burn_sig', burn_sig, 'usdc_sig', usdc_sig, 'url', url) order by starts_at, id)
      from public.pokejam_live_ads where state = 'paid' and starts_at <= now() and ends_at > now()), '[]'),
    'booked', coalesce((select jsonb_agg(jsonb_build_object('starts_at', starts_at, 'ends_at', ends_at) order by starts_at)
      from public.pokejam_live_ads where state = 'paid' and ends_at > now() and starts_at < now() + interval '14 days'), '[]'),
    'totals', (select jsonb_build_object('burned', coalesce(sum(burned), 0)::text, 'usdc', coalesce(sum(usdc_paid), 0)::text,
        'ads', count(*) filter (where extra_of is null), 'advertisers', count(distinct wallet),
        'hours', coalesce(round(sum(extract(epoch from ends_at - starts_at)) / 3600), 0))
      from public.pokejam_live_ads where burn_sig is not null or usdc_sig is not null)
  );
$$;

revoke all on function public.pokejam_live_ad_view(public.pokejam_live_ads) from public, anon, authenticated;
grant execute on function public.pokejam_live_ad_view(public.pokejam_live_ads) to service_role;
revoke all on function public.pokejam_live_ad_board() from public, anon, authenticated;
grant execute on function public.pokejam_live_ad_board() to service_role;
