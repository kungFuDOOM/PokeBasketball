// The rules every region's nine CPU teams are drafted by: the strongest legal five, theme, legendaries, and the difficulty curve.
import { describe, expect, it } from 'vitest';
import { POKEMON, monByDex, type Mon } from '../data/pokemon';
import { chemistry } from '../game/game';
import { strengthOf } from '../screens/strength';
import { RANKED_LEGENDARIES, isLegendary } from '../multiplayer/shared/roster';
import { MIN_ON_TYPE, ON_TYPE_FLOOR, cpuDraftPool, cpuNext, isOnType, legendaryCap, lineupWithStar, livePick, regionRosters } from './kantoDraft';
import { HOENN, JOHTO, KANTO, MAX_BOOST, REGIONS, SINNOH, regionTeams, type RegionDef, type RegionTeam } from './regions';

/** Alakazam, Lucario, Charizard, Garchomp, Snorlax: 91. */
const TEAM = [65, 448, 6, 445, 143];

const HELD: [string, number[]][] = [
  ['the 91 test team held', TEAM],
  ['nothing held', []],
  ['an 86 team held', [26, 123, 94, 68, 464]],
  ['five legendaries held', [151, 386, 150, 384, 493]],
  ['the ten best held', [151, 386, 150, 384, 493, 249, 483, 250, 484, 487]],
];

/**
 * Teams whose type cannot supply `MIN_ON_TYPE` starters rated `ON_TYPE_FLOOR` or better at different positions, with the
 * fewest they start on type over `HELD`. Everyone else starts at least `MIN_ON_TYPE`.
 */
const THIN: Record<string, number> = {
  Brock: 1, Roxanne: 1, Roark: 1, Morty: 1, Bugsy: 1,
  Erika: 2, Giovanni: 2, Jasmine: 2, Pryce: 2, Wattson: 2, Gardenia: 2, Candice: 2, Volkner: 2, Fantina: 2,
};

interface Seat { t: RegionTeam; roster: Mon[]; five: Mon[] }
const seats = (r: RegionDef, held: readonly number[]): Seat[] => {
  const rosters = regionRosters(r, held);
  return regionTeams(r).map((t, i) => ({ t, roster: rosters[i], five: lineupWithStar(rosters[i], t.star).starters }));
};
const strengths = (r: RegionDef, held: readonly number[]) => seats(r, held).map((s) => strengthOf(s.five, s.t.boost).total);

describe('each region has its own legendaries', () => {
  it('as data: legendaries from its own generation, each in the game, none shared', () => {
    expect(KANTO.legendaries).toEqual([144, 145, 146, 150, 151]);
    expect(JOHTO.legendaries).toEqual([243, 244, 245, 249, 250, 251]);
    expect(HOENN.legendaries).toEqual([377, 378, 379, 380, 381, 382, 383, 384, 385, 386]);
    expect(SINNOH.legendaries).toEqual([480, 481, 482, 483, 484, 485, 486, 487, 488, 490, 491, 492, 493]);
    for (const r of REGIONS) {
      for (const d of r.legendaries) {
        expect(isLegendary(d), `${r.name} ${d}`).toBe(true);
        expect(d >= r.dex[0] && d <= r.dex[1], `${r.name} ${d}`).toBe(true);
        expect(POKEMON.some((m) => m.dex === d), `${r.name} ${d}`).toBe(true);
      }
      // Every legendary in the game from the region's range is in its set.
      expect(POKEMON.filter((m) => isLegendary(m.dex) && m.dex >= r.dex[0] && m.dex <= r.dex[1]).map((m) => m.dex), r.name).toEqual(r.legendaries);
    }
    // Between them the four sets are every legendary in the game.
    expect(REGIONS.flatMap((r) => r.legendaries)).toEqual(POKEMON.filter((m) => isLegendary(m.dex)).map((m) => m.dex));
    expect(RANKED_LEGENDARIES.every(isLegendary)).toBe(true);
  });

  it('as a pool: every non-legendary in the game, and only the native legendaries', () => {
    for (const r of REGIONS) {
      const pool = cpuDraftPool(r).map((m) => m.dex);
      expect(pool, r.name).toEqual(POKEMON.filter((m) => !isLegendary(m.dex) || r.legendaries.includes(m.dex)).map((m) => m.dex));
    }
  });

  it('as stars: a legendary star is native', () => {
    for (const r of REGIONS) {
      for (const t of regionTeams(r)) if (isLegendary(t.star!)) expect(r.legendaries, t.name).toContain(t.star);
    }
  });

  it.each(HELD)('no other legendary is on any CPU roster, starter or backup (%s)', (_, held) => {
    for (const r of REGIONS) {
      for (const { t, roster, five } of seats(r, held)) {
        for (const m of [...five, ...roster]) if (isLegendary(m.dex)) expect(r.legendaries, `${t.name}: ${m.name}`).toContain(m.dex);
      }
    }
  });
});

describe('the legendary cap', () => {
  it('is 1 for gyms 1-4, 2 for gyms 5-8 and 3 for the final opponent', () => {
    for (const r of REGIONS) expect(regionTeams(r).map(legendaryCap), r.name).toEqual([1, 1, 1, 1, 2, 2, 2, 2, 3]);
  });

  it.each(HELD)('holds over each whole roster, star included (%s)', (_, held) => {
    for (const r of REGIONS) {
      for (const { t, roster } of seats(r, held)) {
        expect(roster.filter((m) => isLegendary(m.dex)).length, t.name).toBeLessThanOrEqual(legendaryCap(t));
      }
    }
  });

  it.each(HELD)('no team holds a Pokémon twice or one of the user\'s, and no other team takes its star (%s)', (_, held) => {
    for (const r of REGIONS) {
      const stars = regionTeams(r).map((t) => t.star!);
      expect(new Set(stars).size, r.name).toBe(9);
      for (const { t, roster } of seats(r, held)) {
        expect(roster, t.name).toHaveLength(10);
        expect(new Set(roster.map((m) => m.dex)).size, t.name).toBe(10);
        // A gym keeps its star even when the user holds it.
        expect(roster[0].dex, t.name).toBe(t.star);
        for (const m of roster.slice(1)) {
          expect(held, `${t.name}: ${m.name}`).not.toContain(m.dex);
          expect(stars, `${t.name}: ${m.name}`).not.toContain(m.dex);
        }
      }
    }
  });

});

describe('one board per region', () => {
  it.each(HELD)('no Pokémon, legendaries included, is on two CPU teams of a region (%s)', (_, held) => {
    for (const r of REGIONS) {
      const all = seats(r, held).flatMap((s) => s.roster.map((m) => m.dex));
      expect(all, r.name).toHaveLength(90);
      expect(all.filter((d, i) => all.indexOf(d) !== i).map((d) => monByDex(d).name), r.name).toEqual([]);
    }
  });

  it('different regions may use the same Pokémon', () => {
    const names = (r: RegionDef) => seats(r, []).flatMap((s) => s.roster.map((m) => m.name));
    // Steelix is Jasmine's star in Johto and Byron's in Sinnoh.
    expect(names(JOHTO)).toContain('Steelix');
    expect(names(SINNOH)).toContain('Steelix');
  });
});

describe('later regions and earlier ones', () => {
  it.each(HELD)('later gyms roster earlier-region non-legendaries, and never another region\'s legendaries (%s)', (_, held) => {
    for (const r of REGIONS.slice(1)) {
      const pool = cpuDraftPool(r).map((m) => m.dex);
      const rosters = seats(r, held).flatMap((s) => s.roster);
      for (const earlier of REGIONS.slice(0, r.index)) {
        const from = (d: number) => d >= earlier.dex[0] && d <= earlier.dex[1];
        for (const m of POKEMON) if (from(m.dex)) expect(pool.includes(m.dex), `${r.name}: ${m.name}`).toBe(!isLegendary(m.dex));
        expect(rosters.some((m) => from(m.dex)), `${r.name} uses ${earlier.name}`).toBe(true);
      }
      for (const m of rosters) if (isLegendary(m.dex)) expect(r.legendaries, `${r.name}: ${m.name}`).toContain(m.dex);
    }
  });
});

describe('the strongest legal five', () => {
  const mon = monByDex;
  const themeOf = (five: readonly Mon[], t: RegionTeam) =>
    Math.min(MIN_ON_TYPE, five.filter((m) => isOnType(m, t) && (m.ovr >= ON_TYPE_FLOOR || m.dex === t.star)).length);
  const sum = (five: readonly Mon[]) => five.reduce((a, m) => a + m.ovr, 0);

  it.each(HELD)('has a natural player at every position, so every team gets the lineup bonus (%s)', (_, held) => {
    for (const r of REGIONS) for (const { t, five } of seats(r, held)) expect(chemistry(five), t.name).toBe(2);
  });

  it.each(HELD)('its off-type starters cannot be improved on by what was left at its turn (%s)', (_, held) => {
    for (const r of REGIONS) {
      const stars = regionTeams(r).map((t) => t.star!);
      const pool = cpuDraftPool(r).filter((m) => !held.includes(m.dex) && !stars.includes(m.dex));
      // The best few at each position of each kind is every swap that could matter.
      const top = new Map<string, Mon[]>();
      const all = seats(r, held);
      for (const [i, { t, five, roster }] of all.entries()) {
        // The final opponent picks first, then gym 8 down: the fives after it in the list are gone, and so are the theme
        // starters the others reserved before it filled out its five.
        const gone = new Set(all.flatMap((s, j) => (j === i ? [] : s.five.filter((m) => j > i || isOnType(m, s.t)).map((m) => m.dex))));
        top.clear();
        for (const m of pool.filter((x) => !gone.has(x.dex)).sort((a, b) => b.ovr - a.ovr)) {
          const key = `${m.pos}${isOnType(m, t)}${isLegendary(m.dex)}`;
          const list = top.get(key) ?? [];
          if (list.length < 2) top.set(key, [...list, m]);
        }
        const cands = [...top.values()].flat();
        // On-type starters may have been reserved before the others' off-type picks, so only the rest are swapped.
        const free = five.filter((m) => m.dex !== t.star && !isOnType(m, t));
        const legal = (six: readonly Mon[]) => new Set(six.map((m) => m.pos)).size === 5
          && six.filter((m) => isLegendary(m.dex)).length <= legendaryCap(t) && new Set(six.map((m) => m.dex)).size === 5;
        for (const a of free) {
          for (const b of free) {
            for (const x of cands) {
              for (const y of a === b ? [x] : cands) {
                const next = five.map((m) => (m === a ? x : m === b ? y : m));
                if (!legal(next) || themeOf(next, t) < themeOf(five, t)) continue;
                expect(sum(next), `${t.name}: ${next.map((m) => m.name)} beats ${roster.slice(0, 5).map((m) => m.name)}`).toBeLessThanOrEqual(sum(five));
              }
            }
          }
        }
      }
    }
  });

  it.each(HELD)('keeps at least three on type, star included, bar the thin types (%s)', (_, held) => {
    expect(MIN_ON_TYPE).toBe(3);
    for (const r of REGIONS) {
      for (const { t, five } of seats(r, held)) {
        expect(five.filter((m) => isOnType(m, t)).length, `${t.name}: ${five.map((m) => m.name)}`).toBeGreaterThanOrEqual(THIN[t.leader] ?? MIN_ON_TYPE);
        expect(five.map((m) => m.dex), t.name).toContain(t.star);
      }
    }
  });

  // Only eight non-legendary shooting guards reach `ON_TYPE_FLOOR`, one short of nine teams, so one may start an 80 or 81.
  it.each(HELD)('every starter but a star is 80 or better, nearly all 82 or better (%s)', (_, held) => {
    for (const r of REGIONS) {
      const low: string[] = [];
      for (const { t, five } of seats(r, held)) {
        for (const m of five) {
          if (m.dex === t.star) continue;
          expect(m.ovr, `${t.name}: ${m.name}`).toBeGreaterThanOrEqual(80);
          if (m.ovr < ON_TYPE_FLOOR) low.push(`${t.name}: ${m.name}`);
        }
      }
      expect(low.length, `${r.name}: ${low}`).toBeLessThanOrEqual(3);
    }
  });

  it('may use an off-type legendary of the region', () => {
    const off = REGIONS.flatMap((r) => seats(r, []).flatMap(({ t, five }) => five.filter((m) => isLegendary(m.dex) && m.dex !== t.star && !isOnType(m, t))));
    expect(off.length).toBeGreaterThan(0);
  });

  it('never goes past the legendary cap, and the user just takes the best', () => {
    for (const r of REGIONS) {
      for (const { t, roster } of seats(r, [])) expect(roster.filter((m) => isLegendary(m.dex)).length, t.name).toBeLessThanOrEqual(legendaryCap(t));
    }
    expect(cpuNext([mon(150), mon(121)], [])!.name).toBe('Mewtwo');
  });
});

describe('the live draft', () => {
  /** Snake order over the nine, one `livePick` at a time; the user takes `wants(round)` before each round. */
  const live = (r: RegionDef, wants: (picks: Mon[][], mine: number[]) => number | undefined = () => undefined) => {
    const picks: Mon[][] = regionTeams(r).map(() => []);
    const mine: number[] = [];
    for (let n = 0; n < 10; n++) {
      const d = wants(picks, mine);
      if (d != null) mine.push(d);
      const order = picks.map((_, i) => i);
      for (const i of n % 2 ? order.reverse() : order) picks[i].push(livePick(r, i, picks, mine)!);
    }
    return { picks, mine };
  };

  it('builds the same rosters as `regionRosters` when the user takes nothing', () => {
    for (const r of REGIONS) {
      expect(live(r).picks.map((p) => p.map((m) => m.dex)), r.name).toEqual(regionRosters(r).map((p) => p.map((m) => m.dex)));
    }
  });

  it('never repeats a Pokémon or takes the user\'s while the user grabs the gyms\' next targets', () => {
    for (const r of REGIONS) {
      const stars = regionTeams(r).map((t) => t.star!);
      const { picks, mine } = live(r, (sofar, held) => {
        const taken = new Set([...held, ...sofar.flat().map((m) => m.dex)]);
        return regionRosters(r, held).flat().find((m) => !taken.has(m.dex) && !stars.includes(m.dex))?.dex;
      });
      const all = picks.flat().map((m) => m.dex);
      expect(new Set(all).size, r.name).toBe(90);
      expect(mine).toHaveLength(10);
      expect(all.filter((d) => mine.includes(d)), r.name).toEqual([]);
      for (const [i, p] of picks.entries()) {
        const t = regionTeams(r)[i];
        expect(p.filter((m) => isLegendary(m.dex)).length, t.name).toBeLessThanOrEqual(legendaryCap(t));
        for (const m of p) if (isLegendary(m.dex)) expect(r.legendaries, `${t.name}: ${m.name}`).toContain(m.dex);
      }
    }
  });

  it('with only one gym in the draft (Quick Play), that gym still fields its franchise five', () => {
    const full = regionRosters(KANTO);
    for (let slot = 0; slot < 9; slot++) {
      const picks: Mon[][] = regionTeams(KANTO).map(() => []);
      while (picks[slot].length < 5) picks[slot].push(livePick(KANTO, slot, picks, [], 5)!);
      expect(picks[slot].map((m) => m.dex).sort(), regionTeams(KANTO)[slot].name).toEqual(full[slot].slice(0, 5).map((m) => m.dex).sort());
    }
  });
});

describe('the difficulty curve', () => {
  const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;

  it.each([
    [KANTO, [91, 92, 93, 95, 97, 99, 100, 101, 102]],
    [JOHTO, [92, 93, 94, 96, 98, 100, 101, 102, 103]],
    [HOENN, [93, 94, 95, 97, 99, 101, 102, 103, 105]],
    [SINNOH, [94, 95, 96, 98, 100, 101, 102, 104, 106]],
  ])('$name rises every badge against the 91 test team, up to its final opponent', (r, ramp) => {
    expect(strengthOf(TEAM.map(monByDex)).total).toBe(91);
    expect(strengths(r, TEAM)).toEqual(ramp);
  });

  it.each(HELD)('gyms 1-3 are at least 3 under every one of gyms 6-8 (%s)', (_, held) => {
    for (const r of REGIONS) {
      const s = strengths(r, held);
      expect(Math.min(...s.slice(5, 8)) - Math.max(...s.slice(0, 3)), `${r.name}: ${s}`).toBeGreaterThanOrEqual(3);
    }
  });

  it.each(HELD)('gym 7, gym 8 and the final opponent are the hardest; the final tops gym 8 or is within 1 (%s)', (_, held) => {
    for (const r of REGIONS) {
      const s = strengths(r, held);
      expect(Math.min(...s.slice(6)), `${r.name}: ${s}`).toBeGreaterThanOrEqual(Math.max(...s.slice(0, 6)));
      expect(s[8], `${r.name}: ${s}`).toBeGreaterThanOrEqual(s[7] - 1);
    }
  });

  it('Kanto gyms 1-3 play from 88 to 95 and gyms 7, 8 and the Elite at 99 or better, whatever is held', () => {
    for (const [label, held] of HELD) {
      const s = strengths(KANTO, held);
      for (const v of s.slice(0, 3)) expect(v >= 88 && v <= 95, `${label}: ${s}`).toBe(true);
      expect(Math.min(...s.slice(6)), `${label}: ${s}`).toBeGreaterThanOrEqual(99);
    }
  });

  // Not the rows that hold legendaries: they are native to one region each, so holding them weakens only that region.
  it.each(HELD.slice(0, 3))('each region is harder than the one before, early, late and at the final (%s)', (_, held) => {
    const all = REGIONS.map((r) => strengths(r, held));
    for (let i = 1; i < all.length; i++) {
      const [prev, next] = [all[i - 1], all[i]];
      const where = `${REGIONS[i].name}: ${prev} then ${next}`;
      expect(mean(next), where).toBeGreaterThan(mean(prev));
      // Early gyms may only draw level: an 86 team held ties Hoenn's and Sinnoh's.
      expect(mean(next.slice(0, 3)), where).toBeGreaterThanOrEqual(mean(prev.slice(0, 3)));
      expect(mean(next.slice(5, 8)), where).toBeGreaterThan(mean(prev.slice(5, 8)));
      expect(next[8], where).toBeGreaterThanOrEqual(prev[8]);
    }
  });

  it.each(HELD)('each region is harder than the one before on average (%s)', (_, held) => {
    const means = REGIONS.map((r) => mean(strengths(r, held)));
    for (let i = 1; i < means.length; i++) expect(means[i], `${means}`).toBeGreaterThan(means[i - 1]);
  });

  it('boosts are whole numbers from 0 to the cap', () => {
    expect(MAX_BOOST).toBe(14);
    for (const r of REGIONS) {
      for (const t of regionTeams(r)) expect(Number.isInteger(t.boost) && t.boost >= 0 && t.boost <= MAX_BOOST, t.name).toBe(true);
    }
  });
});
