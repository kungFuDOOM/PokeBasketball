// Anti-cheat PR 2: a coin flip picks the host of a queue match, so a modified client can't choose to host by queueing first.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { pickBoth, quickPair, testDb, type Db, type User } from './testDb';

type Row = Record<string, unknown>;
const match = async (t: Db, mid: string) => (await t.sql('select * from public.pokejam_matches where id = $1', [mid]))[0];

async function setScore(t: Db, u: User, score: number) {
  const s = (await t.sql('select * from public.pokejam_ranked_season()'))[0];
  await t.sql('select public.pokejam_ranked_profile_lock($1, $2)', [u.id, s.id]);
  await t.sql(`update public.pokejam_ranked_profiles set status = 'ranked', placements_played = 5, div_idx = $3, points = $4, peak_idx = $3
      where user_id = $1 and season_id = $2`, [u.id, s.id, Math.floor(score / 100), score % 100]);
}

/** `a` queues first and `b` completes the pairing. */
async function rankedPair(a: User, b: User) {
  expect(await a.call('pokejam_find_match', ['ranked'])).toBeNull();
  const mid = await b.call<string | null>('pokejam_find_match', ['ranked']);
  expect(mid).toBeTruthy();
  return mid!;
}

/** For `n` fresh pairs, whether the player who queued first ended up hosting. */
async function firstQueuerHosts(t: Db, n: number, pair: (a: User, b: User) => Promise<string>) {
  const out: boolean[] = [];
  for (let i = 0; i < n; i++) {
    const [a, b] = [await t.user('A'), await t.user('B')];
    const m = await match(t, await pair(a, b));
    expect([a.id, b.id]).toContain(m.host);
    expect(m.guest).toBe(m.host === a.id ? b.id : a.id);
    out.push(m.host === a.id);
  }
  return out;
}
const count = (flags: boolean[]) => flags.filter(Boolean).length;

describe('the host of a queue match is a coin flip', () => {
  it('Ranked: over 60 pairs, either side hosts (fails below 12 or above 48: about 1 run in a million)', async () => {
    const t = await testDb();
    const hosts = count(await firstQueuerHosts(t, 60, rankedPair));
    expect(hosts).toBeGreaterThanOrEqual(12);
    expect(hosts).toBeLessThanOrEqual(48);
  }, 120_000);

  it('Social: over 30 pairs, either side hosts (fails below 3 or above 27: about 1 run in a million)', async () => {
    const t = await testDb();
    const hosts = count(await firstQueuerHosts(t, 30, (a, b) => quickPair(t, a, b)));
    expect(hosts).toBeGreaterThanOrEqual(3);
    expect(hosts).toBeLessThanOrEqual(27);
  }, 120_000);

  it('comes from random(): a fixed seed gives both outcomes and repeats the same sequence', async () => {
    const run = async () => {
      const t = await testDb();
      await t.sql('select setseed(0.42)');
      return firstQueuerHosts(t, 16, rankedPair);
    };
    const first = await run();
    expect(count(first)).toBeGreaterThan(0);
    expect(count(first)).toBeLessThan(16);
    expect(await run()).toEqual(first);
  }, 120_000);

  it('a private room is not part of it: whoever made the room hosts', async () => {
    const t = await testDb();
    for (let i = 0; i < 6; i++) {
      const [a, b] = [await t.user('A'), await t.user('B')];
      const rid = await b.call<string>('pokejam_join_room', [await a.call<string>('pokejam_create_room', [60])]);
      expect(await match(t, rid)).toMatchObject({ host: a.id, guest: b.id });
    }
  }, 60_000);
});

describe('the rest of the row follows the flip', () => {
  it('Ranked: host_mmr and guest_mmr are the host\'s and the guest\'s own queue scores, in both orientations', async () => {
    const t = await testDb();
    await t.sql('select setseed(0.1)');
    const seen = new Set<boolean>();
    for (let i = 0; i < 16; i++) {
      const [a, b] = [await t.user('A'), await t.user('B')];
      await setScore(t, a, 300);
      await setScore(t, b, 320);
      const m = await match(t, await rankedPair(a, b));
      seen.add(m.host === a.id);
      expect([m.host_mmr, m.guest_mmr]).toEqual(m.host === a.id ? [300, 320] : [320, 300]);
    }
    expect(seen.size).toBe(2);
  }, 120_000);

  it('Social: host_mmr and guest_mmr are the host\'s and the guest\'s own, in both orientations', async () => {
    const t = await testDb();
    await t.sql('select setseed(0.1)');
    const seen = new Set<boolean>();
    for (let i = 0; i < 16; i++) {
      const [a, b] = [await t.user('A'), await t.user('B')];
      await t.sql('update public.pokejam_profiles set mmr = 1000 where id = $1', [a.id]);
      await t.sql('update public.pokejam_profiles set mmr = 1040 where id = $1', [b.id]);
      const m = await match(t, await quickPair(t, a, b));
      seen.add(m.host === a.id);
      expect([m.host_mmr, m.guest_mmr]).toEqual(m.host === a.id ? [1000, 1040] : [1040, 1000]);
    }
    expect(seen.size).toBe(2);
  }, 120_000);

  it('both players find the pairing and leave the queue, whoever hosts', async () => {
    const t = await testDb();
    for (let i = 0; i < 8; i++) {
      const [a, b] = [await t.user('A'), await t.user('B')];
      const mid = await rankedPair(a, b);
      expect(await a.call('pokejam_find_match', ['ranked'])).toBe(mid); // the one who queued first polls and gets the news
      expect((await t.sql('select count(*)::int as n from public.pokejam_queue where user_id in ($1, $2)', [a.id, b.id]))[0].n).toBe(0);
    }
  }, 60_000);

  it('a Ranked preset pick stays with the player who made it, whoever hosts', async () => {
    const t = await testDb();
    const presets = await t.sql('select id, dex from public.pokejam_ranked_presets');
    const dex = (id: string) => presets.find((p) => p.id === id)!.dex;
    for (let i = 0; i < 8; i++) {
      const [a, b] = [await t.user('A'), await t.user('B')];
      const mid = await rankedPair(a, b);
      await a.call('pokejam_ranked_pick', [mid, 'C']);
      await b.call('pokejam_ranked_pick', [mid, 'D']);
      const info = await a.call<Row>('pokejam_match_info', [mid]);
      expect(info.host_roster).toEqual(info.host === a.id ? dex('C') : dex('D'));
      expect(info.guest_roster).toEqual(info.host === a.id ? dex('D') : dex('C'));
    }
  }, 60_000);
});

describe('privileges and re-running', () => {
  it('keeps the grants: players may call pokejam_find_match, never pokejam_ranked_find', async () => {
    const t = await testDb();
    const can = async (role: string, fn: string) =>
      (await t.sql('select has_function_privilege($1, $2, \'execute\') as ok', [role, fn]))[0].ok;
    expect(await can('authenticated', 'public.pokejam_find_match(text)')).toBe(true);
    expect(await can('anon', 'public.pokejam_find_match(text)')).toBe(false);
    expect(await can('authenticated', 'public.pokejam_ranked_find(uuid)')).toBe(false);
    expect(await can('anon', 'public.pokejam_ranked_find(uuid)')).toBe(false);
  });

  it('the migration can run twice', async () => {
    const t = await testDb();
    await t.db.exec(readFileSync(new URL('../migrations/20261127_pokejam_random_host.sql', import.meta.url), 'utf8'));
    const [a, b] = [await t.user('A'), await t.user('B')];
    expect(await rankedPair(a, b)).toBeTruthy();
  });
});

describe('testDb runs the presets migration', () => {
  it('a Ranked match needs both picks before a report, and pickBoth gives them', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A'), await t.user('B')];
    const mid = await rankedPair(a, b);
    await expect(a.call('pokejam_report_result', [mid, true])).rejects.toThrow(/no preset picks/);
    await expect(a.call('pokejam_ranked_report_score', [mid, 50, 40])).rejects.toThrow(/no preset picks/);
    await pickBoth(t, mid);
    expect(await a.call('pokejam_report_result', [mid, true])).toMatchObject({ status: 'pending' });
  });
});
