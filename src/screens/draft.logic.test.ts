// Characterization tests: pin the draft logic so the visual rework can't change it.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { POKEMON, POSITIONS, type Mon } from '../data/pokemon';
import { bestLineup, teamOvr } from '../game/game';
import { countAt, CPU_REACH, cpuPick, posTrackHtml, STAR_BONUS, STAR_BY_PICK, targetPer } from './draft';
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
  it('never reaches more than CPU_REACH below the best available, whatever the noise', () => {
    for (const r of [0, 0.5, 0.999999]) {
      const rest = [...pool].reverse();
      const roster = POKEMON.filter((m) => m.pos === 'C').slice(0, 2);
      const m = cpuPick(rest, roster, ['Fire', 'Water', 'Grass'], () => r);
      expect(m.ovr).toBeGreaterThanOrEqual(pool[0].ovr - CPU_REACH);
    }
    seeded(7);
    for (let i = 0; i < 300; i++) {
      const left = [...pool];
      const m = cpuPick(left, [], ['Fire']);
      expect(m.ovr).toBeGreaterThanOrEqual(left[0].ovr - CPU_REACH);
    }
  });
  it('is less predictable: different players come off the top from draft to draft', () => {
    seeded(11);
    const firsts = new Set(Array.from({ length: 60 }, () => cpuPick(pool, [], []).dex));
    expect(firsts.size).toBeGreaterThanOrEqual(5);
  });
  it('still fills positions: a 10-round draft covers (almost) every slot, a 5-round draft most of them', () => {
    seeded(5);
    let missing = 0;
    let slots = 0;
    let covered = 0;
    let teams5 = 0;
    for (let run = 0; run < 20; run++) {
      for (const r of simDraft([0, 1, 2, 3, 4, 5], 10, []).rosters) for (const p of POSITIONS) { slots++; if (!countAt(r, p)) missing++; }
      for (const r of simDraft([0, 1], 5, []).rosters) { teams5++; covered += POSITIONS.filter((p) => countAt(r, p)).length; }
    }
    expect(missing / slots).toBeLessThan(0.01);
    // Averages ~3.9 of 5 across seeds; a 5-round draft can't always cover every slot.
    expect(covered / teams5).toBeGreaterThanOrEqual(3.75);
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

describe('themed CPU teams', () => {
  const themes = [['Fire'], ['Water', 'Ice'], ['Grass'], ['Electric'], ['Psychic'], ['Dragon']];
  const isOn = (m: Mon, ty: string[]) => m.types.some((t) => ty.includes(t));
  it('never passes the top players for its type star: every pick stays within CPU_REACH of the best left', () => {
    seeded(21);
    for (let run = 0; run < 40; run++) {
      const left = [...pool];
      const rosters: Mon[][] = themes.map(() => []);
      for (const t of snakePicks([0, 1, 2, 3, 4, 5], 10)) {
        const m = cpuPick(left, rosters[t], themes[t] as never);
        expect(m.ovr).toBeGreaterThanOrEqual(left[0].ovr - CPU_REACH);
        left.splice(left.indexOf(m), 1);
        rosters[t].push(m);
      }
    }
    // The live bug: an off-type 97 on the board and only weak on-type Pokémon. The team must not take an 80.
    for (const r of [0, 0.5, 0.999999]) {
      const top = { ...pool[0], ovr: 97, types: ['Psychic'], pos: 'SF' } as Mon;
      const weak = { ...pool[1], ovr: 80, types: ['Grass'], pos: 'SF' } as Mon;
      expect(cpuPick([top, weak], [], ['Grass'], () => r)).toBe(top);
      expect(cpuPick([top, weak], [pool[2], pool[3]].map((m) => ({ ...m, types: ['Normal'] }) as Mon), ['Grass'], () => r)).toBe(top);
    }
  });
  it(`favors an on-type star by +${STAR_BONUS} while it has none`, () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const a = { ...pool[0], ovr: 90, types: ['Fire'], pos: 'PG' } as Mon;
    const b = { ...pool[1], ovr: 90 + STAR_BONUS - 1, types: ['Grass'], pos: 'PG' } as Mon;
    expect(cpuPick([a, b], [], ['Fire'])).toBe(a);
    expect(cpuPick([a, b], [], [])).toBe(b);
    expect(cpuPick([a, b], [{ ...a, pos: 'C' }], ['Fire'])).toBe(b);
  });
  it(`every themed team has an on-type player by pick ${STAR_BY_PICK}; later picks are not type-biased`, () => {
    seeded(7);
    let on3 = 0;
    let teams = 0;
    let laterOn = 0;
    let later = 0;
    let base = 0;
    for (let run = 0; run < 40; run++) {
      const { rosters } = simDraft([0, 1, 2, 3, 4, 5], 10, themes);
      rosters.forEach((r, i) => {
        teams++;
        const first = r.findIndex((m) => isOn(m, themes[i]));
        if (first >= 0 && first < STAR_BY_PICK) on3++;
        for (const m of r.slice(first + 1)) { later++; if (isOn(m, themes[i])) laterOn++; }
        base += pool.filter((m) => isOn(m, themes[i])).length / pool.length;
      });
    }
    expect(on3).toBe(teams);
    // After the star, the on-type share stays near the pool's base rate.
    expect(Math.abs(laterOn / later - base / teams)).toBeLessThan(0.08);
  });
  it(`takes the best on-type Pokémon in reach at pick ${STAR_BY_PICK} if it still has none`, () => {
    const roster = [pool[0], pool[1]].map((m) => ({ ...m, types: ['Normal'] }) as Mon);
    const offs = [0, 1, 2].map((i) => ({ ...pool[i + 2], ovr: 90 - i, types: ['Water'], pos: 'C' }) as Mon);
    const on = { ...pool[5], ovr: 85, types: ['Fire'], pos: 'PG' } as Mon;
    for (const r of [0, 0.999999]) expect(cpuPick([...offs, on], roster, ['Fire'], () => r)).toBe(on);
  });
  it('falls back to the best fit when no on-type Pokémon are left', () => {
    seeded(3);
    const noFire = pool.filter((m) => !m.types.includes('Fire'));
    const m = cpuPick(noFire, [], ['Fire']);
    expect(noFire).toContain(m);
  });
});

