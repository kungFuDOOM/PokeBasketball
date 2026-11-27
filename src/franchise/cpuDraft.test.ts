// The rules every region's nine CPU teams are drafted by: theme, the 82 floor, legendaries, near-equal picks, and the ramp.
import { describe, expect, it } from 'vitest';
import { POKEMON, monByDex, type Mon } from '../data/pokemon';
import { chemistry } from '../game/game';
import { strengthOf } from '../screens/strength';
import { RANKED_LEGENDARIES, isLegendary } from '../multiplayer/shared/roster';
import { MIN_ON_TYPE, OFF_TYPE_MARGIN, ON_TYPE_FLOOR, cpuDraftPool, cpuNext, isOnType, legendaryCap, lineupWithStar, regionRosters } from './kantoDraft';
import { HOENN, JOHTO, KANTO, REGIONS, SINNOH, regionTeams, type RegionDef, type RegionTeam } from './regions';

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
 * Teams that cannot always start `MIN_ON_TYPE` on type, with the fewest they start over `HELD`. Everyone else starts at
 * least that many. These types have no Pokémon rated `ON_TYPE_FLOOR` or better at enough positions, once the region's
 * other stars are out:
 */
const THIN: Record<string, number> = {
  // Rock: every Pokémon rated 82+ is a center (Rhyperior, Aggron, Tyrantrum, Tyranitar, and Hoenn's Regirock), so the
  // star is the only one who can start. The same holds for Roxanne and Roark.
  Brock: 1,
  Roxanne: 1,
  Roark: 1,
  // Ghost: the only Pokémon rated 82+ are Gengar, Morty's star, and Sinnoh's Giratina, which Johto may not draft.
  Morty: 1,
  Erika: 2, // Grass: point guards and centers.
  Giovanni: 2, // Ground: power forwards and centers, and Mewtwo is off type.
  Bugsy: 1, // Bug: Scyther, Scizor and Heracross (Chuck's star in Johto); 1 when the user holds one of them.
  Fantina: 2, // Ghost: only Gengar and Giratina are 82+ besides the star; 2 when the user holds either.
  Jasmine: 2, // Steel: Tinkaton and the star; Scizor is Bugsy's star.
  Pryce: 2, // Ice: Weavile and the centers.
  Wattson: 2, // Electric: Raichu, Jolteon, Electrode and Electivire cover two positions, and the star is a third at 81.
  Gardenia: 2, // Grass.
  Candice: 2, // Ice.
  Volkner: 2, // Electric: point guards and Electivire.
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

  it.each(HELD)('each Pokémon, legendaries included, is on one CPU team per region; none is the user\'s (%s)', (_, held) => {
    for (const r of REGIONS) {
      const stars = regionTeams(r).map((t) => t.star!);
      expect(new Set(stars).size, r.name).toBe(9);
      const all = seats(r, held).flatMap((s) => s.roster.map((m) => m.dex));
      expect(all, r.name).toHaveLength(90);
      expect(new Set(all).size, r.name).toBe(90);
      for (const { t, roster } of seats(r, held)) {
        expect(roster, t.name).toHaveLength(10);
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

describe('type first', () => {
  const mon = monByDex;
  const water = { gym: 8, types: ['Water' as const] };

  it('takes the on-type Pokémon unless the best one there is more than the margin better', () => {
    expect(OFF_TYPE_MARGIN).toBe(4);
    // Starmie 86 (Water) against Slaking 91 and Venusaur 88 (neither is).
    expect(cpuNext([mon(3), mon(121)], [], water)!.name).toBe('Starmie');
    expect(cpuNext([mon(289), mon(121)], [], water)!.name).toBe('Slaking');
  });

  it('never takes an on-type Pokémon under 82 over a better rated one', () => {
    expect(ON_TYPE_FLOOR).toBe(82);
    // Vaporeon 81 is within the margin of Hydreigon 85, but under the floor.
    expect(cpuNext([mon(635), mon(134)], [], water)!.name).toBe('Hydreigon');
    // Gallade is 82: at the floor, so the margin applies.
    expect(cpuNext([mon(635), mon(475)], [], { gym: 8, types: ['Psychic' as const] })!.name).toBe('Gallade');
    // With nobody rated higher, the on-type 81 is taken.
    expect(cpuNext([mon(467), mon(142)], [], { gym: 1, types: ['Rock' as const] })!.name).toBe('Aerodactyl');
  });

  it('only takes a legendary that is on type, and never past the cap', () => {
    // Mew 93 is the best here, but a Water team may not have it.
    expect(cpuNext([mon(151), mon(121)], [], water)!.name).toBe('Starmie');
    const early = { gym: 1, types: ['Psychic' as const] };
    expect(cpuNext([mon(150), mon(65)], [mon(151)], early)!.name).toBe('Alakazam');
    expect(cpuNext([mon(150), mon(65)], [mon(151)], { ...early, gym: 5 })!.name).toBe('Mewtwo');
    // The user just takes the best.
    expect(cpuNext([mon(150), mon(121)], [], { human: true })!.name).toBe('Mewtwo');
  });

  it('lets each region pick a different one of the near equals, within 1 OVR', () => {
    // Starmie 86, Feraligatr 86, Milotic 85, and Lapras 84, which is too far down.
    const pool = [mon(121), mon(160), mon(350), mon(131)];
    expect([0, 1, 2, 3].map((turn) => cpuNext(pool, [], water, turn)!.name)).toEqual(['Starmie', 'Feraligatr', 'Milotic', 'Starmie']);
  });

  it('leaves another team its type when the off-type choices are equal', () => {
    // Aerodactyl and Magmortar are both 81; the Rock gym still needs a guard.
    const electric = { gym: 3, types: ['Electric' as const] };
    expect(cpuNext([mon(142), mon(467)], [], electric)!.name).toBe('Aerodactyl');
    expect(cpuNext([mon(142), mon(467)], [], electric, 0, (m) => m.name === 'Aerodactyl')!.name).toBe('Magmortar');
  });

  it('has no per-team draft limits', () => {
    for (const r of REGIONS) {
      for (const t of regionTeams(r)) {
        expect(t, t.name).not.toHaveProperty('margin');
        expect(t, t.name).not.toHaveProperty('ceiling');
      }
    }
  });

  it.each(HELD)('every team starts at least three on type, star included, bar the thin ones (%s)', (_, held) => {
    expect(MIN_ON_TYPE).toBe(3);
    for (const r of REGIONS) {
      for (const { t, five } of seats(r, held)) {
        const min = t.elite ? 4 : THIN[t.leader] ?? MIN_ON_TYPE;
        expect(five.filter((m) => isOnType(m, t)).length, `${t.name}: ${five.map((m) => m.name)}`).toBeGreaterThanOrEqual(min);
        expect(five.map((m) => m.dex), t.name).toContain(t.star);
      }
    }
  });

  it.each(HELD)('no off-type legendary is drafted, to start or to sit; stars aside (%s)', (_, held) => {
    for (const r of REGIONS) {
      for (const { t, roster, five } of seats(r, held)) {
        for (const m of [...five, ...roster]) {
          if (isLegendary(m.dex) && m.dex !== t.star) expect(isOnType(m, t), `${t.name}: ${m.name}`).toBe(true);
        }
      }
    }
  });

  it.each(HELD)('every starter but a star is 82 or better (%s)', (_, held) => {
    for (const r of REGIONS) {
      for (const { t, five } of seats(r, held)) {
        for (const m of five) if (m.dex !== t.star) expect(m.ovr, `${t.name}: ${m.name}`).toBeGreaterThanOrEqual(ON_TYPE_FLOOR);
      }
    }
  });

  it('a spot short of shooting guards is covered, without the lineup bonus; only stars start under 82', () => {
    // Nine teams need one each, and only eight non-legendary shooting guards in the game are rated 82 or better.
    expect(POKEMON.filter((m) => m.pos === 'SG' && m.ovr >= 82 && !isLegendary(m.dex))).toHaveLength(8);
    const all = REGIONS.flatMap((r) => seats(r, TEAM));
    const covered = all.filter(({ five }) => chemistry(five) === 0);
    expect(covered.map(({ t }) => t.leader)).toEqual(['Brock', 'Lt. Surge', 'Falkner', 'Morty', 'Roxanne']);
    for (const { t, roster, five } of covered) {
      // A second point guard plays the two, and nobody on the roster takes the spot back.
      expect(five.filter((m) => m.pos === 'PG'), t.name).toHaveLength(2);
      expect(roster.filter((m) => m.pos === 'SG'), t.name).toEqual([]);
      expect(roster.filter((m) => m.pos === 'PG'), t.name).toHaveLength(2);
    }
    const low = all.flatMap(({ t, five }) => five.filter((m) => m.ovr < 82).map((m) => `${t.leader}: ${m.name} ${m.ovr}${m.dex === t.star ? ' (star)' : ''}`));
    expect(low).toEqual(['Wattson: Manectric 81 (star)', 'Crasher Wake: Floatzel 80 (star)', 'Fantina: Mismagius 81 (star)']);
  });

  it('no two teams of a region start the same five, and the four final opponents all differ', () => {
    for (const r of REGIONS) expect(new Set(seats(r, TEAM).flatMap((s) => s.five.map((m) => m.dex))).size, r.name).toBe(45);
    const elites = REGIONS.map((r) => seats(r, TEAM)[8].five.map((m) => m.dex));
    for (let a = 0; a < elites.length; a++) {
      for (let b = a + 1; b < elites.length; b++) {
        const shared = elites[a].filter((d) => elites[b].includes(d)).length;
        expect(shared, `${REGIONS[a].name} and ${REGIONS[b].name}`).toBeLessThanOrEqual(2);
      }
    }
  });
});

describe('the strength ramp against the 91 test team', () => {
  /** The fewest equal neighbors any boosts of 0 to 4 can give these gym cards without a drop, with gym 8 at most `top`. */
  const fewestTies = (cards: number[], top: number, i = 0, last = -Infinity): number => {
    if (i === cards.length) return 0;
    let best = Infinity;
    for (let b = 0; b <= 4; b++) {
      const v = cards[i] + b;
      if (v >= last && v <= top) best = Math.min(best, (v === last ? 1 : 0) + fewestTies(cards, top, i + 1, v));
    }
    return best;
  };

  // A strict ramp is not possible on these cards, so each region rises with as few ties as boosts of 0 to 4 allow while
  // the final opponent stays 2 above gym 8 on a boost of 6 or less.
  it.each([
    [KANTO, [86, 88, 89, 90, 90, 91, 92, 93, 95], 1],
    [JOHTO, [87, 88, 89, 89, 90, 90, 91, 92, 97], 2],
    [HOENN, [86, 87, 88, 89, 89, 90, 91, 92, 98], 1],
    [SINNOH, [87, 88, 89, 90, 90, 91, 91, 92, 98], 2],
  ])('$name rises with the fewest ties its cards allow, and the final opponent is at least 2 above gym 8', (r, ramp, ties) => {
    expect(strengthOf(TEAM.map(monByDex)).total).toBe(91);
    expect(strengths(r, TEAM)).toEqual(ramp);
    for (let i = 1; i < 8; i++) expect(ramp[i], `${r.name} ${i + 1}`).toBeGreaterThanOrEqual(ramp[i - 1]);
    expect(8 - new Set(ramp.slice(0, 8)).size).toBe(ties);
    expect(ramp[8] - ramp[7]).toBeGreaterThanOrEqual(2);
    const all = seats(r, TEAM);
    const cards = all.slice(0, 8).map((s) => strengthOf(s.five).total);
    expect(fewestTies(cards, strengthOf(all[8].five).total + 6 - 2)).toBe(ties);
  });

  it('only Kanto could rise strictly, and only with the final opponent 1 above gym 8', () => {
    const cards = (r: RegionDef) => seats(r, TEAM).slice(0, 8).map((s) => strengthOf(s.five).total);
    expect(fewestTies(cards(KANTO), Infinity)).toBe(0);
    expect(fewestTies(cards(KANTO), strengthOf(seats(KANTO, TEAM)[8].five).total + 6 - 1)).toBe(0);
    for (const r of [JOHTO, HOENN, SINNOH]) expect(fewestTies(cards(r), Infinity), r.name).toBeGreaterThan(0);
  });

  it('gym boosts are whole numbers from 0 to 4, and a final opponent\'s from 0 to 6', () => {
    for (const r of REGIONS) {
      for (const t of regionTeams(r)) {
        expect(Number.isInteger(t.boost) && t.boost >= 0 && t.boost <= (t.elite ? 6 : 4), t.name).toBe(true);
      }
    }
  });

  it("each final opponent's boost is the smallest that plays at 98 and 2 above gym 8, or 6 if none does", () => {
    expect(REGIONS.map((r) => r.finale.boost)).toEqual([6, 6, 5, 6]);
    for (const r of REGIONS) {
      const gym8 = strengths(r, TEAM)[7];
      const five = seats(r, TEAM)[8].five;
      const enough = [0, 1, 2, 3, 4, 5, 6].find((b) => strengthOf(five, b).total >= Math.max(98, gym8 + 2));
      expect(r.finale.boost, r.name).toBe(enough ?? 6);
    }
  });

  it('the final opponent is at least 2 above gym 8 whatever the user holds', () => {
    for (const [, held] of HELD) {
      for (const r of REGIONS) {
        const s = strengths(r, held);
        expect(s[8] - s[7], `${r.name}: ${s}`).toBeGreaterThanOrEqual(2);
      }
    }
  });
});
