import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POKEMON, monByDex } from '../data/pokemon';
import type { Game } from '../game/game';
import { autoDraft } from '../season/team';
import {
  LEAGUE, advance, awardRegion, createFranchise, enterRegion, finalWeek, finishRookieDraft, gameConfig, gymBadgeCount,
  loadFranchise, recordGame, regionOf, regionStatus, rookieOnClock, rookiePick, saveFranchise, shouldReturnToKanto,
  startRookieDraft, weekGames, type Franchise,
} from './league';
import { HOENN, JOHTO, KANTO, openRegionIds, poolMons, regionTeams } from './regions';

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
});
beforeEach(() => store.clear());

function kanto(unlocked: string[] = []): Franchise {
  const teams = [{ name: 'Pallet Town', abbr: 'PAL', color: '#3b6fd8', color2: '#16224a', human: true }, ...LEAGUE.map((t) => ({ ...t, human: false }))];
  const { rosters, leftovers } = autoDraft(teams, 10, undefined, poolMons(openRegionIds(unlocked)));
  const used = new Set([...rosters.flat(), ...leftovers]);
  const f = createFranchise(teams, rosters, [...leftovers, ...POKEMON.filter((m) => !used.has(m))]);
  if (unlocked.length) f.unlockedRegions = unlocked;
  return f;
}

/** Scores the current schedule, crowns `champ`, and runs the real title award. */
function finish(f: Franchise, beat: number[], champ: number) {
  for (const g of f.games) {
    const opp = g.home === 0 ? g.away : g.away === 0 ? g.home : -1;
    const userWins = opp >= 0 && beat.indexOf(opp) >= 0;
    g.score = opp < 0 ? [80, 70] : (g.home === 0) === userWins ? [90, 80] : [80, 90];
  }
  f.phase = 'done';
  f.week = (f.weeks ?? 9) + 2;
  f.champion = champ;
  awardRegion(f);
}

const gymIds = (f: Franchise) => f.teams.filter((t) => t.gym).map((t) => t.id);

function rookieDraft(f: Franchise) {
  startRookieDraft(f);
  while (rookieOnClock(f)) rookiePick(f);
  finishRookieDraft(f, f.teams[0].roster[f.teams[0].roster.length - 1]);
}

const fakeGame = (score: [number, number]) => ({ score, cfg: { quarterLen: 60 }, quarter: 4, rosterOf: () => [] }) as unknown as Game;

function playWeek(f: Franchise, userWins: (opp: number) => boolean) {
  for (const g of weekGames(f).filter((x) => !x.score)) {
    const opp = g.home === 0 ? g.away : g.away === 0 ? g.home : -1;
    const homeWins = opp < 0 ? true : (g.home === 0) === userWins(opp);
    recordGame(f, g, fakeGame(homeWins ? [88, 80] : [80, 88]), [g.home, g.away], new Map());
  }
  advance(f);
}

function playOut(f: Franchise, userWins: (opp: number) => boolean) {
  while (f.phase !== 'done') playWeek(f, userWins);
}

/** Kanto and Johto already beaten, sitting at the start of a Hoenn season. */
function reachHoenn(): Franchise {
  const f = kanto();
  finish(f, gymIds(f), 0);
  rookieDraft(f);
  expect(enterRegion(f, 'johto')).toBe(true);
  finish(f, gymIds(f), 0);
  rookieDraft(f);
  expect(enterRegion(f, 'hoenn')).toBe(true);
  return f;
}

const cpuDex = (f: Franchise) => f.teams.slice(1).map((t) => t.roster.map((u) => f.players[u].dex));

describe('Hoenn championship cycle', () => {
  it('a Hoenn win returns the next season to a drafted Kanto league and keeps the user team', () => {
    const f = reachHoenn();
    expect(regionStatus(f).next).toBeUndefined();
    expect(enterRegion(f, 'kanto')).toBe(false);
    expect(regionTeams(KANTO).every((t) => !t.roster)).toBe(true);

    const me = f.teams[0];
    const star = me.roster[0];
    const kept = me.roster[1];
    me.lineup = [...me.roster];
    me.name = 'Pallet Town';
    Object.assign(f.players[star], { level: 8, xp: 17, bonus: { sht: 3, spd: 1 }, stats: { ...f.players[star].stats, pts: 40 }, injury: 2 });
    Object.assign(f.players[kept], { dex: 140, king: true, level: 4, xp: 3, bonus: { pas: 1 } });
    const oldCpu = f.teams[3].roster[0];
    Object.assign(f.players[oldCpu], { level: 5, bonus: { def: 2 } });
    f.pokejamMaster = 1;
    const hoennDexes = cpuDex(f);
    const owned = [...me.roster];

    playOut(f, () => true);
    expect(f.champion).toBe(0);
    expect(f.history[f.history.length - 1]).toMatchObject({ season: f.season, champion: 'Pallet Town', region: 'hoenn' });
    expect(f.titles).toEqual([{ regionId: 'kanto', season: 1 }, { regionId: 'johto', season: 2 }, { regionId: 'hoenn', season: 3 }]);
    expect(f.completedRegions).toEqual([{ regionId: 'kanto', season: 1 }, { regionId: 'johto', season: 2 }, { regionId: 'hoenn', season: 3 }]);
    expect(gymBadgeCount(f)).toBe(8);
    expect(shouldReturnToKanto(f)).toBe(true);

    const history = JSON.parse(JSON.stringify(f.history));
    rookieDraft(f);

    expect(f.region).toBe('kanto');
    expect(regionOf(f)).toBe(KANTO);
    expect(shouldReturnToKanto(f)).toBe(false);
    expect(f.phase).toBe('season');
    expect(f.week).toBe(1);
    expect(f.champion).toBeUndefined();
    expect(gymBadgeCount(f)).toBe(0);
    expect(f.games.every((g) => !g.score)).toBe(true);
    expect(f.teams.every((t) => t.w === 0 && t.l === 0)).toBe(true);
    expect(f.teams[0].roster).toEqual(owned);
    expect(f.teams[0].lineup).toEqual(owned);
    expect(f.teams[0].name).toBe('Pallet Town');
    expect(f.players[star]).toMatchObject({ level: 8, xp: 17, bonus: { sht: 3, spd: 1 }, injury: 0 });
    expect(f.players[star].stats.pts).toBe(0);
    expect(f.players[kept]).toMatchObject({ dex: 140, king: true, level: 4, xp: 3, bonus: { pas: 1 } });
    expect(f.freeAgents).toContain(oldCpu);
    expect(f.players[oldCpu]).toMatchObject({ level: 5, bonus: { def: 2 } });
    expect(f.teams.some((t) => t.roster.includes(oldCpu))).toBe(false);
    expect(f.history).toEqual(history);
    expect(f.titles).toEqual([{ regionId: 'kanto', season: 1 }, { regionId: 'johto', season: 2 }, { regionId: 'hoenn', season: 3 }]);
    expect(f.unlockedRegions).toEqual(['johto', 'hoenn']);
    expect(f.pokejamMaster).toBe(1);
    expect(f.news[0]).toContain('returns to the Kanto League');

    expect(f.teams.slice(1).map((t) => t.name)).toEqual(regionTeams(KANTO).map((t) => t.name));
    expect(f.teams.slice(1).map((t) => t.boost)).toEqual(regionTeams(KANTO).map((t) => t.boost));
    expect(f.teams.slice(1).map((t) => t.badge ?? 'Elite')).toEqual(['Boulder', 'Cascade', 'Thunder', 'Rainbow', 'Soul', 'Marsh', 'Volcano', 'Earth', 'Elite']);
    const drafted = cpuDex(f);
    expect(drafted).not.toEqual(hoennDexes);
    const flat = drafted.flat();
    expect(flat).toHaveLength(90);
    expect(new Set(flat).size).toBe(90);
    expect(flat.some((d) => d === 140)).toBe(false);
    for (const t of f.teams.slice(1)) {
      expect(t.roster).toHaveLength(10);
      for (const u of t.roster) {
        expect(f.players[u]).toMatchObject({ level: 1, xp: 0, bonus: {} });
        expect(monByDex(f.players[u].dex).name).toBeTruthy();
      }
    }
    const refs = [...f.teams.flatMap((t) => t.roster), ...f.freeAgents];
    expect(new Set(refs).size).toBe(refs.length);
    expect(f.games.filter((g) => g.home === 0 || g.away === 0).map((g) => f.teams[g.home === 0 ? g.away : g.home].leader))
      .toEqual(['Brock', 'Misty', 'Lt. Surge', 'Erika', 'Koga', 'Sabrina', 'Blaine', 'Giovanni', 'The Elite Four']);
    for (const t of f.teams.slice(1)) {
      const g = f.games.find((x) => (x.home === 0 && x.away === t.id) || (x.away === 0 && x.home === t.id))!;
      expect(gameConfig(f, g, true, 20, 'allstar').cfg.away.boost).toBe(t.boost);
    }

    saveFranchise(f);
    const loaded = loadFranchise()!;
    expect(loaded.region).toBe('kanto');
    expect(cpuDex(loaded)).toEqual(drafted);
    expect(loaded.teams[0].roster).toEqual(owned);
    expect(loaded.players[star]).toMatchObject({ level: 8, xp: 17, bonus: { sht: 3, spd: 1 } });
    expect(loaded.players[kept].king).toBe(true);
    expect(loaded.unlockedRegions).toEqual(['johto', 'hoenn']);
    expect(loaded.history).toEqual(history);

    playWeek(loaded, () => true);
    expect(gymBadgeCount(loaded)).toBe(1);
    expect(loaded.teams.find((t) => t.badge === 'Boulder')).toBeTruthy();
    expect(loaded.region).toBe('kanto');
  });

  it('a Hoenn title with fewer than eight badges still returns, and does not complete the region', () => {
    const f = reachHoenn();
    finish(f, gymIds(f).slice(0, 4), 0);
    expect(f.titles?.filter((t) => t.regionId === 'hoenn')).toEqual([{ regionId: 'hoenn', season: f.season }]);
    expect(f.completedRegions?.some((t) => t.regionId === 'hoenn')).toBe(false);
    expect(shouldReturnToKanto(f)).toBe(true);
    rookieDraft(f);
    expect(f.region).toBe('kanto');
    expect(f.teams.slice(1).every((t) => t.roster.length === 10)).toBe(true);
    expect(f.completedRegions?.some((t) => t.regionId === 'hoenn')).toBe(false);
  });

  it('a Hoenn loss stays in Hoenn with the same teams and the real champion', () => {
    const f = reachHoenn();
    while (f.phase !== 'done') {
      const losingFinal = f.phase === 'playoffs' && f.week === finalWeek(f);
      playWeek(f, () => !losingFinal);
    }
    expect(f.champion).not.toBe(0);
    expect(shouldReturnToKanto(f)).toBe(false);
    const champ = f.teams[f.champion ?? -1]?.name;
    expect(f.history[f.history.length - 1]).toMatchObject({ champion: champ, region: 'hoenn' });
    expect(f.titles?.some((t) => t.regionId === 'hoenn')).toBe(false);
    expect(f.completedRegions?.some((t) => t.regionId === 'hoenn')).toBe(false);
    const names = f.teams.slice(1).map((t) => t.name);
    const rosters = f.teams.slice(1).map((t) => [...t.roster]);
    rookieDraft(f);
    expect(f.region).toBe('hoenn');
    expect(regionOf(f)).toBe(HOENN);
    expect(f.teams.slice(1).map((t) => t.name)).toEqual(names);
    f.teams.slice(1).forEach((t, i) => {
      expect(t.roster.filter((u) => rosters[i].includes(u)).length).toBeGreaterThanOrEqual(9);
    });
    expect(f.history[f.history.length - 1]).toMatchObject({ champion: champ, region: 'hoenn' });
    expect(f.news.join(' ')).not.toContain('returns to the Kanto League');
  });

  it('plays Kanto, then Johto, then Hoenn, and a second Hoenn win returns again', () => {
    const f = reachHoenn();
    const star = f.teams[0].roster[0];
    f.players[star].level = 6;
    playOut(f, () => true);
    rookieDraft(f);
    expect(f.region).toBe('kanto');
    expect(f.players[star].level).toBe(6);

    playOut(f, () => true);
    expect(f.champion).toBe(0);
    expect(f.region).toBe('kanto');
    expect(f.titles?.filter((t) => t.regionId === 'kanto').length).toBe(2);
    rookieDraft(f);
    expect(f.region).toBe('kanto');
    expect(enterRegion(f, 'johto')).toBe(true);

    playOut(f, () => true);
    expect(f.champion).toBe(0);
    expect(regionOf(f)).toBe(JOHTO);
    rookieDraft(f);
    expect(regionOf(f)).toBe(JOHTO);
    expect(enterRegion(f, 'hoenn')).toBe(true);

    playOut(f, () => true);
    expect(f.champion).toBe(0);
    expect(shouldReturnToKanto(f)).toBe(true);
    rookieDraft(f);
    expect(f.region).toBe('kanto');
    expect(f.teams.slice(1).map((t) => t.name)).toEqual(regionTeams(KANTO).map((t) => t.name));
    expect(f.teams.slice(1).every((t) => t.roster.length === 10)).toBe(true);
    expect(f.teams[0].roster).toContain(star);
    expect(f.players[star].level).toBe(6);
    expect(f.unlockedRegions).toEqual(['johto', 'hoenn']);
    expect(f.titles?.filter((t) => t.regionId === 'hoenn')).toHaveLength(2);
    expect(f.history.filter((h) => h.region === 'hoenn').map((h) => h.champion)).toEqual(['Pallet Town', 'Pallet Town']);

    saveFranchise(f);
    const again = loadFranchise()!;
    expect(again.region).toBe('kanto');
    expect(again.players[star].level).toBe(6);
    expect(again.titles?.filter((t) => t.regionId === 'hoenn')).toHaveLength(2);
  });

  it('Kanto and Johto still need eight badges and the title in one season, and a win there does not return', () => {
    const short = kanto();
    finish(short, gymIds(short).slice(0, 7), 0);
    expect(short.unlockedRegions ?? []).toEqual([]);
    expect(regionOf(short).id).toBe('kanto');
    const names = short.teams.slice(1).map((t) => t.name);
    const rosters = short.teams.slice(1).map((t) => [...t.roster]);
    rookieDraft(short);
    expect(regionOf(short).id).toBe('kanto');
    expect(short.teams.slice(1).map((t) => t.name)).toEqual(names);
    short.teams.slice(1).forEach((t, i) => {
      expect(t.roster.filter((u) => rosters[i].includes(u)).length).toBeGreaterThanOrEqual(9);
    });

    const full = kanto();
    finish(full, [], 0);
    expect(full.unlockedRegions ?? []).toEqual([]);
    finish(full, gymIds(full), 1);
    expect(awardRegion(full)).toBeUndefined();
    expect(full.unlockedRegions ?? []).toEqual([]);
    const earned = kanto();
    finish(earned, gymIds(earned), 0);
    expect(earned.unlockedRegions).toEqual(['johto']);
    expect(regionOf(earned).id).toBe('kanto');
    rookieDraft(earned);
    expect(regionOf(earned).id).toBe('kanto');
    expect(enterRegion(earned, 'johto')).toBe(true);

    finish(earned, [], 1);
    rookieDraft(earned);
    expect(regionOf(earned).id).toBe('johto');
    expect(earned.unlockedRegions).toEqual(['johto']);

    finish(earned, gymIds(earned), 0);
    expect(earned.unlockedRegions).toEqual(['johto', 'hoenn']);
    expect(regionOf(earned).id).toBe('johto');
    rookieDraft(earned);
    expect(regionOf(earned).id).toBe('johto');
    expect(enterRegion(earned, 'hoenn')).toBe(true);
    expect(regionOf(earned).id).toBe('hoenn');
  });
});
