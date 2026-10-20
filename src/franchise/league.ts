import { EVOLUTIONS, RATING_LABELS, monByDex, positionWeights, withBonus, type Mon, type PokeType, type Ratings } from '../data/pokemon';
import { Game } from '../game/game';
import type { Difficulty, PStats, TeamDef } from '../game/types';
import type { DraftState } from '../screens/draft';

const SAVE_KEY = 'pokejam.franchise.v1';
/** XP needed to go from `level` to the next one; each level costs a bit more. */
export const xpToNext = (level: number) => 60 + 25 * (level - 1);

/** The rest of the league: the eight Kanto gyms in badge order, then the Elite Four. */
export interface LeagueTeam {
  name: string;
  abbr: string;
  color: string;
  color2: string;
  leader: string;
  /** Types this team's GM favors in the draft. */
  types: PokeType[];
  /** Added to every rating in games: gyms get tougher in badge order and the Elite Four is the final boss. */
  boost: number;
  gym?: number;
  badge?: string;
  elite?: boolean;
}

export const LEAGUE: LeagueTeam[] = [
  { name: 'Pewter Boulders', abbr: 'PEW', color: '#a38c63', color2: '#2e271b', leader: 'Brock', types: ['Rock'], boost: -3, gym: 1, badge: 'Boulder' },
  { name: 'Cerulean Cascades', abbr: 'CER', color: '#2bb3d6', color2: '#0b2c38', leader: 'Misty', types: ['Water'], boost: -2, gym: 2, badge: 'Cascade' },
  { name: 'Vermilion Thunder', abbr: 'VER', color: '#f2c522', color2: '#3a2f06', leader: 'Lt. Surge', types: ['Electric'], boost: -1, gym: 3, badge: 'Thunder' },
  { name: 'Celadon Rainbows', abbr: 'CEL', color: '#5cb85c', color2: '#13301a', leader: 'Erika', types: ['Grass'], boost: 0, gym: 4, badge: 'Rainbow' },
  { name: 'Fuchsia Ninjas', abbr: 'FCH', color: '#b04fc4', color2: '#2d1236', leader: 'Koga', types: ['Poison'], boost: 1, gym: 5, badge: 'Soul' },
  { name: 'Saffron Psychics', abbr: 'SAF', color: '#f2668b', color2: '#3a1220', leader: 'Sabrina', types: ['Psychic'], boost: 2, gym: 6, badge: 'Marsh' },
  { name: 'Cinnabar Volcanoes', abbr: 'CIN', color: '#e8622c', color2: '#3d160b', leader: 'Blaine', types: ['Fire'], boost: 2, gym: 7, badge: 'Volcano' },
  { name: 'Viridian Quakes', abbr: 'VIR', color: '#7c9a3a', color2: '#1e2a0e', leader: 'Giovanni', types: ['Ground'], boost: 3, gym: 8, badge: 'Earth' },
  { name: 'Indigo Elite', abbr: 'E4', color: '#d4a017', color2: '#2a2106', leader: 'The Elite Four', types: ['Ice', 'Fighting', 'Ghost', 'Dragon'], boost: 4, elite: true },
];
export const USER_STYLE = { color: '#3b6fd8', color2: '#16224a' };

export interface SeasonStats extends PStats { gp: number }

export interface FPlayer {
  uid: string;
  dex: number;
  level: number;
  xp: number;
  bonus: Partial<Ratings>;
  stats: SeasonStats;
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
}

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
  history: { season: number; champion: string; mvp: string }[];
}

const emptyStats = (): SeasonStats => ({ gp: 0, pts: 0, fgm: 0, fga: 0, tpm: 0, tpa: 0, reb: 0, ast: 0, stl: 0, blk: 0, dnk: 0 });

export const monOf = (f: Franchise, uid: string): Mon => {
  const p = f.players[uid];
  return withBonus(p.dex, p.bonus);
};

export const teamOvrOf = (f: Franchise, t: FTeam) =>
  Math.round(t.roster.reduce((a, u) => a + monOf(f, u).ovr, 0) / t.roster.length);

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
    players[uid] = { uid, dex: m.dex, level: 1, xp: 0, bonus: {}, stats: emptyStats() };
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
}

export function loadFranchise(): Franchise | null {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return null;
    const f = JSON.parse(raw) as Franchise;
    return f.version === 1 ? f : null;
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
    return raw ? (JSON.parse(raw) as DraftState) : null;
  } catch {
    return null;
  }
}

export function clearFranchise() {
  try {
    localStorage.removeItem(SAVE_KEY);
  } catch { /* storage unavailable */ }
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
  const roster = t.roster.map((u) => {
    const m = monOf(f, u);
    uidOf.set(m, u);
    return m;
  });
  return { def: { name: t.name, abbr: t.abbr, color: t.color, color2: t.color2, roster, human, boost: t.boost, coach: t.leader }, uidOf };
}

/** Teams as seen by the engine: the user's team is always engine team 0 so the controls stay the same. */
export function gameConfig(f: Franchise, game: FGame, humanPlays: boolean, quarterLen: number, difficulty: Difficulty) {
  const userIn = game.home === 0 || game.away === 0;
  const sides: [number, number] = userIn ? [0, game.home === 0 ? game.away : game.home] : [game.home, game.away];
  const a = teamDef(f, sides[0], humanPlays && sides[0] === 0);
  const b = teamDef(f, sides[1], false);
  const uidOf = new Map([...a.uidOf, ...b.uidOf]);
  return { cfg: { home: a.def, away: b.def, quarterLen, difficulty }, sides, uidOf };
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
  for (const gp of g.players) {
    const uid = uidOf.get(gp.mon);
    if (!uid) continue;
    const p = f.players[uid];
    const s = gp.stats;
    p.stats.gp++;
    for (const k of Object.keys(s) as (keyof PStats)[]) p.stats[k] += s[k];
    const score = gameScore(s);
    if (score > best) { best = score; fg.pog = uid; }

    const team = sides[gp.team];
    p.xp += Math.round(15 + s.pts * 0.8 + s.reb + s.ast * 1.5 + (s.stl + s.blk) * 2 + (team === winner ? 10 : 0));
    while (p.xp >= xpToNext(p.level)) {
      p.xp -= xpToNext(p.level);
      p.level++;
      const name = monByDex(p.dex).name;
      const entry: Progress = { uid, team, name, level: p.level, gains: levelUp(p) };
      const evo = EVOLUTIONS[p.dex];
      if (evo && p.level >= evo.level) {
        entry.evolvedFrom = p.dex;
        p.dex = evo.to[Math.floor(Math.random() * evo.to.length)];
        entry.evolvedTo = p.dex;
        const owner = f.teams[team];
        f.news.unshift(`${owner.name}'s ${name} evolved into ${monByDex(p.dex).name}!`);
      }
      progress.push(entry);
    }
  }
  f.news = f.news.slice(0, 8);
  return progress;
}

/** Moves the league forward once every game this week is final: next week, playoffs, or a crowned champion. */
export function advance(f: Franchise) {
  if (weekGames(f).some((g) => !g.score)) return;
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
    const rostered = f.teams.flatMap((t) => t.roster);
    f.mvp = rostered
      .map((u) => f.players[u])
      .filter((p) => p.stats.gp >= 4)
      .sort((a, b) => gameScore(b.stats) / b.stats.gp - gameScore(a.stats) / a.stats.gp)[0]?.uid;
    const champ = f.teams[f.champion];
    f.history.push({ season: f.season, champion: champ.name, mvp: f.mvp ? monByDex(f.players[f.mvp].dex).name : '—' });
    f.news.unshift(`${champ.name} win the Season ${f.season} championship!`);
  }
  f.news = f.news.slice(0, 8);
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
  for (const p of Object.values(f.players)) p.stats = emptyStats();
  f.news = [`Season ${f.season} tips off.`];
}

export const canSign = (f: Franchise) => f.phase !== 'done' && f.signedWeek < f.week;

export function sign(f: Franchise, release: string, add: string) {
  const team = f.teams[0];
  const i = team.roster.indexOf(release);
  const j = f.freeAgents.indexOf(add);
  if (i < 0 || j < 0 || !canSign(f)) return;
  team.roster[i] = add;
  f.freeAgents[j] = release;
  f.signedWeek = f.week;
  f.news.unshift(`${team.name} signed ${monOf(f, add).name} and released ${monOf(f, release).name}.`);
  f.news = f.news.slice(0, 8);
}
