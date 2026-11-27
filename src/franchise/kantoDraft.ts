// The CPU league drafter for every region's gyms and final opponent. Each team locks its star. Then they draft from one
// board, so a Pokémon is on at most one CPU team in a region: in turn from the final opponent down to gym 1, each takes
// the strongest five it may legally field with its type theme from what is left, and once every five is set they take
// backups. Regions are drafted separately, so teams in different regions may share a Pokémon. A region's own
// legendaries are the only ones open to its teams, up to each team's cap. There is no randomness, so the teams come out
// the same every time for the same held-back Pokémon.
import { POKEMON, POSITIONS, monByDex, type Mon, type PokeType, type Pos } from '../data/pokemon';
import { bestLineup } from '../game/game';
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

/** How many on-type starters a CPU team fields, star included, when its type has that many. */
export const MIN_ON_TYPE = 3;
/** An on-type card under this does not count toward `MIN_ON_TYPE`, unless it is the star: type never costs a team a weak starter. */
export const ON_TYPE_FLOOR = 82;

/** The most legendaries a CPU team may hold on its whole roster, star included. */
export const legendaryCap = (team: CpuDraftTeam): number => (team.elite ? 3 : (team.gym ?? 0) >= 5 ? 2 : 1);

export const isOnType = (m: Mon, team: CpuDraftTeam): boolean => m.types.some((t) => team.types?.includes(t));

/** Whether a starter counts toward `MIN_ON_TYPE`. */
const countsForTheme = (m: Mon, team: CpuDraftTeam): boolean => isOnType(m, team) && (m.ovr >= ON_TYPE_FLOOR || m.dex === team.star);

/**
 * Everything `region`'s gyms and final opponent may draft: every non-legendary Pokémon in the game, from every region
 * (earlier ones included), locked or not, plus the region's own legendaries (`RegionDef.legendaries`). This is only a CPU rule: the user's
 * draft, free agents and trades use `poolMons`.
 */
export const cpuDraftPool = (region: RegionDef): Mon[] => POKEMON.filter((m) => !isLegendary(m.dex) || region.legendaries.includes(m.dex));

const ranked = (mons: readonly Mon[]): Mon[] => [...mons].sort((a, b) => b.ovr - a.ovr || a.dex - b.dex);

/** A five in the making: its picks, how many count toward the theme and are on type, its legendaries and its ratings. */
interface Five { picks: Mon[]; theme: number; on: number; legends: number; total: number }

/** More of the theme first (up to `MIN_ON_TYPE`), then the higher ratings, then more on type. */
const better = (a: Five, b: Five): boolean =>
  (Math.min(a.theme, MIN_ON_TYPE) - Math.min(b.theme, MIN_ON_TYPE) || a.total - b.total || a.on - b.on) > 0;

/**
 * The strongest legal starting five that keeps every card in `have`: one natural player at each position still open,
 * with as many theme players as possible up to `MIN_ON_TYPE`, and no more legendaries than `cap`. Returns only the
 * new picks. It is exact: every combination that could matter is compared.
 */
function bestFive(pool: readonly Mon[], have: readonly Mon[], team: CpuDraftTeam, cap: number): Mon[] {
  const counts = (m: Mon) => countsForTheme(m, team);
  const add = (f: Five, m: Mon, pick: boolean): Five => ({
    picks: pick ? [...f.picks, m] : f.picks,
    theme: f.theme + (counts(m) ? 1 : 0),
    on: f.on + (isOnType(m, team) ? 1 : 0),
    legends: f.legends + (isLegendary(m.dex) ? 1 : 0),
    total: f.total + m.ovr,
  });
  const start = have.reduce((f, m) => add(f, m, false), { picks: [], theme: 0, on: 0, legends: 0, total: 0 } as Five);
  let fives = [start];
  for (const pos of POSITIONS) {
    if (have.some((m) => m.pos === pos)) continue;
    // Only the best few of each kind (on or off theme, legendary or not) can be in the best five.
    const seen: Record<string, number> = {};
    const cands = ranked(pool.filter((m) => m.pos === pos)).filter((m) => {
      const kind = `${counts(m)}${isOnType(m, team)}${isLegendary(m.dex)}`;
      return (seen[kind] = (seen[kind] ?? 0) + 1) === 1;
    });
    // The best partial five for each state that limits what can be added later.
    const next = new Map<string, Five>();
    for (const f of fives) {
      for (const m of cands) {
        if (isLegendary(m.dex) && f.legends >= cap) continue;
        const g = add(f, m, true);
        const key = `${Math.min(g.theme, MIN_ON_TYPE)},${g.legends}`;
        const old = next.get(key);
        if (!old || better(g, old)) next.set(key, g);
      }
    }
    // Nobody legal at this position: the spot stays open for the backups to fill.
    if (next.size) fives = [...next.values()];
  }
  return fives.reduce((a, b) => (better(b, a) ? b : a)).picks;
}

/** The best player left for a roster, ignoring types: at a position with no starter, then no backup, then any. */
export function cpuNext(pool: readonly Mon[], roster: readonly Mon[]): Mon | undefined {
  const free = pool.filter((m) => !roster.some((r) => r.dex === m.dex));
  const count = (p: Pos) => roster.filter((m) => m.pos === p).length;
  for (const depth of [1, 2]) {
    const fit = free.filter((m) => count(m.pos) < depth);
    if (fit.length) return ranked(fit)[0];
  }
  return ranked(free)[0];
}

/**
 * Fills the CPU teams' `rosters` (what each already holds, its star first) up to `size` from the one board `pool`,
 * taking each pick off it, so no two teams end up with the same Pokémon. `null` marks a team that doesn't draft here.
 * Turns go from the final opponent down to gym 1. First each team in turn reserves the on-type starters its theme
 * needs, so no team loses them to another going off type. Then each completes its strongest legal five; then
 * the backups go one per team per turn, one per position in turn. The legendary cap holds over each whole roster. A
 * backup who is off type is rated below the starter at his position, so the coach never starts him over the theme.
 */
function fillRosters(pool: readonly Mon[], teams: readonly CpuDraftTeam[], rosters: (Mon[] | null)[], size: number): void {
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
  /** The picks that would complete team `i`'s strongest legal five from what is left, best first. */
  const wanted = (i: number) => {
    const roster = rosters[i]!;
    const starters = fiveOf(roster);
    if (starters.length === POSITIONS.length) return [];
    const room = legendaryCap(teams[i]) - legends(roster.filter((m) => !starters.includes(m)));
    return ranked(bestFive(legal(i), starters, teams[i], room));
  };
  const before = rosters.map((r) => r?.length ?? 0);
  for (const i of order) {
    let need = MIN_ON_TYPE - rosters[i]!.filter((m) => countsForTheme(m, teams[i])).length;
    for (const m of wanted(i)) if (need > 0 && rosters[i]!.length < size && countsForTheme(m, teams[i])) { take(i, m); need--; }
  }
  for (const i of order) for (const m of wanted(i).slice(0, size - rosters[i]!.length)) take(i, m);
  // The new starters go best first, reserved or not.
  for (const i of order) rosters[i]!.splice(before[i], Infinity, ...ranked(rosters[i]!.slice(before[i])));
  // By roster size, so a live draft resumed in the middle of a round takes its turns in the same order.
  for (let held = 0; held < size; held++) {
    for (const i of order) {
      const roster = rosters[i]!;
      if (roster.length !== held) continue;
      const five = fiveOf(roster);
      const benchable = (m: Mon) => isOnType(m, teams[i]) || !five.some((s) => s.pos === m.pos && s.dex !== teams[i].star && m.ovr >= s.ovr);
      const free = legal(i);
      const fit = free.filter(benchable);
      const m = cpuNext(fit.length ? fit : free, roster);
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
): Mon[][] {
  const draftCpu = (held: ReadonlySet<number>) => {
    const free = cpuPool.filter((m) => !held.has(m.dex));
    // No team drafts another's star.
    const stars = new Set(teams.map((t) => (t.human ? undefined : t.star)));
    const rosters = teams.map((t) => (t.human ? null : t.star != null ? [monByDex(t.star)] : []));
    fillRosters(free.filter((m) => !stars.has(m.dex)), teams, rosters, size);
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
  return draftCpuLeague(regionTeams(region), size, cpuDraftPool(region).filter((m) => !held.includes(m.dex)));
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
  fillRosters(cpuDraftPool(region).filter((m) => !held.includes(m.dex) && !stars.has(m.dex)), teams, rosters, size);
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
