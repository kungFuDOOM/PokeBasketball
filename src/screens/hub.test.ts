import { describe, expect, it, vi } from 'vitest';
import { POKEMON, type Mon } from '../data/pokemon';
import { LEAGUE, createFranchise, type Franchise } from '../franchise/league';
import { nextCard } from './hub';
import type { Settings } from './menu';

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

vi.stubGlobal('window', {});

const settings = { quarterLen: 60, difficulty: 'pro' } as unknown as Settings;
const actions = (html: string) => [...html.matchAll(/data-a="([\w-]+)"/g)].map((m) => m[1]);

describe('franchise next-game card', () => {
  const expectAll = (f: Franchise) => {
    expect(actions(nextCard(f, settings))).toEqual(expect.arrayContaining(['play', 'watch-mine', 'sim-mine']));
  };

  it('offers Play, Watch and Sim for a regular-season game', () => {
    expectAll(league());
  });

  it('offers Play, Watch and Sim for a semifinal', () => {
    const f = league();
    f.phase = 'playoffs';
    f.week = 12;
    f.games.push({ week: 12, home: 0, away: 3, score: null, round: 'semi' }, { week: 12, home: 1, away: 2, score: null, round: 'semi' });
    expectAll(f);
  });

  it('offers Play, Watch and Sim for the final', () => {
    const f = league();
    f.phase = 'playoffs';
    f.week = 13;
    f.games.push({ week: 13, home: 2, away: 0, score: null, round: 'final' });
    expectAll(f);
  });
});
