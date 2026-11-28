// Franchise gyms field the fixed rosters in `gymRosters.ts` (docs/gym-rosters.md), whatever the user's team holds.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POKEMON, monByDex } from '../data/pokemon';
import { GYM_ROSTERS } from './gymRosters';
import { LEAGUE, bringBackKanto, createFranchise, enterRegion, type Franchise } from './league';
import { REGIONS, regionTeams } from './regions';

vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
beforeEach(() => vi.restoreAllMocks());

/** Two very different user teams: the 91 test team's bench-mates, and one holding gym stars and legendaries. */
const USERS = [
  [65, 448, 6, 445, 143, 1, 4, 7, 10, 13],
  [112, 9, 145, 3, 144, 151, 146, 150, 149, 384],
];

describe('franchise gym rosters', () => {
  it('are the fixed data in every region, with the star first, whatever the user holds', () => {
    for (const r of REGIONS) {
      expect(GYM_ROSTERS[r.id].map((x) => x[0]), r.name).toEqual(regionTeams(r).map((t) => t.star));
      expect(GYM_ROSTERS[r.id].map((x) => new Set(x).size), r.name).toEqual(Array(9).fill(10));
    }
    for (const user of USERS) {
      const teams = [{ name: 'Me', abbr: 'MEE', color: '#000000', color2: '#ffffff', human: true }, ...LEAGUE.map((t) => ({ ...t, human: false }))];
      const mine = user.map(monByDex);
      // Whatever the draft handed the CPU teams is replaced.
      const rest = POKEMON.filter((m) => !user.includes(m.dex));
      const f: Franchise = createFranchise(teams, teams.map((_, i) => (i ? rest.slice(i * 10, i * 10 + 10) : mine)), rest.slice(100));
      const cpu = () => f.teams.slice(1).map((t) => t.roster.map((u) => f.players[u].dex));
      expect(cpu()).toEqual(GYM_ROSTERS.kanto);
      for (const r of REGIONS.slice(1)) {
        f.unlockedRegions = REGIONS.slice(1, r.index + 1).map((x) => x.id);
        expect(enterRegion(f, r.id)).toBe(true);
        expect(cpu(), r.name).toEqual(GYM_ROSTERS[r.id]);
      }
      bringBackKanto(f);
      expect(cpu()).toEqual(GYM_ROSTERS.kanto);
      expect(f.teams[0].roster.map((u) => f.players[u].dex)).toEqual(user);
    }
  });
});
