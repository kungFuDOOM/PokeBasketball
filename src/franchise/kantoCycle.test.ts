import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POKEMON, monByDex } from '../data/pokemon';
import type { Game } from '../game/game';
import { autoDraft } from '../season/team';
import {
  LEAGUE, advance, awardRegion, createFranchise, enterRegion, finalWeek, finishRookieDraft, gameConfig, gymBadgeCount,
  lineupOf, loadFranchise, recordGame, regionOf, regionStatus, rookieOnClock, rookiePick, saveFranchise, shouldReturnToKanto,
  startRookieDraft, weekGames, type FGame, type Franchise,
} from './league';
import { HOENN, JOHTO, KANTO, KANTO_GYMS_REV, KANTO_RETURN_BUMP, SINNOH, isKantoCpuMon, openRegionIds, poolMons, regionTeams } from './regions';

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
  const { rosters, leftovers } = autoDraft(teams, 10, undefined, poolMons(openRegionIds(unlocked)), isKantoCpuMon);
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

/** Kanto, Johto and Hoenn already beaten, sitting at the start of a Sinnoh season. */
function reachSinnoh(): Franchise {
  const f = reachHoenn();
  finish(f, gymIds(f), 0);
  rookieDraft(f);
  expect(enterRegion(f, 'sinnoh')).toBe(true);
  return f;
}

const cpuDex = (f: Franchise) => f.teams.slice(1).map((t) => t.roster.map((u) => f.players[u].dex));

describe('Sinnoh championship cycle', () => {
  it('a Sinnoh win returns the next season to a drafted Kanto league and keeps the user team', () => {
    const f = reachSinnoh();
    expect(regionStatus(f).next).toBeUndefined();
    expect(enterRegion(f, 'kanto')).toBe(false);
    expect(regionOf(f)).toBe(SINNOH);
    expect(KANTO.gyms.every((t) => t.roster?.length === 10)).toBe(true);
    expect(KANTO.finale.roster).toBeUndefined();

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
    const sinnohDexes = cpuDex(f);
    const owned = [...me.roster];

    playOut(f, () => true);
    expect(f.champion).toBe(0);
    expect(f.history[f.history.length - 1]).toMatchObject({ season: f.season, champion: 'Pallet Town', region: 'sinnoh' });
    expect(f.titles).toEqual([{ regionId: 'kanto', season: 1 }, { regionId: 'johto', season: 2 }, { regionId: 'hoenn', season: 3 }, { regionId: 'sinnoh', season: 4 }]);
    expect(f.completedRegions).toEqual([{ regionId: 'kanto', season: 1 }, { regionId: 'johto', season: 2 }, { regionId: 'hoenn', season: 3 }, { regionId: 'sinnoh', season: 4 }]);
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
    expect(f.titles).toEqual([{ regionId: 'kanto', season: 1 }, { regionId: 'johto', season: 2 }, { regionId: 'hoenn', season: 3 }, { regionId: 'sinnoh', season: 4 }]);
    expect(f.unlockedRegions).toEqual(['johto', 'hoenn', 'sinnoh']);
    expect(f.pokejamMaster).toBe(1);
    expect(f.news[0]).toContain('returns to the Kanto League');

    expect(f.teams.slice(1).map((t) => t.name)).toEqual(regionTeams(KANTO).map((t) => t.name));
    expect(f.teams.slice(1).map((t) => t.boost)).toEqual(regionTeams(KANTO).map((t, i) => t.boost + KANTO_RETURN_BUMP[i]));
    expect(f.teams.slice(1).map((t) => t.badge ?? 'Elite')).toEqual(['Boulder', 'Cascade', 'Thunder', 'Rainbow', 'Soul', 'Marsh', 'Volcano', 'Earth', 'Elite']);
    const drafted = cpuDex(f);
    expect(drafted).not.toEqual(sinnohDexes);
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
    expect(loaded.unlockedRegions).toEqual(['johto', 'hoenn', 'sinnoh']);
    expect(loaded.history).toEqual(history);

    playWeek(loaded, () => true);
    expect(gymBadgeCount(loaded)).toBe(1);
    expect(loaded.teams.find((t) => t.badge === 'Boulder')).toBeTruthy();
    expect(loaded.region).toBe('kanto');
  });

  it('a Sinnoh title with fewer than eight badges still returns, and does not complete the region', () => {
    const f = reachSinnoh();
    finish(f, gymIds(f).slice(0, 4), 0);
    expect(f.titles?.filter((t) => t.regionId === 'sinnoh')).toEqual([{ regionId: 'sinnoh', season: f.season }]);
    expect(f.completedRegions?.some((t) => t.regionId === 'sinnoh')).toBe(false);
    expect(shouldReturnToKanto(f)).toBe(true);
    rookieDraft(f);
    expect(f.region).toBe('kanto');
    expect(f.teams.slice(1).every((t) => t.roster.length === 10)).toBe(true);
    expect(f.completedRegions?.some((t) => t.regionId === 'sinnoh')).toBe(false);
  });

  it('a Sinnoh loss stays in Sinnoh with the same teams and the real champion', () => {
    const f = reachSinnoh();
    while (f.phase !== 'done') {
      const losingFinal = f.phase === 'playoffs' && f.week === finalWeek(f);
      playWeek(f, () => !losingFinal);
    }
    expect(f.champion).not.toBe(0);
    expect(shouldReturnToKanto(f)).toBe(false);
    const champ = f.teams[f.champion ?? -1]?.name;
    expect(f.history[f.history.length - 1]).toMatchObject({ champion: champ, region: 'sinnoh' });
    expect(f.titles?.some((t) => t.regionId === 'sinnoh')).toBe(false);
    expect(f.completedRegions?.some((t) => t.regionId === 'sinnoh')).toBe(false);
    const names = f.teams.slice(1).map((t) => t.name);
    const rosters = f.teams.slice(1).map((t) => [...t.roster]);
    rookieDraft(f);
    expect(f.region).toBe('sinnoh');
    expect(regionOf(f)).toBe(SINNOH);
    expect(f.teams.slice(1).map((t) => t.name)).toEqual(names);
    f.teams.slice(1).forEach((t, i) => {
      expect(t.roster.filter((u) => rosters[i].includes(u)).length).toBeGreaterThanOrEqual(9);
    });
    expect(f.history[f.history.length - 1]).toMatchObject({ champion: champ, region: 'sinnoh' });
    expect(f.news.join(' ')).not.toContain('returns to the Kanto League');
  });

  it('plays Kanto, then Johto, Hoenn and Sinnoh, and a second Sinnoh win returns again', () => {
    const f = reachSinnoh();
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
    expect(regionOf(f)).toBe(HOENN);
    expect(shouldReturnToKanto(f)).toBe(false);
    rookieDraft(f);
    expect(regionOf(f)).toBe(HOENN);
    expect(enterRegion(f, 'sinnoh')).toBe(true);

    playOut(f, () => true);
    expect(f.champion).toBe(0);
    expect(shouldReturnToKanto(f)).toBe(true);
    rookieDraft(f);
    expect(f.region).toBe('kanto');
    expect(f.teams.slice(1).map((t) => t.name)).toEqual(regionTeams(KANTO).map((t) => t.name));
    expect(f.teams.slice(1).every((t) => t.roster.length === 10)).toBe(true);
    expect(f.teams[0].roster).toContain(star);
    expect(f.players[star].level).toBe(6);
    expect(f.unlockedRegions).toEqual(['johto', 'hoenn', 'sinnoh']);
    expect(f.titles?.filter((t) => t.regionId === 'sinnoh')).toHaveLength(2);
    expect(f.history.filter((h) => h.region === 'sinnoh').map((h) => h.champion)).toEqual(['Pallet Town', 'Pallet Town']);

    saveFranchise(f);
    const again = loadFranchise()!;
    expect(again.region).toBe('kanto');
    expect(again.players[star].level).toBe(6);
    expect(again.titles?.filter((t) => t.regionId === 'sinnoh')).toHaveLength(2);
  });

  it('a Hoenn win does not return to Kanto: Sinnoh unlocks and the league stays in Hoenn until the user enters it', () => {
    const f = reachHoenn();
    playOut(f, () => true);
    expect(f.champion).toBe(0);
    expect(f.unlockedRegions).toEqual(['johto', 'hoenn', 'sinnoh']);
    expect(shouldReturnToKanto(f)).toBe(false);
    const names = f.teams.slice(1).map((t) => t.name);
    rookieDraft(f);
    expect(regionOf(f)).toBe(HOENN);
    expect(f.teams.slice(1).map((t) => t.name)).toEqual(names);
    expect(f.news.join(' ')).not.toContain('returns to the Kanto League');
    expect(regionStatus(f)).toMatchObject({ next: SINNOH, unlocked: true, canEnter: true });
    expect(enterRegion(f, 'sinnoh')).toBe(true);
    expect(regionOf(f)).toBe(SINNOH);
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

  /** Gyms and Elite: Gen 1 plus later-gen Pokémon in a Gen 1 evolution family (the production helper), never Garchomp and co. */
  const gen1Only = (f: Franchise) => f.teams.filter((t) => !t.human).flatMap((t) => t.roster).every((u) => isKantoCpuMon({ dex: f.players[u].dex }));

  it('a new Kanto franchise drafts its gyms and Elite from Gen 1 and its family evolutions only, while the user pool keeps the open exceptions', () => {
    expect(poolMons(openRegionIds([])).some((m) => m.dex === 376 || m.dex === 445)).toBe(true);
    for (const unlocked of [[], ['johto', 'hoenn', 'sinnoh']]) {
      for (let i = 0; i < 5; i++) {
        const f = kanto(unlocked);
        expect(f.teams.filter((t) => t.gym || t.elite)).toHaveLength(9);
        expect(gen1Only(f)).toBe(true);
        for (const t of f.teams.filter((x) => !x.human)) expect(t.roster).toHaveLength(10);
        // Later-gen Pokémon were not lost: they are in free agency (or on the user's team).
        const rest = [...f.freeAgents, ...f.teams[0].roster];
        expect(rest.some((u) => f.players[u].dex > 151)).toBe(true);
      }
    }
  });

  it('a Sinnoh title return redrafts the gyms from Gen 1 and family evolutions only, and the user keeps a later-gen roster', () => {
    const f = reachSinnoh();
    const me = f.teams[0];
    const held = new Set(me.roster.map((u) => f.players[u].dex));
    for (const [i, dex] of [376, 445, 384].entries()) if (!held.has(dex)) { held.delete(f.players[me.roster[i]].dex); f.players[me.roster[i]].dex = dex; held.add(dex); }
    const owned = [...me.roster];
    const laterOwned = owned.filter((u) => f.players[u].dex > 151);
    expect(laterOwned.length).toBeGreaterThanOrEqual(3);
    playOut(f, () => true);
    rookieDraft(f);
    expect(f.region).toBe('kanto');
    expect(gen1Only(f)).toBe(true);
    const banned = new Set([445, 376, 384, 373, 330, 448]); // Garchomp, Metagross, Rayquaza, Salamence, Flygon, Lucario
    expect(f.teams.filter((t) => !t.human).flatMap((t) => t.roster).some((u) => banned.has(f.players[u].dex))).toBe(false);
    expect(f.teams.filter((t) => !t.human).every((t) => t.roster.length === 10)).toBe(true);
    for (const u of laterOwned) expect(f.teams[0].roster).toContain(u);
    expect(f.teams[0].roster.some((u) => f.players[u].dex > 151)).toBe(true);
  });

  it('a Season 1 save with Mewtwo on Pewter rebuilds Brock and leaves the user team', () => {
    const f = kanto();
    const mine = [...f.teams[0].roster];
    const userDex = mine.map((u) => f.players[u].dex);
    const brock = f.teams[1];
    f.players[brock.roster[0]].dex = 150;
    brock.boost = 0;
    f.season = 1;
    f.region = 'kanto';
    delete f.titles;
    delete f.gymsRev;
    saveFranchise(f);
    const g = loadFranchise()!;
    expect(g.teams[0].roster).toEqual(mine);
    expect(g.teams[0].roster.map((u) => g.players[u].dex)).toEqual(userDex);
    const dexes = g.teams[1].roster.map((u) => g.players[u].dex);
    expect(dexes).toEqual(KANTO.gyms[0].roster);
    expect(dexes).not.toContain(150);
    expect(g.teams[1].boost).toBe(KANTO.gyms[0].boost);
    expect(g.freeAgents.some((u) => g.players[u].dex === 150)).toBe(true);
    const elite = f.teams.findIndex((t) => t.elite);
    expect(g.teams[elite].roster.map((u) => g.players[u].dex)).toEqual(f.teams[elite].roster.map((u) => f.players[u].dex));
    const uid = g.teams[1].roster[0];
    g.players[uid].level = 4;
    saveFranchise(g);
    const again = loadFranchise()!;
    expect(again.teams[1].roster).toEqual(g.teams[1].roster);
    expect(again.players[uid].level).toBe(4);
    expect(again.teams[0].roster).toEqual(mine);
  });

  it('a Kanto save with a Sinnoh title raises gym boosts to the design plus the return bump', () => {
    const f = kanto();
    f.region = 'kanto';
    f.season = 4;
    f.titles = [{ regionId: 'sinnoh', season: 4 }];
    for (const t of f.teams.slice(1)) t.boost = t.elite ? 9 : 16;
    delete f.gymsRev;
    saveFranchise(f);
    const g = loadFranchise()!;
    // Gyms are set to the design plus the bump (lowered here). The Elite Four's stored boost is left alone.
    expect(g.teams.slice(1).map((t) => t.boost)).toEqual(regionTeams(KANTO).map((t, i) => (t.elite ? 9 : t.boost + KANTO_RETURN_BUMP[i])));
    expect(g.teams[0].roster).toEqual(f.teams[0].roster);
  });

  it("the live save: Brock's Mew/Aerodactyl/Zapdos/Omanyte/Muk roster becomes the new Brock, and old boosts come down", () => {
    const f = kanto();
    const brock = f.teams[1];
    // Starters Mew (PG), Aerodactyl (SG), Zapdos (SF), Omanyte (PF), Muk (C), then a bench.
    [151, 142, 145, 138, 89, 74, 75, 111, 140, 51].forEach((dex, i) => { f.players[brock.roster[i]].dex = dex; });
    const old = [10, 7, 8, 13, 13, 13, 15, 16];
    f.teams.filter((t) => t.gym).forEach((t) => { t.boost = old[t.gym! - 1]; });
    delete f.gymsRev;
    const mine = structuredClone(f.teams[0]);
    const elite = structuredClone(f.teams.find((t) => t.elite)!);
    saveFranchise(f);

    const g = loadFranchise()!;
    expect(g.teams[1].roster.map((u) => g.players[u].dex)).toEqual(KANTO.gyms[0].roster);
    const five = lineupOf(g, g.teams[1]).starters.map((u) => g.players[u].dex);
    expect(five).toContain(76);
    for (const gone of [151, 145, 89]) expect(g.teams[1].roster.map((u) => g.players[u].dex)).not.toContain(gone);
    expect(g.teams.filter((t) => t.gym).map((t) => t.boost)).toEqual(KANTO.gyms.map((t) => t.boost));
    expect(g.teams[0]).toEqual(mine);
    const kept = g.teams.find((t) => t.elite)!;
    expect([kept.roster, kept.boost]).toEqual([elite.roster, elite.boost]);
    expect(kept.roster.map((u) => g.players[u].dex)).toEqual(elite.roster.map((u) => f.players[u].dex));
    expect(g.gymsRev).toBe(KANTO_GYMS_REV);
  });

  it('the repair runs once, so a later change to a gym roster (a trade, a rookie) sticks', () => {
    const f = kanto();
    delete f.gymsRev;
    saveFranchise(f);
    const g = loadFranchise()!;
    const mine = g.teams[0].roster[9];
    const theirs = g.teams[1].roster[9];
    g.teams[0].roster[9] = theirs;
    g.teams[1].roster[9] = mine;
    saveFranchise(g);
    const again = loadFranchise()!;
    expect(again.teams[0].roster[9]).toBe(theirs);
    expect(again.teams[1].roster[9]).toBe(mine);
  });

  it('a rebuilt gym takes its species from free agency instead of adding a second copy', () => {
    const f = kanto();
    const brock = f.teams[1];
    const golem = brock.roster.find((u) => f.players[u].dex === 76)!;
    brock.roster[brock.roster.indexOf(golem)] = f.freeAgents.shift()!;
    f.freeAgents.push(golem);
    delete f.gymsRev;
    saveFranchise(f);
    const g = loadFranchise()!;
    expect(g.teams[1].roster).toContain(golem);
    expect(g.freeAgents).not.toContain(golem);
    expect(Object.keys(g.players)).toHaveLength(Object.keys(f.players).length);
  });

  it("a Kanto gym's players level up but keep their species", () => {
    const f = kanto();
    const brock = f.teams[1];
    const onix = brock.roster.find((u) => f.players[u].dex === 95)!;
    const { cfg, sides, uidOf } = gameConfig(f, { week: 1, home: 0, away: 1, score: null } as unknown as FGame, false, 60, 'pro');
    const gp = [...cfg.away.roster].find((m) => uidOf.get(m) === onix)!;
    f.players[onix].level = 60;
    f.players[onix].xp = 100000;
    const stats = { pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, fgm: 0, fga: 0, sec: 60 };
    const game = { score: [80, 70], cfg: { quarterLen: 60 }, quarter: 4, rosterOf: (t: number) => (t === 1 ? [{ mon: gp, team: 1, stats }] : []) } as unknown as Game;
    recordGame(f, { week: 1, home: 0, away: 1, score: null } as unknown as FGame, game, sides, uidOf);
    expect(f.players[onix].level).toBeGreaterThan(60);
    expect(f.players[onix].dex).toBe(95);
  });
});
