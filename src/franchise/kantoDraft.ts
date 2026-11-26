// The Kanto gym drafter: each gym locks its star first, then the CPU teams take the best Pokémon left from the Gen 1
// family pool, filling the five starting positions before any backup. There is no randomness, so the gyms come out the
// same every time for the same held-back Pokémon.
import { POKEMON, POSITIONS, monByDex, type Mon, type PokeType } from '../data/pokemon';
import { bestLineup } from '../game/game';
import { KANTO, isKantoCpuMon, regionTeams } from './regions';

export interface KantoDraftTeam {
  human?: boolean;
  types?: readonly PokeType[];
  /** Dex number of the locked star. Teams without one (the Indigo Elite) look for an on-type player early instead. */
  star?: number;
  gym?: number;
  elite?: boolean;
}

/** A team without a locked star takes the best on-type Pokémon by this pick (1-based). */
const ON_TYPE_BY_PICK = 3;

/** Everything a Kanto CPU team may draft. */
export const kantoPool = (): Mon[] => POKEMON.filter(isKantoCpuMon);

/**
 * The next pick for a team: the best Pokémon in `pool` at a position it has no starter for, then at a position with no
 * backup, then anyone. The team's own type only breaks ties.
 */
export function kantoNext(pool: readonly Mon[], roster: readonly Mon[], team: KantoDraftTeam = {}): Mon | undefined {
  const isOn = (m: Mon) => m.types.some((t) => team.types?.includes(t));
  const count = (p: string) => roster.filter((m) => m.pos === p).length;
  let cands: readonly Mon[] = pool;
  for (const depth of [1, 2]) {
    const fit = pool.filter((m) => count(m.pos) < depth);
    if (fit.length) { cands = fit; break; }
  }
  if (team.star == null && !roster.some(isOn) && roster.length >= ON_TYPE_BY_PICK - 1) {
    const on = cands.filter(isOn);
    if (on.length) cands = on;
  }
  const value = (m: Mon) => m.ovr + (isOn(m) ? 0.5 : 0);
  return [...cands].sort((a, b) => value(b) - value(a) || a.dex - b.dex)[0];
}

/**
 * Drafts the CPU teams (and the user, if a team is `human`) to `size`. Stars are locked before anyone picks. Each pass
 * then goes from the final opponent through gym 8 down to gym 1, so the gyms get stronger in badge order. A human team
 * picks in the middle of that order, from `userPool`. Returns rosters in the order of `teams`, star first.
 */
export function draftKantoLeague(
  teams: readonly KantoDraftTeam[],
  size: number,
  cpuPool: readonly Mon[] = kantoPool(),
  userPool: readonly Mon[] = [],
): Mon[][] {
  const taken = new Set<number>();
  const rosters = teams.map((t): Mon[] => (!t.human && t.star != null ? [monByDex(t.star)] : []));
  for (const r of rosters) for (const m of r) taken.add(m.dex);
  const rank = (i: number) => (teams[i].elite ? Infinity : teams[i].gym ?? 0);
  const order = teams.map((_, i) => i).filter((i) => !teams[i].human).sort((a, b) => rank(b) - rank(a));
  const human = teams.findIndex((t) => t.human);
  if (human >= 0 && userPool.length) order.splice(Math.floor(order.length / 2), 0, human);
  for (let n = 0; n < size; n++) {
    for (const i of order) {
      if (rosters[i].length > n) continue;
      const free = (teams[i].human ? userPool : cpuPool).filter((m) => !taken.has(m.dex));
      const m = kantoNext(free, rosters[i], teams[i].human ? {} : teams[i]);
      if (!m) continue;
      taken.add(m.dex);
      rosters[i].push(m);
    }
  }
  return rosters;
}

/**
 * The nine Kanto CPU rosters (gyms in badge order, then the Elite) when the Pokémon in `held` are not available.
 * A gym keeps its star even when it is held.
 */
export function kantoRosters(held: readonly number[] = [], size = 10): Mon[][] {
  return draftKantoLeague(regionTeams(KANTO), size, kantoPool().filter((m) => !held.includes(m.dex)));
}

/** The star of the Kanto gym with this team name, if it is one. */
export const kantoStarOf = (teamName: string): number | undefined => KANTO.gyms.find((g) => g.name === teamName)?.star;

/** `bestLineup`, except that `star` (when on the roster) always starts, at its own position. */
export function lineupWithStar(mons: Mon[], star?: number): { starters: Mon[]; bench: Mon[] } {
  const best = bestLineup(mons);
  const ace = star == null ? undefined : mons.find((m) => m.dex === star);
  if (!ace || best.starters.includes(ace)) return best;
  const slot = Math.max(0, best.slots.indexOf(ace.pos) >= 0 ? best.slots.indexOf(ace.pos) : POSITIONS.indexOf(ace.pos));
  const starters = [...best.starters];
  const out = starters[slot];
  starters[slot] = ace;
  return { starters, bench: [...best.bench.filter((m) => m !== ace), ...(out ? [out] : [])].sort((a, b) => b.ovr - a.ovr) };
}
