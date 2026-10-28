import { describe, expect, it, vi } from 'vitest';

// The Ranked paths in the match service are compiled out unless the Ranked flag is on (set before the imports run).
vi.hoisted(() => vi.stubEnv('VITE_MODE_RANKED', 'true'));

import { ENGINE_VERSION } from '../../game/types';
import { SupabaseMatchService, type OnlineOpponent, type RpcClient } from '../shared/onlineMatchService';
import { outcomeBetween, parseProfile, serverView } from './serverRank';

const row = (o: Record<string, unknown> = {}) => ({ mmr: 1000, placements: 0, ladder: 1000, shield: 0, tier: null, division: null, rp: 0, wins: 0, losses: 0, ...o });

describe('server rating mapping', () => {
  it('a missing or odd profile reads as a fresh player', () => {
    expect(parseProfile(null)).toEqual(row());
    expect(parseProfile({ mmr: 'x', tier: 5 })).toEqual(row());
  });

  it('shows the server tier, division and RP once placed; placement progress before', () => {
    expect(serverView(parseProfile(row({ placements: 3 }))).label).toBe('Unranked, placements 3/5');
    const v = serverView(parseProfile(row({ placements: 5, tier: 'Gold', division: 'II', rp: 40 })));
    expect(v).toMatchObject({ placed: true, tier: 'Gold', division: 'II', rp: 40, label: 'Gold II · 40 RP' });
    expect(serverView(parseProfile(row({ placements: 5, tier: 'Pokémon Master', rp: 12 }))).label).toBe('Pokémon Master · 12 RP');
  });

  it('diffs two server rows into a match outcome', () => {
    const placing = outcomeBetween(parseProfile(row({ placements: 4 })), parseProfile(row({ mmr: 1032, placements: 5, ladder: 1032, tier: 'Silver', division: 'III', rp: 32, wins: 1 })));
    expect(placing).toMatchObject({ mmrDelta: 32, event: 'placed' });
    const up = outcomeBetween(parseProfile(row({ placements: 5, tier: 'Silver', division: 'III', rp: 95, wins: 3 })), parseProfile(row({ mmr: 1024, placements: 5, tier: 'Silver', division: 'II', rp: 10, wins: 4 })));
    expect(up.event).toBe('promoted');
    const down = outcomeBetween(parseProfile(row({ placements: 5, tier: 'Silver', division: 'II', rp: 2 })), parseProfile(row({ mmr: 976, placements: 5, tier: 'Silver', division: 'III', rp: 80, losses: 1 })));
    expect(down).toMatchObject({ event: 'demoted', mmrDelta: -24 });
    const shield = outcomeBetween(parseProfile(row({ placements: 5, tier: 'Gold', division: 'III', rp: 0 })), parseProfile(row({ placements: 5, tier: 'Gold', division: 'III', rp: 0, shield: 1, losses: 1 })));
    expect(shield.event).toBe('shielded');
  });
});

/** A fake server for the Ranked path: profile rows come from `profiles` in order, one per ensure_profile call. */
function fakeServer(profiles: unknown[], answers: Record<string, unknown[]>) {
  const calls: { fn: string; args?: Record<string, unknown> }[] = [];
  const left = { ...answers, pokejam_ensure_profile: [...profiles] };
  const db: RpcClient = {
    rpc(fn, args) {
      calls.push({ fn, args });
      const q = left[fn as keyof typeof left] as unknown[] | undefined;
      return Promise.resolve({ data: q && q.length > 1 ? q.shift() : q?.[0] ?? null, error: null });
    },
  };
  return { db, calls };
}

const opp = (mySide: 0 | 1): OnlineOpponent => ({ id: 'them', name: 'Rival', mmr: 1000, simulated: false, matchId: 'm1', mySide });
const result = (won: boolean) => ({ won, score: (won ? [50, 40] : [40, 50]) as [number, number], engineVersion: ENGINE_VERSION });
const before = row({ placements: 4 });
const after = row({ mmr: 1030, placements: 5, ladder: 1030, tier: 'Silver', division: 'III', rp: 30, wins: 1 });

describe('SupabaseMatchService (Ranked)', () => {
  it('a Ranked service takes the rating from the server profile after the server rates the match', async () => {
    const { db, calls } = fakeServer([before, after], {
      pokejam_find_match: ['m1'],
      pokejam_match_info: [{ id: 'm1', queue: 'ranked', host: 'h', guest: 'me', host_name: 'Ash', guest_name: 'Misty', seed: 7, quarter_len: 120 }],
      // The client claims a huge win; only the server's profile decides the rating.
      pokejam_report_result: [{ status: 'done', rank: { mmrDelta: 999 } }],
    });
    const svc = new SupabaseMatchService(db, 'me', ['ranked']);
    const match = await svc.quickMatch('ranked');
    expect(match.queue).toBe('ranked');
    const out = await svc.reportResult('ranked', opp(1), result(true));
    expect(out.status).toBe('done');
    expect(out.rank).toMatchObject({ mmrDelta: 30, event: 'placed' });
    expect(calls.find((c) => c.fn === 'pokejam_report_result')?.args).toEqual({ p_match: 'm1', p_host_won: false });
    // Rating reads are profile reads (no name sent), never a client-side write.
    expect(calls.filter((c) => c.fn === 'pokejam_ensure_profile').every((c) => c.args?.p_name === null)).toBe(true);
  });

  it('when the other player has not reported, it waits for the server and then reads the rating', async () => {
    const { db } = fakeServer([before, after], {
      pokejam_find_match: ['m1'],
      pokejam_match_info: [{ id: 'm1', queue: 'ranked', host: 'me', guest: 'g', host_name: 'Misty', guest_name: 'Ash', seed: 7, quarter_len: 120 }],
      pokejam_report_result: [{ status: 'pending' }],
      pokejam_match_status: [{ status: 'done' }],
    });
    const svc = new SupabaseMatchService(db, 'me', ['ranked']);
    await svc.quickMatch('ranked');
    const out = await svc.reportResult('ranked', opp(0), result(true));
    expect(out.status).toBe('pending');
    expect(out.rank).toBeUndefined();
    const final = await out.later!;
    expect(final.status).toBe('done');
    expect(final.rank).toMatchObject({ mmrDelta: 30 });
  });

  it('a void match shows no rating change', async () => {
    const { db } = fakeServer([before], { pokejam_find_match: ['m1'], pokejam_match_info: [{ id: 'm1', queue: 'ranked', host: 'me', guest: 'g', host_name: 'A', guest_name: 'B', seed: 7, quarter_len: 120 }], pokejam_report_result: [{ status: 'void' }] });
    const svc = new SupabaseMatchService(db, 'me', ['ranked']);
    await svc.quickMatch('ranked');
    expect(await svc.reportResult('ranked', opp(0), result(false))).toEqual({ queue: 'ranked', status: 'void' });
  });

  it('a Social-only service still refuses Ranked', async () => {
    await expect(new SupabaseMatchService(fakeServer([], {}).db, 'me', ['social']).quickMatch('ranked')).rejects.toThrow(/ranked/);
  });
});
