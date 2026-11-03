import { describe, expect, it } from 'vitest';
import { makeChallengeCache, type RaffleMe } from './client';

const me = (n: number): RaffleMe => ({ signed_in: true, week_start: '2026-11-02', resets_at: '2026-11-09T08:00:00Z', config: {}, counts: { offline: n, online: 0, online_wins: 0, social_matches: 0, shares: 0, rank_steps: 0, zenith: false }, score: { base: false, grind: 0, holder: 0, bonus: 0, total: 0, social_have: 0, rank_done: false, offline: { have: n, need: 3, done: false }, online: { have: 0, need: 3, done: false }, social: { have: 0, need: 1, done: false }, rank: { have: 0, need: 1, done: false } }, wallet: null, last_draw: null });

describe('challenge cache', () => {
  it('fetches once for a burst, then again after the fresh window', async () => {
    let now = 1_000;
    let calls = 0;
    const cache = makeChallengeCache(async () => me(++calls), () => now);
    const [a, b] = await Promise.all([cache.load(true), cache.load(true)]);
    expect(a.counts.offline).toBe(1);
    expect(b.counts.offline).toBe(1);
    expect(calls).toBe(1);
    now += 4_000;
    expect((await cache.load(true)).counts.offline).toBe(1);
    now += 2_000;
    expect((await cache.load(true)).counts.offline).toBe(2);
    expect((await cache.load(false)).counts.offline).toBe(2);
    cache.invalidate();
    expect((await cache.load(false)).counts.offline).toBe(3);
  });
});
