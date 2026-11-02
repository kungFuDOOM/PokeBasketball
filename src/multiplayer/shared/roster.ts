import { POKEMON, POSITIONS, monByDex, type Mon } from '../../data/pokemon';
import { seededRng } from '../../game/types';

/** One random Pokémon for each position. */
export function randomFive(rng: () => number = Math.random, pool: readonly Mon[] = POKEMON): Mon[] {
  return POSITIONS.map((p) => {
    const at = pool.filter((m) => m.pos === p);
    return at[Math.floor(rng() * at.length)];
  });
}

/**
 * Left out of Ranked entirely: the legendaries too strong to balance against anything else at their position
 * (all OVR 91 or more, about two standard deviations above the rest). kungFuDOOM: "If that means no one gets
 * Mewtwo then so be it." Change Ranked's pool here.
 */
export const RANKED_EXCLUDED: readonly number[] = [
  150, // Mewtwo, SF 97
  249, // Lugia, C 96
  250, // Ho-Oh, C 95
  151, // Mew, PG 94
  384, // Rayquaza, PF 93
  381, // Latios, SF 92
  383, // Groudon, PF 92
  382, // Kyogre, C 92
  380, // Latias, SF 91
];

/** Every lore legendary in the dex: the RANKED_EXCLUDED nine plus the birds, beasts and Celebi. None may be on a
 * Ranked preset team. */
export const RANKED_LEGENDARIES: readonly number[] = [
  ...RANKED_EXCLUDED,
  144, // Articuno
  145, // Zapdos
  146, // Moltres
  243, // Raikou
  244, // Entei
  245, // Suicune
  251, // Celebi
];

/** No Ranked preset member may be rated above this. */
export const RANKED_MAX_OVR = 88;

/** Whether a Pokémon may be on a Ranked preset team: OVR at most RANKED_MAX_OVR and not a legendary. */
export function isRankedLegal(m: Mon): boolean {
  return m.ovr <= RANKED_MAX_OVR && !RANKED_LEGENDARIES.includes(m.dex);
}

// Ranked balance: change the caps here.
/** Ranked teams' total OVR may differ by at most this much (out of about 350). */
export const RANKED_MAX_GAP = 3;
/** On each Ranked team, the best and worst starters' OVR may differ by at most this much, so no team is top-heavy
 * (an 87 C next to a 44 PG). */
export const RANKED_MAX_SPREAD = 25;
/** Rerolls before Ranked settles for the closest pair it found. */
const RANKED_TRIES = 400;
/** Rerolls for one team before it settles for the most even five it found. */
const SPREAD_TRIES = 200;

export const RANKED_POOL: readonly Mon[] = POKEMON.filter((m) => !RANKED_EXCLUDED.includes(m.dex));

/** A team's strength, for balancing: its starters' total OVR. */
export const teamOvr = (team: readonly Mon[]) => team.reduce((s, m) => s + m.ovr, 0);

/** How top-heavy a team is: its best starter's OVR minus its worst's. */
export const teamSpread = (team: readonly Mon[]) => Math.max(...team.map((m) => m.ovr)) - Math.min(...team.map((m) => m.ovr));

/** A random Ranked five within RANKED_MAX_SPREAD (or the most even one after SPREAD_TRIES). */
function evenFive(rng: () => number): Mon[] {
  let best = randomFive(rng, RANKED_POOL);
  for (let i = 1; i < SPREAD_TRIES && teamSpread(best) > RANKED_MAX_SPREAD; i++) {
    const t = randomFive(rng, RANKED_POOL);
    if (teamSpread(t) < teamSpread(best)) best = t;
  }
  return best;
}

/**
 * Two random fives of equal strength: from the Ranked pool, each team even (RANKED_MAX_SPREAD), rerolled from the
 * same seeded stream until their total OVR is within RANKED_MAX_GAP (or the closest pair after RANKED_TRIES), then a
 * coin flip for which side gets which, so any leftover gap doesn't always favour the host.
 */
export function balancedRosters(rng: () => number): [Mon[], Mon[]] {
  let best: [Mon[], Mon[]] | null = null;
  let bestGap = Infinity;
  for (let i = 0; i < RANKED_TRIES && bestGap > RANKED_MAX_GAP; i++) {
    const a = evenFive(rng);
    const b = evenFive(rng);
    const gap = Math.abs(teamOvr(a) - teamOvr(b));
    if (gap < bestGap) { best = [a, b]; bestGap = gap; }
  }
  const [a, b] = best!;
  return rng() < 0.5 ? [a, b] : [b, a];
}

/**
 * An online match's two starting fives, from the seed the server picked for it. Both players (and the winner check)
 * work them out the same way, so neither can hand the other a weak team (or themselves a strong one). Ranked teams
 * are balanced. Social's are a fallback for a match without a draft (#28): simply random.
 */
export function rostersFor(seed: number, queue: 'social' | 'ranked' = 'social'): [Mon[], Mon[]] {
  // Its own stream, kept apart from the game's (which is seeded with the same number).
  const rng = seededRng((seed ^ 0x5bd1e995) >>> 0);
  return queue === 'ranked' ? balancedRosters(rng) : [randomFive(rng), randomFive(rng)];
}

/**
 * The two fives for a match-flow game, mine first. Ranked plays the online match's server rosters (host, guest;
 * Pokédex numbers by position); only CPU practice (and the offline simulated opponent, which has no server) gets two
 * balanced teams from a seed. Social: random fives.
 */
export function flowRosters(
  opts: { queue: 'social' | 'ranked'; practice?: boolean },
  opp: { simulated: boolean; rosters?: [number[], number[]] | null; mySide?: 0 | 1 },
  seed = (Math.random() * 2 ** 32) >>> 0,
): [Mon[], Mon[]] {
  if (opts.queue !== 'ranked') return [randomFive(), randomFive()];
  if (opp.rosters) {
    const [host, guest] = opp.rosters.map((t) => t.map(monByDex));
    return opp.mySide === 1 ? [guest, host] : [host, guest];
  }
  if (opts.practice || opp.simulated) return rostersFor(seed, 'ranked');
  throw new Error('ranked match has no preset rosters');
}
