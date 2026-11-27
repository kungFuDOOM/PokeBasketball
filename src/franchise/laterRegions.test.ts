// Johto, Hoenn and Sinnoh draft like Kanto (the rules are in cpuDraft.test.ts): stars, entering and the old-save rebuild.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POKEMON, monByDex } from '../data/pokemon';
import { autoDraft } from '../season/team';
import { strengthOf } from '../screens/strength';
import {
  LEAGUE, createFranchise, enterRegion, lineupOf, loadFranchise, matchStrength, saveFranchise, type Franchise, type FTeam,
} from './league';
import { cpuDraftPool, draftCpuLeague, regionRosters, starOf } from './kantoDraft';
import { GYMS_REV, HOENN, JOHTO, KANTO, KANTO_RETURN_BUMP, REGIONS, SINNOH, regionTeams, type RegionDef } from './regions';

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
});
beforeEach(() => store.clear());

/** Alakazam, Lucario, Charizard, Garchomp, Snorlax: 91. Four of them are a later-region star. */
const TEAM = [65, 448, 6, 445, 143];
const LATER = [JOHTO, HOENN, SINNOH];

/** A new franchise whose user holds exactly the test team plus the drafter's bench for it. */
function testFranchise(): Franchise {
  const mine = TEAM.map(monByDex);
  const teams = [{ name: 'Test Team', abbr: 'TST', color: '#3b6fd8', color2: '#16224a', human: true }, ...LEAGUE.map((t) => ({ ...t, human: false }))];
  const { rosters } = autoDraft(teams, 10, mine);
  const used = new Set(rosters.flat().map((m) => m.dex));
  return createFranchise(teams, rosters, POKEMON.filter((m) => !used.has(m.dex)));
}

/** The test franchise, moved into `r` through the real `enterRegion` from the region before it. */
function enter(r: RegionDef, f = testFranchise()): Franchise {
  f.unlockedRegions = REGIONS.slice(1, r.index + 1).map((x) => x.id);
  f.region = REGIONS[r.index - 1].id;
  expect(enterRegion(f, r.id)).toBe(true);
  return f;
}

const dexesOf = (f: Franchise, t: FTeam) => t.roster.map((u) => f.players[u].dex);
const fiveOf = (f: Franchise, t: FTeam) => lineupOf(f, t).starters.map((u) => monByDex(f.players[u].dex));
const plays = (f: Franchise) => f.teams.slice(1).map((t) => strengthOf(fiveOf(f, t), t.boost).total);
/** What the app should seat for `r`: the drafter around only the user's team. */
const expected = (r: RegionDef, f: Franchise) => regionRosters(r, dexesOf(f, f.teams[0])).map((x) => x.map((m) => m.dex));

describe('later-region stars', () => {
  it('keeps each ace as the star, with the two shared ones replaced', () => {
    const names = (r: RegionDef) => regionTeams(r).map((t) => monByDex(t.star!).name);
    expect(names(JOHTO)).toEqual(['Crobat', 'Scizor', 'Snorlax', 'Gengar', 'Heracross', 'Steelix', 'Lapras', 'Dragonite', 'Tyranitar']);
    expect(names(HOENN)).toEqual(['Aggron', 'Hariyama', 'Manectric', 'Charizard', 'Slaking', 'Salamence', 'Espeon', 'Starmie', 'Metagross']);
    expect(names(SINNOH)).toEqual(['Rhyperior', 'Tangrowth', 'Lucario', 'Floatzel', 'Mismagius', 'Steelix', 'Weavile', 'Electivire', 'Garchomp']);
    expect(monByDex(HOENN.gyms[6].star!).types).toContain('Psychic');
    expect(monByDex(SINNOH.gyms[5].star!).types).toContain('Steel');
  });

  it('are unique within a region, on the team type for every gym, and found by team name', () => {
    for (const r of LATER) {
      expect(new Set(regionTeams(r).map((t) => t.star)).size, r.name).toBe(9);
      for (const t of r.gyms) expect(monByDex(t.star!).types.some((ty) => t.types.includes(ty)), t.leader).toBe(true);
    }
    for (const r of REGIONS) for (const t of regionTeams(r)) expect(starOf(t.name), t.name).toBe(t.star);
    expect(starOf('Pallet Town')).toBeUndefined();
  });

  it('keep starting when a better player at their position joins', () => {
    for (const r of LATER) {
      const f = enter(r);
      for (const t of f.teams.slice(1)) {
        const star = starOf(t.name)!;
        const better = POKEMON.filter((m) => m.pos === monByDex(star).pos).sort((a, b) => b.ovr - a.ovr)[0];
        f.players[t.roster[9]].dex = better.dex;
        expect(fiveOf(f, t).map((m) => m.dex), t.name).toContain(star);
      }
    }
  });
});

describe('entering a later region', () => {
  it.each(LATER)('seats the $name drafter around the user team, and the matchup card shows its strength', (r) => {
    const f = enter(r);
    expect(f.teams.slice(1).map((t) => dexesOf(f, t))).toEqual(expected(r, f));
    for (const t of f.teams.slice(1)) {
      const g = f.games.find((x) => (x.home === 0 && x.away === t.id) || (x.away === 0 && x.home === t.id))!;
      expect(matchStrength(f, g, t.id).total, t.name).toBe(strengthOf(fiveOf(f, t), t.boost).total);
    }
    // Gyms 1-3 are well under gyms 6-8, and the final opponent is the hardest (`cpuDraft.test.ts` has each ramp).
    const ramp = plays(f);
    expect(Math.min(...ramp.slice(5, 8)) - Math.max(...ramp.slice(0, 3)), `${ramp}`).toBeGreaterThanOrEqual(3);
    expect(ramp[8], `${ramp}`).toBeGreaterThan(Math.max(...ramp.slice(0, 8)));
  });

  it('signs a drafted species out of free agency with its level, and never touches the user team', () => {
    const f = testFranchise();
    const star = regionRosters(JOHTO, TEAM)[0][0].dex;
    // Falkner's Crobat is waiting in free agency, or on an old Kanto team about to be released.
    const uid = Object.keys(f.players).find((u) => f.players[u].dex === star)!;
    f.players[uid].level = 7;
    const mine = structuredClone(f.teams[0]);
    const myPlayers = structuredClone(mine.roster.map((u) => f.players[u]));
    enter(JOHTO, f);
    expect(f.teams[1].roster).toContain(uid);
    expect(f.players[uid].level).toBe(7);
    expect(f.teams[0]).toEqual(mine);
    expect(mine.roster.map((u) => f.players[u])).toEqual(myPlayers);
    const refs = [...f.teams.flatMap((t) => t.roster), ...f.freeAgents];
    expect(new Set(refs).size).toBe(refs.length);
    expect(f.gymsRev).toBe(GYMS_REV);
  });
});

/** Gym 1 as each later region fixed it before the draft, and the final opponent's old boost. */
const OLD: Record<string, { gym1: number[]; boosts: number[] }> = {
  johto: { gym1: [169, 6, 178, 227, 149, 189, 198, 226, 193, 207], boosts: [0, 3, 6, 3, 3, 5, 7, 3, 6] },
  hoenn: { gym1: [306, 282, 142, 141, 369, 348, 346, 338, 337, 299], boosts: [2, 6, 5, 3, 7, 4, 8, 7, 10] },
  sinnoh: { gym1: [464, 429, 409, 142, 141, 476, 411, 398, 467, 437], boosts: [3, 4, 2, 5, 7, 3, 9, 6, 7] },
};

/** A save from before the rework: the region's teams hold weak fixed rosters and the old boosts. */
function oldSave(r: RegionDef, rev: number | undefined): Franchise {
  const f = enter(r);
  f.teams.slice(1).forEach((t, i) => { t.boost = OLD[r.id].boosts[i]; });
  OLD[r.id].gym1.forEach((dex, i) => { f.players[f.teams[1].roster[i]].dex = dex; });
  const elite = f.teams[9];
  for (let i = 0; i < 5; i++) {
    const weak = f.freeAgents.pop()!;
    f.freeAgents.unshift(elite.roster[i]);
    elite.roster[i] = weak;
  }
  f.teams[1].lineup = [...f.teams[1].roster].reverse();
  if (rev === undefined) delete f.gymsRev;
  else f.gymsRev = rev;
  return f;
}

describe('the later-region save repair', () => {
  it.each(LATER.flatMap((r) => [[r.name, r, undefined], [r.name, r, 9], [r.name, r, 10], [r.name, r, 11]] as const))(
    'rebuilds an old %s save once and leaves the user team (revision %#)', (_, r, rev) => {
      expect(GYMS_REV).toBe(12);
      const f = oldSave(r, rev);
      // A Sinnoh title on record: only Kanto adds the return bump.
      f.titles = [{ regionId: 'sinnoh', season: 1 }];
      const mine = structuredClone(f.teams[0]);
      const myPlayers = structuredClone(mine.roster.map((u) => f.players[u]));
      const count = Object.keys(f.players).length;
      saveFranchise(f);
      const g = loadFranchise()!;
      expect(g.region).toBe(r.id);
      expect(g.gymsRev).toBe(GYMS_REV);
      expect(g.teams[0]).toEqual(mine);
      expect(mine.roster.map((u) => g.players[u])).toEqual(myPlayers);
      expect(g.teams.slice(1).map((t) => dexesOf(g, t))).toEqual(expected(r, g));
      expect(g.teams.slice(1).map((t) => t.boost)).toEqual(regionTeams(r).map((t) => t.boost));
      expect(g.teams[1].lineup).toBeUndefined();
      const strength = plays(g);
      expect(strength[8]).toBeGreaterThan(strength[7]);
      const refs = [...g.teams.flatMap((t) => t.roster), ...g.freeAgents];
      expect(new Set(refs).size).toBe(refs.length);
      const cpu = g.teams.slice(1).flatMap((t) => dexesOf(g, t));
      expect(new Set(cpu).size).toBe(cpu.length);
      // Species already in the save are signed again; only the few the fake old gym wrote over are new.
      expect(Object.keys(g.players).length).toBeLessThanOrEqual(count + OLD[r.id].gym1.length);

      // A later change sticks: the repair has run.
      const a = g.teams[0].roster[4];
      const b = g.teams[1].roster[9];
      g.teams[0].roster[4] = b;
      g.teams[1].roster[9] = a;
      saveFranchise(g);
      expect(loadFranchise()!.teams).toEqual(g.teams);
    });

  it.each(LATER)('does not rebuild a current $name save', (r) => {
    const f = enter(r);
    OLD[r.id].gym1.forEach((dex, i) => { f.players[f.teams[1].roster[i]].dex = dex; });
    f.teams[1].boost = 4;
    saveFranchise(f);
    const g = loadFranchise()!;
    expect(dexesOf(g, g.teams[1])).toEqual(OLD[r.id].gym1);
    expect(g.teams[1].boost).toBe(4);
  });
});

describe('Kanto drafts the same way', () => {
  it('from its own CPU pool, with its boosts and return bump', () => {
    expect(regionRosters(KANTO, TEAM)).toEqual(draftCpuLeague(regionTeams(KANTO), 10, cpuDraftPool(KANTO).filter((m) => !TEAM.includes(m.dex)), [], KANTO.dex));
    expect(regionTeams(KANTO).map((t) => t.boost)).toEqual([11, 6, 8, 14, 12, 16, 16, 13, 17]);
    expect(KANTO_RETURN_BUMP).toEqual([1, 1, 2, 2, 2, 2, 1, 2, 2]);
  });
});
