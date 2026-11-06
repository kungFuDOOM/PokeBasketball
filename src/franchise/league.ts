import { EVOLUTIONS, RATING_LABELS, isRetired, monByDex, positionWeights, withBonus, type Mon, type PokeType, type Ratings } from '../data/pokemon';
import { Game, bestLineup } from '../game/game';
import { courtFor, userCourt } from '../data/courts';
import type { Difficulty, GameConfig, PStats, TeamDef } from '../game/types';
import type { DraftState } from '../screens/draft';
import { safeName } from '../nameFilter';
import { fixAbbr } from '../util';
import { USER_STYLE, contrastAway } from '../multiplayer/shared/matchSetup';
import { KANTO, REGIONS, inPool, nextRegion, openRegionIds, regionById, regionTeams, type LeagueTeam, type RegionDef } from './regions';

const SAVE_KEY = 'pokejam.franchise.v1';
/** XP needed to go from `level` to the next one; each level costs a bit more. */
export const xpToNext = (level: number) => 60 + 25 * (level - 1);

/** The rest of the league in Kanto: the eight gyms in badge order, then the Elite Four (see `regions.ts`). */
export const LEAGUE: LeagueTeam[] = regionTeams(KANTO);
export type { LeagueTeam };
export { USER_STYLE, contrastAway };

export interface SeasonStats extends PStats { gp: number }

export interface FPlayer {
  uid: string;
  dex: number;
  level: number;
  xp: number;
  bonus: Partial<Ratings>;
  stats: SeasonStats;
  /** OVR when the season began, for Most Improved. */
  ovrStart?: number;
  /** Weeks left on the injury list. */
  injury?: number;
}

export interface FTeam {
  id: number;
  name: string;
  abbr: string;
  color: string;
  color2: string;
  human: boolean;
  leader?: string;
  types?: PokeType[];
  boost?: number;
  gym?: number;
  badge?: string;
  elite?: boolean;
  roster: string[];
  /** The user's depth chart: five starters, then the bench in order. Missing means the coach decides. */
  lineup?: string[];
  w: number;
  l: number;
  pf: number;
  pa: number;
  streak: number; // +n wins in a row, -n losses
}

export interface FGame {
  week: number;
  home: number;
  away: number;
  score: [number, number] | null; // [home, away]
  round?: 'semi' | 'final';
  pog?: string;
  /** Box score, kept for the current season. Missing for games played before box scores were saved. */
  box?: BoxLine[];
  /** Periods played (5+ means overtime). */
  q?: number;
}

/**
 * One player's line in a stored box score: uid, dex at the time (they may evolve later), side (0 home,
 * 1 away), starter flag, then seconds played, PTS, FGM, FGA, 3PM, 3PA, REB, AST, STL, BLK, DNK.
 */
export type BoxLine = [string, number, 0 | 1, 0 | 1, number, number, number, number, number, number, number, number, number, number, number];

export interface Progress {
  uid: string;
  team: number;
  name: string;
  level: number;
  gains: string[];
  evolvedFrom?: number;
  evolvedTo?: number;
}

export interface Franchise {
  version: 1;
  season: number;
  /** 1..weeks is the regular season; weeks+1 the semifinals, weeks+2 the final. */
  week: number;
  /** Regular-season weeks. Missing in early saves, which played a 10-week double round robin. */
  weeks?: number;
  phase: 'season' | 'playoffs' | 'done';
  teams: FTeam[];
  players: Record<string, FPlayer>;
  freeAgents: string[];
  games: FGame[];
  signedWeek: number;
  news: string[];
  champion?: number;
  mvp?: string;
  /** This season's awards, set when the final ends. */
  awards?: Award[];
  history: { season: number; champion: string; mvp: string; region?: string }[];
  /** Offseason rookie draft, between the final and the next season. */
  rookies?: RookieDraft;
  /** Seeds the rookie classes, so the same save gets the same class. Missing in older saves; made on first use. */
  seed?: number;
  /** Recent rookie classes (dex numbers), newest last, so the same prospects don't come back year after year. */
  classes?: { season: number; dexes: number[] }[];
  /** Season whose championship cutscene has been shown. Missing in older saves. */
  titleShown?: number;
  /** Season the user became a PokeJam Master (won the title with every badge); its cutscene has played. Permanent. */
  pokejamMaster?: number;
  /** Season whose new-season preview has been shown. Missing in older saves. */
  introShown?: number;
  /** The user's pick in the last rookie draft, for the new-season preview. */
  draftedRookie?: string;
  /** Region the league plays in (an id from `regions.ts`). Missing in older saves: Kanto. */
  region?: string;
  /** Every title the user's team has won, by region. Permanent. */
  titles?: RegionRecord[];
  /** Seasons the user won a region's title with all eight of its gym badges. Permanent. */
  completedRegions?: RegionRecord[];
  /** Regions after the first that this franchise may enter (earned here or on this device). */
  unlockedRegions?: string[];
}

export interface RegionRecord { regionId: string; season: number }

/**
 * One-round rookie draft from the unevolved free agents, worst record first and the champion last.
 * Every team then has eleven players and cuts one before the next season.
 */
export interface RookieDraft {
  /** Team ids in pick order. */
  order: number[];
  /** Uids picked so far, in order. */
  picks: string[];
  /** The prospects (free-agent uids). */
  pool: string[];
}

export interface Award {
  key: 'mvp' | 'smoy' | 'dpoy' | 'mip' | 'scoring';
  label: string;
  uid: string;
  team: number;
  line: string;
}

const emptyStats = (): SeasonStats => ({ gp: 0, pts: 0, fgm: 0, fga: 0, tpm: 0, tpa: 0, reb: 0, ast: 0, stl: 0, blk: 0, dnk: 0, sec: 0, gs: 0 });

export const monOf = (f: Franchise, uid: string): Mon => {
  const p = f.players[uid];
  return withBonus(p.dex, p.bonus);
};

/** Uids of a team's starting five and bench, in the order the coach would use them. */
/**
 * Who dresses: starters and bench in order, from the user's depth chart or the coach's pick.
 * Injured players sit out (`out`) unless the team can't field five without them.
 */
export function lineupOf(f: Franchise, t: FTeam): { starters: string[]; bench: string[]; out: string[] } {
  const hurt = (u: string) => (f.players[u].injury ?? 0) > 0;
  let out = t.roster.filter(hurt);
  if (t.roster.length - out.length < 5) out = [];
  const healthy = t.roster.filter((u) => !out.includes(u));
  const custom = t.lineup;
  if (custom && t.roster.length > 5 && custom.length === t.roster.length && t.roster.every((u) => custom.includes(u))) {
    const order = custom.filter((u) => !out.includes(u));
    return { starters: order.slice(0, 5), bench: order.slice(5), out };
  }
  const byMon = new Map(healthy.map((u) => [monOf(f, u), u]));
  const { starters, bench } = bestLineup([...byMon.keys()]);
  return { starters: starters.map((m) => byMon.get(m)!), bench: bench.map((m) => byMon.get(m)!), out };
}

/** Swaps two players in the user's depth chart (starting from the coach's lineup the first time). */
export function swapInLineup(f: Franchise, a: string, b: string) {
  const t = f.teams[0];
  const { starters, bench, out } = lineupOf(f, t);
  const order = t.lineup && t.lineup.length === t.roster.length ? [...t.lineup] : [...starters, ...bench, ...out];
  const i = order.indexOf(a);
  const j = order.indexOf(b);
  if (i < 0 || j < 0) return;
  [order[i], order[j]] = [order[j], order[i]];
  t.lineup = order;
}

/** Hands the depth chart back to the coach. */
export function resetLineup(f: Franchise) {
  delete f.teams[0].lineup;
}

/** Rating of the starting five. */
export const teamOvrOf = (f: Franchise, t: FTeam) => {
  const { starters } = lineupOf(f, t);
  return Math.round(starters.reduce((a, u) => a + monOf(f, u).ovr, 0) / starters.length);
};

export function perGame(s: SeasonStats) {
  const g = Math.max(1, s.gp);
  return { ppg: s.pts / g, rpg: s.reb / g, apg: s.ast / g, spg: s.stl / g, bpg: s.blk / g };
}

const gameScore = (s: PStats) => s.pts + s.reb * 1.2 + s.ast * 1.5 + s.stl * 2 + s.blk * 2 - (s.fga - s.fgm) * 0.4;

/** Round robin twice (circle method): every team plays every other team home and away. */
/** Every team plays every other team once (`twice` adds the return games). */
function schedule(n: number, twice: boolean): FGame[] {
  const ids = [...Array(n).keys()];
  const rounds: [number, number][][] = [];
  for (let r = 0; r < n - 1; r++) {
    const pairs: [number, number][] = [];
    for (let i = 0; i < n / 2; i++) {
      const a = ids[i];
      const b = ids[n - 1 - i];
      pairs.push(r % 2 ? [b, a] : [a, b]);
    }
    rounds.push(pairs);
    ids.splice(1, 0, ids.pop()!);
  }
  if (!twice) {
    // The user's journey: gyms in badge order (team ids 1..8), then the Elite Four in the last week.
    const userOpp = (pairs: [number, number][]) => pairs.flat().find((id, i, all) => all[i ^ 1] === 0 && id !== 0) ?? 0;
    rounds.sort((a, b) => userOpp(a) - userOpp(b));
  }
  const games: FGame[] = [];
  rounds.forEach((pairs, r) => pairs.forEach(([home, away]) => games.push({ week: r + 1, home, away, score: null })));
  if (twice) rounds.forEach((pairs, r) => pairs.forEach(([home, away]) => games.push({ week: r + n, home: away, away: home, score: null })));
  return games;
}

export function createFranchise(
  teams: (Omit<FTeam, 'id' | 'roster' | 'w' | 'l' | 'pf' | 'pa' | 'streak'>)[],
  rosters: Mon[][],
  leftovers: Mon[],
): Franchise {
  const players: Record<string, FPlayer> = {};
  let n = 0;
  const add = (m: Mon) => {
    const uid = `p${n++}`;
    players[uid] = { uid, dex: m.dex, level: 1, xp: 0, bonus: {}, stats: emptyStats(), ovrStart: m.ovr };
    return uid;
  };
  return {
    version: 1,
    season: 1,
    week: 1,
    phase: 'season',
    teams: teams.map((t, id) => ({ id, ...t, roster: rosters[id].map(add), w: 0, l: 0, pf: 0, pa: 0, streak: 0 })),
    players,
    freeAgents: leftovers.map(add),
    weeks: teams.length - 1,
    games: schedule(teams.length, false),
    signedWeek: 0,
    news: [],
    history: [],
  };
}

export function saveFranchise(f: Franchise) {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify(f));
  } catch { /* storage unavailable: the franchise lives for this visit only */ }
  // Regions this franchise earned stay unlocked on the device, even if the franchise is replaced.
  const earned = earnedUnlocks(f);
  if (earned.some((id) => loadRegionProfile().indexOf(id) < 0)) saveRegionProfile(earned);
}

/**
 * Older saves can hold retired Pokémon, which are no longer in the game: drop them from free agency and the
 * rookie class, and replace any on a roster with the best free agent at the same position.
 */
function retireLegacy(f: Franchise) {
  const gone = (u: string) => isRetired(f.players[u].dex);
  f.freeAgents = f.freeAgents.filter((u) => !gone(u));
  if (f.rookies) f.rookies.pool = f.rookies.pool.filter((u) => !gone(u) || f.rookies!.picks.includes(u));
  for (const t of f.teams) {
    for (const u of t.roster.filter(gone)) {
      const old = monOf(f, u);
      const fas = f.freeAgents.filter((x) => canAcquire(f, x)).sort((a, b) => monOf(f, b).ovr - monOf(f, a).ovr);
      const add = fas.find((x) => monOf(f, x).pos === old.pos) ?? fas[0];
      if (!add) continue;
      t.roster = t.roster.map((x) => (x === u ? add : x));
      if (t.lineup) t.lineup = t.lineup.map((x) => (x === u ? add : x));
      f.freeAgents.splice(f.freeAgents.indexOf(add), 1);
      f.news.unshift(`${old.name} left the league (retired from Poké Jam). ${t.name} signed ${monOf(f, add).name}.`);
    }
  }
  f.news = f.news.slice(0, 8);
}

const HEX = /^#[0-9a-f]{3,8}$/i;

/**
 * Saves come back from browser storage, where they could have been edited by hand: keep team names plain
 * and short, abbreviations exactly three letters and colors real hex colors before any of it reaches the page.
 */
function cleanTeams(teams: unknown, cpu: LeagueTeam[] = LEAGUE): boolean {
  if (!Array.isArray(teams) || !teams.length) return false;
  for (const [i, t] of (teams as { name: unknown; abbr: unknown; color: unknown; color2: unknown; human?: unknown }[]).entries()) {
    if (!t || typeof t !== 'object') return false;
    // A blocked name (a hand-edited save) becomes the team's default: the league's name for it, or Pallet Town for the player's.
    t.name = safeName(String(t.name ?? '').slice(0, 24) || 'Team', t.human ? 'Pallet Town' : cpu[i - 1]?.name ?? 'Team');
    t.abbr = fixAbbr(t.abbr, t.name as string);
    if (typeof t.color !== 'string' || !HEX.test(t.color)) t.color = USER_STYLE.color;
    if (typeof t.color2 !== 'string' || !HEX.test(t.color2)) t.color2 = USER_STYLE.color2;
  }
  return true;
}

export function loadFranchise(): Franchise | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const f = JSON.parse(raw) as Franchise;
    if (f?.version !== 1 || typeof f.players !== 'object' || !f.players || !Array.isArray(f.games)) return null;
    if (!cleanTeams(f.teams, regionTeams(regionById(f.region) ?? KANTO))) return null;
    reconcileRegions(f, loadRegionProfile());
    retireLegacy(f);
    const earned = earnedUnlocks(f);
    if (earned.some((id) => loadRegionProfile().indexOf(id) < 0)) saveRegionProfile(earned);
    return f;
  } catch {
    return null;
  }
}

const DRAFT_KEY = 'pokejam.draft.v1';

/** A league draft still in progress, so leaving to the menu doesn't lose picks. */
export function saveDraft(d: DraftState | null) {
  try {
    if (d) localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
    else localStorage.removeItem(DRAFT_KEY);
  } catch { /* storage unavailable */ }
}

export function loadDraft(): DraftState | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as DraftState;
    if (!cleanTeams(d?.teams) || !Array.isArray(d.order) || !Array.isArray(d.taken)) return null;
    // A franchise draft's pool boundary: only known regions count; anything else drafts from the first region alone.
    if (d.regions !== undefined) d.regions = openRegionIds(Array.isArray(d.regions) ? d.regions : []);
    return d;
  } catch {
    return null;
  }
}

export function clearFranchise() {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch { /* storage unavailable */ }
}

// ---------- regions ----------

const REGION_KEY = 'pokejam.regions.v1';

/** Known regions past the first, once each. */
const laterRegionIds = (ids: unknown): string[] =>
  Array.isArray(ids) ? REGIONS.filter((r) => r.index > 0 && ids.indexOf(r.id) >= 0).map((r) => r.id) : [];

/**
 * Regions unlocked on this device, apart from any one franchise: a new or replacement franchise keeps them.
 * A small versioned record; anything malformed counts as nothing unlocked.
 */
export function loadRegionProfile(): string[] {
  try {
    const raw = localStorage.getItem(REGION_KEY);
    if (!raw) return [];
    const p = JSON.parse(raw) as { v?: unknown; unlocked?: unknown } | null;
    return p && p.v === 1 ? laterRegionIds(p.unlocked) : [];
  } catch {
    return [];
  }
}

/** Adds `ids` to the device's unlocked regions (never removes any). */
export function saveRegionProfile(ids: string[]) {
  const unlocked = laterRegionIds([...loadRegionProfile(), ...ids]);
  try {
    localStorage.setItem(REGION_KEY, JSON.stringify({ v: 1, unlocked }));
  } catch { /* storage unavailable */ }
}

/** The region the league plays in. */
export const regionOf = (f: Franchise): RegionDef => regionById(f.region) ?? KANTO;

/** Region ids whose Pokémon this franchise may draft, sign, trade for and see as rookies. */
export const openRegions = (f: Franchise): string[] => openRegionIds([...(f.unlockedRegions ?? []), regionOf(f).id]);

/** Whether the user may pick up this player now (free agency, trades, rookie classes). Owned players are never touched. */
export const canAcquire = (f: Franchise, uid: string) => !!f.players[uid] && inPool(f.players[uid].dex, openRegions(f));

/** Gym badges of the league's region the user has won this season (the final opponent's emblem is not one). */
export function gymBadgeCount(f: Franchise): number {
  const won = badgesEarned(f);
  return regionOf(f).gyms.filter((g) => f.teams.some((t) => !t.human && t.gym === g.gym && t.name === g.name && won.has(t.id))).length;
}

/** The user's team won this season's title (the final is over). */
export const wonTitle = (f: Franchise) => f.phase === 'done' && f.champion === 0 && !!f.teams[0]?.human;

const addRecord = (list: RegionRecord[], regionId: string, season: number) => {
  if (!list.some((r) => r.regionId === regionId && r.season === season)) list.push({ regionId, season });
};

/**
 * Regions unlocked by this franchise's own completions: each one needs the region before it fully beaten, and that
 * region open when it was (the first region, the league's own, one in `known`, or one unlocked earlier in the chain),
 * so a Johto record can only unlock Hoenn for a franchise that could play in Johto.
 */
export function earnedUnlocks(f: Franchise, known: readonly string[] = f.unlockedRegions ?? []): string[] {
  const open = new Set([KANTO.id, regionOf(f).id, ...known]);
  const out: string[] = [];
  for (const r of REGIONS) {
    const prev = REGIONS.find((x) => x.index === r.index - 1);
    if (r.index === 0 || !prev || !open.has(prev.id) || !(f.completedRegions ?? []).some((c) => c.regionId === prev.id)) continue;
    out.push(r.id);
    open.add(r.id);
  }
  return out;
}

/**
 * Called when the final crowns a champion: a user title goes in the record book for the region, and a title with
 * all eight of the region's gym badges in the same season completes it, which unlocks the next region. Returns the
 * region newly unlocked, if any. Safe to call again.
 */
export function awardRegion(f: Franchise): RegionDef | undefined {
  if (!wonTitle(f)) return undefined;
  const r = regionOf(f);
  addRecord(f.titles ??= [], r.id, f.season);
  if (gymBadgeCount(f) < 8) return undefined;
  addRecord(f.completedRegions ??= [], r.id, f.season);
  const next = nextRegion(r);
  if (!next || (f.unlockedRegions ?? []).indexOf(next.id) >= 0) return undefined;
  (f.unlockedRegions ??= []).push(next.id);
  return next;
}

const cleanRecords = (list: unknown, season: number): RegionRecord[] => {
  const out: RegionRecord[] = [];
  if (!Array.isArray(list)) return out;
  for (const r of list as Partial<RegionRecord>[]) {
    if (r && regionById(r.regionId) && Number.isInteger(r.season) && r.season! >= 1 && r.season! <= season) addRecord(out, r.regionId!, r.season!);
  }
  return out;
};

/**
 * Region fields of a loaded save: the region is the one whose teams the league actually has (Kanto otherwise),
 * records are checked, and only proven evidence counts. An old save's finished season won by the user is a title,
 * and with all eight gym badges a full completion; so is the season it became PokeJam Master (title + every badge,
 * Kanto only). Unlocks are those earned here plus the device's.
 */
export function reconcileRegions(f: Franchise, device: string[]) {
  const cpu = f.teams.filter((t) => !t.human);
  const match = REGIONS.find((r) => {
    const teams = regionTeams(r);
    return teams.length === cpu.length && teams.every((t, i) => f.teams[i + 1]?.name === t.name);
  });
  f.region = match ? match.id : KANTO.id;
  f.titles = cleanRecords(f.titles, f.season);
  f.completedRegions = cleanRecords(f.completedRegions, f.season);
  const pm = f.pokejamMaster;
  if (f.region === KANTO.id && Number.isInteger(pm) && pm! >= 1 && pm! <= f.season) {
    addRecord(f.titles, KANTO.id, pm!);
    addRecord(f.completedRegions, KANTO.id, pm!);
  }
  awardRegion(f);
  f.unlockedRegions = laterRegionIds([...earnedUnlocks(f, device), ...device]);
}

/** Every region the user has won a title in, with the seasons: the hub's champion banners. */
export function regionTitles(f: Franchise): { region: RegionDef; seasons: number[] }[] {
  return REGIONS.map((region) => ({ region, seasons: (f.titles ?? []).filter((t) => t.regionId === region.id).map((t) => t.season).sort((a, b) => a - b) }))
    .filter((x) => x.seasons.length > 0);
}

/** A new season is set and nobody has played: the moment to move to another region. */
export const atSeasonStart = (f: Franchise) => f.phase === 'season' && f.week === 1 && !f.rookies && !f.games.some((g) => g.score);

export interface RegionStatus {
  /** The region after this one, if there is one. */
  next?: RegionDef;
  unlocked: boolean;
  /** This season's gym badges in the current region, out of 8. */
  badges: number;
  /** The user's team won this season's title. */
  title: boolean;
  /** The user can enter `next` right now. */
  canEnter: boolean;
}

export function regionStatus(f: Franchise): RegionStatus {
  const next = nextRegion(regionOf(f));
  const unlocked = !!next && (f.unlockedRegions ?? []).indexOf(next.id) >= 0;
  return { next, unlocked, badges: gymBadgeCount(f), title: wonTitle(f), canEnter: unlocked && atSeasonStart(f) && f.teams[0]?.human === true };
}

/**
 * Moves the league to an unlocked region at the start of a season. The user's team keeps everything (id, players,
 * levels, lineup, name and colors). The old CPU players join free agency; the region's teams come in with new
 * players from its data. Schedule and records start over; history, titles and awards stay.
 */
export function enterRegion(f: Franchise, id: string): boolean {
  const st = regionStatus(f);
  const r = st.next;
  if (!r || r.id !== id || !st.canEnter) return false;
  const from = regionOf(f);
  const cpu = regionTeams(r);
  if (cpu.some((t) => !t.roster || t.roster.length < 5)) return false;
  const fa = new Set(f.freeAgents);
  for (const t of f.teams) {
    if (t.human) continue;
    for (const u of t.roster) if (!fa.has(u) && f.players[u]) { f.freeAgents.push(u); fa.add(u); }
  }
  let n = Object.keys(f.players).reduce((a, k) => Math.max(a, /^p\d+$/.test(k) ? Number(k.slice(1)) + 1 : a), 0);
  const add = (dex: number) => {
    while (f.players[`p${n}`]) n++;
    const uid = `p${n++}`;
    f.players[uid] = { uid, dex, level: 1, xp: 0, bonus: {}, stats: emptyStats(), ovrStart: monByDex(dex).ovr };
    return uid;
  };
  const me = f.teams[0];
  f.teams = [me, ...cpu.map((t, i): FTeam => ({
    id: i + 1, name: t.name, abbr: t.abbr, color: t.color, color2: t.color2, human: false, leader: t.leader, types: [...t.types], boost: t.boost,
    ...(t.gym ? { gym: t.gym, badge: t.badge } : {}), ...(t.elite ? { elite: true } : {}),
    roster: t.roster!.map(add), w: 0, l: 0, pf: 0, pa: 0, streak: 0,
  }))];
  Object.assign(me, { w: 0, l: 0, pf: 0, pa: 0, streak: 0 });
  f.region = r.id;
  f.weeks = f.teams.length - 1;
  f.week = 1;
  f.games = schedule(f.teams.length, false);
  f.signedWeek = 0;
  // The new-season preview plays again, with the new region's teams.
  delete f.introShown;
  f.news = [`Welcome to the ${r.name} League! ${cpu[0].leader} and the ${cpu[0].name} are first.`, `The ${from.name} teams' players are now free agents.`];
  return true;
}

/** Win %, then point differential, then points scored. */
export function standings(f: Franchise): FTeam[] {
  const pct = (t: FTeam) => (t.w + t.l ? t.w / (t.w + t.l) : 0);
  return [...f.teams].sort((a, b) => pct(b) - pct(a) || (b.pf - b.pa) - (a.pf - a.pa) || b.pf - a.pf);
}

export const weekGames = (f: Franchise, week = f.week) => f.games.filter((g) => g.week === week);
export const userGame = (f: Franchise) => weekGames(f).find((g) => !g.score && (g.home === 0 || g.away === 0)) ?? null;

export const seasonWeeks = (f: Franchise) => f.weeks ?? 10;
export const semisWeek = (f: Franchise) => seasonWeeks(f) + 1;
export const finalWeek = (f: Franchise) => seasonWeeks(f) + 2;

export function weekLabel(f: Franchise, week = f.week): string {
  if (week <= seasonWeeks(f)) return `Week ${week} of ${seasonWeeks(f)}`;
  return week === semisWeek(f) ? 'Semifinals' : 'Final';
}

/** Ids of the gym and Elite Four teams the user has beaten this season (one badge each). */
export function badgesEarned(f: Franchise): Set<number> {
  const won = new Set<number>();
  for (const g of f.games) {
    if (!g.score || (g.home !== 0 && g.away !== 0)) continue;
    const opp = g.home === 0 ? g.away : g.home;
    const t = f.teams[opp];
    const userWon = (g.home === 0 ? g.score[0] > g.score[1] : g.score[1] > g.score[0]);
    if (userWon && (t.gym || t.elite)) won.add(opp);
  }
  return won;
}

export function teamDef(f: Franchise, id: number, human: boolean): { def: TeamDef; uidOf: Map<Mon, string> } {
  const t = f.teams[id];
  const uidOf = new Map<Mon, string>();
  const { starters, bench } = lineupOf(f, t);
  const toMon = (u: string) => {
    const m = monOf(f, u);
    uidOf.set(m, u);
    return m;
  };
  const roster = starters.map(toMon);
  return { def: { name: t.name, abbr: t.abbr, color: t.color, color2: t.color2, roster, bench: bench.map(toMon), human, boost: t.boost, coach: t.leader }, uidOf };
}

/** The home team's floor. */
export function venueOf(f: Franchise, teamId: number) {
  const t = f.teams[teamId];
  if (t.human) return userCourt(t.name);
  const region = REGIONS.find((r) => r.index > 0 && regionTeams(r).some((x) => x.name === t.name));
  const rt = region && regionTeams(region).find((x) => x.name === t.name);
  if (!region || !rt) return courtFor(t);
  // Later regions' floors: the classic floor in the team's colors, with its badge at center court.
  const city = rt.city ?? t.name;
  const up = city.toUpperCase();
  return {
    ...courtFor(t), venue: rt.elite ? city : `${city} Gym`, logo: rt.elite ? 'Elite' : rt.badge ?? 'pokeball', floorText: up,
    board: `${up} ★ ${region.name.toUpperCase()} LEAGUE ★ ${rt.elite ? (rt.title ?? 'THE FINAL BOSS').toUpperCase() : `THE ${(rt.badge ?? '').toUpperCase()} BADGE`}`,
  };
}

/** Teams as seen by the engine: the user's team is always engine team 0 so the controls stay the same. */
export function gameConfig(f: Franchise, game: FGame, humanPlays: boolean, quarterLen: number, difficulty: Difficulty, autoSubs = true) {
  const userIn = game.home === 0 || game.away === 0;
  const sides: [number, number] = userIn ? [0, game.home === 0 ? game.away : game.home] : [game.home, game.away];
  const a = teamDef(f, sides[0], humanPlays && sides[0] === 0);
  const b = teamDef(f, sides[1], false);
  // Two blues (you vs Misty) are hard to tell apart on the floor: give the second team a contrasting color.
  b.def = contrastAway(a.def, b.def);
  const uidOf = new Map([...a.uidOf, ...b.uidOf]);
  const cfg: GameConfig = { home: a.def, away: b.def, quarterLen, difficulty, court: venueOf(f, game.home), stamina: true, injuries: true, userAutoSubs: autoSubs };
  return { cfg, sides, uidOf };
}

/** Plays a CPU-controlled game with the real engine, yielding to the browser between slices. */
export function simulate(cfg: ConstructorParameters<typeof Game>[0]): Promise<Game> {
  return new Promise((resolve) => {
    const g = new Game(cfg);
    let steps = 0;
    const over = () => g.phase === 'final' || steps >= 400000;
    const slice = () => {
      const t0 = performance.now();
      while (!over() && performance.now() - t0 < 14) {
        for (let i = 0; i < 120 && !over(); i++, steps++) g.update(1 / 60);
        g.events.length = 0;
        g.sfx.length = 0;
      }
      if (over()) resolve(g);
      else setTimeout(slice, 0);
    };
    slice();
  });
}

function levelUp(p: FPlayer, rng = Math.random): string[] {
  const mon = monByDex(p.dex);
  const w = positionWeights(mon.pos);
  const keys = Object.keys(RATING_LABELS) as (keyof Ratings)[];
  const gains: string[] = [];
  for (let i = 0; i < 2; i++) {
    // Mostly the ratings that matter for the position, occasionally anything.
    const weights = keys.map((k) => (w[k] ?? 0) + 0.04);
    let x = rng() * weights.reduce((a, b) => a + b, 0);
    let k = keys[0];
    for (let j = 0; j < keys.length; j++) {
      x -= weights[j];
      if (x <= 0) { k = keys[j]; break; }
    }
    if (mon.r[k] + (p.bonus[k] ?? 0) >= 99) continue;
    p.bonus[k] = (p.bonus[k] ?? 0) + 1;
    gains.push(`+1 ${RATING_LABELS[k]}`);
  }
  return gains;
}

/**
 * Where a player on `team` may evolve to. A later region's gyms and final opponent never field a Pokémon from a later
 * generation than the region's own (Pryce's Piloswine stays a Piloswine in Johto); everyone else evolves freely.
 */
function evolutionsFor(f: Franchise, team: number, to: number[]): number[] {
  const t = f.teams[team];
  const r = regionOf(f);
  return t && !t.human && r.index > 0 ? to.filter((d) => d <= r.dex[1]) : to;
}

/** Applies a finished engine game to the league: score, standings, stats, XP, level-ups and evolutions. */
export function recordGame(f: Franchise, fg: FGame, g: Game, sides: [number, number], uidOf: Map<Mon, string>): Progress[] {
  const pts: Record<number, number> = { [sides[0]]: g.score[0], [sides[1]]: g.score[1] };
  fg.score = [pts[fg.home], pts[fg.away]];
  const winner = fg.score[0] > fg.score[1] ? fg.home : fg.away;

  if (!fg.round) {
    for (const id of [fg.home, fg.away]) {
      const t = f.teams[id];
      const won = id === winner;
      t.w += won ? 1 : 0;
      t.l += won ? 0 : 1;
      t.pf += pts[id];
      t.pa += pts[id === fg.home ? fg.away : fg.home];
      t.streak = won ? Math.max(1, t.streak + 1) : Math.min(-1, t.streak - 1);
    }
  }

  const progress: Progress[] = [];
  let best = -Infinity;
  const fullGame = g.cfg.quarterLen * 4;
  for (const gp of [...g.rosterOf(0), ...g.rosterOf(1)]) {
    const uid = uidOf.get(gp.mon);
    if (!uid) continue;
    const p = f.players[uid];
    const s = gp.stats;
    if (s.sec > 0) p.stats.gp++;
    if (gp.hurt) {
      // +1 because the week this game belongs to is about to tick off in advance().
      p.injury = Math.max(p.injury ?? 0, gp.hurt + 1);
      f.news.unshift(`${f.teams[sides[gp.team]].name}'s ${gp.mon.name} is out ${gp.hurt} week${gp.hurt > 1 ? 's' : ''}.`);
    }
    // `?? 0` covers stats saved before a field existed.
    for (const k of Object.keys(s) as (keyof PStats)[]) p.stats[k] = (p.stats[k] ?? 0) + s[k];
    const score = gameScore(s);
    if (score > best) { best = score; fg.pog = uid; }

    const team = sides[gp.team];
    // XP follows minutes: a full game is worth 15 on top of production; a DNP still earns 5 in practice.
    const share = Math.min(1, s.sec / fullGame);
    p.xp += Math.round(5 + 10 * share + s.pts * 0.8 + s.reb + s.ast * 1.5 + (s.stl + s.blk) * 2 + (team === winner ? 10 * share : 0));
    while (p.xp >= xpToNext(p.level)) {
      p.xp -= xpToNext(p.level);
      p.level++;
      const name = monByDex(p.dex).name;
      const entry: Progress = { uid, team, name, level: p.level, gains: levelUp(p) };
      const evo = EVOLUTIONS[p.dex];
      const to = evo ? evolutionsFor(f, team, evo.to) : [];
      if (evo && to.length && p.level >= evo.level) {
        entry.evolvedFrom = p.dex;
        p.dex = to[Math.floor(Math.random() * to.length)];
        entry.evolvedTo = p.dex;
        const owner = f.teams[team];
        f.news.unshift(`${owner.name}'s ${name} evolved into ${monByDex(p.dex).name}!`);
      }
      progress.push(entry);
    }
  }
  fg.q = g.quarter;
  fg.box = [...g.rosterOf(0), ...g.rosterOf(1)].flatMap((gp): BoxLine[] => {
    const uid = uidOf.get(gp.mon);
    if (!uid) return [];
    const s = gp.stats;
    return [[uid, gp.mon.dex, sides[gp.team] === fg.home ? 0 : 1, gp.starter ? 1 : 0, Math.round(s.sec), s.pts, s.fgm, s.fga, s.tpm, s.tpa, s.reb, s.ast, s.stl, s.blk, s.dnk]];
  });
  f.news = f.news.slice(0, 8);
  return progress;
}

/** Moves the league forward once every game this week is final: next week, playoffs, or a crowned champion. */
export function advance(f: Franchise) {
  if (weekGames(f).some((g) => !g.score)) return;
  // A week passes: everyone on the injury list gets a week closer to healthy.
  for (const p of Object.values(f.players)) if (p.injury) p.injury--;
  if (f.phase === 'season' && f.week < seasonWeeks(f)) {
    f.week++;
  } else if (f.phase === 'season') {
    const seeds = standings(f).slice(0, 4).map((t) => t.id);
    f.phase = 'playoffs';
    f.week = semisWeek(f);
    f.games.push(
      { week: f.week, home: seeds[0], away: seeds[3], score: null, round: 'semi' },
      { week: f.week, home: seeds[1], away: seeds[2], score: null, round: 'semi' },
    );
    f.news.unshift(`Playoffs set: ${seeds.map((id, i) => `${i + 1}. ${f.teams[id].name}`).join(', ')}`);
  } else if (f.week === semisWeek(f)) {
    const winners = weekGames(f).map((g) => (g.score![0] > g.score![1] ? g.home : g.away));
    f.week++;
    f.games.push({ week: f.week, home: winners[0], away: winners[1], score: null, round: 'final' });
  } else {
    const fin = weekGames(f)[0];
    f.champion = fin.score![0] > fin.score![1] ? fin.home : fin.away;
    f.phase = 'done';
    f.awards = computeAwards(f);
    f.mvp = f.awards.find((a) => a.key === 'mvp')?.uid;
    for (const a of [...f.awards].reverse()) f.news.unshift(`${a.label}: ${monOf(f, a.uid).name} (${f.teams[a.team].abbr}), ${a.line}`);
    const champ = f.teams[f.champion];
    f.history.push({ season: f.season, champion: champ.name, mvp: f.mvp ? monByDex(f.players[f.mvp].dex).name : '—', region: regionOf(f).id });
    f.news.unshift(`${champ.name} win the Season ${f.season} championship!`);
    const opened = awardRegion(f);
    if (opened) f.news.unshift(`Every ${regionOf(f).name} badge and the title: the ${opened.name} League is unlocked!`);
  }
  f.news = f.news.slice(0, 8);
}

/** Season awards from per-game numbers; a player needs at least four games to qualify. */
function computeAwards(f: Franchise): Award[] {
  const pool = f.teams.flatMap((t) => t.roster.map((uid) => ({ uid, team: t.id, p: f.players[uid] })))
    .filter(({ p }) => p.stats.gp >= 4);
  const pg = (p: FPlayer, k: keyof SeasonStats) => (p.stats[k] ?? 0) / p.stats.gp;
  const line = (p: FPlayer) => `${pg(p, 'pts').toFixed(1)} PPG · ${pg(p, 'reb').toFixed(1)} RPG · ${pg(p, 'ast').toFixed(1)} APG`;
  const best = (list: typeof pool, score: (p: FPlayer) => number) =>
    [...list].sort((a, b) => score(b.p) - score(a.p))[0];
  const out: Award[] = [];
  const add = (key: Award['key'], label: string, pick: (typeof pool)[number] | undefined, text: (p: FPlayer) => string) => {
    if (pick) out.push({ key, label, uid: pick.uid, team: pick.team, line: text(pick.p) });
  };
  add('mvp', 'MVP', best(pool, (p) => gameScore(p.stats) / p.stats.gp), line);
  add('scoring', 'Scoring title', best(pool, (p) => pg(p, 'pts')), (p) => `${pg(p, 'pts').toFixed(1)} PPG`);
  add('dpoy', 'Defensive Player', best(pool, (p) => pg(p, 'stl') * 2 + pg(p, 'blk') * 2 + pg(p, 'reb') * 0.5),
    (p) => `${pg(p, 'stl').toFixed(1)} STL · ${pg(p, 'blk').toFixed(1)} BLK`);
  const bench = pool.filter(({ p }) => (p.stats.gs ?? 0) <= p.stats.gp / 2);
  add('smoy', 'Sixth Man', best(bench, (p) => gameScore(p.stats) / p.stats.gp), line);
  const improved = pool.filter(({ uid, p }) => p.ovrStart !== undefined && monOf(f, uid).ovr - p.ovrStart >= 1);
  add('mip', 'Most Improved', best(improved, (p) => withBonus(p.dex, p.bonus).ovr - (p.ovrStart ?? 0)),
    (p) => `${p.ovrStart} → ${withBonus(p.dex, p.bonus).ovr} OVR`);
  return out;
}

/** Same rosters and levels, fresh schedule and records. */
export function nextSeason(f: Franchise) {
  f.season++;
  f.week = 1;
  f.phase = 'season';
  f.champion = undefined;
  f.mvp = undefined;
  f.signedWeek = 0;
  f.games = schedule(f.teams.length, !f.weeks);
  for (const t of f.teams) Object.assign(t, { w: 0, l: 0, pf: 0, pa: 0, streak: 0 });
  for (const [uid, p] of Object.entries(f.players)) {
    p.stats = emptyStats();
    p.ovrStart = monOf(f, uid).ovr;
    p.injury = 0;
  }
  f.awards = undefined;
  f.news = [`Season ${f.season} tips off.`];
}

export const canSign = (f: Franchise) => f.phase !== 'done' && f.signedWeek < f.week;

// ---------- trades ----------

/** Trading is open until three weeks before the regular season ends, and again in the offseason. */
export const tradeDeadline = (f: Franchise) => Math.max(1, seasonWeeks(f) - 3);
export const canTrade = (f: Franchise) => (f.phase === 'season' && f.week <= tradeDeadline(f)) || f.phase === 'done';

/** What a Pokémon is worth to a team: rating first, then level and evolution upside. */
export function tradeValue(f: Franchise, uid: string, toTeam?: FTeam): number {
  const p = f.players[uid];
  const m = monOf(f, uid);
  let v = Math.pow(Math.max(0, m.ovr - 55), 1.5);
  const evo = EVOLUTIONS[p.dex];
  if (evo) {
    // Upside: the best form it can reach, discounted by how far away it is.
    const best = Math.max(...evo.to.map((d) => withBonus(d, p.bonus).ovr));
    const away = Math.max(0, evo.level - p.level);
    v += Math.max(0, Math.pow(Math.max(0, best - 55), 1.5) - v) * (0.55 - away * 0.08);
  }
  if ((p.injury ?? 0) > 0) v *= 0.75;
  if (toTeam?.types && m.types.some((t) => toTeam.types!.includes(t))) v *= 1.15;
  return v;
}

export interface TradeVerdict {
  ok: boolean;
  /** -1 (insulting) … 0 (fair) … 1 (they love it), for the meter. */
  lean: number;
  reason: string;
}

/** The other GM's answer to `give` (yours) for `get` (theirs). */
export function judgeTrade(f: Franchise, teamId: number, give: string[], get: string[]): TradeVerdict {
  if (!canTrade(f)) return { ok: false, lean: 0, reason: 'The trade deadline has passed. Trading reopens in the offseason.' };
  if (!give.length || give.length !== get.length) return { ok: false, lean: 0, reason: 'Pick the same number of players on each side (1 or 2).' };
  const them = f.teams[teamId];
  const locked = get.find((u) => !canAcquire(f, u));
  if (locked) {
    const r = REGIONS.find((x) => f.players[locked].dex >= x.dex[0] && f.players[locked].dex <= x.dex[1]);
    return { ok: false, lean: 0, reason: `${monOf(f, locked).name} is a ${r?.name ?? 'locked'} Pokémon: unlock ${r?.name ?? 'its region'} to trade for it.` };
  }
  const incoming = give.reduce((a, u) => a + tradeValue(f, u, them), 0);
  const outgoing = get.reduce((a, u) => a + tradeValue(f, u, them), 0);
  // They want to come out a little ahead.
  const ratio = incoming / Math.max(1, outgoing * 1.05);
  const lean = Math.max(-1, Math.min(1, (ratio - 1) * 2.5));
  const who = them.leader ?? them.name;
  if (ratio >= 1) return { ok: true, lean, reason: `${who}: "Deal!"` };
  if (ratio >= 0.85) return { ok: false, lean, reason: `${who}: "Close. Add a little more."` };
  if (ratio >= 0.6) return { ok: false, lean, reason: `${who}: "That's not enough."` };
  return { ok: false, lean, reason: `${who}: "Not even close."` };
}

export function makeTrade(f: Franchise, teamId: number, give: string[], get: string[]): boolean {
  if (!judgeTrade(f, teamId, give, get).ok) return false;
  const me = f.teams[0];
  const them = f.teams[teamId];
  me.roster = me.roster.map((u) => (give.includes(u) ? get[give.indexOf(u)] : u));
  them.roster = them.roster.map((u) => (get.includes(u) ? give[get.indexOf(u)] : u));
  if (me.lineup) me.lineup = me.lineup.map((u) => (give.includes(u) ? get[give.indexOf(u)] : u));
  delete them.lineup;
  const names = (us: string[]) => us.map((u) => monOf(f, u).name).join(' and ');
  f.news.unshift(`Trade! ${me.name} send ${names(give)} to ${them.name} for ${names(get)}.`);
  f.news = f.news.slice(0, 8);
  return true;
}

export function sign(f: Franchise, release: string, add: string) {
  const team = f.teams[0];
  const i = team.roster.indexOf(release);
  const j = f.freeAgents.indexOf(add);
  if (i < 0 || j < 0 || !canSign(f) || !canAcquire(f, add)) return;
  team.roster[i] = add;
  if (team.lineup) team.lineup = team.lineup.map((u) => (u === release ? add : u));
  f.freeAgents[j] = release;
  f.signedWeek = f.week;
  f.news.unshift(`${team.name} signed ${monOf(f, add).name} and released ${monOf(f, release).name}.`);
  f.news = f.news.slice(0, 8);
}

/** The best form a Pokémon can grow into in franchise mode, and the level it gets there. */
export function potentialOf(dex: number, bonus: Partial<Ratings> = {}): { dex: number; ovr: number; level: number } {
  const ovrOf = (d: number) => withBonus(d, bonus).ovr;
  let best = { dex, ovr: ovrOf(dex), level: 1 };
  const walk = (d: number, seen: number) => {
    const evo = EVOLUTIONS[d];
    if (!evo || seen > 3) return;
    for (const to of evo.to) {
      const o = ovrOf(to);
      if (o > best.ovr) best = { dex: to, ovr: o, level: evo.level };
      walk(to, seen + 1);
    }
  };
  walk(dex, 0);
  return best;
}

/** Prospects per class. */
const CLASS_SIZE = 24;
/** How many past classes a prospect sits out. */
const CLASS_MEMORY = 3;
/** No rookie's fully grown form rates above this (the best class ceiling the draft has always had). */
const POTENTIAL_CAP = 91;
/** Prospects must be able to grow to at least this (the weakest class ceiling the draft has always had). */
const MIN_POTENTIAL = 62;
const inRange = (pot: number) => pot >= MIN_POTENTIAL && pot <= POTENTIAL_CAP;

function mulberry32(seed: number) {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hashOf = (text: string) => {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
};

/** The save's draft seed. Older saves get one from their team names and starting rosters, then keep it. */
function draftSeed(f: Franchise): number {
  f.seed ??= hashOf(f.teams.map((t) => `${t.name}:${t.roster.join(',')}`).join('|') + Object.keys(f.players).length);
  return f.seed;
}

/** Pokémon with no earlier form: the only ones that show up as rookies. */
const BASICS = (() => {
  const later = new Set(Object.values(EVOLUTIONS).flatMap((e) => e.to));
  return (dex: number) => !later.has(dex);
})();

/**
 * Picks `n` of `cands` at random with soft quotas: each pick makes its type and position less likely
 * next time, empty positions are favored, and better prospects are somewhat more likely.
 */
function pickClass(cands: number[], n: number, rng: () => number, bonusOf: (dex: number) => Partial<Ratings>): number[] {
  const left = [...cands];
  const out: number[] = [];
  const typeCount: Record<string, number> = {};
  const posCount: Record<string, number> = {};
  const cap = Math.ceil(n / 4);
  while (out.length < n && left.length) {
    const weights = left.map((d) => {
      const m = monByDex(d);
      const pos = posCount[m.pos] ?? 0;
      let w = Math.exp((potentialOf(d, bonusOf(d)).ovr - 76) / 12);
      for (const t of m.types) w *= Math.pow(0.45, typeCount[t] ?? 0);
      w *= pos === 0 ? 3 : pos >= cap ? 0.15 : Math.pow(0.7, pos);
      return w;
    });
    let x = rng() * weights.reduce((a, b) => a + b, 0);
    let i = 0;
    while (i < left.length - 1 && (x -= weights[i]) > 0) i++;
    const m = monByDex(left[i]);
    for (const t of m.types) typeCount[t] = (typeCount[t] ?? 0) + 1;
    posCount[m.pos] = (posCount[m.pos] ?? 0) + 1;
    out.push(left.splice(i, 1)[0]);
  }
  return out;
}

/**
 * A prospect's talent roll, added to every rating: mostly small (bell-shaped), now and then a gem (+5) or a bust
 * (-5). Never lifts the grown-up form past POTENTIAL_CAP.
 */
function talentRoll(dex: number, rng: () => number): Partial<Ratings> {
  const r = rng();
  const bell = (rng() + rng() + rng() + rng() - 2) * 3.5;
  let delta = r < 0.06 ? 5 : r < 0.12 ? -5 : Math.round(bell);
  const bonusOf = (d: number) => Object.fromEntries((Object.keys(RATING_LABELS) as (keyof Ratings)[]).map((k) => [k, d])) as Partial<Ratings>;
  while (delta > 0 && potentialOf(dex, bonusOf(delta)).ovr > Math.max(POTENTIAL_CAP, potentialOf(dex).ovr)) delta--;
  return delta ? bonusOf(delta) : {};
}

/**
 * Sets up the rookie draft once the final is over. Prospects are level-1 free agents with no earlier form
 * (they can still evolve), drawn at random from the whole pool with the save's seed and the season: no repeats
 * of recent classes, a mix of types and positions, and a talent roll each. Short pools fall back to older
 * classes, then to anyone available.
 */
export function startRookieDraft(f: Franchise) {
  if (f.phase !== 'done' || f.rookies) return;
  const rng = mulberry32(draftSeed(f) ^ Math.imul(f.season, 0x9e3779b1));
  const classes = f.classes ?? [];
  const fresh = f.freeAgents.filter((u) => canAcquire(f, u) && f.players[u].level === 1 && BASICS(f.players[u].dex) && inRange(potentialOf(f.players[u].dex).ovr)).sort((a, b) => f.players[a].dex - f.players[b].dex);
  const byDex = new Map<number, string>();
  for (const u of fresh) if (!byDex.has(f.players[u].dex)) byDex.set(f.players[u].dex, u);
  // Skip the last few classes; if that leaves too few, bring back the oldest ones first.
  let recent = classes.slice(-CLASS_MEMORY);
  const dexes = () => [...byDex.keys()].filter((d) => !recent.some((c) => c.dexes.includes(d)));
  while (dexes().length < CLASS_SIZE && recent.length) recent = recent.slice(1);
  let cands = dexes();
  if (cands.length < CLASS_SIZE) {
    // Still short: any free agent will do, but never a duplicate Pokémon.
    for (const u of f.freeAgents.filter((x) => canAcquire(f, x) && !byDex.has(f.players[x].dex)).sort((a, b) => f.players[a].dex - f.players[b].dex)) {
      if (!byDex.has(f.players[u].dex)) byDex.set(f.players[u].dex, u);
    }
    cands = [...byDex.keys()].filter((d) => !recent.some((c) => c.dexes.includes(d)));
    if (cands.length < CLASS_SIZE) cands = [...byDex.keys()];
  }
  // Talent first, so the quota weights see each prospect as he really is.
  const bonuses = new Map(cands.map((d) => [d, talentRoll(d, rng)] as const));
  const chosen = pickClass(cands, CLASS_SIZE, rng, (d) => bonuses.get(d) ?? {});
  const pool = chosen.map((d) => byDex.get(d)!);
  for (const u of pool) f.players[u].bonus = { ...bonuses.get(f.players[u].dex) };
  pool.sort((a, b) => potentialOf(f.players[b].dex, f.players[b].bonus).ovr - potentialOf(f.players[a].dex, f.players[a].bonus).ovr);
  f.classes = [...classes.filter((c) => c.season !== f.season), { season: f.season, dexes: pool.map((u) => f.players[u].dex) }].slice(-6);
  const order = standings(f).reverse().map((t) => t.id);
  if (f.champion !== undefined) order.push(...order.splice(order.indexOf(f.champion), 1));
  f.rookies = { order, picks: [], pool };
}

/** Whose pick it is, or null once every team has picked. */
export const rookieOnClock = (f: Franchise): FTeam | null =>
  f.rookies && f.rookies.picks.length < f.rookies.order.length ? f.teams[f.rookies.order[f.rookies.picks.length]] : null;

export const rookieLeft = (f: Franchise) => (f.rookies ? f.rookies.pool.filter((u) => !f.rookies!.picks.includes(u)) : []);

/** Rookie value for a team: grown-up rating, how soon it gets there, its type, and an open position. */
function rookieScore(f: Franchise, uid: string, t: FTeam): number {
  const m = monOf(f, uid);
  const pot = potentialOf(m.dex, f.players[uid].bonus);
  const have = t.roster.filter((u) => monOf(f, u).pos === m.pos).length;
  return pot.ovr * 1.2 + m.ovr * 0.3 - pot.level * 1.5 + (have === 0 ? 6 : have === 1 ? 2 : 0)
    + (t.types?.length && m.types.some((ty) => t.types!.includes(ty))
      && !t.roster.some((u) => monOf(f, u).types.some((ty) => t.types!.includes(ty))) ? 5 : 0) + rookieJitter(f, uid, t) * 3;
}

/** A little noise in CPU rookie picks, fixed by the save's seed: the same save drafts the same way. */
function rookieJitter(f: Franchise, uid: string, t: FTeam): number {
  let h = draftSeed(f) ^ Math.imul(f.season, 0x9e3779b1) ^ Math.imul(t.id + 1, 0x85ebca6b);
  for (let i = 0; i < uid.length; i++) h = Math.imul(h ^ uid.charCodeAt(i), 0x01000193);
  return mulberry32(h >>> 0)();
}

/** Makes the current pick: `uid` for the team on the clock, or the CPU's choice when omitted. */
export function rookiePick(f: Franchise, uid?: string): string | null {
  const t = rookieOnClock(f);
  const left = rookieLeft(f);
  if (!t || !left.length) return null;
  const pick = uid && left.includes(uid) ? uid : left.reduce((a, b) => (rookieScore(f, b, t) > rookieScore(f, a, t) ? b : a));
  f.rookies!.picks.push(pick);
  t.roster.push(pick);
  if (t.lineup) t.lineup.push(pick);
  f.freeAgents.splice(f.freeAgents.indexOf(pick), 1);
  return pick;
}

/** CPU teams cut their least valuable player; the user cuts `release`. Then the next season starts. */
export function finishRookieDraft(f: Franchise, release: string) {
  const r = f.rookies;
  if (!r || rookieOnClock(f)) return;
  const cut = (t: FTeam, uid: string) => {
    t.roster = t.roster.filter((u) => u !== uid);
    if (t.lineup) t.lineup = t.lineup.filter((u) => u !== uid);
    f.freeAgents.push(uid);
  };
  const me = f.teams[0];
  if (me.roster.includes(release)) cut(me, release);
  for (const t of f.teams) {
    if (t.human || t.roster.length <= 10) continue;
    cut(t, t.roster.reduce((a, b) => (tradeValue(f, b, t) < tradeValue(f, a, t) ? b : a)));
  }
  const mine = r.picks[r.order.indexOf(0)];
  delete f.rookies;
  nextSeason(f);
  f.draftedRookie = mine && me.roster.includes(mine) ? mine : undefined;
  if (mine &&me.roster.includes(mine)) f.news.push(`${me.name} drafted ${monOf(f, mine).name} in the rookie draft.`);
  const top = r.picks[0];
  f.news.push(`${f.teams[r.order[0]].name} took ${monOf(f, top).name} first overall.`);
}
