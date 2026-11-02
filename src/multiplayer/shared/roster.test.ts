import { describe, expect, it } from 'vitest';
import { Game } from '../../game/game';
import { stateHash } from '../../game/sync';
import { buildConfig, setupFor } from './netplay';
import type { OnlineMatch } from './onlineMatchService';
import { RANKED_EXCLUDED, RANKED_MAX_GAP, RANKED_MAX_SPREAD, RANKED_POOL, flowRosters, rostersFor, teamOvr, teamSpread } from './roster';
import { POSITIONS, monByDex, type Mon } from '../../data/pokemon';
import { gameConfigFor } from './winnerCheck';
import { RANKED_PRESETS } from '../ranked/presets';

const SEEDS = Array.from({ length: 3000 }, (_, i) => (i * 2654435761) >>> 0);

describe('Ranked: two evenly matched teams (#29)', () => {
  it('across 3,000 seeds the teams are always within the margin, one per position', () => {
    let worst = 0;
    for (const seed of SEEDS) {
      const [a, b] = rostersFor(seed, 'ranked');
      for (const t of [a, b]) expect(t.map((m) => m.pos)).toEqual([...POSITIONS]);
      worst = Math.max(worst, Math.abs(teamOvr(a) - teamOvr(b)));
    }
    expect(worst).toBeLessThanOrEqual(RANKED_MAX_GAP);
  });

  it('no team is top-heavy: on every team the best and worst starters are within the spread cap', () => {
    // The example from #29: an 87 C next to a 44 PG is a 43-point spread, well past the cap.
    expect(teamSpread([44, 60, 62, 70, 87].map((ovr) => ({ ...monByDex(25), ovr })))).toBe(43);
    expect(RANKED_MAX_SPREAD).toBeLessThan(43);
    let worst = 0;
    for (const seed of SEEDS) for (const t of rostersFor(seed, 'ranked')) worst = Math.max(worst, teamSpread(t));
    expect(worst).toBeLessThanOrEqual(RANKED_MAX_SPREAD);
  });

  it('the cap still leaves plenty of variety: dozens of different Pokémon at every position', () => {
    const seen = new Map(POSITIONS.map((p) => [p, new Set<number>()]));
    for (const seed of SEEDS) for (const t of rostersFor(seed, 'ranked')) for (const m of t) seen.get(m.pos)!.add(m.dex);
    for (const pos of POSITIONS) expect(seen.get(pos)!.size, pos).toBeGreaterThanOrEqual(20);
  });

  it('Mewtwo and the other excluded legendaries never appear', () => {
    expect(RANKED_EXCLUDED).toContain(150);
    expect(RANKED_POOL.some((m) => RANKED_EXCLUDED.includes(m.dex))).toBe(false);
    for (const seed of SEEDS) for (const t of rostersFor(seed, 'ranked')) for (const m of t) expect(RANKED_EXCLUDED, `seed ${seed}`).not.toContain(m.dex);
    // Every position still has plenty to draw from.
    for (const pos of POSITIONS) expect(RANKED_POOL.filter((m) => m.pos === pos).length).toBeGreaterThan(30);
  });

  it('the same seed always gives the same teams, and the stronger team lands on either side about half the time', () => {
    let homeStronger = 0;
    let even = 0;
    for (const seed of SEEDS) {
      const x = rostersFor(seed, 'ranked').map((t) => t.map((m) => m.dex));
      expect(rostersFor(seed, 'ranked').map((t) => t.map((m) => m.dex))).toEqual(x);
      const [a, b] = rostersFor(seed, 'ranked').map(teamOvr);
      if (a > b) homeStronger++;
      else if (a === b) even++;
    }
    const uneven = SEEDS.length - even;
    expect(homeStronger / uneven).toBeGreaterThan(0.4);
    expect(homeStronger / uneven).toBeLessThan(0.6);
  });

  it('host, guest and the winner check build the identical Ranked game from the server preset rosters', () => {
    const rosters: [number[], number[]] = [RANKED_PRESETS[1].dex, RANKED_PRESETS[4].dex];
    const match = (side: 0 | 1): OnlineMatch => ({
      id: 'r1', queue: 'ranked', side,
      me: { id: side ? 'g' : 'h', name: side ? 'Misty' : 'Ash' }, opponent: { id: side ? 'h' : 'g', name: side ? 'Ash' : 'Misty', mmr: 1000, simulated: false },
      game: { seed: 987654321, quarterLen: 120, rosters }, keys: [null, null],
    });
    const setup = setupFor(match(0));
    expect(setupFor(match(1))).toEqual(setup);
    expect([setup.home.roster, setup.away.roster]).toEqual(rosters);
    const games = [new Game(buildConfig(match(0))), new Game(buildConfig(match(1))), new Game(gameConfigFor(setup))];
    for (let t = 0; t < 600; t++) for (const g of games) g.update(1 / 60);
    expect(new Set(games.map(stateHash)).size).toBe(1);
  });

  it('a Ranked match without preset rosters throws instead of playing seed teams', () => {
    const match: OnlineMatch = {
      id: 'r2', queue: 'ranked', side: 0, me: { id: 'h', name: 'Ash' }, opponent: { id: 'g', name: 'Misty', mmr: 1000, simulated: false },
      game: { seed: 5, quarterLen: 120, rosters: null }, keys: [null, null],
    };
    expect(() => setupFor(match)).toThrow('ranked match has no preset rosters');
    expect(() => buildConfig(match)).toThrow('ranked match has no preset rosters');
  });

  it('match flow: Ranked online plays the match rosters (mine first), throws without them; CPU practice stays random', () => {
    const opp = { simulated: false };
    const dex = (r: [Mon[], Mon[]]) => r.map((t) => t.map((m) => m.dex));
    const rosters: [number[], number[]] = [RANKED_PRESETS[0].dex, RANKED_PRESETS[1].dex];
    expect(dex(flowRosters({ queue: 'ranked' }, { ...opp, rosters, mySide: 0 }))).toEqual(rosters);
    expect(dex(flowRosters({ queue: 'ranked' }, { ...opp, rosters, mySide: 1 }))).toEqual([rosters[1], rosters[0]]);
    expect(() => flowRosters({ queue: 'ranked' }, { ...opp, rosters: null })).toThrow('ranked match has no preset rosters');
    expect(dex(flowRosters({ queue: 'ranked', practice: true }, { simulated: true }, 77))).toEqual(dex(rostersFor(77, 'ranked')));
  });

  it('Social is unchanged: plain random teams from the whole pool (its draft comes separately)', () => {
    const seen = new Set<number>();
    for (const seed of SEEDS.slice(0, 2000)) for (const t of rostersFor(seed, 'social')) for (const m of t) seen.add(m.dex);
    expect([...seen].some((d) => RANKED_EXCLUDED.includes(d))).toBe(true);
  });
});
