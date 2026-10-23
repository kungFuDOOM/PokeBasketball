import { describe, expect, it } from 'vitest';
import { POKEMON, monByDex, type Mon } from '../data/pokemon';
import {
  LEAGUE, createFranchise, finishRookieDraft, monOf, potentialOf, rookieOnClock, rookiePick, startRookieDraft, tradeValue, type Franchise,
} from './league';

function league(): Franchise {
  const pool = [...POKEMON].sort((a, b) => b.ovr - a.ovr);
  const teams = [{ name: 'Me', abbr: 'ME', color: '#3b6fd8', color2: '#16224a', human: true }, ...LEAGUE.map((t) => ({
    name: t.name, abbr: t.abbr, color: t.color, color2: t.color2, human: false, leader: t.leader, types: t.types, boost: t.boost,
  }))];
  const rosters: Mon[][] = teams.map(() => []);
  let i = 0;
  for (let r = 0; r < 10; r++) for (let j = 0; j < teams.length; j++) rosters[r % 2 ? teams.length - 1 - j : j].push(pool[i++]);
  return createFranchise(teams, rosters, pool.slice(i));
}

const dexOf = (f: Franchise, uids: string[]) => uids.map((u) => f.players[u].dex);

/** Ends the season, drafts the whole class, and returns it. */
function runSeason(f: Franchise): { dexes: number[]; rostered: Set<number> } {
  f.phase = 'done';
  f.champion = 0;
  startRookieDraft(f);
  const dexes = dexOf(f, f.rookies!.pool);
  const rostered = new Set(f.teams.flatMap((t) => dexOf(f, t.roster)));
  while (rookieOnClock(f)) rookiePick(f);
  const me = f.teams[0];
  finishRookieDraft(f, me.roster.reduce((a, b) => (tradeValue(f, b) < tradeValue(f, a) ? b : a)));
  return { dexes, rostered };
}

const seasons = (f: Franchise, n: number) => Array.from({ length: n }, () => runSeason(f));

describe('rookie class variety', () => {
  it('brings a different set of prospects across ten seasons', () => {
    const classes = seasons(league(), 10).map((c) => c.dexes);
    const unique = new Set(classes.flat());
    // Before this change ten classes held about 36 distinct Pokémon; the free pool only has ~110 prospects.
    expect(unique.size).toBeGreaterThanOrEqual(90);
  });

  it('never repeats a Pokémon within a class, and never drafts one already on a roster', () => {
    for (const c of seasons(league(), 10)) {
      expect(new Set(c.dexes).size).toBe(c.dexes.length);
      expect(c.dexes.length).toBe(24);
      for (const d of c.dexes) expect(c.rostered.has(d)).toBe(false);
    }
  });

  it('keeps the last few classes out of the next one', () => {
    const classes = seasons(league(), 6).map((c) => c.dexes);
    for (let i = 1; i < classes.length; i++) {
      for (let back = 1; back <= Math.min(3, i); back++) {
        const earlier = new Set(classes[i - back]);
        expect(classes[i].filter((d) => earlier.has(d))).toEqual([]);
      }
    }
  });

  it('is deterministic for the same save and season', () => {
    const a = league();
    const b = league();
    a.seed = b.seed = 12345;
    const ca = seasons(a, 3).map((c) => c.dexes);
    const cb = seasons(b, 3).map((c) => c.dexes);
    expect(ca).toEqual(cb);
    // Starting the draft again on the same save returns the same class (it is kept in the save).
    const c = league();
    c.seed = 999;
    c.phase = 'done';
    startRookieDraft(c);
    const first = dexOf(c, c.rookies!.pool);
    delete c.rookies;
    c.classes = [];
    startRookieDraft(c);
    expect(dexOf(c, c.rookies!.pool)).toEqual(first);
    // A different save seed gives a different class.
    const d = league();
    d.seed = 1000;
    d.phase = 'done';
    startRookieDraft(d);
    expect(dexOf(d, d.rookies!.pool)).not.toEqual(first);
  });

  it('mixes types and positions in every class', () => {
    for (const c of seasons(league(), 6)) {
      const mons = c.dexes.map(monByDex);
      const types = new Set(mons.flatMap((m) => m.types));
      const pos = new Set(mons.map((m) => m.pos));
      expect(types.size).toBeGreaterThanOrEqual(10);
      expect(pos.size).toBeGreaterThanOrEqual(4);
      for (const p of pos) expect(mons.filter((m) => m.pos === p).length).toBeLessThanOrEqual(10);
      const primary: Record<string, number> = {};
      for (const m of mons) primary[m.types[0]] = (primary[m.types[0]] ?? 0) + 1;
      expect(Math.max(...Object.values(primary))).toBeLessThanOrEqual(6);
    }
  });

  it('spreads talent without lifting the top end', () => {
    const f = league();
    const pots: number[] = [];
    const ovrs: number[] = [];
    for (let s = 0; s < 6; s++) {
      f.phase = 'done';
      startRookieDraft(f);
      for (const u of f.rookies!.pool) {
        const m = monOf(f, u);
        const pot = potentialOf(m.dex, f.players[u].bonus);
        pots.push(pot.ovr);
        ovrs.push(m.ovr);
        // Every prospect has a sprite in the repo and starts at level 1.
        expect(f.players[u].level).toBe(1);
      }
      while (rookieOnClock(f)) rookiePick(f);
      finishRookieDraft(f, f.teams[0].roster[0]);
    }
    const sd = (xs: number[]) => { const m = xs.reduce((a, b) => a + b) / xs.length; return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length); };
    expect(Math.max(...pots)).toBeLessThanOrEqual(91);
    expect(Math.min(...pots)).toBeGreaterThanOrEqual(55);
    expect(sd(pots)).toBeGreaterThan(4);
    expect(sd(ovrs)).toBeGreaterThan(5);
  });

  it('works on old saves with no seed or class history', () => {
    const f = league();
    delete f.seed;
    delete f.classes;
    f.phase = 'done';
    startRookieDraft(f);
    expect(f.rookies!.pool.length).toBe(24);
    expect(typeof f.seed).toBe('number');
    expect(f.classes).toHaveLength(1);
    const again = JSON.parse(JSON.stringify(f)) as Franchise;
    delete again.rookies;
    again.classes = [];
    delete again.seed;
    again.phase = 'done';
    // Re-derived seed from the same save gives the same class.
    const seeded = f.seed;
    startRookieDraft(again);
    expect(again.seed).toBe(seeded);
  });

  it('falls back to older classes instead of failing when the pool runs short', () => {
    const f = league();
    // Pretend a long history that already used almost every free prospect.
    f.phase = 'done';
    const free = f.freeAgents.map((u) => f.players[u].dex);
    f.classes = [{ season: 0, dexes: free.slice(0, 40) }, { season: -1, dexes: free.slice(40) }];
    startRookieDraft(f);
    const dexes = dexOf(f, f.rookies!.pool);
    expect(dexes.length).toBe(24);
    expect(new Set(dexes).size).toBe(24);
  });
});
