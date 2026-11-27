// The CPU league drafter for every region's gyms and final opponent: each team locks its star first, then the CPU teams
// draft type first from the whole game (every region in `POKEMON`, but only the region's own legendaries, only on-type
// ones, and only up to each team's cap), filling the five starting positions (one at a time) before any backup. There is no randomness, so
// the teams come out the same every time for the same held-back Pokémon.
import { POKEMON, POSITIONS, monByDex, type Mon, type PokeType, type Pos } from '../data/pokemon';
import { COVER, bestLineup } from '../game/game';
import { isLegendary } from '../multiplayer/shared/roster';
import { KANTO, REGIONS, regionTeams, type RegionDef } from './regions';

export interface CpuDraftTeam {
  human?: boolean;
  types?: readonly PokeType[];
  /** Dex number of the locked star. */
  star?: number;
  gym?: number;
  elite?: boolean;
}

/** An on-type Pokémon is taken unless the best off-type one at that spot is more than this many OVR better. */
export const OFF_TYPE_MARGIN = 4;

/** How many on-type starters a CPU team is after, star included. */
export const MIN_ON_TYPE = 3;
/** Type never gets a Pokémon rated under this picked over a better rated one. */
export const ON_TYPE_FLOOR = 82;
/** Picks this close in OVR count as equals, and each region takes a different one of them. */
export const NEAR_EQUAL = 1;

/** The most legendaries a CPU team may hold on its whole roster, star included. */
export const legendaryCap = (team: CpuDraftTeam): number => (team.elite ? 3 : (team.gym ?? 0) >= 5 ? 2 : 1);

export const isOnType = (m: Mon, team: CpuDraftTeam): boolean => m.types.some((t) => team.types?.includes(t));

/**
 * Everything `region`'s gyms and final opponent may draft: every non-legendary Pokémon in the game, from every region,
 * locked or not, plus the region's own legendaries (`RegionDef.legendaries`). This is only a CPU rule: the user's
 * draft, free agents and trades use `poolMons`.
 */
export const cpuDraftPool = (region: RegionDef): Mon[] => POKEMON.filter((m) => !isLegendary(m.dex) || region.legendaries.includes(m.dex));

const ranked = (mons: readonly Mon[]): Mon[] => [...mons].sort((a, b) => b.ovr - a.ovr || a.dex - b.dex);

/**
 * The pick among the near equals: those within `NEAR_EQUAL` of the best in `mons` and not under `floor`, best first.
 * `turn` (a region's index) chooses which, so regions do not all take the same one. 0 takes the best.
 */
function nearBest(mons: readonly Mon[], floor: number, turn: number): Mon | undefined {
  const sorted = ranked(mons);
  const band = sorted.filter((m) => m.ovr >= Math.max(sorted[0].ovr - NEAR_EQUAL, floor));
  return band[turn % band.length] ?? sorted[0];
}

/**
 * The Pokémon in `pool` a team may take. A CPU team with types only takes a legendary that is on type, and none past its
 * cap (its star is locked before this applies). Which legendaries are in the pool at all is the region's business
 * (`cpuDraftPool`).
 */
function allowedFor(pool: readonly Mon[], roster: readonly Mon[], team: CpuDraftTeam): readonly Mon[] {
  if (team.human || !team.types?.length) return pool;
  const room = roster.filter((m) => isLegendary(m.dex)).length < legendaryCap(team);
  return pool.filter((m) => !isLegendary(m.dex) || (room && isOnType(m, team)));
}

/**
 * The next pick for a team, from the positions it has no starter for, then those with no backup, then any. A gym or
 * final opponent drafts type first: the best Pokémon of its types there, unless the best one there of any type is more
 * than `OFF_TYPE_MARGIN` OVR better, or the on-type one is under `ON_TYPE_FLOOR` and anyone is rated higher. Among near
 * equals, `turn` chooses (see `nearBest`), and an off-type pick passes over any that `wanted` says another team still
 * needs for its theme. A team with no `types` (the user) just takes the best.
 */
export function cpuNext(
  pool: readonly Mon[],
  roster: readonly Mon[],
  team: CpuDraftTeam = {},
  turn = 0,
  wanted: (m: Mon) => boolean = () => false,
): Mon | undefined {
  const count = (p: string) => roster.filter((m) => m.pos === p).length;
  const themed = !team.human && !!team.types?.length;
  const allowed = allowedFor(pool, roster, team);
  let cands = allowed;
  for (const depth of [1, 2]) {
    const fit = allowed.filter((m) => count(m.pos) < depth);
    if (fit.length) { cands = fit; break; }
  }
  const top = ranked(cands)[0];
  if (!themed || !top) return top;
  /** The lowest OVR type gets taken at, here. */
  const least = Math.max(top.ovr - OFF_TYPE_MARGIN, Math.min(top.ovr, ON_TYPE_FLOOR));
  const on = cands.filter((m) => isOnType(m, team) && m.ovr >= least);
  if (on.length) return nearBest(on, least, turn);
  const floor = Math.min(top.ovr, ON_TYPE_FLOOR);
  const spare = cands.filter((m) => m.ovr >= Math.max(top.ovr - NEAR_EQUAL, floor) && !wanted(m));
  return nearBest(spare.length ? spare : cands, floor, turn);
}

/**
 * Drafts the CPU teams (and the user, if a team is `human`) to `size`. Stars are locked before anyone picks. Teams pick
 * one position at a time (PG to C), each time from the final opponent through gym 8 down to gym 1, so later gyms get the
 * first choice. The final opponent drafts by the same rules as the gyms. The starting fives take three rounds:
 * 1. Theme picks. Each team takes an on-type Pokémon at each spot where `cpuNext` would, and otherwise waits.
 * 2. A team short of `MIN_ON_TYPE` reaches past the margin, but never under `ON_TYPE_FLOOR`.
 * 3. The spots still open go to the best Pokémon left.
 * A CPU team never takes a starter under `ON_TYPE_FLOOR` in those rounds. When nobody it may take at a spot reaches it
 * (the data is short of shooting guards), the spot stays open until every other spot is filled, and then a spare player
 * from the closest covering position (`COVER`) starts there, at the cost of the lineup bonus. Such a team carries nobody
 * who would take the spot back: no one at that position, or ahead of the cover in `COVER`.
 * The backups follow in passes in the same order. A human team picks in the middle of that order, from `userPool`.
 * `turn` is the region's index: gyms use it to choose among near equals (see `nearBest`); the final opponent does not.
 * Returns rosters in the order of `teams`: the star first, then the other starters best first, then the backups. An
 * off-type backup is always rated below the starter at its position, so the coach never starts it over the theme.
 */
export function draftCpuLeague(
  teams: readonly CpuDraftTeam[],
  size: number,
  cpuPool: readonly Mon[],
  userPool: readonly Mon[] = [],
  turn = 0,
): Mon[][] {
  const taken = new Set<number>();
  const rosters = teams.map((t): Mon[] => (!t.human && t.star != null ? [monByDex(t.star)] : []));
  // Every gym's star is out before the first pick, so no other team can draft it.
  for (const r of rosters) for (const m of r) taken.add(m.dex);
  const locked = rosters.map((r) => r.length);
  const rank = (i: number) => (teams[i].elite ? Infinity : teams[i].gym ?? 0);
  const order = teams.map((_, i) => i).filter((i) => !teams[i].human).sort((a, b) => rank(b) - rank(a));
  const human = teams.findIndex((t) => t.human);
  if (human >= 0 && userPool.length) order.splice(Math.floor(order.length / 2), 0, human);
  const freeFor = (i: number, pos?: Pos) =>
    (teams[i].human ? userPool : cpuPool).filter((m) => !taken.has(m.dex) && (!pos || m.pos === pos));
  const take = (i: number, m?: Mon) => {
    if (!m) return;
    taken.add(m.dex);
    rosters[i].push(m);
  };
  const open = (i: number, pos: Pos) => rosters[i].length < size && !rosters[i].some((m) => m.pos === pos);
  // The final opponent is meant to be the strongest, so it takes the best of near equals.
  const turnOf = (i: number) => (teams[i].elite ? 0 : turn);
  /** Whether another CPU team still has no starter at `m`'s position and would be on type with it. */
  const wanted = (i: number, m: Mon) => order.some((j) => j !== i && !teams[j].human && isOnType(m, teams[j]) && open(j, m.pos));
  const next = (i: number, from: readonly Mon[]) =>
    cpuNext(from, rosters[i], teams[i].human ? {} : teams[i], turnOf(i), (m) => wanted(i, m));
  const pick = (i: number, pos?: Pos) => take(i, next(i, freeFor(i, pos)));
  /** Whether a CPU team has nobody of `ON_TYPE_FLOOR` or better to take at `pos`. */
  const short = (i: number, pos: Pos) =>
    !teams[i].human && !allowedFor(freeFor(i, pos), rosters[i], teams[i]).some((m) => m.ovr >= ON_TYPE_FLOOR);
  // 1. Theme picks.
  for (const pos of POSITIONS) {
    for (const i of order) {
      if (!open(i, pos) || short(i, pos)) continue;
      if (teams[i].human) { pick(i, pos); continue; }
      const m = next(i, freeFor(i, pos));
      if (m && isOnType(m, teams[i])) take(i, m);
    }
  }
  // 2. A team still short of `MIN_ON_TYPE` reaches for it, at the spot where staying on type costs the least. This comes
  //    before any off-type pick, so nobody's filler takes another team's type.
  for (const i of order) {
    if (teams[i].human) continue;
    while (rosters[i].filter((m) => isOnType(m, teams[i])).length < MIN_ON_TYPE) {
      const reach = POSITIONS.filter((pos) => open(i, pos)).flatMap((pos) => {
        const allowed = allowedFor(freeFor(i, pos), rosters[i], teams[i]);
        const on = allowed.filter((m) => isOnType(m, teams[i]) && m.ovr >= ON_TYPE_FLOOR);
        const m = on.length ? nearBest(on, ON_TYPE_FLOOR, turnOf(i)) : undefined;
        return m ? [{ on: m, cost: ranked(allowed)[0].ovr - m.ovr }] : [];
      }).sort((a, b) => a.cost - b.cost || b.on.ovr - a.on.ovr);
      if (!reach.length) break;
      take(i, reach[0].on);
    }
  }
  // 3. Whatever is still open, PG to C.
  for (const pos of POSITIONS) for (const i of order) if (open(i, pos) && !short(i, pos)) pick(i, pos);
  // The spots nobody good enough plays: another position covers. With nobody to cover, the best natural one starts.
  const covers = teams.map((): { slot: Pos; mon: Mon }[] => []);
  for (const i of order) {
    for (const slot of POSITIONS) {
      if (!open(i, slot) || covers[i].some((c) => c.slot === slot)) continue;
      const mon = COVER[slot]
        .map((p) => next(i, freeFor(i, p).filter((m) => m.ovr >= ON_TYPE_FLOOR)))
        .find((m) => !!m);
      if (!mon) { pick(i, slot); continue; }
      take(i, mon);
      covers[i].push({ slot, mon });
    }
  }
  /** Whether `m` on the bench would start at a covered spot instead of the cover. */
  const uncovers = (i: number, m: Mon) => covers[i].some(({ slot, mon }) =>
    m.pos === slot || (m.pos === mon.pos ? m.ovr >= mon.ovr : COVER[slot].indexOf(m.pos) < COVER[slot].indexOf(mon.pos)));
  for (const i of order) {
    // Best first, so a live draft (which takes these in order) goes after its best players early.
    rosters[i] = [...rosters[i].slice(0, locked[i]), ...rosters[i].slice(locked[i]).sort((a, b) => b.ovr - a.ovr || a.dex - b.dex)];
  }
  // The five who start. The coach starts the best at each spot, so an off-type backup must be rated below the starter at
  // its position, or it would take that spot and undo the theme.
  const fives = rosters.map((r) => [...r]);
  const benchable = (i: number, m: Mon) =>
    !!teams[i].human || (!uncovers(i, m) && (isOnType(m, teams[i]) || !fives[i].some((s) => s.pos === m.pos && m.ovr >= s.ovr)));
  for (let n = 0; n < size; n++) {
    for (const i of order) {
      if (rosters[i].length > n) continue;
      const free = freeFor(i);
      const fit = free.filter((m) => benchable(i, m));
      take(i, next(i, fit.length ? fit : free));
    }
  }
  return rosters;
}

/**
 * A region's nine CPU rosters (gyms in badge order, then the final opponent) when the Pokémon in `held` are not
 * available. `held` is the user's team: no CPU team drafts those. The one exception is a locked star, which its team
 * keeps even when the user holds it too. A star is never drafted by another team in the region, held or not.
 */
export function regionRosters(region: RegionDef, held: readonly number[] = [], size = 10): Mon[][] {
  return draftCpuLeague(regionTeams(region), size, cpuDraftPool(region).filter((m) => !held.includes(m.dex)), [], region.index);
}

/** `regionRosters` for Kanto, the league the franchise draft and Quick Play use. */
export const kantoRosters = (held: readonly number[] = [], size = 10): Mon[][] => regionRosters(KANTO, held, size);

/** The locked star of the gym or final opponent with this team name, in any region (team names are unique). */
export const starOf = (teamName: string): number | undefined => REGIONS.flatMap(regionTeams).find((t) => t.name === teamName)?.star;

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
