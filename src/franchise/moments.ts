// The two franchise "moments": the championship cutscene after the final, and the new-season preview after
// the rookie draft. Everything here reads the save; nothing is invented.
import { monOf, standings, teamOvrOf, type FGame, type FTeam, type Franchise } from './league';
import { ordinal } from '../screens/draft.logic';

/** Season 1 starts in this year's autumn: 2025 + 1 = 2026. */
export const BASE_YEAR = 2025;

/** Saves count seasons 1, 2, 3...; shown as a year range: season 1 = "2026–27", season 74 = "2099–00". */
export const seasonLabel = (season: number) => {
  const start = BASE_YEAR + season;
  const end = (start + 1) % 100;
  return `${start}–${end < 10 ? '0' : ''}${end}`;
};

/** The cutscene plays once per season, right after the final ends and before the rookie draft. */
export const shouldShowChampionship = (f: Franchise) =>
  f.phase === 'done' && f.champion !== undefined && !!f.teams[f.champion] && f.titleShown !== f.season;

/** The preview shows once, at the start of every season after the first, before anyone has played. */
export const shouldShowNewSeason = (f: Franchise) =>
  f.phase === 'season' && f.season > 1 && f.week === 1 && f.introShown !== f.season && !f.games.some((g) => g.score);

export const finalGame = (f: Franchise): FGame | undefined => f.games.find((g) => g.round === 'final' && g.score);

export interface Spotlight { uid: string; label: string }

/** Finals MVP is the final's player of the game when on the champion; otherwise the champion's season MVP, then its best player. */
export function spotlightOf(f: Franchise, champ: FTeam): Spotlight | null {
  const fin = finalGame(f);
  if (fin && fin.pog && champ.roster.indexOf(fin.pog) >= 0 && f.players[fin.pog]) return { uid: fin.pog, label: 'Finals MVP' };
  if (f.mvp && champ.roster.indexOf(f.mvp) >= 0 && f.players[f.mvp]) return { uid: f.mvp, label: 'Season MVP' };
  const best = [...champ.roster].sort((a, b) => monOf(f, b).ovr - monOf(f, a).ovr)[0];
  return best ? { uid: best, label: 'Top player' } : null;
}

export interface Cast { mvp: string | null; crew: string[] }

/** Who celebrates on the court: the MVP (centre, trophy overhead) plus the champion's best players, up to `max` in all. */
export function celebrationCast(f: Franchise, champ: FTeam, max = 8): Cast {
  const spot = spotlightOf(f, champ);
  const mvp = spot ? spot.uid : null;
  const crew = champ.roster
    .filter((u) => u !== mvp && f.players[u])
    .sort((a, b) => monOf(f, b).ovr - monOf(f, a).ovr)
    .slice(0, Math.max(0, max - (mvp ? 1 : 0)));
  return { mvp, crew };
}

/** Where the user's team finished, from the playoff games and the final standings. */
export function userFinish(f: Franchise): string {
  if (f.champion === 0) return 'You won the title.';
  const inRound = (r: 'semi' | 'final') => f.games.some((g) => g.round === r && (g.home === 0 || g.away === 0));
  if (inRound('final')) return 'Your team lost in the Final.';
  if (inRound('semi')) return 'Your team lost in the semifinals.';
  const me = f.teams[0];
  const rank = standings(f).findIndex((t) => t.human) + 1;
  return `Your team missed the playoffs, finishing ${ordinal(rank)} of ${f.teams.length} at ${me.w}-${me.l}.`;
}

export interface Ranked { team: FTeam; ovr: number; rank: number }

/** Every team ranked by starting-five rating, best first. */
export function ovrRanking(f: Franchise): Ranked[] {
  return f.teams
    .map((team) => ({ team, ovr: teamOvrOf(f, team), rank: 0 }))
    .sort((a, b) => b.ovr - a.ovr)
    .map((r, i) => ({ ...r, rank: i + 1 }));
}

/** The best teams other than the user's. */
export const topContenders = (f: Franchise, n = 3): Ranked[] => ovrRanking(f).filter((r) => !r.team.human).slice(0, n);

/** The user's next scheduled games, in order. */
export function firstGames(f: Franchise, n = 3): { week: number; opp: FTeam; home: boolean }[] {
  return f.games
    .filter((g) => !g.score && !g.round && (g.home === 0 || g.away === 0))
    .sort((a, b) => a.week - b.week)
    .slice(0, n)
    .map((g) => ({ week: g.week, opp: f.teams[g.home === 0 ? g.away : g.home], home: g.home === 0 }));
}

/** The user's best players by rating, with the rookie they just drafted (if still on the roster) flagged. */
export function rosterHighlights(f: Franchise, n = 4): { uid: string; rookie: boolean }[] {
  const me = f.teams[0];
  const rookie = f.draftedRookie && me.roster.indexOf(f.draftedRookie) >= 0 ? f.draftedRookie : undefined;
  const top = [...me.roster].sort((a, b) => monOf(f, b).ovr - monOf(f, a).ovr).slice(0, n);
  const list = top.map((uid) => ({ uid, rookie: uid === rookie }));
  if (rookie && top.indexOf(rookie) < 0) list.push({ uid: rookie, rookie: true });
  return list;
}
