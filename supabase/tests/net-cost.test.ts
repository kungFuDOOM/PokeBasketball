// The moderators' net cost panel (migration 20261126): per Pacific day, matches, stats coverage, Realtime and TURN
// estimates, browser engines and resyncs.
import { describe, expect, it, vi } from 'vitest';
import { quickPair, testDb, type User } from './testDb';

vi.setConfig({ testTimeout: 30_000 });

type Day = Record<string, unknown> & { day: string; matches: number; engines: Record<string, number> };

const ins = (mid: string, u: User, cols: Record<string, string | number | boolean> = {}) => {
  const all = { relay_protocol: 'udp', ...cols };
  const v = Object.values(all).map((x) => (typeof x === 'string' ? `'${x}'` : String(x)));
  return u.sql(`insert into public.pokejam_match_net_stats(match_id, user_id, ${Object.keys(all).join(', ')}) values ('${mid}', '${u.id}', ${v.join(', ')})`);
};

describe('pokejam_admin_net_cost', () => {
  it('refuses anyone who is not a moderator', async () => {
    const t = await testDb();
    const a = await t.user('A');
    await expect(a.call('pokejam_admin_net_cost', [7])).rejects.toThrow(/moderators only/);
    await expect(t.as('anon', null)('select public.pokejam_admin_net_cost(7)')).rejects.toThrow(/permission denied/);
  });

  it('returns one row per day, newest first, without dividing by zero on empty days, and clamps p_days', async () => {
    const t = await testDb();
    const mod = await t.user('Mod');
    await t.sql('insert into public.pokejam_admins(user_id) values ($1)', [mod.id]);
    const days = await mod.call<Day[]>('pokejam_admin_net_cost', [7]);
    expect(days).toHaveLength(7);
    expect(days.map((d) => d.day)).toEqual([...days.map((d) => d.day)].sort().reverse());
    expect(days[0]).toMatchObject({ matches: 0, stat_rows: 0, coverage: null, match_coverage: null, fallback_rate: null,
      rt_msgs_per_match: null, rt_msgs_billed: null, turn_bytes_est: 0, turn_msg_bytes: 88, avg_resyncs: null, resync_matches: 0,
      engines: { blink: 0, gecko: 0, webkit: 0, other: 0, unknown: 0 } });
    expect(await mod.call<Day[]>('pokejam_admin_net_cost', [0])).toHaveLength(1);
    expect(await mod.call<Day[]>('pokejam_admin_net_cost', [1000])).toHaveLength(90);
    expect(await mod.call<Day[]>('pokejam_admin_net_cost', [null])).toHaveLength(7);
  });

  it('adds up matches, coverage, fallback, Realtime, TURN bytes, engines and resyncs', async () => {
    const t = await testDb();
    const [mod, a, b, c, d, e, f, g, h] = await Promise.all(['Mod', 'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].map((n) => t.user(n)));
    await t.sql('insert into public.pokejam_admins(user_id) values ($1)', [mod.id]);
    const m1 = await quickPair(t, a, b); // both sides reported
    const m2 = await quickPair(t, c, d); // only one side reported
    const m3 = await quickPair(t, e, f); // 10 days ago
    const m4 = await quickPair(t, g, h); // one row from an older client (no new fields)
    await t.sql(`update public.pokejam_matches set created_at = now() - interval '10 days' where id = $1`, [m3]);

    await ins(m1, a, { sent_realtime: 100, sent_direct: 1000, browser_engine: 'blink' });
    await ins(m1, b, { relay_protocol: 'unknown', sent_realtime: 300, sent_direct: 2000, used_realtime_fallback: true, resyncs: 2, browser_engine: 'webkit' });
    await ins(m2, c, { relay_protocol: 'tcp', sent_realtime: 200, sent_direct: 500, browser_engine: 'gecko' });
    await ins(m3, e, { sent_realtime: 999, sent_direct: 999, resyncs: 5, browser_engine: 'blink' });
    await ins(m4, g, { stalls: 3 });

    const [today, ...rest] = await mod.call<Day[]>('pokejam_admin_net_cost', [7]);
    expect(today).toMatchObject({
      matches: 3, stat_rows: 4, reporting_rows: 3,
      coverage: 0.667, match_coverage: 1, fallback_rate: 0.25,
      rt_msgs_per_match: 400, rt_msgs_billed: 800, // (100 + 300 + 200) / 3 rows × 2 sides; × 2 again for billing
      turn_bytes_est: (1000 + 500 + 0) * 88 * 2, // b went direct (relay_protocol unknown), so it is left out
      turn_msg_bytes: 88,
      engines: { blink: 1, gecko: 1, webkit: 1, other: 0, unknown: 1 },
      avg_resyncs: 0.667, resync_matches: 1,
    });
    expect(rest.every((x) => x.matches === 0)).toBe(true); // the 10-day-old match is outside the window

    const month = await mod.call<Day[]>('pokejam_admin_net_cost', [30]);
    const old = month.filter((x) => x.matches > 0 && x.day !== today.day);
    expect(old).toHaveLength(1);
    expect(old[0]).toMatchObject({ matches: 1, stat_rows: 1, coverage: 0.5, rt_msgs_per_match: 1998, resync_matches: 1 });
  });
});
