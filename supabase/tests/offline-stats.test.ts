// Offline game counts (migration 20261110): anyone can log through the function only, junk and floods are dropped,
// and only moderators can read the summary.
import { describe, expect, it, vi } from 'vitest';
import { testDb } from './testDb';

vi.setConfig({ testTimeout: 30_000 });

const D1 = '00000000-0000-4000-8000-000000000001';
const D2 = '00000000-0000-4000-8000-000000000002';

describe('pokejam offline stats', () => {
  it('logs through the function only, validating and clamping', async () => {
    const t = await testDb();
    const anon = t.as('anon', null);
    const log = (...a: unknown[]) => anon(`select public.pokejam_log_offline(${a.map((_, i) => `$${i + 1}`).join(', ')})`, a);
    await log(D1, 'start', 'quick');
    await log(D1, 'finish', 'quick', 'played');
    await log(D1, 'season', 'franchise', 'played', 5000, 99); // resolution ignored, ints clamped
    await log(D1, 'finish', 'quick', null); // a finish needs a resolution
    await log(D1, 'start', 'ranked');
    await log(D1, 'hack', 'quick');
    await log(null, 'start', 'quick');
    await log(D1, null, 'quick');
    await expect(anon('select * from public.pokejam_offline_events')).rejects.toThrow(/permission denied/);
    await expect(anon(`insert into public.pokejam_offline_events(device_id, event, mode) values ($1, 'start', 'quick')`, [D1])).rejects.toThrow(/permission denied/);
    const rows = await t.sql('select event, mode, resolution, season, playoff_round from public.pokejam_offline_events order by id');
    expect(rows).toEqual([
      { event: 'start', mode: 'quick', resolution: null, season: null, playoff_round: null },
      { event: 'finish', mode: 'quick', resolution: 'played', season: null, playoff_round: null },
      { event: 'season', mode: 'franchise', resolution: null, season: 1000, playoff_round: 10 },
    ]);
  });

  it('drops a device past 30 events in 10 minutes', async () => {
    const t = await testDb();
    for (let i = 0; i < 40; i++) await t.as('anon', null)(`select public.pokejam_log_offline($1, 'start', 'quick')`, [D1]);
    expect((await t.sql('select count(*)::int as n from public.pokejam_offline_events'))[0].n).toBe(30);
  });

  it('summarizes for moderators only', async () => {
    const t = await testDb();
    const [mod, a] = [await t.user('Mod'), await t.user('A')];
    await expect(a.call('pokejam_admin_offline_stats')).rejects.toThrow(/moderators only/);
    await expect(t.as('anon', null)('select public.pokejam_admin_offline_stats()')).rejects.toThrow(/permission denied/);
    await t.sql('insert into public.pokejam_admins(user_id) values ($1)', [mod.id]);
    expect(await mod.call('pokejam_admin_offline_stats')).toMatchObject({ players_all: 0, games_all: {}, first_event_at: null });

    await t.sql(`insert into public.pokejam_offline_events(device_id, event, mode, resolution, season, playoff_round, created_at) values
      ($1, 'start', 'quick', null, null, null, now()), ($1, 'finish', 'quick', 'played', null, null, now()),
      ($2, 'start', 'franchise', null, null, null, now()), ($2, 'finish', 'franchise', 'simmed', null, null, now()),
      ($2, 'season', 'franchise', null, 1, 3, now()), ($2, 'season', 'franchise', null, 2, 0, now() - interval '3 days'),
      ($1, 'start', 'quick', null, null, null, now() - interval '30 days'), ($1, 'season', 'season_draft', null, null, 1, now() - interval '30 days')`, [D1, D2]);
    const s = await mod.call<Record<string, unknown>>('pokejam_admin_offline_stats');
    expect(s).toMatchObject({
      players_today: 2, players_7d: 2, players_all: 2,
      games_today: { quick: { started: 1, finished: 1 }, franchise: { started: 1, finished: 1 } },
      games_all: { quick: { started: 2, finished: 1 }, franchise: { started: 1, finished: 1 } },
      finish_today: { played: 1, watched: 0, simmed: 1 },
      finish_all: { played: 1, watched: 0, simmed: 1 },
      seasons_today: { franchise: { seasons: 1, playoffs: 1, titles: 1 } },
      seasons_all: { franchise: { seasons: 2, playoffs: 1, titles: 1 }, season_draft: { seasons: 1, playoffs: 1, titles: 0 } },
    });
    expect(typeof s.first_event_at).toBe('string');
  });
});
