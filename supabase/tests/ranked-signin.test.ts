// Migration 20261113: Ranked refuses guest (anonymous) sessions, and a leave after the 30 s no-connect window is no longer
// a free dodge.
import { describe, expect, it, vi } from 'vitest';
import { testDb, type Db } from './testDb';

vi.setConfig({ testTimeout: 60_000 });

type Row = Record<string, unknown>;
const prof = async (t: Db, uid: string) => ((await t.sql('select * from public.pokejam_ranked_profiles where user_id = $1 order by season_id desc limit 1', [uid]))[0]
  ?? { wins: 0, losses: 0, leaves_24h: 0, cooldown_until: null }) as Row;
const status = async (t: Db, mid: string) => (await t.sql('select status from public.pokejam_matches where id = $1', [mid]))[0].status;
const age = (t: Db, mid: string, seconds: number) =>
  t.sql(`update public.pokejam_matches set created_at = now() - make_interval(secs => $2) where id = $1`, [mid, seconds]);
const KEY = 'a'.repeat(64);
const showUp = (t: Db, mid: string, side: 'host' | 'guest') =>
  t.sql(`update public.pokejam_matches set ${side}_key = $2 where id = $1`, [mid, KEY]);
const cleanup = async (t: Db) => Number((await t.service('select public.pokejam_cleanup_matches() as n'))[0].n);

async function rankedPair(t: Db) {
  const [a, b] = [await t.user('A'), await t.user('B')];
  expect(await a.call('pokejam_find_match', ['ranked'])).toBeNull();
  const mid = await b.call<string | null>('pokejam_find_match', ['ranked']);
  expect(mid).toBeTruthy();
  const info = await a.call<Record<string, string>>('pokejam_match_info', [mid!]);
  return { mid: mid!, host: info.host === a.id ? a : b, guest: info.host === a.id ? b : a };
}

describe('Ranked needs a signed-in account', () => {
  it('a guest cannot search the Ranked queue, a signed-in player can, and Social stays open to guests', async () => {
    const t = await testDb();
    const guest = await t.user('Guest', true);
    const member = await t.user('Member');
    await expect(guest.call('pokejam_find_match', ['ranked'])).rejects.toThrow(/signed-in account/);
    expect((await t.sql('select count(*)::int as n from public.pokejam_queue where user_id = $1', [guest.id]))[0].n).toBe(0);
    expect(await member.call('pokejam_find_match', ['ranked'])).toBeNull();
    expect(await guest.call('pokejam_find_match', ['social'])).toBeNull(); // guests still queue for Social
    expect((await t.sql('select count(*)::int as n from public.pokejam_queue where user_id = $1', [guest.id]))[0].n).toBe(1);
  });

  it('a guest cannot report a Ranked score, result or forfeit', async () => {
    const t = await testDb();
    const { mid, host } = await rankedPair(t);
    // the same account turned into a guest session: refused on every Ranked report path
    const asGuest = (name: string) => ({
      call: async (fn: string, args: unknown[]) =>
        (await t.as('authenticated', host.id, undefined, true)(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args))[0].r,
      name,
    });
    const g = asGuest('host-as-guest');
    await expect(g.call('pokejam_ranked_report_score', [mid, 50, 40])).rejects.toThrow(/signed-in account/);
    await expect(g.call('pokejam_report_result', [mid, true])).rejects.toThrow(/signed-in account/);
    await expect(g.call('pokejam_ranked_forfeit', [mid])).rejects.toThrow(/signed-in account/);
    // the signed-in session of the same player still works
    await host.call('pokejam_ranked_report_score', [mid, 50, 40]);
    expect(await host.call('pokejam_report_result', [mid, true])).toMatchObject({ status: 'pending' });
  });

  it('a Social result by a guest still reports', async () => {
    const t = await testDb();
    const a = await t.user('A', true);
    const b = await t.user('B', true);
    expect(await a.call('pokejam_find_match', ['social'])).toBeNull();
    const mid = await b.call<string>('pokejam_find_match', ['social']);
    expect(mid).toBeTruthy();
    await a.call('pokejam_match_alive', [mid]);
    expect(await a.call('pokejam_report_result', [mid, true])).toMatchObject({ status: 'pending' });
    expect(await b.call('pokejam_report_result', [mid, true])).toMatchObject({ status: 'done' });
  });
});

describe('the late dodge', () => {
  it('leaving after the 30 s window without ever showing up (the other did) is a dodge: loss, leave count, cooldown on the 2nd', async () => {
    const t = await testDb();
    const { mid, host, guest } = await rankedPair(t);
    await showUp(t, mid, 'host'); // the stayer registered a key the moment they started connecting
    await age(t, mid, 35);
    await guest.call('pokejam_leave_match', [mid]);
    expect(await status(t, mid)).toBe('void');
    expect(await prof(t, guest.id)).toMatchObject({ losses: 1, leaves_24h: 1 });
    expect(await prof(t, host.id)).toMatchObject({ wins: 0, losses: 0, leaves_24h: 0 });
  });

  it('the stayer who waited and gave up is not charged; the one who never showed up is', async () => {
    const t = await testDb();
    const { mid, host, guest } = await rankedPair(t);
    await showUp(t, mid, 'host');
    await age(t, mid, 41);
    await host.call('pokejam_leave_match', [mid]); // the host's connect timeout
    expect(await status(t, mid)).toBe('void');
    expect(await prof(t, host.id)).toMatchObject({ losses: 0, leaves_24h: 0 });
    expect(await prof(t, guest.id)).toMatchObject({ losses: 1, leaves_24h: 1 });
  });

  it('both showed up and the link failed, or nobody can be told apart: nobody is charged', async () => {
    const t = await testDb();
    const one = await rankedPair(t);
    await showUp(t, one.mid, 'host');
    await showUp(t, one.mid, 'guest');
    await age(t, one.mid, 40);
    await one.guest.call('pokejam_leave_match', [one.mid]);
    expect(await prof(t, one.guest.id)).toMatchObject({ losses: 0, leaves_24h: 0 });
    expect(await prof(t, one.host.id)).toMatchObject({ losses: 0, leaves_24h: 0 });
    const two = await rankedPair(t);
    await age(t, two.mid, 40);
    await two.host.call('pokejam_leave_match', [two.mid]);
    expect(await status(t, two.mid)).toBe('void');
    expect(await prof(t, two.host.id)).toMatchObject({ losses: 0, leaves_24h: 0 });
  });

  it('a leave inside the 30 s window is still a dodge, whoever showed up', async () => {
    const t = await testDb();
    const { mid, host, guest } = await rankedPair(t);
    await showUp(t, mid, 'host');
    await showUp(t, mid, 'guest');
    await host.call('pokejam_leave_match', [mid]);
    expect(await prof(t, host.id)).toMatchObject({ losses: 1, leaves_24h: 1 });
    expect(await prof(t, guest.id)).toMatchObject({ losses: 0 });
  });

  it('an idle dodger who never leaves is charged by the sweep after 90 s, not the stayer', async () => {
    const t = await testDb();
    const { mid, host, guest } = await rankedPair(t);
    await showUp(t, mid, 'host');
    await age(t, mid, 100);
    expect(await cleanup(t)).toBe(1);
    expect(await status(t, mid)).toBe('void');
    expect(await prof(t, guest.id)).toMatchObject({ losses: 1, leaves_24h: 1 });
    expect(await prof(t, host.id)).toMatchObject({ losses: 0, leaves_24h: 0 });
  });

  it('a leave after a game heartbeat is still a forfeit', async () => {
    const t = await testDb();
    const { mid, host, guest } = await rankedPair(t);
    await host.call('pokejam_match_alive', [mid]);
    await age(t, mid, 60);
    await guest.call('pokejam_leave_match', [mid]);
    expect(await status(t, mid)).toBe('done');
    expect(await prof(t, guest.id)).toMatchObject({ losses: 1 });
    expect(await prof(t, host.id)).toMatchObject({ wins: 1 });
  });
});
