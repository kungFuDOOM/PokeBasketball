import { describe, expect, it } from 'vitest';
import { POKEMON, type Mon } from '../data/pokemon';
import { LEAGUE, createFranchise, finishRookieDraft, loadFranchise, nextSeason, rookiePick, rookieOnClock, startRookieDraft, tradeValue, type Franchise } from './league';
import {
  firstGames, ovrRanking, rosterHighlights, seasonLabel, shouldShowChampionship, shouldShowNewSeason, spotlightOf, topContenders, userFinish,
} from './moments';

function league(): Franchise {
  const pool = [...POKEMON].sort((a, b) => b.ovr - a.ovr);
  const teams = [{ name: 'Me', abbr: 'ME', color: '#3b6fd8', color2: '#16224a', human: true }, ...LEAGUE.map((t) => ({
    name: t.name, abbr: t.abbr, color: t.color, color2: t.color2, human: false, leader: t.leader, types: t.types, boost: t.boost,
  }))];
  const rosters: Mon[][] = teams.map(() => []);
  let i = 0;
  for (let r = 0; r < 10; r++) for (let j = 0; j < teams.length; j++) rosters[r % 2 ? teams.length - 1 - j : j].push(pool[i++]);
  return createFranchise(teams, rosters, pool.slice(i));
}

/** A finished season: semis 1v4 and 2v3 among teams `seeds`, final won by `champion`. */
function finish(f: Franchise, seeds: number[], champion: number) {
  const [a, b, c, d] = seeds;
  const other = champion === a || champion === d ? b : a;
  f.games.push(
    { week: 11, home: a, away: d, score: [60, 50], round: 'semi' },
    { week: 11, home: b, away: c, score: [60, 50], round: 'semi' },
    { week: 12, home: champion, away: other, score: [70, 62], round: 'final', pog: f.teams[champion].roster[0] },
  );
  f.phase = 'done';
  f.champion = champion;
}

describe('championship cutscene trigger', () => {
  it('shows once the final has ended, for any champion, and only once per season', () => {
    const f = league();
    expect(shouldShowChampionship(f)).toBe(false);
    finish(f, [3, 4, 5, 6], 3);
    expect(shouldShowChampionship(f)).toBe(true);
    f.titleShown = f.season;
    expect(shouldShowChampionship(f)).toBe(false);
    f.titleShown = f.season - 1;
    expect(shouldShowChampionship(f)).toBe(true);
  });

  it('shows when the user wins, and not before the final ends', () => {
    const f = league();
    f.phase = 'playoffs';
    expect(shouldShowChampionship(f)).toBe(false);
    finish(f, [0, 1, 2, 3], 0);
    expect(shouldShowChampionship(f)).toBe(true);
  });

  it('does not crash on an unknown champion id', () => {
    const f = league();
    f.phase = 'done';
    f.champion = 99;
    expect(shouldShowChampionship(f)).toBe(false);
  });

  it('picks the final\'s player of the game on the champion as Finals MVP, with fallbacks', () => {
    const f = league();
    finish(f, [3, 4, 5, 6], 3);
    const champ = f.teams[3];
    expect(spotlightOf(f, champ)).toEqual({ uid: champ.roster[0], label: 'Finals MVP' });
    f.games.find((g) => g.round === 'final')!.pog = f.teams[4].roster[0];
    f.mvp = champ.roster[2];
    expect(spotlightOf(f, champ)).toEqual({ uid: champ.roster[2], label: 'Season MVP' });
    f.mvp = undefined;
    expect(spotlightOf(f, champ)!.label).toBe('Top player');
  });
});

describe('where the user finished', () => {
  it('says you won', () => {
    const f = league();
    finish(f, [0, 1, 2, 3], 0);
    expect(userFinish(f)).toBe('You won the title.');
  });
  it('says lost in the final', () => {
    const f = league();
    finish(f, [0, 1, 2, 3], 1);
    f.games.find((g) => g.round === 'final')!.away = 0;
    expect(userFinish(f)).toBe('Your team lost in the Final.');
  });
  it('says lost in the semifinals', () => {
    const f = league();
    finish(f, [1, 2, 3, 0], 1);
    expect(userFinish(f)).toBe('Your team lost in the semifinals.');
  });
  it('gives the real seed and record when the playoffs were missed', () => {
    const f = league();
    finish(f, [1, 2, 3, 4], 1);
    f.teams.forEach((t, i) => Object.assign(t, { w: 9 - i, l: i }));
    f.teams[9].w = 1;
    expect(userFinish(f)).toBe('Your team missed the playoffs, finishing 1st of 10 at 9-0.');
    f.teams[0].w = 0;
    f.teams[0].l = 10;
    expect(userFinish(f)).toBe('Your team missed the playoffs, finishing 10th of 10 at 0-10.');
  });
});

describe('new-season preview trigger', () => {
  it('counts the season label up each year', () => {
    const f = league();
    expect(seasonLabel(f.season)).toBe('Season 1');
    nextSeason(f);
    expect(seasonLabel(f.season)).toBe('Season 2');
    nextSeason(f);
    expect(seasonLabel(f.season)).toBe('Season 3');
  });

  it('does not show in the first season, shows at the start of later ones, and only once', () => {
    const f = league();
    expect(shouldShowNewSeason(f)).toBe(false);
    nextSeason(f);
    expect(shouldShowNewSeason(f)).toBe(true);
    f.introShown = f.season;
    expect(shouldShowNewSeason(f)).toBe(false);
  });

  it('does not show mid-season or in the offseason', () => {
    const f = league();
    nextSeason(f);
    f.week = 3;
    expect(shouldShowNewSeason(f)).toBe(false);
    f.week = 1;
    f.games[0].score = [50, 40];
    expect(shouldShowNewSeason(f)).toBe(false);
    f.phase = 'done';
    expect(shouldShowNewSeason(f)).toBe(false);
  });

  it('follows the rookie draft: cutscene first, then the preview with the new rookie', () => {
    const f = league();
    finish(f, [3, 4, 5, 6], 3);
    expect(shouldShowChampionship(f)).toBe(true);
    startRookieDraft(f);
    while (rookieOnClock(f)) rookiePick(f);
    const me = f.teams[0];
    const mine = f.rookies!.picks[f.rookies!.order.indexOf(0)];
    finishRookieDraft(f, me.roster.filter((u) => u !== mine).reduce((a, b) => (tradeValue(f, b) < tradeValue(f, a) ? b : a)));
    expect(f.season).toBe(2);
    expect(shouldShowChampionship(f)).toBe(false);
    expect(shouldShowNewSeason(f)).toBe(true);
    expect(f.draftedRookie).toBeDefined();
    const hl = rosterHighlights(f);
    expect(hl.some((h) => h.rookie && h.uid === f.draftedRookie)).toBe(true);
  });
});

describe('preview data', () => {
  it('ranks all teams, lists contenders without the user, and the first games from the schedule', () => {
    const f = league();
    const ranking = ovrRanking(f);
    expect(ranking).toHaveLength(10);
    expect(ranking.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const top = topContenders(f, 3);
    expect(top).toHaveLength(3);
    expect(top.every((r) => !r.team.human)).toBe(true);
    const games = firstGames(f, 3);
    expect(games).toHaveLength(3);
    expect(games.map((g) => g.week)).toEqual([1, 2, 3]);
    expect(games.every((g) => !g.opp.human)).toBe(true);
  });

  it('old saves without the new fields still load and behave', () => {
    const f = league();
    const store: Record<string, string> = {};
    (globalThis as unknown as { localStorage: unknown }).localStorage = {
      getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; }, removeItem: (k: string) => { delete store[k]; },
    };
    localStorage.setItem('pokejam.franchise.v1', JSON.stringify(f));
    const g = loadFranchise()!;
    expect(g.titleShown).toBeUndefined();
    expect(g.introShown).toBeUndefined();
    expect(rosterHighlights(g).some((h) => h.rookie)).toBe(false);
  });
});
