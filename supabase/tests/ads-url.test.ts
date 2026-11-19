// Live ad click-through link (migration 20261221): a nullable, https-only url on a booking, carried by the board and the view.
import { describe, expect, it, vi } from 'vitest';
import { testDb } from './testDb';

vi.setConfig({ testTimeout: 60_000 });
const WALLET = '9wqysMYY4DTcbPjSZpGQU3pF29YUw9w6A1a8XDKVhezh';
const BASE = 'https://slabz.com/ref/POKEJAM';

async function setup() {
  const t = await testDb();
  const ad = async (url: string | null, text = 'SLABZ .COM') => (await t.sql(
    `insert into public.pokejam_live_ads(code, wallet, text, theme, plan, hours, pay_method, price, wants_start, state, starts_at, ends_at, burn_sig, burned, url)
     values (gen_random_uuid()::text, $1, $2, 'gold', 'week', 168, 'burn', 1, now(), 'paid', now() - interval '1 minute', now() + interval '1 hour', gen_random_uuid()::text, 1, $3) returning id`, [WALLET, text, url]))[0].id as string;
  return { t, ad };
}

describe('pokejam_live_ads.url', () => {
  it('shows up on the board payload for a live ad, null when not set', async () => {
    const { t, ad } = await setup();
    const withUrl = await ad(BASE);
    const without = await ad(null, 'NO LINK');
    const b = (await t.service('select public.pokejam_live_ad_board() as r'))[0].r as { live: { id: string; url: string | null }[] };
    expect(b.live.find((a) => a.id === withUrl)).toMatchObject({ url: BASE });
    expect(b.live.find((a) => a.id === without)!.url).toBeNull();
    expect(b.live.every((a) => 'url' in a)).toBe(true);
  });

  it('is carried by the booking view too', async () => {
    const { t, ad } = await setup();
    const id = await ad(BASE);
    const rows = await t.sql('select public.pokejam_live_ad_view(a) as v from public.pokejam_live_ads a where a.id = $1', [id]);
    expect((rows[0].v as { url: string }).url).toBe(BASE);
  });

  it('allows null and real https links, and rejects everything else', async () => {
    const { ad } = await setup();
    await expect(ad(null)).resolves.toBeTruthy();
    await expect(ad('https://slabz.com/ref/POKEJAM?utm_source=x#top')).resolves.toBeTruthy();
    await expect(ad('https://slabz.com:8443/x')).resolves.toBeTruthy();
    for (const bad of ['http://slabz.com/x', 'javascript:alert(1)', 'https://user:pw@slabz.com/', 'https://localhost/x', 'ftp://slabz.com', 'slabz.com',
      'https://slabz.com/a b', `https://slabz.com/${'a'.repeat(300)}`, '']) {
      await expect(ad(bad), bad.slice(0, 40)).rejects.toThrow(/pokejam_live_ads_url_check/);
    }
  });

  it('keeps the board and view service-role only', async () => {
    const { t } = await setup();
    await expect(t.as('anon', null)('select public.pokejam_live_ad_board()')).rejects.toThrow(/permission denied/);
    await expect(t.as('authenticated', null)('select public.pokejam_live_ad_board()')).rejects.toThrow(/permission denied/);
    await expect(t.as('anon', null)('select public.pokejam_live_ad_view(a) from public.pokejam_live_ads a')).rejects.toThrow(/permission denied/);
  });
});
