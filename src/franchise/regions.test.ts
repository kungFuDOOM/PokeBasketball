import { beforeEach, describe, expect, it, vi } from 'vitest';
import { POKEMON, monByDex } from '../data/pokemon';
import { Game as RealGame, type Game } from '../game/game';
import { autoDraft } from '../season/team';
import { badgeSvg } from '../ui/badges';
import {
  LEAGUE, advance, atSeasonStart, awardRegion, canAcquire, createFranchise, enterRegion, finishRookieDraft, gameConfig, judgeTrade, loadDraft,
  lineupOf, matchStrength,
  loadFranchise, loadRegionProfile, recordGame, regionOf, regionStatus, regionTitles, rookieOnClock, rookiePick, saveDraft, saveFranchise,
  seasonWeeks, sign, simulate, startRookieDraft, venueOf, weekGames, type Franchise,
} from './league';
import { shouldPlayMasterCutscene } from './moments';
import { RANKED_PRESETS } from '../multiplayer/ranked/presets';
import { kantoRosters, lineupWithStar } from './kantoDraft';
import { GYM_ROSTERS } from './gymRosters';
import { RANKED_MAX_OVR } from '../multiplayer/shared/roster';
import { HOENN, JOHTO, KANTO, MAX_BOOST, REGIONS, SINNOH, inPool, nextRegion, openRegionIds, poolMons, regionTeams } from './regions';

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
      { name: 'Pewter Boulders', abbr: 'PEW', color: '#a38c63', color2: '#2e271b', leader: 'Brock', types: ['Rock'], boost: 10, gym: 1, badge: 'Boulder', star: 112 },
      { name: 'Cerulean Cascades', abbr: 'CER', color: '#2bb3d6', color2: '#0b2c38', leader: 'Misty', types: ['Water'], boost: 8, gym: 2, badge: 'Cascade', star: 9 },
      { name: 'Vermilion Thunder', abbr: 'VER', color: '#f2c522', color2: '#3a2f06', leader: 'Lt. Surge', types: ['Electric'], boost: 7, gym: 3, badge: 'Thunder', star: 145 },
      { name: 'Celadon Rainbows', abbr: 'CEL', color: '#5cb85c', color2: '#13301a', leader: 'Erika', types: ['Grass'], boost: 10, gym: 4, badge: 'Rainbow', star: 3 },
      { name: 'Fuchsia Ninjas', abbr: 'FCH', color: '#b04fc4', color2: '#2d1236', leader: 'Koga', types: ['Poison'], boost: 10, gym: 5, badge: 'Soul', star: 144 },
      { name: 'Saffron Psychics', abbr: 'SAF', color: '#f2668b', color2: '#3a1220', leader: 'Sabrina', types: ['Psychic'], boost: 10, gym: 6, badge: 'Marsh', star: 151 },
      { name: 'Cinnabar Volcanoes', abbr: 'CIN', color: '#e8622c', color2: '#3d160b', leader: 'Blaine', types: ['Fire'], boost: 11, gym: 7, badge: 'Volcano', star: 146 },
      { name: 'Viridian Quakes', abbr: 'VIR', color: '#7c9a3a', color2: '#1e2a0e', leader: 'Giovanni', types: ['Ground'], boost: 9, gym: 8, badge: 'Earth', star: 150 },
      { name: 'Indigo Elite', abbr: 'E4', color: '#d4a017', color2: '#2a2106', leader: 'The Elite Four', types: ['Ice', 'Fighting', 'Ghost', 'Dragon'], boost: 12, elite: true, star: 149 },
    ]);
  });

  it('each Kanto gym locks its star, which is on type and starts', () => {
    expect(KANTO.gyms.map((t) => monByDex(t.star!).name)).toEqual(
      ['Rhydon', 'Blastoise', 'Zapdos', 'Venusaur', 'Articuno', 'Mew', 'Moltres', 'Mewtwo']);
    const rosters = kantoRosters();
    KANTO.gyms.forEach((t, i) => {
      const ace = monByDex(t.star!);
      // The two designed exceptions: Koga's Articuno and Giovanni's Mewtwo are legendaries off the gym's type.
      const onType = ace.types.some((ty) => t.types.includes(ty));
      expect(onType, `${t.leader}: ${ace.name}`).toBe(t.leader !== 'Koga' && t.leader !== 'Giovanni');
      expect(rosters[i][0].dex, t.leader).toBe(t.star);
      expect(lineupWithStar(rosters[i], t.star).starters.map((m) => m.dex), t.leader).toContain(t.star);
    });
  });

  it('Brock and Misty lock the better rated of their two candidates', () => {
    expect(monByDex(112).ovr).toBeGreaterThan(monByDex(76).ovr); // Rhydon over Golem
    expect(KANTO.gyms[0].star).toBe(112); // not Rhyperior (#464): Kanto's gyms are Gen 1 only
    expect(monByDex(9).ovr).toBeGreaterThan(monByDex(130).ovr); // Blastoise over Gyarados
  });

  it('the Kanto CPU teams are Gen 1 only', () => {
    for (const m of kantoRosters().flat()) expect(m.dex, m.name).toBeLessThanOrEqual(151);
  });

  it('a new franchise drafts the same gyms every time, and every star starts', () => {
    const f = kanto();
    const again = kanto();
    KANTO.gyms.forEach((g) => {
      const t = f.teams.find((x) => x.gym === g.gym)!;
      const other = again.teams.find((x) => x.gym === g.gym)!;
      expect(t.roster.map((u) => f.players[u].dex), g.leader).toEqual(other.roster.map((u) => again.players[u].dex));
      expect(lineupOf(f, t).starters.map((u) => f.players[u].dex), g.leader).toContain(g.star);
    });
  });

  it('a gym star keeps starting when a better player at its position joins', () => {
    const f = kanto();
    const brock = f.teams.find((t) => t.leader === 'Brock')!;
    f.players[brock.roster[9]].dex = 373; // Salamence, a power forward rated above Rhydon
    const five = lineupOf(f, brock).starters.map((u) => f.players[u].dex);
    expect(five).toContain(112);
    expect(five).not.toContain(373);
  });

  it('Ranked presets stay at 88 or below', () => {
    expect(RANKED_MAX_OVR).toBeLessThanOrEqual(88);
    for (const team of RANKED_PRESETS) for (const d of team.dex) expect(monByDex(d).ovr, `${team.name} #${d}`).toBeLessThanOrEqual(88);
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
      // Difficulty is the starting five's rating plus the boost, not the boost alone: `laterRegions.test.ts` checks the ramps.
      expect(r.finale.elite).toBe(true);
      expect(r.finale.gym).toBeUndefined();
      for (const t of regionTeams(r)) expect(Number.isInteger(t.boost) && t.boost >= 0 && t.boost <= MAX_BOOST, t.name).toBe(true);
    });
    expect(nextRegion(KANTO)).toBe(JOHTO);
    expect(nextRegion(JOHTO)).toBe(HOENN);
    expect(nextRegion(HOENN)).toBe(SINNOH);
    expect(nextRegion(SINNOH)).toBeUndefined();
    expect(REGIONS.map((r) => r.id)).toEqual(['kanto', 'johto', 'hoenn', 'sinnoh']);
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
    expect(JOHTO.finale.star).toBe(248);
  });

  it("a Kanto gym's players never evolve past Gen 1 in the league; the user's still do", () => {
    const f = kanto();
    const brock = f.teams.find((t) => t.leader === 'Brock')!;
    const rhydon = brock.roster[0];
    expect(f.players[rhydon].dex).toBe(112);
    const mine = f.teams[0].roster[0];
    f.players[mine].dex = 112;
    for (const uid of [rhydon, mine]) Object.assign(f.players[uid], { level: 3, xp: 99999 });
    const g = f.games.find((x) => (x.home === 0 && x.away === brock.id) || (x.away === 0 && x.home === brock.id))!;
    const stats = { pts: 0, fgm: 0, fga: 0, tpm: 0, tpa: 0, reb: 0, ast: 0, stl: 0, blk: 0, dnk: 0, sec: 600, gs: 1 };
    const sides: [number, number] = [0, brock.id];
    const on = [{ mon: { ...monByDex(112) }, team: 0, stats }, { mon: { ...monByDex(112) }, team: 1, stats }];
    const box = { score: [80, 70], cfg: { quarterLen: 60 }, quarter: 4, rosterOf: (side: number) => [on[side]] } as unknown as Game;
    recordGame(f, { ...g, score: null }, box, sides, new Map([[on[0].mon, mine], [on[1].mon, rhydon]]));
    expect(f.players[mine].dex).toBe(464);
    expect(f.players[rhydon].dex).toBe(112);
  });

  it("a Johto gym's players never evolve past Gen 2 in the league; the user's still do", () => {
    const f = kanto();
    finish(f, gymIds(f), 0);
    awardRegion(f);
    rookieDraft(f);
    expect(enterRegion(f, 'johto')).toBe(true);
    const pryce = f.teams.find((t) => t.leader === 'Pryce')!;
    const pilo = pryce.roster[9];
    f.players[pilo].dex = 221;
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

  it('autoDraft for a locked franchise gives the user no Gen 2; the Kanto CPU teams never take it', () => {
    const f = kanto();
    // The gyms and Elite are Gen 1 only, whatever is unlocked.
    expect(f.teams[0].roster.some((u) => gen2(f.players[u].dex))).toBe(false);
    const cpuGen2 = f.teams.slice(1).flatMap((t) => t.roster.filter((u) => gen2(f.players[u].dex)));
    expect(cpuGen2).toEqual([]);
    // The held-back Pokémon still exist, in free agency, for later.
    expect(f.freeAgents.filter((u) => gen2(f.players[u].dex))).toHaveLength(100);
    // The user's own drafted team is kept as is, even with locked Pokémon in it, and no CPU team copies it (stars aside).
    const mine = [monByDex(248), ...POKEMON.slice(0, 9)];
    const league = [{ name: 'A', abbr: 'AAA', color: '#000', color2: '#fff', human: true }, ...LEAGUE.map((t) => ({ ...t, human: false }))];
    const stars = KANTO.gyms.map((g) => g.star!);
    for (const open of [['kanto'], ['kanto', 'johto']]) {
      const { rosters, leftovers } = autoDraft(league, 10, mine, poolMons(open));
      expect(rosters[0]).toEqual(mine);
      expect(rosters.slice(1).flat().filter((m) => mine.includes(m)).every((m) => stars.includes(m.dex))).toBe(true);
      expect(leftovers.some((m) => gen2(m.dex))).toBe(open.includes('johto'));
      // A gym may field a species the user's team also holds. What is left of the pool is not on a roster.
      for (const m of leftovers) expect(rosters.every((r) => !r.includes(m))).toBe(true);
      expect(rosters.slice(1).every((r) => r.length === 10)).toBe(true);
    }
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
    expect(f.teams.slice(1).map((t) => t.roster.map((u) => f.players[u].dex)))
      .toEqual(GYM_ROSTERS.johto);
    // Released to free agency; a Johto team may sign one straight back.
    for (const u of oldCpu) expect([...f.freeAgents, ...f.teams.slice(1).flatMap((t) => t.roster)]).toContain(u);
    // Every player belongs to exactly one place, and every reference resolves.
    const refs = [...f.teams.flatMap((t) => t.roster), ...f.freeAgents];
    expect(new Set(refs).size).toBe(refs.length);
    for (const u of refs) expect(f.players[u]?.uid).toBe(u);
    // A drafted species already in free agency is signed instead of added again.
    expect(Object.keys(f.players).length).toBeLessThan(before + 90);
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

describe('later-region gyms play at their fixed boost', () => {
  const johto = () => {
    const f = kanto();
    finish(f, gymIds(f), 0);
    awardRegion(f);
    rookieDraft(f);
    expect(enterRegion(f, 'johto')).toBe(true);
    return f;
  };
  const cfgVs = (f: Franchise, opp: number, difficulty: 'rookie' | 'allstar' = 'allstar') => {
    const g = f.games.find((x) => (x.home === 0 && x.away === opp) || (x.away === 0 && x.home === opp))!;
    return { g, cfg: gameConfig(f, g, true, 20, difficulty).cfg };
  };
  /** Gives every one of the user's players +40 on each rating, far past any gym. */
  const juiceUser = (f: Franchise) => {
    for (const u of f.teams[0].roster) f.players[u].bonus = { sht: 40, ins: 40, pas: 40, hnd: 40, spd: 40, def: 40, blk: 40, reb: 40 };
  };

  /** The engine and the matchup card use the team's own boost, however strong the user is. */
  const checkRegion = (f: Franchise) => {
    juiceUser(f);
    for (const t of f.teams.slice(1)) {
      const { g, cfg } = cfgVs(f, t.id);
      expect(cfg.away.boost, t.name).toBe(t.boost);
      expect(matchStrength(f, g, t.id).boost, t.name).toBe(t.boost);
    }
    expect(f.teams.slice(1).map((t) => t.boost)).toEqual(regionTeams(regionOf(f)).map((t) => t.boost));
  };

  it('Kanto gyms and the Kanto finale keep their fixed boost', () => {
    checkRegion(kanto());
  });

  it('Johto, Hoenn and Sinnoh gyms are never scaled to the user', () => {
    const f = johto();
    checkRegion(f);
    for (const next of ['hoenn', 'sinnoh']) {
      for (const u of f.teams[0].roster) f.players[u].bonus = {};
      finish(f, gymIds(f), 0);
      awardRegion(f);
      rookieDraft(f);
      expect(enterRegion(f, next)).toBe(true);
      checkRegion(f);
    }
  });

  it('the difficulty setting still stacks on top in the engine', () => {
    const f = johto();
    const gym = f.teams.find((t) => t.gym === 8)!;
    const easy = new RealGame({ ...cfgVs(f, gym.id, 'rookie').cfg, seed: 1 });
    const hard = new RealGame({ ...cfgVs(f, gym.id, 'allstar').cfg, seed: 1 });
    expect(easy.cfg.away.boost).toBe(hard.cfg.away.boost);
    const sum = (g: RealGame) => g.players.filter((p) => p.team === 1).reduce((a, p) => a + p.r.sht, 0);
    expect(sum(hard)).toBeGreaterThan(sum(easy));
  });
});
