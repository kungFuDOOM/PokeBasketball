// Ad click counter (migration 20261220): service-only recording with a 30 s per-caller dedupe, moderator-only counts.
import { describe, expect, it, vi } from 'vitest';
import { testDb } from './testDb';

vi.setConfig({ testTimeout: 60_000 });
const WALLET = '9wqysMYY4DTcbPjSZpGQU3pF29YUw9w6A1a8XDKVhezh';

async function setup() {
  const t = await testDb();
  const ad = async (state = 'paid') => (await t.sql(
    `insert into public.pokejam_live_ads(code, wallet, text, theme, plan, hours, pay_method, price, wants_start, state, starts_at, ends_at, burn_sig, burned)
     values (gen_random_uuid()::text, $1, 'RIPIT .CO', 'gold', 'hour', 1, 'burn', 1, now(), $2, now() - interval '1 minute', now() + interval '1 hour', gen_random_uuid()::text, 1) returning id`, [WALLET, state]))[0].id as string;
  return { t, ad };
}

describe('pokejam_live_ad_click', () => {
  it('is service-role only and the table is closed to clients', async () => {
    const { t, ad } = await setup();
    const id = await ad();
    await expect(t.as('anon', null)('select public.pokejam_live_ad_click($1, $2, $3, null)', [id, 'https://ripit.co', 'h'])).rejects.toThrow(/permission denied/);
    await expect(t.as('authenticated', null)('select * from public.pokejam_ad_clicks')).rejects.toThrow(/permission denied/);
    await expect(t.as('anon', null)('insert into public.pokejam_ad_clicks(ad_url) values ($1)', ['https://x.co'])).rejects.toThrow(/permission denied/);
  });
  it('counts a paid ad once per caller per 30 s, and only live paid ads with https links', async () => {
    const { t, ad } = await setup();
    const id = await ad();
    const click = (i: string, url = 'https://ripit.co/play?x=1', h = 'hash1') => t.as('service_role', null)('select public.pokejam_live_ad_click($1, $2, $3, $4) as r', [i, url, h, 'https://pokejam.xyz']).then((r) => r[0].r);
    expect(await click(id)).toBe(true);
    expect(await click(id)).toBe(false);
    expect(await click(id, 'https://ripit.co', 'hash2')).toBe(true);
    await t.sql(`update public.pokejam_ad_clicks set clicked_at = now() - interval '31 seconds' where ip_hash = 'hash1'`);
    expect(await click(id)).toBe(true);
    expect(await click(id, 'http://ripit.co', 'h3')).toBe(false);
    expect(await click(id, 'javascript:alert(1)', 'h4')).toBe(false);
    expect(await click(await ad('pending'), 'https://ripit.co', 'h5')).toBe(false);
    expect(await click(crypto.randomUUID(), 'https://ripit.co', 'h6')).toBe(false);
    const rows = await t.sql('select link_domain, ip_hash from public.pokejam_ad_clicks');
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.link_domain === 'ripit.co')).toBe(true);
  });
});

describe('pokejam_admin_ad_clicks', () => {
  it('refuses non-moderators and counts total, 24h and 7d per domain for moderators', async () => {
    const { t, ad } = await setup();
    const id = await ad();
    const who = await t.user('A');
    await expect(who.call('pokejam_admin_ad_clicks')).rejects.toThrow(/moderators only/);
    await t.sql('insert into public.pokejam_admins(user_id) values ($1)', [who.id]);
    for (const [h, age] of [['a', '0 minutes'], ['b', '2 days'], ['c', '10 days']]) {
      await t.sql(`insert into public.pokejam_ad_clicks(ad_id, ad_url, link_domain, ip_hash, clicked_at) values ($1, 'https://ripit.co', 'ripit.co', $2, now() - $3::interval)`, [id, h, age]);
    }
    const rows = await who.call<{ domain: string; ads: string[]; total: number; last_24h: number; last_7d: number }[]>('pokejam_admin_ad_clicks');
    expect(rows).toEqual([{ domain: 'ripit.co', ads: ['RIPIT .CO'], total: 3, last_24h: 1, last_7d: 2 }]);
  });
});
