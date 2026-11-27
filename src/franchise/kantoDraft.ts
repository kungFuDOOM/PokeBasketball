// The CPU league drafter for every region's gyms and final opponent. It is type-first: each team starts as many players
// of its own types as the pool can legally supply, and only then looks at ratings (the `STRENGTH_FIRST` leaders are the
// exception: they draft for ratings alone). A starter has to clear
// `STARTER_FLOOR` (a card under it may only ride the bench, and only when no legal floor-clearing card can). An on-type
// card is also skipped when it is more than `ON_TYPE_MARGIN` below the best legal off-type option at that position, and
// the spot goes to that off-type card. A team still aims for `MIN_ON_TYPE` on-type starters and drops below that only
// when three cards cannot clear both checks. Players only start at their natural position, so before anyone picks,
// `onTypeSlots` works out for each position which teams can get a quality on-type starter there, and no pick may take
// that away from another team. Each team locks its star. Then they draft from one board, so a Pokémon is on at most one
// CPU team in a region: in turn from the final opponent down to gym 1, each takes its on-type starters, then in the same
// order fills any spot left off type, and once every five is set they take backups. A `STRENGTH_FIRST` team takes its
// whole five in the first round of turns, after every team ahead of it has filled its own five. Regions are drafted separately, so
// teams in different regions may share a Pokémon. A region's teams draft nothing newer than its generation, and its own
// legendaries are the only ones open to them, up to each team's cap. There is no randomness, so the teams come out the
// same every time for the same held-back Pokémon.
import { POKEMON, POSITIONS, monByDex, type Mon, type PokeType, type Pos } from '../data/pokemon';
import { bestLineup } from '../game/game';
import { isLegendary } from '../multiplayer/shared/roster';
import { KANTO, REGIONS, regionTeams, type RegionDef } from './regions';

export interface CpuDraftTeam {
  human?: boolean;
  leader?: string;
  types?: readonly PokeType[];
  /** Dex number of the locked star. */
  star?: number;
  gym?: number;
  elite?: boolean;
}

/** The fewest on-type starters, star included, a CPU team fields unless its quality on-type pool is exhausted. */
export const MIN_ON_TYPE = 3;
/** A starter is never rated under this. A card under it may sit on the bench only when nothing at the floor can. */
export const STARTER_FLOOR = 74;
/**
 * An on-type starter more than this far under the best legal off-type option at its position is skipped, and that
 * off-type card starts instead. The gap is raw OVR, not the native-generation tie-break.
 */
export const ON_TYPE_MARGIN = 8;
/**
 * How much a Pokémon of the region's own generation is preferred by: it is taken over one from an earlier region that is
 * rated up to this much higher, so later regions don't all field the same names.
 */
export const NATIVE_EDGE = 2;
/** Types a leader accepts on top of the gym's listed ones. */
const SECOND_THEME: Record<string, readonly PokeType[]> = { Brock: ['Ground'] };

/**
 * Leaders who draft for strength instead of type. Nothing is reserved for them and they have no on-type target: in the
 * first pass, at their turn, they take the best five they can. Their listed types are flavor (`isOnType` still reads them).
 */
export const STRENGTH_FIRST: readonly string[] = ['Pryce', 'Candice'];
/** Whether the drafter treats `m` as one of the team's types: `isOnType`, never for a `STRENGTH_FIRST` leader. */
const draftsAsOnType = (m: Mon, team: CpuDraftTeam): boolean => !STRENGTH_FIRST.includes(team.leader ?? '') && isOnType(m, team);

/** The most legendaries a CPU team may hold on its whole roster, star included. */
export const legendaryCap = (team: CpuDraftTeam): number => (team.elite ? 3 : (team.gym ?? 0) >= 5 ? 2 : 1);

/** Whether either of `m`'s types is one the team drafts: its listed types, plus `SECOND_THEME`. */
export const isOnType = (m: Mon, team: CpuDraftTeam): boolean =>
  m.types.some((t) => team.types?.includes(t) || SECOND_THEME[team.leader ?? '']?.includes(t));

/**
 * Everything `region`'s gyms and final opponent may draft: every non-legendary Pokémon up to the end of the region's
 * generation (earlier regions included, locked or not), plus the region's own legendaries (`RegionDef.legendaries`).
 * This is only a CPU rule: the user's draft, free agents and trades use `poolMons`.
 */
export const cpuDraftPool = (region: RegionDef): Mon[] =>
  POKEMON.filter((m) => m.dex <= region.dex[1] && (!isLegendary(m.dex) || region.legendaries.includes(m.dex)));

const ranked = (mons: readonly Mon[]): Mon[] => [...mons].sort((a, b) => b.ovr - a.ovr || a.dex - b.dex);

/** What a starter is worth to the drafter: its rating, plus `NATIVE_EDGE` for the region's own generation. */
const worth = (m: Mon, native: Dex): number => m.ovr + (native && m.dex >= native[0] && m.dex <= native[1] ? NATIVE_EDGE : 0);
type Dex = readonly [number, number] | undefined;

/** Best first for the drafter: by `worth`, the native one first on a tie. */
const preferred = (mons: readonly Mon[], native: Dex): Mon[] => {
  const own = (m: Mon) => worth(m, native) - m.ovr;
  return [...mons].sort((a, b) => worth(b, native) - worth(a, native) || own(b) - own(a) || a.dex - b.dex);
};

/**
 * On-type cards from `ons` that may start against the best off-type option `off`: they clear `STARTER_FLOOR`, and they
 * are at most `ON_TYPE_MARGIN` under that off-type card. Nothing under the floor is offered. `off` is omitted when the
 * position has no off-type card that clears the floor.
 */
const qualityOn = (ons: readonly Mon[], off: Mon | undefined, native: Dex): Mon[] => {
  const onFloor = ons.filter((m) => m.ovr >= STARTER_FLOOR);
  if (!off || off.ovr < STARTER_FLOOR) return preferred(onFloor, native);
  return preferred(onFloor.filter((m) => off.ovr - m.ovr <= ON_TYPE_MARGIN), native);
};

/** The best off-type card in `offs` that clears the floor, if there is one. */
const bestOffType = (offs: readonly Mon[], native: Dex): Mon | undefined =>
  preferred(offs.filter((m) => m.ovr >= STARTER_FLOOR), native)[0];

/**
 * Who may start at one position. `onOnly` is the on-type pass. Otherwise the quality on-type cards plus every off-type
 * card that clears the floor. When nobody clears the floor, the single best card starts: type does not pull in a weaker one.
 */
const starterChoices = (ons: readonly Mon[], offs: readonly Mon[], off: Mon | undefined, onOnly: boolean, native: Dex): Mon[] => {
  const onOk = qualityOn(ons, off, native);
  if (onOnly) return onOk;
  const offFloor = offs.filter((m) => m.ovr >= STARTER_FLOOR);
  if (onOk.length || offFloor.length) return [...onOk, ...preferred(offFloor, native)];
  return preferred([...ons, ...offs], native).slice(0, 1);
};

/** Whether every team in `teams` can be given its own player from `options(team)`, leaving out `skip` (bipartite matching). */
function canSeat(teams: readonly number[], options: (i: number) => readonly Mon[], skip?: number): boolean {
  const owner = new Map<number, number>();
  const seat = (i: number, seen: Set<number>): boolean => options(i).some((m) => {
    if (m.dex === skip || seen.has(m.dex)) return false;
    seen.add(m.dex);
    const other = owner.get(m.dex);
    if (other !== undefined && !seat(other, seen)) return false;
    owner.set(m.dex, i);
    return true;
  });
  return teams.every((i) => seat(i, new Set()));
}

/**
 * For each position, the teams that get an on-type starter there: as many as the pool allows. `open(i, pos)` lists team
 * `i`'s legal on-type players for a position it still has to fill. When a position runs short, the teams with the fewest
 * on-type positions of their own go first (then draft order), so scarcity doesn't pile up on one team.
 */
function onTypeSlots(order: readonly number[], open: (i: number, pos: Pos) => readonly Mon[], have: (i: number) => number): Map<Pos, number[]> {
  const reach = new Map(order.map((i) => [i, have(i) + POSITIONS.filter((p) => open(i, p).length).length]));
  const need = [...order].sort((a, b) => reach.get(a)! - reach.get(b)!);
  return new Map(POSITIONS.map((pos) => {
    const seated: number[] = [];
    for (const i of need) if (open(i, pos).length && canSeat([...seated, i], (t) => open(t, pos))) seated.push(i);
    return [pos, seated];
  }));
}

/** A five in the making: its picks, how many are on type, its legendaries and its total worth. */
interface Five { picks: Mon[]; on: number; legends: number; total: number }

/** More on type first, then the higher worth. */
const better = (a: Five, b: Five): boolean => (a.on - b.on || a.total - b.total) > 0;

/**
 * The best legal starting five from `options` (one list per position still open): as many on type as possible, then the
 * most worth, with no more than `cap` new legendaries. Returns only the new picks. It is exact.
 */
function bestFive(options: readonly (readonly Mon[])[], team: CpuDraftTeam, cap: number, native: Dex): Mon[] {
  // The best partial five for each number of legendaries used.
  let fives: Five[] = [{ picks: [], on: 0, legends: 0, total: 0 }];
  for (const list of options) {
    // Only the best of each kind (on or off type, legendary or not) can be in the best five.
    const seen = new Set<string>();
    const cands = preferred(list, native).filter((m) => {
      const kind = `${draftsAsOnType(m, team)}${isLegendary(m.dex)}`;
      return !seen.has(kind) && !!seen.add(kind);
    });
    const next = new Map<number, Five>();
    for (const f of fives) {
      for (const m of cands) {
        const legends = f.legends + (isLegendary(m.dex) ? 1 : 0);
        if (legends > cap && isLegendary(m.dex)) continue;
        const g = { picks: [...f.picks, m], on: f.on + (draftsAsOnType(m, team) ? 1 : 0), legends, total: f.total + worth(m, native) };
        const old = next.get(legends);
        if (!old || better(g, old)) next.set(legends, g);
      }
    }
    // Nobody legal at this position: the spot stays open for the backups to fill.
    if (next.size) fives = [...next.values()];
  }
  return fives.reduce((a, b) => (better(b, a) ? b : a)).picks;
}

/**
 * The best player left for a roster, ignoring types: at a position with no starter, then no backup, then any. With
 * `native`, near-equal ratings go to the region's own generation (`NATIVE_EDGE`).
 */
export function cpuNext(pool: readonly Mon[], roster: readonly Mon[], native?: readonly [number, number]): Mon | undefined {
  const free = pool.filter((m) => !roster.some((r) => r.dex === m.dex));
  const count = (p: Pos) => roster.filter((m) => m.pos === p).length;
  for (const depth of [1, 2]) {
    const fit = free.filter((m) => count(m.pos) < depth);
    if (fit.length) return preferred(fit, native)[0];
  }
  return preferred(free, native)[0];
}

/**
 * Fills the CPU teams' `rosters` (what each already holds, its star first) up to `size` from the one board `pool`,
 * taking each pick off it, so no two teams end up with the same Pokémon. `null` marks a team that doesn't draft here.
 * Turns go from the final opponent down to gym 1. First each team in turn takes its quality on-type starters, the most
 * `worth` it can without taking a player another team needs for its `onTypeSlots`; then each fills any spot still open
 * with the most `worth` left that clears `STARTER_FLOOR` (see `starterChoices`). At a `STRENGTH_FIRST` team's turn in
 * the first round, every team up to and including it fills its open spots, so it picks right after the teams ahead of
 * it and before any later team's on-type picks (their `onTypeSlots` stay protected). Then the backups go one per team per
 * turn, one per position in turn. The legendary cap holds over each whole roster. A backup is never rated above the
 * starter at its position (an off-type one is rated below), so the coach keeps the drafted five. A card under the floor
 * is a backup only when no floor-clearing card can take the spot.
 * `native` is the region's own dex range (see `NATIVE_EDGE`).
 */
function fillRosters(pool: readonly Mon[], teams: readonly CpuDraftTeam[], rosters: (Mon[] | null)[], size: number, native: Dex): void {
  const gone = new Set(rosters.flatMap((r) => r?.map((m) => m.dex) ?? []));
  const rank = (i: number) => (teams[i].elite ? Infinity : teams[i].gym ?? 0);
  const order = teams.map((_, i) => i).filter((i) => rosters[i]).sort((a, b) => rank(b) - rank(a));
  const legends = (mons: readonly Mon[]) => mons.filter((m) => isLegendary(m.dex)).length;
  const legal = (i: number) => {
    const room = legends(rosters[i]!) < legendaryCap(teams[i]);
    return pool.filter((m) => !gone.has(m.dex) && (room || !isLegendary(m.dex)));
  };
  const take = (i: number, m: Mon) => { rosters[i]!.push(m); gone.add(m.dex); };
  // The starters so far: the first card the team took at each position.
  const fiveOf = (roster: readonly Mon[]) => POSITIONS.flatMap((pos) => roster.find((m) => m.pos === pos) ?? []);
  const needs = (i: number, pos: Pos) => !rosters[i]!.some((m) => m.pos === pos) && rosters[i]!.length < size;
  const atPos = (i: number, pos: Pos, on: boolean) => legal(i).filter((m) => m.pos === pos && draftsAsOnType(m, teams[i]) === on);
  const qualityAt = (i: number, pos: Pos) =>
    (needs(i, pos) ? qualityOn(atPos(i, pos, true), bestOffType(atPos(i, pos, false), native), native) : []);
  // A team can only start `legendaryCap` legendaries. Reserving every on-type legendary locks cards it will never take
  // (the cap is spent on its best one) and keeps an earlier team from starting them.
  const keptLegends = new Map(order.map((i) => {
    const room = legendaryCap(teams[i]) - legends(rosters[i]!);
    const legs = preferred(POSITIONS.flatMap((pos) => qualityAt(i, pos).filter((m) => isLegendary(m.dex))), native);
    return [i, new Set(legs.slice(0, Math.max(0, room)).map((m) => m.dex))] as const;
  }));
  /** Team `i`'s quality on-type options for a position it still has to fill. Weak cards and extra legendaries are not reserved. */
  const onType = (i: number, pos: Pos) =>
    qualityAt(i, pos).filter((m) => !isLegendary(m.dex) || keptLegends.get(i)!.has(m.dex));
  const slots = onTypeSlots(order, onType, (i) => fiveOf(rosters[i]!).filter((m) => draftsAsOnType(m, teams[i])).length);
  const before = rosters.map((r) => r?.length ?? 0);
  /**
   * The best off-type card team `i` can still have at `pos`. Teams that draft earlier and still need the position take
   * the best open cards before `i`'s off-type pass, so those cards are not the comparison for the margin.
   */
  const realisticOff = (i: number, pos: Pos, ons: readonly Mon[], offs: readonly Mon[]): Mon | undefined => {
    const earlier = order.slice(0, order.indexOf(i)).filter((t) => needs(t, pos)).length;
    const mine = new Set(ons.map((m) => m.dex));
    const left = preferred([...offs, ...ons], native).slice(earlier).filter((m) => !mine.has(m.dex));
    return bestOffType(left, native) ?? preferred(left, native)[0];
  };
  /**
   * Team `i` takes the best five it can at its open positions, keeping every seated team's on-type slot. `onOnly` is the
   * first pass (quality on-type). The second pass fills what is left with the best legal card, still refusing an
   * on-type card that misses the floor or the margin.
   */
  const pickStarters = (i: number, onOnly: boolean) => {
    const options = POSITIONS.filter((p) => needs(i, p)).map((pos) => {
      const others = slots.get(pos)!.filter((t) => t !== i && needs(t, pos));
      // Nothing is taken while the options are built, so each other team's list is worked out once.
      const theirs = new Map(others.map((t) => [t, onType(t, pos)]));
      const seat = (m: Mon) => canSeat(others, (t) => theirs.get(t)!, m.dex);
      const ons = atPos(i, pos, true).filter(seat);
      const offs = atPos(i, pos, false).filter(seat);
      return starterChoices(ons, offs, realisticOff(i, pos, ons, offs), onOnly, native);
    }).filter((list) => list.length);
    const room = legendaryCap(teams[i]) - legends(rosters[i]!);
    for (const m of bestFive(options, teams[i], room, native).slice(0, size - rosters[i]!.length)) take(i, m);
  };
  // Every team takes its quality on-type starters before anyone fills a spot off type, so no filler pick costs a team a
  // card that clears the floor and the margin. The exception: at a `STRENGTH_FIRST` team's turn, the teams ahead of it
  // and then that team complete their fives, still keeping every seated team's on-type slot.
  order.forEach((i, turn) => {
    if (!STRENGTH_FIRST.includes(teams[i].leader ?? '')) return pickStarters(i, true);
    for (const t of order.slice(0, turn + 1)) pickStarters(t, false);
  });
  for (const i of order) pickStarters(i, false);
  // The new starters go best first.
  for (const i of order) rosters[i]!.splice(before[i], Infinity, ...ranked(rosters[i]!.slice(before[i])));
  // By roster size, so a live draft resumed in the middle of a round takes its turns in the same order.
  for (let held = 0; held < size; held++) {
    for (const i of order) {
      const roster = rosters[i]!;
      if (roster.length !== held) continue;
      const five = fiveOf(roster);
      const benchable = (m: Mon) => !five.some((s) => s.pos === m.pos && s.dex !== teams[i].star
        && (m.ovr > s.ovr || (m.ovr === s.ovr && !draftsAsOnType(m, teams[i]))));
      const free = legal(i);
      const fit = free.filter(benchable);
      const m = cpuNext(fit.length ? fit : free, roster, native);
      if (m) take(i, m);
    }
  }
}

/**
 * Drafts a league without the draft screen. Each CPU team starts with its star and they draft the rest from `cpuPool`
 * together (see `fillRosters`), so no Pokémon is on two of them. A human team drafts from `userPool` as in a live draft: one pick per
 * team per round, with the human in the middle of the order, and what a CPU team has taken by then is off the human's
 * board. The CPU teams then draft without anything the human holds.
 * Returns rosters in the order of `teams`: the star first, then the other starters best first, then the backups.
 */
export function draftCpuLeague(
  teams: readonly CpuDraftTeam[],
  size: number,
  cpuPool: readonly Mon[],
  userPool: readonly Mon[] = [],
  native?: readonly [number, number],
): Mon[][] {
  const draftCpu = (held: ReadonlySet<number>) => {
    const free = cpuPool.filter((m) => !held.has(m.dex));
    // No team drafts another's star.
    const stars = new Set(teams.map((t) => (t.human ? undefined : t.star)));
    const rosters = teams.map((t) => (t.human ? null : t.star != null ? [monByDex(t.star)] : []));
    fillRosters(free.filter((m) => !stars.has(m.dex)), teams, rosters, size, native);
    return rosters.map((r) => r ?? []);
  };
  const human = teams.findIndex((t) => t.human);
  if (human < 0 || !userPool.length) return draftCpu(new Set());
  const plan = draftCpu(new Set());
  const rank = (i: number) => (teams[i].elite ? Infinity : teams[i].gym ?? 0);
  const order = teams.map((_, i) => i).filter((i) => i !== human).sort((a, b) => rank(b) - rank(a));
  order.splice(Math.floor(order.length / 2), 0, human);
  const gone = new Set<number>(teams.flatMap((t) => (!t.human && t.star != null ? [t.star] : [])));
  const mine: Mon[] = [];
  for (let n = 0; n < size; n++) {
    for (const i of order) {
      if (i !== human) {
        if (plan[i][n]) gone.add(plan[i][n].dex);
        continue;
      }
      const m = cpuNext(userPool.filter((x) => !gone.has(x.dex)), mine);
      if (m) { mine.push(m); gone.add(m.dex); }
    }
  }
  const rosters = draftCpu(new Set(mine.map((m) => m.dex)));
  rosters[human] = mine;
  return rosters;
}

/**
 * A region's nine CPU rosters (gyms in badge order, then the final opponent) when the Pokémon in `held` are not
 * available. `held` is the user's team: no CPU team drafts those. The one exception is a locked star, which its team
 * keeps even when the user holds it too. A star is never drafted by another team in the region, held or not. No
 * Pokémon is on two of the nine.
 */
export function regionRosters(region: RegionDef, held: readonly number[] = [], size = 10): Mon[][] {
  return draftCpuLeague(regionTeams(region), size, cpuDraftPool(region).filter((m) => !held.includes(m.dex)), [], region.dex);
}

/** `regionRosters` for Kanto, the league the franchise draft and Quick Play use. */
export const kantoRosters = (held: readonly number[] = [], size = 10): Mon[][] => regionRosters(KANTO, held, size);

/**
 * The next pick for one gym or final opponent in a live draft. `picks` is what each of `regionTeams` holds so far (an
 * empty list for one that hasn't picked or isn't in this draft) and `held` is the user's picks. While every team's
 * picks still follow `regionRosters` around `held`, it is the team's next card there. Once the user has taken someone a
 * team had already passed, all nine re-plan from what they hold, so nothing is ever taken twice.
 */
export function livePick(region: RegionDef, slot: number, picks: readonly (readonly Mon[])[], held: readonly number[] = [], size = 10): Mon | undefined {
  const teams = regionTeams(region);
  if (!picks[slot]?.length) return monByDex(teams[slot].star!);
  const plan = regionRosters(region, held, size);
  if (picks.every((p, i) => p.every((m, k) => plan[i][k]?.dex === m.dex))) return plan[slot][picks[slot].length];
  const rosters = teams.map((t, i) => (picks[i]?.length ? [...picks[i]] : [monByDex(t.star!)]));
  const stars = new Set(teams.map((t) => t.star));
  fillRosters(cpuDraftPool(region).filter((m) => !held.includes(m.dex) && !stars.has(m.dex)), teams, rosters, size, region.dex);
  return rosters[slot][picks[slot].length];
}

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
