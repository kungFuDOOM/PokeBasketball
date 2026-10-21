// Characterization tests: pin the draft logic so the visual rework can't change it.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { POKEMON, POSITIONS, type Mon } from '../data/pokemon';
import { bestLineup, teamOvr } from '../game/game';
import { countAt, cpuPick, posTrackHtml, targetPer } from './draft';
import { snakePicks } from './draft.logic';

const pool = [...POKEMON].sort((a, b) => b.ovr - a.ovr);

/** Deterministic Math.random (mulberry32). */
function seeded(seed: number) {
  let a = seed;
  vi.spyOn(Math, 'random').mockImplementation(() => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  });
}
beforeAll(() => { vi.stubGlobal('window', {}); });
afterEach(() => vi.restoreAllMocks());

/** Runs a full snake draft of CPU picks, like "Sim rest" does. */
function simDraft(order: number[], size: number, types: (string[] | undefined)[]) {
  const left = [...pool];
  const rosters: Mon[][] = order.map(() => []);
  for (const t of snakePicks(order, size)) {
    const m = cpuPick(left, rosters[t], types[t] as never);
    left.splice(left.indexOf(m), 1);
    rosters[t].push(m);
  }
  return { rosters, left };
}

describe('snakePicks', () => {
  it('alternates direction each round', () => {
    expect(snakePicks([2, 0, 1], 4)).toEqual([2, 0, 1, 1, 0, 2, 2, 0, 1, 1, 0, 2]);
  });
  it('gives every team `size` picks, and does not mutate the order', () => {
    const order = [3, 1, 0, 2];
    const picks = snakePicks(order, 10);
    expect(picks).toHaveLength(40);
    for (const t of order) expect(picks.filter((p) => p === t)).toHaveLength(10);
    expect(order).toEqual([3, 1, 0, 2]);
  });
  it('two-team quick play (5 rounds)', () => {
    expect(snakePicks([1, 0], 5)).toEqual([1, 0, 0, 1, 1, 0, 0, 1, 1, 0]);
  });
});

describe('targetPer / countAt', () => {
  it('wants one per position for 5, two per position for more', () => {
    expect(targetPer(5)).toBe(1);
    expect(targetPer(6)).toBe(2);
    expect(targetPer(10)).toBe(2);
  });
  it('counts a position', () => {
    const r = pool.slice(0, 30);
    for (const p of POSITIONS) expect(countAt(r, p)).toBe(r.filter((m) => m.pos === p).length);
    expect(countAt([], 'PG')).toBe(0);
  });
});

describe('cpuPick', () => {
  it('takes the best fit with a pinned seed', () => {
    seeded(1);
    const picks: string[] = [];
    let roster: Mon[] = [];
    let left = [...pool];
    for (let i = 0; i < 6; i++) {
      const m = cpuPick(left, roster, i % 2 ? ['Fire', 'Water'] : []);
      picks.push(`${m.dex}`);
      roster = [...roster, m];
      left = left.filter((x) => x !== m);
    }
    expect(picks).toMatchSnapshot();
  });
  it('is the top overall when the pool is a single mon, and returns pool[0] for an empty-score tie', () => {
    seeded(2);
    expect(cpuPick([pool[5]], [])).toBe(pool[5]);
  });
  it('nudges toward an open position (+5) over a filled one (+0) at equal rating', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const a = { ...pool.find((m) => m.pos === 'PG')!, ovr: 80 } as Mon;
    const b = { ...pool.find((m) => m.pos === 'C')!, ovr: 80 } as Mon;
    expect(cpuPick([a, b], [{ ...a }, { ...a }])).toBe(b);
    expect(cpuPick([a, b], [{ ...b }, { ...b }])).toBe(a);
  });
  it('favors team types by +8', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const a = { ...pool[0], ovr: 70, types: ['Fire'], pos: 'PG' } as Mon;
    const b = { ...pool[1], ovr: 76, types: ['Grass'], pos: 'PG' } as Mon;
    expect(cpuPick([a, b], [], ['Fire'])).toBe(a);
    expect(cpuPick([a, b], [], [])).toBe(b);
  });
  it('full 4-team 10-round CPU draft is stable for a seed', () => {
    seeded(99);
    const { rosters, left } = simDraft([2, 0, 3, 1], 10, [['Fire'], undefined, ['Water', 'Ice'], []]);
    expect(rosters.map((r) => r.map((m) => m.dex))).toMatchSnapshot();
    expect(left).toHaveLength(pool.length - 40);
    expect(rosters.map((r) => teamOvr(bestLineup(r).starters))).toMatchSnapshot();
  });
});

describe('ratings math', () => {
  it('starters overall of a top-ten roster is pinned', () => {
    const r = pool.slice(0, 10);
    expect(bestLineup(r).starters.map((m) => m.dex)).toMatchSnapshot();
    expect(teamOvr(bestLineup(r).starters)).toMatchSnapshot();
    expect(teamOvr([])).toBe(0);
  });
});

describe('posTrackHtml (need/thin/ok classes)', () => {
  it('flags need / thin / ok per position', () => {
    const pg = pool.filter((m) => m.pos === 'PG');
    const html10 = posTrackHtml([pg[0]], 10);
    expect(html10.match(/class="need"/g)).toHaveLength(4);
    expect(html10.match(/class="thin"/g)).toHaveLength(1);
    const html5 = posTrackHtml([pg[0]], 5);
    expect(html5.match(/class="ok"/g)).toHaveLength(1);
    expect(posTrackHtml([pg[0], pg[1]], 10).match(/class="ok"/g)).toHaveLength(1);
  });
});
