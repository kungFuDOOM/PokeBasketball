import { describe, expect, it, vi } from 'vitest';

// The Ranked paths in the match service are compiled out unless the Ranked flag is on (set before the imports run).
vi.hoisted(() => vi.stubEnv('VITE_MODE_RANKED', 'true'));

import { ENGINE_VERSION } from '../../game/types';
import { RankedCooldownError, SupabaseMatchService, type OnlineOpponent, type RpcClient } from '../shared/onlineMatchService';
import { cooldownSeconds, outcomeBetween, parsePickState, parsePresetIds, parseProfile, parseRankResult, serverView } from './serverRank';

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

describe('Ranked preset picks', () => {
  it('reads the pick state and fails soft on junk', () => {
    expect(parsePickState({ mine: 'C', deadline_s: '12', done: true })).toEqual({ mine: 'C', deadline_s: 12, done: true });
    expect(parsePickState({ mine: 'Z', deadline_s: -3, done: 'yes' })).toEqual({ mine: null, deadline_s: 0, done: false });
    for (const junk of [null, undefined, 7, 'x', [], { deadline_s: NaN }]) expect(parsePickState(junk)).toEqual({ mine: null, deadline_s: 0, done: false });
  });

  it('keeps only preset ids the client knows, in client order', () => {
    expect(parsePresetIds([{ id: 'B' }, 'A', { id: 'Q' }, null, 'F'])).toEqual(['A', 'B', 'F']);
    expect(parsePresetIds({ id: 'A' })).toEqual([]);
    expect(parsePresetIds(null)).toEqual([]);
  });

  it('sends the preset id only, and reads my own pick back', async () => {
    const { db, calls } = fakeServer([], {
      pokejam_ranked_presets: [[{ id: 'A' }, { id: 'B' }, { id: 'C' }, { id: 'D' }, { id: 'E' }, { id: 'F' }]],
      pokejam_ranked_pick_state: [{ mine: 'D', deadline_s: 9, done: false }],
    });
    const svc = new SupabaseMatchService(db, 'me', ['ranked']);
    expect(await svc.rankedPresets()).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    await svc.rankedPick('m1', 'D');
    expect(await svc.rankedPickState('m1')).toEqual({ mine: 'D', deadline_s: 9, done: false });
    expect(calls).toEqual([
      { fn: 'pokejam_ranked_presets', args: undefined },
      { fn: 'pokejam_ranked_pick', args: { p_match: 'm1', p_preset: 'D' } },
      { fn: 'pokejam_ranked_pick_state', args: { p_match: 'm1' } },
    ]);
  });
});
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

describe('Season 1 server answers', () => {
  it('reads the new rank shape, withheld numbers included, and ignores anything else', () => {
    expect(parseRankResult({ placing: false, event: 'promoted', placements_played: 5, before: 395, after: 410, delta: 15, div_idx: 4, points: 10 }))
      .toEqual({ placing: false, event: 'promoted', placementsPlayed: 5, before: 395, after: 410, delta: 15, divIdx: 4, points: 10 });
    expect(parseRankResult({ placing: true, placements_played: 2, event: null })).toMatchObject({ placing: true, placementsPlayed: 2, before: null, delta: null });
    expect(parseRankResult({ placing: false, event: 'weird' })?.event).toBeNull();
    for (const old of [null, undefined, 'x', {}, { mmrDelta: 30 }]) expect(parseRankResult(old)).toBeNull();
  });

  it('tells a cooldown refusal from any other error', () => {
    expect(cooldownSeconds('ranked cooldown: 295 seconds left')).toBe(295);
    expect(cooldownSeconds('human check needed')).toBeNull();
  });
});

describe('SupabaseMatchService (Ranked, Season 1)', () => {
  const info = { id: 'm1', queue: 'ranked', host: 'h', guest: 'me', host_name: 'Ash', guest_name: 'Misty', seed: 7, quarter_len: 120 };

  it('reports the agreed score (host first) before the result, and uses the rank the server sends back', async () => {
    const { db, calls } = fakeServer([before], {
      pokejam_find_match: ['m1'], pokejam_match_info: [info],
      pokejam_report_result: [{ status: 'done', rank: { placing: false, event: 'demoted', before: 410, after: 395, delta: -15, div_idx: 3, points: 95 } }],
    });
    const svc = new SupabaseMatchService(db, 'me', ['ranked']);
    await svc.quickMatch('ranked');
    const out = await svc.reportResult('ranked', opp(1), result(false)); // I'm the guest and lost 40-50
    expect(out).toMatchObject({ queue: 'ranked', status: 'done', result: { event: 'demoted', delta: -15 } });
    const fns = calls.map((c) => c.fn);
    expect(fns.indexOf('pokejam_ranked_report_score')).toBeGreaterThan(-1);
    expect(fns.indexOf('pokejam_ranked_report_score')).toBeLessThan(fns.indexOf('pokejam_report_result'));
    expect(calls.find((c) => c.fn === 'pokejam_ranked_report_score')?.args).toEqual({ p_match: 'm1', p_host_score: 50, p_guest_score: 40 });
    expect(fns.filter((f) => f === 'pokejam_ensure_profile')).toHaveLength(1); // only the one read before the search
  });

  it('a refused or missing score report does not stop the result', async () => {
    const calls: string[] = [];
    const db: RpcClient = {
      rpc(fn) {
        calls.push(fn);
        if (fn === 'pokejam_ranked_report_score') return Promise.resolve({ data: null, error: { message: 'bad score' } });
        return Promise.resolve({ data: fn === 'pokejam_report_result' ? { status: 'void' } : null, error: null });
      },
    };
    const out = await new SupabaseMatchService(db, 'me', ['ranked']).reportResult('ranked', opp(0), result(true));
    expect(out).toEqual({ queue: 'ranked', status: 'void' });
    expect(calls).toContain('pokejam_report_result');
  });

  it('a Social result never sends a score', async () => {
    const { db, calls } = fakeServer([], { pokejam_report_result: [{ status: 'done' }] });
    await new SupabaseMatchService(db, 'me', ['social']).reportResult('social', opp(0), result(true));
    expect(calls.map((c) => c.fn)).toEqual(['pokejam_report_result']);
  });

  it('surfaces a cooldown as a typed error with the seconds left', async () => {
    const db: RpcClient = {
      rpc(fn) {
        return Promise.resolve(fn === 'pokejam_find_match' ? { data: null, error: { message: 'ranked cooldown: 120 seconds left' } } : { data: row(), error: null });
      },
    };
    const err = await new SupabaseMatchService(db, 'me', ['ranked']).quickMatch('ranked').catch((e) => e);
    expect(err).toBeInstanceOf(RankedCooldownError);
    expect(err.seconds).toBe(120);
    expect(err.message).toMatch(/2 min/);
  });

  it('the stayer claim settles through the server and keeps the heartbeat going', async () => {
    const { db, calls } = fakeServer([], { pokejam_ranked_forfeit: [{ status: 'active' }, { status: 'done', winner: 'me', rank: { placing: false, event: null, before: 100, after: 124, delta: 24 } }] });
    vi.useFakeTimers();
    try {
      const p = new SupabaseMatchService(db, 'me', ['ranked']).claimForfeit('m1', 60_000);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await p).toMatchObject({ status: 'done', result: { delta: 24 } });
      expect(calls.map((c) => c.fn)).toContain('pokejam_match_alive');
      expect(calls.filter((c) => c.fn === 'pokejam_ranked_forfeit')).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
