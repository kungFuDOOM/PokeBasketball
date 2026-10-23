import { describe, expect, it } from 'vitest';
import { POKEMON, POSITIONS, type Mon } from '../data/pokemon';
import { LEAGUE } from '../franchise/league';
import { bestLineup } from '../game/game';
import { simulateSeason, type SimInput } from './sim';

const byOvr = [...POKEMON].sort((a, b) => b.ovr - a.ovr);
const league = (seed: number, stack?: number): SimInput => {
  const n = 1 + LEAGUE.length;
  const rosters: Mon[][] = Array.from({ length: n }, () => []);
  // Teams take turns down the pool; `stack` gets the ten best outright.
  const pool = [...byOvr.slice(0, n * 10)];
  if (stack !== undefined) rosters[stack] = pool.splice(0, 10);
  pool.forEach((m) => { const t = rosters.findIndex((r, i) => r.length < 10 && i !== stack); rosters[t].push(m); });
  return {
    seed,
    teams: rosters.map((roster, i) => ({
      name: i ? LEAGUE[i - 1].name : 'Pallet Town', abbr: i ? LEAGUE[i - 1].abbr : 'PAL',
      color: i ? LEAGUE[i - 1].color : '#3b6fd8', color2: '#16224a', boost: i ? LEAGUE[i - 1].boost : 0, roster,
    })),
  };
};

describe('All-Stars', () => {
  it('are exactly five, one per position, each at their listed or starting slot', () => {
    for (const seed of [1, 2, 3, 99]) {
      const inp = league(seed);
      const { allStars } = simulateSeason(inp);
      expect(allStars.map((a) => a.slot)).toEqual(POSITIONS);
      expect(new Set(allStars.map((a) => `${a.team}:${a.dex}`)).size).toBe(5);
      for (const a of allStars) {
        const roster = inp.teams[a.team].roster;
        const lu = bestLineup(roster);
        const started = lu.slots[lu.starters.findIndex((m) => m.dex === a.dex)];
        expect(a.pos === a.slot || started === a.slot).toBe(true);
        expect(a.teamName).toBe(inp.teams[a.team].name);
      }
    }
  });

  it('are deterministic for a seed', () => {
    expect(simulateSeason(league(42)).allStars).toEqual(simulateSeason(league(42)).allStars);
  });

  it('are drawn from the whole league, not just your team', () => {
    // Stack a CPU team with the ten best Pokémon: the All-Stars should not all be yours.
    const { allStars } = simulateSeason(league(5, 4));
    expect(allStars.some((a) => a.team !== 0)).toBe(true);
    expect(allStars.some((a) => a.team === 4)).toBe(true);
    const teamsSeen = new Set<number>();
    for (const seed of [1, 2, 3, 4, 5, 6]) simulateSeason(league(seed)).allStars.forEach((a) => teamsSeen.add(a.team));
    expect(teamsSeen.size).toBeGreaterThan(1);
  });

  it('do not change any game result (stats are bookkeeping only)', () => {
    const r = simulateSeason(league(11));
    expect(r.weeks.length).toBe(18);
    expect(r.standings.reduce((s, t) => s + t.w, 0)).toBe(r.standings.reduce((s, t) => s + t.l, 0));
  });
});
