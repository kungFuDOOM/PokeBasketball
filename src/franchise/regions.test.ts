import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EVOLUTIONS, POKEMON, isRetired, monByDex } from '../data/pokemon';
import { bestLineup, type Game } from '../game/game';
import { autoDraft } from '../season/team';
import { badgeSvg } from '../ui/badges';
import {
  LEAGUE, advance, atSeasonStart, awardRegion, canAcquire, createFranchise, enterRegion, finishRookieDraft, gameConfig, judgeTrade, loadDraft,
  loadFranchise, loadRegionProfile, recordGame, regionOf, regionStatus, regionTitles, rookieOnClock, rookiePick, saveDraft, saveFranchise,
  seasonWeeks, sign, simulate, startRookieDraft, venueOf, weekGames, type Franchise,
} from './league';
import { shouldPlayMasterCutscene } from './moments';
import { HOENN, JOHTO, KANTO, REGIONS, inPool, nextRegion, openRegionIds, poolMons, regionTeams } from './regions';

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
});
beforeEach(() => store.clear());

const gen2 = (dex: number) => dex >= 152 && dex <= 251;

/** A new franchise exactly as the menu makes one: the user, then the Kanto league, drafted from the open pool. */
function kanto(unlocked: string[] = []): Franchise {
  const teams = [{ name: 'Me', abbr: 'MEE', color: '#3b6fd8', color2: '#16224a', human: true }, ...LEAGUE.map((t) => ({ ...t, human: false }))];
  const open = openRegionIds(unlocked);
  const { rosters, leftovers } = autoDraft(teams, 10, undefined, poolMons(open));
  const used = new Set([...rosters.flat(), ...leftovers]);
  const f = createFranchise(teams, rosters, [...leftovers, ...POKEMON.filter((m) => !used.has(m))]);
  if (unlocked.length) f.unlockedRegions = unlocked;
  return f;
}

/** Ends the regular season on paper: the user beats the teams in `beat` and loses to the rest; `champ` wins the final. */
function finish(f: Franchise, beat: number[], champ: number) {
  for (const g of f.games) {
    const opp = g.home === 0 ? g.away : g.away === 0 ? g.home : -1;
    const userWins = opp >= 0 && beat.indexOf(opp) >= 0;
    g.score = opp < 0 ? [80, 70] : (g.home === 0) === userWins ? [90, 80] : [80, 90];
  }
  f.phase = 'done';
  f.week = seasonWeeks(f) + 2;
  f.champion = champ;
}

const gymIds = (f: Franchise) => f.teams.filter((t) => t.gym).map((t) => t.id);
const eliteId = (f: Franchise) => f.teams.find((t) => t.elite)!.id;

/** A finished engine game with a set score and no box score. */
const fakeGame = (score: [number, number]) => ({ score, cfg: { quarterLen: 60 }, quarter: 4, rosterOf: () => [] }) as unknown as Game;

/** Plays every open game of the week (the user wins `userWins(opp)`, CPU home teams win), then advances. */
function playWeek(f: Franchise, userWins: (opp: number) => boolean) {
  for (const g of weekGames(f).filter((x) => !x.score)) {
    const opp = g.home === 0 ? g.away : g.away === 0 ? g.home : -1;
    const homeWins = opp < 0 ? true : (g.home === 0) === userWins(opp);
    recordGame(f, g, fakeGame(homeWins ? [88, 80] : [80, 88]), [g.home, g.away], new Map());
  }
  advance(f);
}

/** Season start after the rookie draft (the CPU picks for everyone, the user cuts their worst). */
function rookieDraft(f: Franchise) {
  startRookieDraft(f);
  while (rookieOnClock(f)) rookiePick(f);
  finishRookieDraft(f, f.teams[0].roster[f.teams[0].roster.length - 1]);
}

describe('region data', () => {
  it('Kanto keeps its eight gyms and the Indigo Elite, and LEAGUE is exactly the Kanto league', () => {
    expect(KANTO.gyms.map((t) => t.badge)).toEqual(['Boulder', 'Cascade', 'Thunder', 'Rainbow', 'Soul', 'Marsh', 'Volcano', 'Earth']);
    expect(KANTO.gyms.map((t) => t.leader)).toEqual(['Brock', 'Misty', 'Lt. Surge', 'Erika', 'Koga', 'Sabrina', 'Blaine', 'Giovanni']);
    expect(LEAGUE).toEqual([
      { name: 'Pewter Boulders', abbr: 'PEW', color: '#a38c63', color2: '#2e271b', leader: 'Brock', types: ['Rock'], boost: -3, gym: 1, badge: 'Boulder' },
      { name: 'Cerulean Cascades', abbr: 'CER', color: '#2bb3d6', color2: '#0b2c38', leader: 'Misty', types: ['Water'], boost: -2, gym: 2, badge: 'Cascade' },
      { name: 'Vermilion Thunder', abbr: 'VER', color: '#f2c522', color2: '#3a2f06', leader: 'Lt. Surge', types: ['Electric'], boost: -1, gym: 3, badge: 'Thunder' },
      { name: 'Celadon Rainbows', abbr: 'CEL', color: '#5cb85c', color2: '#13301a', leader: 'Erika', types: ['Grass'], boost: 0, gym: 4, badge: 'Rainbow' },
      { name: 'Fuchsia Ninjas', abbr: 'FCH', color: '#b04fc4', color2: '#2d1236', leader: 'Koga', types: ['Poison'], boost: 1, gym: 5, badge: 'Soul' },
      { name: 'Saffron Psychics', abbr: 'SAF', color: '#f2668b', color2: '#3a1220', leader: 'Sabrina', types: ['Psychic'], boost: 2, gym: 6, badge: 'Marsh' },
      { name: 'Cinnabar Volcanoes', abbr: 'CIN', color: '#e8622c', color2: '#3d160b', leader: 'Blaine', types: ['Fire'], boost: 2, gym: 7, badge: 'Volcano' },
      { name: 'Viridian Quakes', abbr: 'VIR', color: '#7c9a3a', color2: '#1e2a0e', leader: 'Giovanni', types: ['Ground'], boost: 3, gym: 8, badge: 'Earth' },
      { name: 'Indigo Elite', abbr: 'E4', color: '#d4a017', color2: '#2a2106', leader: 'The Elite Four', types: ['Ice', 'Fighting', 'Ghost', 'Dragon'], boost: 4, elite: true },
    ]);
  });

  it('a Kanto franchise still plays nine regular-season games, then semifinals and a final', () => {
    const f = kanto();
    expect(seasonWeeks(f)).toBe(9);
    expect(f.games.filter((g) => g.home === 0 || g.away === 0).map((g) => (g.home === 0 ? g.away : g.home))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (let w = 0; w < 9; w++) playWeek(f, () => true);
    expect(f.phase).toBe('playoffs');
    expect(weekGames(f).map((g) => g.round)).toEqual(['semi', 'semi']);
    playWeek(f, () => true);
    expect(weekGames(f).map((g) => g.round)).toEqual(['final']);
  });

  it('every region has eight unique gyms in badge order, valid boosts and a final opponent', () => {
    REGIONS.forEach((r, i) => {
      expect(r.index).toBe(i);
      expect(r.gyms.map((g) => g.gym)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
      expect(new Set(r.gyms.map((g) => g.name)).size).toBe(8);
      expect(new Set(r.gyms.map((g) => g.badge)).size).toBe(8);
      expect(new Set(regionTeams(r).map((g) => g.abbr)).size).toBe(9);
      // Difficulty is the starting five's rating plus the boost, not the boost alone: each later region's own test checks that ramp.
      expect(r.finale.elite).toBe(true);
      expect(r.finale.gym).toBeUndefined();
      for (const t of regionTeams(r)) expect(Number.isInteger(t.boost) && t.boost >= -5 && t.boost <= 8).toBe(true);
    });
    expect(nextRegion(KANTO)).toBe(JOHTO);
    expect(nextRegion(JOHTO)).toBe(HOENN);
    expect(nextRegion(HOENN)).toBeUndefined();
    expect(REGIONS.map((r) => r.id)).toEqual(['kanto', 'johto', 'hoenn']);
  });

  it('Johto: Falkner to Clair with the canonical badges, then the Johto Elite Four & Champion Lance', () => {
    expect(JOHTO.dex).toEqual([152, 251]);
    expect(JOHTO.gyms.map((g) => [g.city, g.leader, g.types[0], g.badge])).toEqual([
      ['Violet City', 'Falkner', 'Flying', 'Zephyr'],
      ['Azalea Town', 'Bugsy', 'Bug', 'Hive'],
      ['Goldenrod City', 'Whitney', 'Normal', 'Plain'],
      ['Ecruteak City', 'Morty', 'Ghost', 'Fog'],
      ['Cianwood City', 'Chuck', 'Fighting', 'Storm'],
      ['Olivine City', 'Jasmine', 'Steel', 'Mineral'],
      ['Mahogany Town', 'Pryce', 'Ice', 'Glacier'],
      ['Blackthorn City', 'Clair', 'Dragon', 'Rising'],
    ]);
    expect(JOHTO.finale.leader).toBe('Will · Koga · Bruno · Karen · Champion Lance');
    expect(JOHTO.finale.title).toBe('Johto Elite Four & Champion Lance');
    expect(JOHTO.finale.ace).toBe(248);
  });

  it('Johto rosters: ten real, unique Pokémon, ace first, no starters, five natural positions, on-type players', () => {
    const starters = ['Chikorita', 'Bayleef', 'Meganium', 'Cyndaquil', 'Quilava', 'Typhlosion', 'Totodile', 'Croconaw', 'Feraligatr'];
    for (const t of regionTeams(JOHTO)) {
      const roster = t.roster!;
      expect(roster).toHaveLength(10);
      expect(new Set(roster).size).toBe(10);
      expect(roster[0]).toBe(t.ace);
      const mons = roster.map(monByDex);
      mons.forEach((m, i) => expect(m.dex).toBe(roster[i]));
      for (const m of mons) {
        expect(isRetired(m.dex)).toBe(false);
        expect(starters.some((s) => m.name.startsWith(s))).toBe(false);
        // Never a later generation (no Mamoswine, no Magnezone).
        expect(m.dex, `${t.name}: ${m.name}`).toBeLessThanOrEqual(251);
      }
      // Star rule: up to two earlier-generation (Gen 1) Pokémon per team, each of one of the team's types.
      const earlier = mons.filter((m) => !gen2(m.dex));
      expect(earlier.length, t.name).toBeLessThanOrEqual(2);
      for (const m of earlier) expect(m.types.some((ty) => t.types.indexOf(ty) >= 0), `${t.name}: ${m.name}`).toBe(true);
      const { starters: five } = bestLineup(mons);
      expect(five.map((m) => m.pos).sort()).toEqual(['C', 'PF', 'PG', 'SF', 'SG']);
      expect(five.map((m) => m.dex), `${t.name}: the ace starts`).toContain(t.ace);
      expect(mons.some((m) => m.types.some((ty) => t.types.indexOf(ty) >= 0)), t.name).toBe(true);
    }
  });

  it("Johto's starting fives are strong, fully evolved and ramp like Kanto's (regression: weak PG/ace filler used to start)", () => {
    const eff = (t: (typeof JOHTO.gyms)[number]) => {
      const mons = t.roster!.map(monByDex);
      const { starters: five } = bestLineup(mons);
      for (const m of five) {
        expect(m.ovr, `${t.name}: ${m.name} starts`).toBeGreaterThanOrEqual(70);
        // Fully evolved within Gen 2: nothing in the five has a Gen 1-2 evolution left.
        expect((EVOLUTIONS[m.dex]?.to ?? []).filter((d) => d <= 251), `${t.name}: ${m.name} is unevolved`).toEqual([]);
      }
      expect(five.filter((m) => m.types.some((ty) => t.types.indexOf(ty) >= 0)).length, `${t.name}: on-type starters`).toBeGreaterThanOrEqual(2);
      return five.reduce((a, m) => a + m.ovr, 0) / 5 + 2 + t.boost; // +2: five positions, as in the game
    };
    const gyms = JOHTO.gyms.map(eff);
    const elite = eff(JOHTO.finale);
    for (const e of [...gyms, elite]) expect(e).toBeGreaterThanOrEqual(84); // Kanto's gym 1 plays at about 83 once boosted
    expect(gyms[7]).toBeGreaterThan(gyms[0] + 3);
    expect(elite).toBeGreaterThan(Math.max(...gyms));
    // The ramp does not dip by more than a point and a half from one badge to the next.
    gyms.forEach((e, i) => { if (i) expect(e, `badge ${i + 1}`).toBeGreaterThan(gyms[i - 1] - 1.5); });
  });

  it("a Johto gym's players never evolve past Gen 2 in the league; the user's still do", () => {
    const f = kanto();
    finish(f, gymIds(f), 0);
    awardRegion(f);
    rookieDraft(f);
    expect(enterRegion(f, 'johto')).toBe(true);
    const pryce = f.teams.find((t) => t.leader === 'Pryce')!;
    const pilo = pryce.roster.find((u) => f.players[u].dex === 221)!;
    // The user's own Piloswine, for comparison.
    const mine = f.teams[0].roster[0];
    f.players[mine].dex = 221;
    for (const u of [pilo, mine]) Object.assign(f.players[u], { level: 9, xp: 0 });
    const g = f.games.find((x) => !x.score)!;
    const box = { score: [80, 70], cfg: { quarterLen: 60 }, quarter: 4,
      rosterOf: (side: number) => side === 0 ? [{ mon: monByDex(221), team: 0, stats: { pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, sec: 60, fgm: 0, fga: 0, tpm: 0, tpa: 0, dnk: 0, gs: 1 } }]
        : [{ mon: { ...monByDex(221) }, team: 1, stats: { pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, sec: 60, fgm: 0, fga: 0, tpm: 0, tpa: 0, dnk: 0, gs: 1 } }] } as unknown as Game;
    const sides: [number, number] = [0, pryce.id];
    const uidOf = new Map(([0, 1] as const).flatMap((sd) => box.rosterOf(sd).map((gp) => [gp.mon, sd === 0 ? mine : pilo] as const)));
    for (let i = 0; i < 40; i++) recordGame(f, { ...g, score: null }, box, sides, uidOf);
    expect(f.players[pilo].dex).toBe(221);
    expect(f.players[mine].dex).toBe(473);
  });

  it('draws a badge for every Johto badge, and a neutral medal (not the Elite emblem) for unknown ones', () => {
    const neutral = badgeSvg('Nope', true);
    expect(neutral).not.toBe(badgeSvg('Elite', true).replace('Elite Badge', 'Nope Badge'));
    for (const b of JOHTO.gyms.map((g) => g.badge!)) {
      const svg = badgeSvg(b, true);
      expect(svg).toContain(`aria-label="${b} Badge"`);
      expect(svg.replace(`${b} Badge`, 'Nope Badge')).not.toBe(neutral);
    }
  });
});

describe('unlocking Johto', () => {
  it('needs all eight Kanto gym badges and the user title in the same season', () => {
    const cases: [number[] | 'all', number, boolean][] = [
      [[], 1, false], // no badges, CPU title
      [[], 0, false], // title, no badges
      ['all', 1, false], // every badge, CPU title
      [[1, 2, 3, 4, 5, 6, 7, 9], 0, false], // title + 7/8 (the Elite emblem is not a gym badge)
      ['all', 0, true],
    ];
    for (const [beat, champ, unlocks] of cases) {
      const f = kanto();
      finish(f, beat === 'all' ? [...gymIds(f), eliteId(f)] : beat, champ);
      const opened = awardRegion(f);
      expect(!!opened, `${beat} / ${champ}`).toBe(unlocks);
      expect(regionStatus(f).unlocked).toBe(unlocks);
      expect(f.titles ?? []).toEqual(champ === 0 ? [{ regionId: 'kanto', season: 1 }] : []);
    }
  });

  it('eight gym badges without the Elite Four still count, and awarding again changes nothing', () => {
    const f = kanto();
    finish(f, gymIds(f), 0);
    expect(awardRegion(f)?.id).toBe('johto');
    expect(awardRegion(f)).toBeUndefined();
    expect(f.unlockedRegions).toEqual(['johto']);
    expect(f.titles).toEqual([{ regionId: 'kanto', season: 1 }]);
    expect(f.completedRegions).toEqual([{ regionId: 'kanto', season: 1 }]);
  });

  it('an old save gets the unlock its finished season proves; an unfinished or title-only one does not', () => {
    const old = (f: Franchise) => {
      const raw = JSON.parse(JSON.stringify(f)) as Record<string, unknown>;
      for (const k of ['region', 'titles', 'completedRegions', 'unlockedRegions']) delete raw[k];
      store.clear();
      store.set('pokejam.franchise.v1', JSON.stringify(raw));
      return loadFranchise()!;
    };
    const done = kanto();
    finish(done, gymIds(done), 0);
    const a = old(done);
    expect(a.region).toBe('kanto');
    expect(a.titles).toEqual([{ regionId: 'kanto', season: 1 }]);
    expect(a.unlockedRegions).toEqual(['johto']);
    expect(loadRegionProfile()).toEqual(['johto']);

    const titleOnly = kanto();
    finish(titleOnly, [1, 2, 3], 0);
    const b = old(titleOnly);
    expect(b.titles).toEqual([{ regionId: 'kanto', season: 1 }]);
    expect(b.unlockedRegions).toEqual([]);
    expect(loadRegionProfile()).toEqual([]);

    // All the games but no final yet: nothing.
    const midway = kanto();
    finish(midway, gymIds(midway), 0);
    midway.phase = 'playoffs';
    midway.champion = undefined;
    const c = old(midway);
    expect(c.titles).toEqual([]);
    expect(c.unlockedRegions).toEqual([]);

    // A hand-edited save can't claim an unlock or a region it doesn't have.
    const fake = kanto();
    Object.assign(fake, { unlockedRegions: ['johto', 'hoenn'], region: 'johto', titles: [{ regionId: 'mars', season: 1 }, { regionId: 'kanto', season: 99 }] });
    store.clear();
    store.set('pokejam.franchise.v1', JSON.stringify(fake));
    const d = loadFranchise()!;
    expect(d.region).toBe('kanto');
    expect(d.unlockedRegions).toEqual([]);
    expect(d.titles).toEqual([]);
  });

  it('a PokeJam Master save is a proven Kanto completion', () => {
    const f = kanto();
    f.season = 4;
    f.pokejamMaster = 2;
    store.set('pokejam.franchise.v1', JSON.stringify(f));
    const g = loadFranchise()!;
    expect(g.titles).toEqual([{ regionId: 'kanto', season: 2 }]);
    expect(g.unlockedRegions).toEqual(['johto']);
    expect(g.pokejamMaster).toBe(2);
  });

  it('the unlock lives on the device: a replacement franchise keeps it, a bare save does not create it', () => {
    const f = kanto();
    f.region = 'johto';
    f.unlockedRegions = ['johto'];
    saveFranchise(f);
    expect(loadRegionProfile()).toEqual([]);
    const won = kanto();
    finish(won, gymIds(won), 0);
    awardRegion(won);
    saveFranchise(won);
    expect(loadRegionProfile()).toEqual(['johto']);
    store.delete('pokejam.franchise.v1');
    // The menu's new franchise reads the device; deleting all Poké Jam data clears it with everything else.
    const next = kanto(loadRegionProfile());
    expect(regionStatus(next).unlocked).toBe(true);
    store.set('pokejam.regions.v1', '{"v":2,"unlocked":["johto"]}');
    expect(loadRegionProfile()).toEqual([]);
    store.set('pokejam.regions.v1', '{"v":1,"unlocked":["johto","johto","atlantis"]}');
    expect(loadRegionProfile()).toEqual(['johto']);
  });

  it('a full season through recordGame, a real simulated game and advance crowns the user and unlocks Johto', async () => {
    const f = kanto();
    // One real engine game (CPU vs CPU) recorded the usual way.
    const cpu = weekGames(f).find((g) => g.home !== 0 && g.away !== 0)!;
    const { cfg, sides, uidOf } = gameConfig(f, cpu, false, 20, 'rookie');
    recordGame(f, cpu, await simulate(cfg), sides, uidOf);
    expect(cpu.box?.length).toBeGreaterThan(0);
    saveFranchise(f);
    expect(loadRegionProfile()).toEqual([]);
    while (f.phase !== 'done') {
      playWeek(f, () => true);
      expect(f.unlockedRegions ?? []).toEqual((f.phase as string) === 'done' ? ['johto'] : []);
    }
    expect(f.champion).toBe(0);
    expect(f.titles).toEqual([{ regionId: 'kanto', season: 1 }]);
    expect(f.news.join(' ')).toContain('Johto League is unlocked');
    expect(f.history[0]).toMatchObject({ season: 1, region: 'kanto' });
  }, 60000);
});

describe('the PokeJam Master scene stays Kanto only', () => {
  it('plays once for a Kanto title with every badge, never in Johto', () => {
    const f = kanto();
    finish(f, [...gymIds(f), eliteId(f)], 0);
    awardRegion(f);
    expect(shouldPlayMasterCutscene(f)).toBe(true);
    f.pokejamMaster = f.season;
    expect(shouldPlayMasterCutscene(f)).toBe(false);
    rookieDraft(f);
    expect(enterRegion(f, 'johto')).toBe(true);
    finish(f, [...gymIds(f), eliteId(f)], 0);
    awardRegion(f);
    expect(f.completedRegions).toEqual([{ regionId: 'kanto', season: 1 }, { regionId: 'johto', season: 2 }]);
    expect(shouldPlayMasterCutscene(f)).toBe(false);
    expect(f.pokejamMaster).toBe(1);
    // Even a Johto save that never had the Kanto scene doesn't play it.
    delete f.pokejamMaster;
    expect(shouldPlayMasterCutscene(f)).toBe(false);
  });
});

describe('titles', () => {
  it('persist through save and load, the rookie draft, the next season and Johto', () => {
    const f = kanto();
    finish(f, [1, 2], 0);
    awardRegion(f);
    saveFranchise(f);
    const g = loadFranchise()!;
    expect(regionTitles(g).map((t) => [t.region.name, t.seasons])).toEqual([['Kanto', [1]]]);
    // A title without the badges doesn't unlock anything.
    expect(regionStatus(g).unlocked).toBe(false);
    rookieDraft(g);
    expect(g.season).toBe(2);
    expect(g.titles).toEqual([{ regionId: 'kanto', season: 1 }]);
    g.unlockedRegions = ['johto'];
    expect(enterRegion(g, 'johto')).toBe(true);
    saveFranchise(g);
    const h = loadFranchise()!;
    expect(h.region).toBe('johto');
    expect(h.titles).toEqual([{ regionId: 'kanto', season: 1 }]);
    finish(h, [], 0);
    awardRegion(h);
    expect(regionTitles(h).map((t) => `${t.region.name} Champion`)).toEqual(['Kanto Champion', 'Johto Champion']);
  });

  it('new saves have none', () => {
    expect(regionTitles(kanto())).toEqual([]);
    expect(regionTitles(kanto(['johto']))).toEqual([]);
  });
});

describe('the franchise Pokémon pool', () => {
  it('holds back #152-251 until Johto unlocks; Pokémon outside every region range stay', () => {
    const locked = openRegionIds([]);
    expect(locked).toEqual(['kanto']);
    expect(poolMons(locked).some((m) => gen2(m.dex))).toBe(false);
    expect(poolMons(locked).some((m) => m.dex > 251)).toBe(true);
    expect(poolMons(openRegionIds(['johto'])).filter((m) => gen2(m.dex))).toHaveLength(100);
    expect(poolMons(undefined)).toHaveLength(POKEMON.length);
    expect(inPool(152, locked)).toBe(false);
    expect(inPool(151, locked)).toBe(true);
  });

  it('autoDraft for a locked franchise drafts no Gen 2; unlocked, the CPU drafts them', () => {
    const f = kanto();
    expect(f.teams.flatMap((t) => t.roster).some((u) => gen2(f.players[u].dex))).toBe(false);
    // The held-back Pokémon still exist, in free agency, for later.
    expect(f.freeAgents.filter((u) => gen2(f.players[u].dex))).toHaveLength(100);
    const open = kanto(['johto']);
    expect(open.teams.flatMap((t) => t.roster).some((u) => gen2(open.players[u].dex))).toBe(true);
    // The user's own drafted team is kept as is, even with Gen 2 Pokémon in it.
    const mine = [monByDex(248), ...POKEMON.slice(0, 9)];
    const { rosters, leftovers } = autoDraft([{ name: 'A', abbr: 'AAA', color: '#000', color2: '#fff', human: true }, ...LEAGUE.map((t) => ({ ...t, human: false }))], 10, mine, poolMons(['kanto']));
    expect(rosters[0]).toEqual(mine);
    expect([...rosters.slice(1).flat(), ...leftovers].some((m) => gen2(m.dex))).toBe(false);
    expect(new Set([...rosters.flat(), ...leftovers]).size).toBe(rosters.flat().length + leftovers.length);
  });

  it('a saved franchise draft keeps its pool boundary, so a resumed draft finds every pick', () => {
    const regions = openRegionIds([]);
    const picks = poolMons(regions).slice(0, 7).map((m) => m.dex);
    saveDraft({ teams: [{ name: 'Me', abbr: 'MEE', color: '#3b6fd8', color2: '#16224a', human: true }, ...LEAGUE.map((t) => ({ ...t, human: false }))], order: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], taken: picks, rounds: 10, regions });
    // Unlocking Johto meanwhile doesn't change the pool of the draft in progress.
    store.set('pokejam.regions.v1', '{"v":1,"unlocked":["johto"]}');
    const d = loadDraft()!;
    expect(d.regions).toEqual(['kanto']);
    const pool = poolMons(d.regions);
    for (const dex of d.taken) expect(pool.some((m) => m.dex === dex)).toBe(true);
    // Junk in the boundary falls back to the first region; no boundary (Quick Play, older drafts) means every Pokémon.
    saveDraft({ ...d, regions: 'all' as unknown as string[] });
    expect(loadDraft()!.regions).toEqual(['kanto']);
    saveDraft({ ...d, regions: undefined });
    expect(loadDraft()!.regions).toBeUndefined();
  });

  it('free agency, trades and rookie classes obey the lock without removing anyone', () => {
    const f = kanto();
    const players = Object.keys(f.players).length;
    const locked = f.freeAgents.find((u) => gen2(f.players[u].dex))!;
    const ok = f.freeAgents.find((u) => !gen2(f.players[u].dex))!;
    expect(canAcquire(f, locked)).toBe(false);
    expect(canAcquire(f, ok)).toBe(true);
    const release = f.teams[0].roster[9];
    sign(f, release, locked);
    expect(f.teams[0].roster).not.toContain(locked);
    // An older save's CPU team may hold a Gen 2 player: it can't be traded for until Johto unlocks.
    const them = f.teams[3];
    them.roster[0] = locked;
    f.freeAgents.splice(f.freeAgents.indexOf(locked), 1);
    const verdict = judgeTrade(f, 3, [f.teams[0].roster[0]], [locked]);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('Johto');
    finish(f, [], 1);
    startRookieDraft(f);
    expect(f.rookies!.pool.some((u) => gen2(f.players[u].dex))).toBe(false);
    expect(Object.keys(f.players)).toHaveLength(players);

    const g = kanto(['johto']);
    const gen2fa = g.freeAgents.find((u) => gen2(g.players[u].dex))!;
    sign(g, g.teams[0].roster[9], gen2fa);
    expect(g.teams[0].roster).toContain(gen2fa);
    finish(g, [], 1);
    startRookieDraft(g);
    expect(g.rookies!.pool.some((u) => gen2(g.players[u].dex))).toBe(true);
  });
});

describe('entering Johto', () => {
  function unlockedAtSeasonStart(): Franchise {
    const f = kanto();
    finish(f, gymIds(f), 0);
    awardRegion(f);
    f.teams[0].lineup = [...f.teams[0].roster].reverse();
    for (const u of f.teams[0].roster) Object.assign(f.players[u], { level: 4, xp: 12, bonus: { sht: 2 } });
    rookieDraft(f);
    return f;
  }

  it('is offered only at the start of a season once unlocked, and only once', () => {
    const f = kanto();
    expect(regionStatus(f).canEnter).toBe(false);
    expect(enterRegion(f, 'johto')).toBe(false);
    finish(f, gymIds(f), 0);
    awardRegion(f);
    // Unlocked, but the title season isn't over: the rookie draft comes first.
    expect(regionStatus(f)).toMatchObject({ unlocked: true, canEnter: false });
    expect(enterRegion(f, 'johto')).toBe(false);
    rookieDraft(f);
    expect(atSeasonStart(f)).toBe(true);
    expect(regionStatus(f).canEnter).toBe(true);
    expect(enterRegion(f, 'hoenn')).toBe(false);
    expect(enterRegion(f, 'johto')).toBe(true);
    // Next up is Hoenn, still locked.
    expect(regionStatus(f)).toMatchObject({ next: HOENN, unlocked: false, canEnter: false });
    expect(enterRegion(f, 'johto')).toBe(false);
    expect(enterRegion(f, 'hoenn')).toBe(false);
  });

  it('keeps the user team whole, frees the Kanto players and brings in the Johto teams with new ids', () => {
    const f = unlockedAtSeasonStart();
    const me = JSON.parse(JSON.stringify(f.teams[0]));
    const mine = JSON.parse(JSON.stringify(me.roster.map((u: string) => f.players[u])));
    const oldCpu = f.teams.slice(1).flatMap((t) => t.roster);
    const history = JSON.parse(JSON.stringify(f.history));
    const before = Object.keys(f.players).length;
    f.pokejamMaster = 1;
    expect(enterRegion(f, 'johto')).toBe(true);

    expect(f.region).toBe('johto');
    expect(regionOf(f)).toBe(JOHTO);
    expect(f.teams[0]).toEqual(me);
    expect(me.roster.map((u: string) => f.players[u])).toEqual(mine);
    expect(f.teams.map((t) => t.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(f.teams.slice(1).map((t) => t.name)).toEqual(regionTeams(JOHTO).map((t) => t.name));
    f.teams.slice(1).forEach((t, i) => expect(t.roster.map((u) => f.players[u].dex)).toEqual(regionTeams(JOHTO)[i].roster));
    for (const u of oldCpu) expect(f.freeAgents).toContain(u);
    // Every player belongs to exactly one place, and every reference resolves.
    const refs = [...f.teams.flatMap((t) => t.roster), ...f.freeAgents];
    expect(new Set(refs).size).toBe(refs.length);
    for (const u of refs) expect(f.players[u]?.uid).toBe(u);
    expect(Object.keys(f.players)).toHaveLength(before + 90);
    expect(f.history).toEqual(history);
    expect(f.titles).toEqual([{ regionId: 'kanto', season: 1 }]);
    expect(f.pokejamMaster).toBe(1);
    expect(f.introShown).toBeUndefined();
    // A fresh nine-game schedule against the Johto gyms in order, then the Elite.
    expect(seasonWeeks(f)).toBe(9);
    expect(f.games.every((g) => !g.score)).toBe(true);
    expect(f.games.filter((g) => g.home === 0 || g.away === 0).map((g) => f.teams[g.home === 0 ? g.away : g.home].leader))
      .toEqual(['Falkner', 'Bugsy', 'Whitney', 'Morty', 'Chuck', 'Jasmine', 'Pryce', 'Clair', 'Will · Koga · Bruno · Karen · Champion Lance']);
    expect(venueOf(f, 1)).toMatchObject({ venue: 'Violet City Gym', logo: 'Zephyr' });
    expect(venueOf(f, 9).logo).toBe('Elite');
    // Gen 2 free agents are open to the user now.
    const gen2fa = f.freeAgents.find((u) => gen2(f.players[u].dex))!;
    expect(canAcquire(f, gen2fa)).toBe(true);
    sign(f, f.teams[0].roster[0], gen2fa);
    expect(f.teams[0].roster).toContain(gen2fa);
    // Quick Play's league is untouched.
    expect(LEAGUE.map((t) => t.name)).toEqual(regionTeams(KANTO).map((t) => t.name));
  });

  it('survives save and load, and a Johto season plays through', () => {
    const f = unlockedAtSeasonStart();
    enterRegion(f, 'johto');
    saveFranchise(f);
    const g = loadFranchise()!;
    expect(g.region).toBe('johto');
    expect(g.teams.slice(1).map((t) => t.badge ?? 'Elite')).toEqual(['Zephyr', 'Hive', 'Plain', 'Fog', 'Storm', 'Mineral', 'Glacier', 'Rising', 'Elite']);
    while (g.phase !== 'done') playWeek(g, () => true);
    expect(g.champion).toBe(0);
    expect(g.completedRegions!.map((c) => c.regionId)).toEqual(['kanto', 'johto']);
    expect(shouldPlayMasterCutscene(g)).toBe(false);
    rookieDraft(g);
    expect(g.region).toBe('johto');
    expect(g.teams.slice(1).map((t) => t.name)).toEqual(regionTeams(JOHTO).map((t) => t.name));
  });
});
