// The rules every region's nine CPU teams are drafted by: type first, generation limits, legendaries, and the difficulty curve.
import { describe, expect, it } from 'vitest';
import { POKEMON, POSITIONS, monByDex, type Mon } from '../data/pokemon';
import { chemistry } from '../game/game';
import { strengthOf } from '../screens/strength';
import { RANKED_LEGENDARIES, isLegendary } from '../multiplayer/shared/roster';
import { MIN_ON_TYPE, NATIVE_EDGE, ON_TYPE_MARGIN, STARTER_FLOOR, cpuDraftPool, cpuNext, isOnType, legendaryCap, lineupWithStar, livePick, regionRosters } from './kantoDraft';
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
 * Fewest on-type starters a leader manages across `HELD`, when that is under `MIN_ON_TYPE`. Each pool really cannot
 * supply three cards that clear `STARTER_FLOOR` and `ON_TYPE_MARGIN`:
 * Giovanni has Marowak and Nidoqueen; Dugtrio starts for Brock and Onix is more than 8 under Lapras.
 * Morty has Haunter and Gengar; Misdreavus is 71.
 * Jasmine has Steelix and Skarmory; Magneton is more than 8 under the guard she can take, and Forretress is a center.
 * Pryce has Lapras; Jynx is 9 under Jolteon and the other ice finals are centers or under the floor.
 * Clair has Dragonite and Kingdra; Dragonair and Dratini are under the floor.
 * Candice has Weavile; the other ice cards are more than 8 under the forwards and center she can take.
 * Volkner drops to Raichu and Electivire when a much stronger small forward is free.
 */
const THIN: Record<string, number> = { Giovanni: 2, Morty: 2, Jasmine: 2, Pryce: 1, Clair: 2, Candice: 1, Volkner: 2 };

/** The on-type starters each region's nine field (gyms in badge order, then the final) with the 91 test team held. */
const ON_TYPE: Record<string, number[]> = {
  Kanto: [5, 5, 3, 3, 3, 4, 3, 2, 4],
  Johto: [5, 4, 4, 2, 3, 2, 1, 2, 4],
  Hoenn: [4, 4, 3, 3, 3, 5, 3, 4, 5],
  Sinnoh: [4, 3, 4, 5, 4, 5, 1, 3, 5],
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

  it('as a pool: every non-legendary up to its generation, and only the native legendaries', () => {
    for (const r of REGIONS) {
      const pool = cpuDraftPool(r).map((m) => m.dex);
      expect(pool, r.name).toEqual(
        POKEMON.filter((m) => m.dex <= r.dex[1] && (!isLegendary(m.dex) || r.legendaries.includes(m.dex))).map((m) => m.dex));
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

describe('generation limits', () => {
  it('Kanto stops at 151, Johto at 251, Hoenn at 386 and Sinnoh at 493', () => {
    expect(REGIONS.map((r) => r.dex[1])).toEqual([151, 251, 386, 493]);
  });

  it.each(HELD)('no CPU roster, star, starter or backup, goes past its region\'s generation (%s)', (_, held) => {
    for (const r of REGIONS) {
      for (const { t, roster } of seats(r, held)) {
        for (const m of roster) expect(m.dex, `${t.name}: ${m.name}`).toBeLessThanOrEqual(r.dex[1]);
      }
    }
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
        expect(rosters.some((m) => from(m.dex) && !isLegendary(m.dex)), `${r.name} drafts ${earlier.name}`).toBe(true);
        expect(rosters.some((m) => from(m.dex)), `${r.name} uses ${earlier.name}`).toBe(true);
      }
      for (const m of rosters) if (isLegendary(m.dex)) expect(r.legendaries, `${r.name}: ${m.name}`).toContain(m.dex);
    }
  });
});

describe('type first', () => {
  it('Brock also takes Ground; every other team only its listed types', () => {
    const brock = KANTO.gyms[0];
    expect(brock.types).toEqual(['Rock']);
    expect(isOnType(monByDex(51), brock)).toBe(true); // Dugtrio
    expect(isOnType(monByDex(51), JOHTO.gyms[0])).toBe(false);
    for (const r of REGIONS) {
      for (const t of regionTeams(r)) {
        if (t.leader === 'Brock') continue;
        for (const m of POKEMON) expect(isOnType(m, t), `${t.name}: ${m.name}`).toBe(m.types.some((ty) => t.types.includes(ty)));
      }
    }
  });

  it.each(HELD)('every gym and final starts at least three on type, star included (%s)', (_, held) => {
    expect(MIN_ON_TYPE).toBe(3);
    for (const r of REGIONS) {
      for (const { t, five } of seats(r, held)) {
        expect(five.filter((m) => isOnType(m, t)).length, `${t.name}: ${five.map((m) => m.name)}`).toBeGreaterThanOrEqual(THIN[t.leader] ?? MIN_ON_TYPE);
        expect(five.map((m) => m.dex), t.name).toContain(t.star);
      }
    }
  });

  it('starts these many on type against the 91 test team', () => {
    for (const r of REGIONS) {
      expect(seats(r, TEAM).map(({ t, five }) => five.filter((m) => isOnType(m, t)).length), r.name).toEqual(ON_TYPE[r.name]);
    }
  });

  /** What a team could have started at `m`'s position: the pool less the stars, the user's and every starting five. */
  const leftAt = (r: RegionDef, all: Seat[], held: readonly number[], pos: Mon['pos']) => {
    const gone = new Set([...held, ...regionTeams(r).map((t) => t.star!), ...all.flatMap((s) => s.five.map((m) => m.dex))]);
    return cpuDraftPool(r).filter((m) => m.pos === pos && !gone.has(m.dex));
  };
  const legendsOf = (mons: readonly Mon[]) => mons.filter((m) => isLegendary(m.dex)).length;

  it.each(HELD)('starts off type only when no on-type card clears the floor and the margin (%s)', (_, held) => {
    for (const r of REGIONS) {
      const all = seats(r, held);
      for (const { t, five } of all) {
        for (const off of five.filter((m) => m.dex !== t.star && !isOnType(m, t))) {
          const room = (m: Mon) => !isLegendary(m.dex) || legendsOf(five) - legendsOf([off]) < legendaryCap(t);
          const usable = leftAt(r, all, held, off.pos).filter((m) => isOnType(m, t) && m.ovr >= STARTER_FLOOR && room(m));
          const offsLeft = leftAt(r, all, held, off.pos).filter((m) => !isOnType(m, t) && m.ovr >= STARTER_FLOOR);
          const bestOff = Math.max(off.ovr, ...offsLeft.map((m) => m.ovr));
          // A leftover on-type card within the margin of that off-type option should have started.
          expect(usable.filter((m) => bestOff - m.ovr <= ON_TYPE_MARGIN).map((m) => m.name), `${t.name} starts ${off.name}`).toEqual([]);
          const wasted = all.flatMap((s) => (s.t === t ? [] : s.five.filter((m) => m.pos === off.pos && m.dex !== s.t.star
            && !isOnType(m, s.t) && isOnType(m, t) && !isLegendary(m.dex) && m.ovr >= STARTER_FLOOR && bestOff - m.ovr <= ON_TYPE_MARGIN)));
          expect(wasted.map((m) => m.name), `${t.name} starts ${off.name}`).toEqual([]);
        }
      }
    }
  });

  it.each(HELD)('a starter under the floor means no floor card was left at the position (%s)', (_, held) => {
    expect(STARTER_FLOOR).toBe(74);
    expect(ON_TYPE_MARGIN).toBe(8);
    for (const r of REGIONS) {
      const all = seats(r, held);
      for (const { t, five } of all) {
        for (const s of five) {
          if (s.ovr >= STARTER_FLOOR) continue;
          const better = leftAt(r, all, held, s.pos).filter((m) => m.ovr >= STARTER_FLOOR
            && (!isLegendary(m.dex) || legendsOf(five) - legendsOf([s]) < legendaryCap(t)));
          expect(better.map((m) => `${m.name} ${m.ovr}`), `${t.name} starts ${s.name} ${s.ovr}`).toEqual([]);
        }
      }
    }
  });

  it.each(HELD)('no non-legendary left on the bench or the board beats a starter of its kind (%s)', (_, held) => {
    for (const r of REGIONS) {
      const all = seats(r, held);
      const worth = (m: Mon) => m.ovr + (m.dex >= r.dex[0] && m.dex <= r.dex[1] ? NATIVE_EDGE : 0);
      for (const { t, five } of all) {
        for (const s of five.filter((m) => m.dex !== t.star)) {
          for (const m of leftAt(r, all, held, s.pos)) {
            if (isLegendary(m.dex) || isOnType(m, t) !== isOnType(s, t)) continue;
            expect(worth(m), `${t.name}: ${m.name} over ${s.name}`).toBeLessThanOrEqual(worth(s));
          }
        }
      }
    }
  });

  it('a later region takes its own generation when ratings are close', () => {
    expect(NATIVE_EDGE).toBe(2);
    const pick = (mons: Mon[]) => cpuNext(mons, [], JOHTO.dex)!.name;
    const at = (name: string, ovr: number, dex: number): Mon => ({ ...monByDex(dex), name, ovr, pos: 'PG' });
    expect(pick([at('kanto', 85, 25), at('johto', 83, 196)])).toBe('johto');
    expect(pick([at('kanto', 86, 25), at('johto', 83, 196)])).toBe('kanto');
  });

  it.each(HELD)('has a natural player at every position, so every team gets the lineup bonus (%s)', (_, held) => {
    for (const r of REGIONS) {
      for (const { t, five } of seats(r, held)) {
        expect(new Set(five.map((m) => m.pos)).size, t.name).toBe(POSITIONS.length);
        expect(chemistry(five), t.name).toBe(2);
      }
    }
  });

  it.each(HELD)('the coach starts the five the team drafted (%s)', (_, held) => {
    for (const r of REGIONS) {
      for (const { t, roster, five } of seats(r, held)) {
        expect(five.map((m) => m.dex).sort(), t.name).toEqual(roster.slice(0, 5).map((m) => m.dex).sort());
      }
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
    expect(cpuNext([monByDex(150), monByDex(121)], [])!.name).toBe('Mewtwo');
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
  }, 30000);

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
  }, 30000);

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
    [KANTO, [91, 92, 93, 95, 97, 99, 101, 100, 102]],
    [JOHTO, [92, 93, 94, 96, 98, 100, 102, 102, 105]],
    [HOENN, [94, 94, 95, 97, 99, 101, 102, 105, 106]],
    [SINNOH, [95, 95, 96, 98, 100, 102, 105, 106, 107]],
  ])('$name rises every badge against the 91 test team, up to its final opponent', (r, ramp) => {
    expect(strengthOf(TEAM.map(monByDex)).total).toBe(91);
    expect(strengths(r, TEAM)).toEqual(ramp);
  });

  it('Johto\'s final never plays under Clair, whichever of these is held', () => {
    const best = [...cpuDraftPool(JOHTO)].sort((a, b) => b.ovr - a.ovr).slice(0, 10).map((m) => m.dex);
    for (const held of [...HELD.map(([, h]) => h), best]) {
      const s = strengths(JOHTO, held);
      expect(s[8], `${held}: ${s}`).toBeGreaterThanOrEqual(s[7]);
    }
  });

  it('Sinnoh is above Hoenn at gyms 6 and 7 against the test team', () => {
    const [h, n] = [strengths(HOENN, TEAM), strengths(SINNOH, TEAM)];
    expect(n[5]).toBeGreaterThan(h[5]);
    expect(n[6]).toBeGreaterThan(h[6]);
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
      expect(s[8], `${r.name}: ${s}`).toBeGreaterThanOrEqual(s[7]);
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
      // Early gyms may only draw level.
      expect(mean(next.slice(0, 3)), where).toBeGreaterThanOrEqual(mean(prev.slice(0, 3)));
      // Strictly harder against the test team; with other rosters the late gyms may draw level (Kanto's and Johto's can).
      if (held === TEAM) expect(mean(next.slice(5, 8)), where).toBeGreaterThan(mean(prev.slice(5, 8)));
      else expect(mean(next.slice(5, 8)), where).toBeGreaterThanOrEqual(mean(prev.slice(5, 8)));
      expect(next[8], where).toBeGreaterThanOrEqual(prev[8]);
    }
  });

  it.each(HELD)('each region is harder than the one before on average (%s)', (_, held) => {
    const means = REGIONS.map((r) => mean(strengths(r, held)));
    for (let i = 1; i < means.length; i++) expect(means[i], `${means}`).toBeGreaterThan(means[i - 1]);
  });

  it('boosts are whole numbers from 0 to the cap', () => {
    expect(MAX_BOOST).toBe(16);
    for (const r of REGIONS) {
      for (const t of regionTeams(r)) expect(Number.isInteger(t.boost) && t.boost >= 0 && t.boost <= MAX_BOOST, t.name).toBe(true);
    }
  });
});
