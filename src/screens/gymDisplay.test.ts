import { describe, expect, it, vi } from 'vitest';
import { POKEMON, POSITIONS, type Mon } from '../data/pokemon';
import { LEAGUE, createFranchise, teamDef } from '../franchise/league';
import { introHtml } from './intro';
import { nextCard } from './hub';
import type { Settings } from './menu';

vi.stubGlobal('window', {});

describe('opponent preview ratings', () => {
  const pool = [...POKEMON].sort((a, b) => b.ovr - a.ovr);
  const teams = [{ name: 'Me', abbr: 'ME', color: '#3b6fd8', color2: '#16224a', human: true }, ...LEAGUE.map((t) => ({ ...t, human: false }))];
  const rosters: Mon[][] = teams.map(() => []);
  let i = 0;
  for (let r = 0; r < 10; r++) for (let j = 0; j < teams.length; j++) rosters[r % 2 ? teams.length - 1 - j : j].push(pool[i++]);
  const f = createFranchise(teams, rosters, pool.slice(i));
  const pewter = f.teams.find((t) => t.name === 'Pewter Boulders')!;
  f.games = [{ week: f.week, home: 0, away: pewter.id, score: null }];
  const mine = teamDef(f, 0, true).def;
  const theirs = teamDef(f, pewter.id, false).def;
  const byPos = (ms: Mon[]) => [...ms].sort((a, b) => POSITIONS.indexOf(a.pos) - POSITIONS.indexOf(b.pos));
  const ratings = (html: string, re: RegExp) => [...html.matchAll(re)].map((m) => Number(m[1]));

  it("shows Pewter's starters boosted and your own unchanged", () => {
    const card = nextCard(f, { quarterLen: 60, difficulty: 'pro' } as unknown as Settings);
    const [home, away] = card.split('<ul class="lineup">').slice(1).map((h) => ratings(h.split('</ul>')[0], /<b class="t-\w+">(\d+)</g));
    expect(away).toEqual([86, 91, 93, 89, 84]);
    expect(home).toEqual(byPos(mine.roster).map((m) => m.ovr));
    const [you, gym] = introHtml({ home: mine, away: theirs }).split('class="intro-vs"').map((h) => ratings(h, /<i[^>]*>(\d+)<\/i>/g));
    expect([...gym].sort()).toEqual([...away].sort());
    expect(you).toEqual(mine.roster.map((m) => m.ovr));
  });
});
