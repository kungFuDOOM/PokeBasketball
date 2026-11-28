import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EVOLUTIONS, POKEMON, POSITIONS, bodyOf, isRetired, monByDex } from '../data/pokemon';
import { GENERATED_ROWS } from '../data/generated';
import { RANKED_EXCLUDED, RANKED_LEGENDARIES, RANKED_POOL } from '../multiplayer/shared/roster';
import { autoDraft } from '../season/team';
import { championBannerHtml, regionCardHtml } from '../screens/hub';
import { badgeSvg } from '../ui/badges';
import {
  LEAGUE, advance, awardRegion, canAcquire, createFranchise, enterRegion, finishRookieDraft, loadFranchise, loadRegionProfile, recordGame,
  regionOf, regionStatus, regionTitles, rookieOnClock, rookiePick, saveFranchise, seasonWeeks, sign, startRookieDraft, venueOf, weekGames,
  type Franchise,
} from './league';
import { GYM_ROSTERS } from './gymRosters';
import { HOENN, JOHTO, REGIONS, SINNOH, inPool, openRegionIds, poolMons, regionTeams } from './regions';
import type { Game } from '../game/game';

vi.stubGlobal('window', {});
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
});
beforeEach(() => store.clear());

const gen4 = (dex: number) => dex >= 387 && dex <= 493;
/** The fifteen Sinnoh Pokémon hand-tuned before Sinnoh was added. */
const LEGACY = [392, 405, 437, 445, 448, 454, 461, 462, 464, 465, 466, 468, 470, 473, 475];
const fresh = (dex: number) => gen4(dex) && LEGACY.indexOf(dex) < 0;
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

function kanto(unlocked: string[] = []): Franchise {
  const teams = [{ name: 'Me', abbr: 'MEE', color: '#3b6fd8', color2: '#16224a', human: true }, ...LEAGUE.map((t) => ({ ...t, human: false }))];
  const { rosters, leftovers } = autoDraft(teams, 10, undefined, poolMons(openRegionIds(unlocked)));
  const used = new Set([...rosters.flat(), ...leftovers]);
  const f = createFranchise(teams, rosters, [...leftovers, ...POKEMON.filter((m) => !used.has(m))]);
  if (unlocked.length) f.unlockedRegions = unlocked;
  return f;
}

/** Ends the season on paper: the user beats `beat` (team ids), `champ` wins the final, and the title is awarded. */
function finish(f: Franchise, beat: number[], champ: number) {
  for (const g of f.games) {
    const opp = g.home === 0 ? g.away : g.away === 0 ? g.home : -1;
    const userWins = opp >= 0 && beat.indexOf(opp) >= 0;
    g.score = opp < 0 ? [80, 70] : (g.home === 0) === userWins ? [90, 80] : [80, 90];
  }
  f.phase = 'done';
  f.week = seasonWeeks(f) + 2;
  f.champion = champ;
  awardRegion(f);
}

const gymIds = (f: Franchise) => f.teams.filter((t) => t.gym).map((t) => t.id);

function rookieDraft(f: Franchise) {
  startRookieDraft(f);
  while (rookieOnClock(f)) rookiePick(f);
  finishRookieDraft(f, f.teams[0].roster[f.teams[0].roster.length - 1]);
}

/** Kanto, Johto and Hoenn each won with every badge in one season, sitting at the start of the Hoenn season's end. */
function inHoenn(): Franchise {
  const f = kanto();
  finish(f, gymIds(f), 0);
  rookieDraft(f);
  expect(enterRegion(f, 'johto')).toBe(true);
  finish(f, gymIds(f), 0);
  rookieDraft(f);
  expect(enterRegion(f, 'hoenn')).toBe(true);
  return f;
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

describe('Gen 4 data (#387-493)', () => {
  it('adds exactly 92 Pokémon: 107 in Sinnoh = the 15 hand-tuned before + 92 new', () => {
    const sinnoh = POKEMON.filter((m) => gen4(m.dex));
    expect(sinnoh.map((m) => m.dex)).toEqual(Array.from({ length: 107 }, (_, i) => 387 + i));
    expect(sinnoh.filter((m) => fresh(m.dex))).toHaveLength(92);
    expect(SINNOH.open).toEqual(LEGACY);
    // The ratings come from the generator for all but the starters and the five legendaries tuned by hand below.
    const generated = GENERATED_ROWS.filter((r) => gen4(r[0])).map((r) => r[0]);
    expect(generated.some((d) => LEGACY.indexOf(d) >= 0)).toBe(false);
    expect(generated).toHaveLength(92 - 12);
    expect(GENERATED_ROWS.every((r) => r[0] >= 1 && r[0] <= 493)).toBe(true);
    expect(new Set(POKEMON.map((m) => m.dex)).size).toBe(POKEMON.length);
  });

  it('every Gen 4 card is complete: finite ratings in range, a real body, a position, a move', () => {
    for (const m of POKEMON.filter((x) => gen4(x.dex))) {
      for (const v of Object.values(m.r)) expect(Number.isInteger(v) && v >= 20 && v <= 99, `${m.name}`).toBe(true);
      expect(m.ovr >= 25 && m.ovr <= 99 && Number.isFinite(m.ovr)).toBe(true);
      expect(m.size >= 0.8 && m.size <= 1.3).toBe(true);
      expect(bodyOf(m.dex).h).toBeGreaterThan(0);
      expect(bodyOf(m.dex).w).toBeGreaterThan(0);
      expect(POSITIONS).toContain(m.pos);
      expect(m.types.length >= 1 && m.types.length <= 2).toBe(true);
      expect(m.move).toBeTruthy();
      expect(m.name).toMatch(/^[A-Z]/);
      expect(isRetired(m.dex)).toBe(false);
      expect(monByDex(m.dex)).toBe(m);
    }
    expect(monByDex(387).name).toBe('Turtwig');
    expect(monByDex(396).name).toBe('Starly');
    expect(monByDex(493).name).toBe('Arceus');
  });

  it('leaves the fifteen Pokémon that were already in the game exactly as they were', () => {
    expect(monByDex(392)).toMatchObject({ name: 'Infernape', pos: 'SG', ovr: 87, r: { spd: 92, sht: 82, ins: 88, pas: 72, def: 74, blk: 55, reb: 58, hnd: 86 } });
    expect(monByDex(445)).toMatchObject({ name: 'Garchomp', pos: 'PF', ovr: 89, r: { spd: 92, sht: 66, ins: 96, pas: 60, def: 84, blk: 84, reb: 82, hnd: 70 } });
    expect(monByDex(448)).toMatchObject({ name: 'Lucario', pos: 'SG', ovr: 87 });
    expect(monByDex(470)).toMatchObject({ name: 'Leafeon', pos: 'PG', ovr: 87 });
  });

  it('brings the Gen 4 evolutions, cross-generation ones included, without changing the old ones', () => {
    expect(EVOLUTIONS[387].to).toEqual([388]);
    expect(EVOLUTIONS[388].to).toEqual([389]);
    expect(EVOLUTIONS[390].to).toEqual([391]);
    expect(EVOLUTIONS[394].to).toEqual([395]);
    expect(EVOLUTIONS[133].to).toEqual([134, 135, 136, 196, 197, 470, 471]); // Eevee gains Glaceon
    expect(EVOLUTIONS[361].to).toEqual([362, 478]); // Snorunt -> Glalie / Froslass
    expect(EVOLUTIONS[200].to).toEqual([429]); // Misdreavus -> Mismagius
    expect(EVOLUTIONS[438]).toEqual({ level: 4, to: [185] }); // Bonsly -> Sudowoodo
    for (const [from, e] of Object.entries(EVOLUTIONS)) {
      monByDex(Number(from));
      for (const to of e.to) monByDex(to);
    }
  });
});

describe('Sinnoh starters and legendaries', () => {
  const ovr = (d: number) => monByDex(d).ovr;
  it('the three lines are buffed like the Gen 2 and 3 starters: each stage a step up, finals under the Kanto finals', () => {
    for (const line of [[387, 388, 389], [390, 391, 392], [393, 394, 395]]) {
      expect(ovr(line[1])).toBeGreaterThan(ovr(line[0]));
      expect(ovr(line[2])).toBeGreaterThan(ovr(line[1]));
      expect(ovr(line[2]) - ovr(line[1])).toBeGreaterThan(ovr(line[1]) - ovr(line[0]));
    }
    expect(monByDex(389)).toMatchObject({ name: 'Torterra', pos: 'C', ovr: 87, archetype: 'Glass Cleaner' });
    expect(monByDex(395)).toMatchObject({ name: 'Empoleon', pos: 'C', ovr: 85 });
    expect(monByDex(392).ovr).toBe(87); // Infernape, unchanged
    expect(ovr(6)).toBeGreaterThan(ovr(392));
    expect(ovr(3)).toBeGreaterThan(ovr(389)); // Venusaur
    expect(ovr(9)).toBeGreaterThan(ovr(395)); // Blastoise
    expect(monByDex(389).r.blk).toBeLessThan(90);
  });

  it('legendaries follow the earlier generations: Arceus is the only 97, nothing is 98 or above, the strongest kept out of Ranked', () => {
    const legends = [480, 481, 482, 483, 484, 485, 486, 487, 488, 490, 491, 492, 493];
    for (const d of legends) expect(monByDex(d).ovr, monByDex(d).name).toBeLessThanOrEqual(97);
    expect(monByDex(493).ovr).toBe(97);
    expect(POKEMON.filter((m) => m.ovr === 97).map((m) => m.name)).toEqual(['Arceus']);
    expect(Math.max(...POKEMON.map((m) => m.ovr))).toBe(97);
    for (const d of [483, 484, 486, 487, 491, 493]) expect(RANKED_EXCLUDED, `#${d}`).toContain(d);
    for (const d of legends) expect(RANKED_LEGENDARIES, `#${d}`).toContain(d);
    expect(RANKED_POOL.some((m) => [483, 484, 486, 487, 491, 493].includes(m.dex))).toBe(false);
    // Every Ranked-excluded Pokémon is OVR 91 or more.
    for (const d of RANKED_EXCLUDED) expect(monByDex(d).ovr, monByDex(d).name).toBeGreaterThanOrEqual(91);
  });
});

describe('Sinnoh region data', () => {
  it('Roark to Volkner with the Sinnoh badges, then the Sinnoh Elite Four & Champion Cynthia', () => {
    expect(SINNOH).toMatchObject({ id: 'sinnoh', index: 3, name: 'Sinnoh', generation: 4, dex: [387, 493] });
    expect(REGIONS.indexOf(SINNOH)).toBe(3);
    expect(SINNOH.gyms.map((g) => [g.city, g.leader, g.types[0], g.badge])).toEqual([
      ['Oreburgh City', 'Roark', 'Rock', 'Coal'],
      ['Eterna City', 'Gardenia', 'Grass', 'Forest'],
      ['Veilstone City', 'Maylene', 'Fighting', 'Cobble'],
      ['Pastoria City', 'Crasher Wake', 'Water', 'Fen'],
      ['Hearthome City', 'Fantina', 'Ghost', 'Relic'],
      ['Canalave City', 'Byron', 'Steel', 'Mine'],
      ['Snowpoint City', 'Candice', 'Ice', 'Icicle'],
      ['Sunyshore City', 'Volkner', 'Electric', 'Beacon'],
    ]);
    expect(SINNOH.finale.leader).toBe('Aaron · Bertha · Flint · Lucian · Champion Cynthia');
    expect(SINNOH.finale.title).toBe('Sinnoh Elite Four & Champion Cynthia');
    const names = REGIONS.flatMap((r) => regionTeams(r).map((t) => t.name));
    expect(new Set(names).size).toBe(names.length);
  });

  it('draws every Sinnoh badge', () => {
    const neutral = badgeSvg('Nope', true);
    for (const b of SINNOH.gyms.map((g) => g.badge!)) {
      const svg = badgeSvg(b, true);
      expect(svg).toContain(`aria-label="${b} Badge"`);
      expect(svg.replace(`${b} Badge`, 'Nope Badge')).not.toBe(neutral);
    }
  });
});

describe('the Sinnoh franchise pool', () => {
  it('holds back the 92 new Gen 4 Pokémon until Sinnoh unlocks; the 15 already in the game stay open', () => {
    for (const unlocked of [[], ['johto'], ['johto', 'hoenn']]) {
      const pool = poolMons(openRegionIds(unlocked));
      expect(pool.filter((m) => gen4(m.dex)).map((m) => m.dex)).toEqual(LEGACY);
    }
    expect(poolMons(openRegionIds(['johto', 'hoenn', 'sinnoh'])).filter((m) => gen4(m.dex))).toHaveLength(107);
    expect(inPool(387, ['kanto', 'johto', 'hoenn'])).toBe(false);
    expect(inPool(445, ['kanto'])).toBe(true);
    expect(inPool(387, ['kanto', 'johto', 'hoenn', 'sinnoh'])).toBe(true);
    expect(poolMons(undefined)).toHaveLength(POKEMON.length);
  });

  it('a locked franchise drafts the legacy 15 but no new Gen 4; free agency and rookies follow the lock', () => {
    const f = kanto();
    // The lock is the user's: Kanto's CPU teams draft from every region.
    expect(f.teams[0].roster.some((u) => fresh(f.players[u].dex))).toBe(false);
    const onGyms = f.teams.slice(1).flatMap((t) => t.roster.map((u) => f.players[u].dex)).filter(fresh);
    expect(f.freeAgents.filter((u) => fresh(f.players[u].dex))).toHaveLength(92 - onGyms.length);
    const newFa = f.freeAgents.find((u) => fresh(f.players[u].dex))!;
    expect(canAcquire(f, newFa)).toBe(false);
    sign(f, f.teams[0].roster[9], newFa);
    expect(f.teams[0].roster).not.toContain(newFa);
    finish(f, [], 1);
    startRookieDraft(f);
    expect(f.rookies!.pool.some((u) => fresh(f.players[u].dex))).toBe(false);
  });
});

describe('unlocking and entering Sinnoh', () => {
  it('needs all eight Hoenn gym badges and the user title in one Hoenn season', () => {
    const cases: [number[] | 'gyms', number, boolean][] = [
      [[], 1, false],
      [[], 0, false], // Hoenn title alone
      ['gyms', 1, false], // every Hoenn badge, CPU title
      [[1, 2, 3, 4, 5, 6, 7, 9], 0, false], // title + 7/8
      ['gyms', 0, true],
    ];
    for (const [beat, champ, unlocks] of cases) {
      const f = inHoenn();
      finish(f, beat === 'gyms' ? gymIds(f) : beat, champ);
      expect(regionStatus(f).unlocked, `${beat} / ${champ}`).toBe(unlocks);
      expect((f.unlockedRegions ?? []).indexOf('sinnoh') >= 0).toBe(unlocks);
    }
  });

  it('a hand-edited Hoenn record in a Kanto league does not unlock Sinnoh', () => {
    const fake = kanto();
    Object.assign(fake, { season: 4, completedRegions: [{ regionId: 'hoenn', season: 3 }], unlockedRegions: ['sinnoh'] });
    store.set('pokejam.franchise.v1', JSON.stringify(fake));
    const g = loadFranchise()!;
    expect(g.unlockedRegions).toEqual([]);
    expect(loadRegionProfile()).toEqual([]);
  });

  function sinnohStart(): Franchise {
    const f = inHoenn();
    finish(f, gymIds(f), 0);
    expect(regionStatus(f)).toMatchObject({ next: SINNOH, unlocked: true, canEnter: false });
    expect(enterRegion(f, 'sinnoh')).toBe(false);
    rookieDraft(f);
    expect(regionStatus(f).canEnter).toBe(true);
    expect(text(regionCardHtml(f))).toContain('Enter Sinnoh');
    expect(text(regionCardHtml(f))).toContain('Roark to Volkner');
    return f;
  }

  it('moves the league to Sinnoh with the user team whole and new Sinnoh players', () => {
    const f = sinnohStart();
    const me = JSON.parse(JSON.stringify(f.teams[0]));
    const before = Object.keys(f.players).length;
    expect(enterRegion(f, 'sinnoh')).toBe(true);
    expect(regionOf(f)).toBe(SINNOH);
    expect(f.teams[0]).toEqual(me);
    expect(f.teams.slice(1).map((t) => t.name)).toEqual(regionTeams(SINNOH).map((t) => t.name));
    expect(f.teams.slice(1).map((t) => t.roster.map((u) => f.players[u].dex)))
      .toEqual(GYM_ROSTERS.sinnoh);
    expect(Object.keys(f.players).length).toBeGreaterThanOrEqual(before);
    expect(Object.keys(f.players).length).toBeLessThan(before + 90);
    const refs = [...f.teams.flatMap((t) => t.roster), ...f.freeAgents];
    expect(new Set(refs).size).toBe(refs.length);
    expect(f.games.filter((g) => g.home === 0 || g.away === 0).map((g) => f.teams[g.home === 0 ? g.away : g.home].leader))
      .toEqual(['Roark', 'Gardenia', 'Maylene', 'Crasher Wake', 'Fantina', 'Byron', 'Candice', 'Volkner', 'Aaron · Bertha · Flint · Lucian · Champion Cynthia']);
    expect(venueOf(f, 1)).toMatchObject({ venue: 'Oreburgh City Gym', logo: 'Coal' });
    expect(venueOf(f, 9)).toMatchObject({ venue: 'Sinnoh League', logo: 'Elite' });
    // Sinnoh is the last region: no card, nothing to enter.
    expect(regionStatus(f).next).toBeUndefined();
    expect(regionCardHtml(f)).toBe('');
    // New Gen 4 free agents are open now.
    const newFa = f.freeAgents.find((u) => fresh(f.players[u].dex))!;
    expect(canAcquire(f, newFa)).toBe(true);
    sign(f, f.teams[0].roster[0], newFa);
    expect(f.teams[0].roster).toContain(newFa);
  });

  it('a Sinnoh title adds a Sinnoh Champion banner and sends the next season back to Kanto', () => {
    const f = sinnohStart();
    enterRegion(f, 'sinnoh');
    saveFranchise(f);
    const g = loadFranchise()!;
    expect(g.region).toBe('sinnoh');
    expect(g.teams.slice(1).map((t) => t.badge ?? 'Elite')).toEqual(['Coal', 'Forest', 'Cobble', 'Fen', 'Relic', 'Mine', 'Icicle', 'Beacon', 'Elite']);
    while (g.phase !== 'done') playWeek(g, () => true);
    expect(g.champion).toBe(0);
    expect(g.completedRegions!.map((c) => c.regionId)).toEqual(['kanto', 'johto', 'hoenn', 'sinnoh']);
    expect(regionTitles(g).map((t) => `${t.region.name} Champion`)).toEqual(['Kanto Champion', 'Johto Champion', 'Hoenn Champion', 'Sinnoh Champion']);
    expect(text(championBannerHtml(g))).toBe('Kanto Champion Season 1 Johto Champion Season 2 Hoenn Champion Season 3 Sinnoh Champion Season 4');
    expect(g.unlockedRegions).toEqual(['johto', 'hoenn', 'sinnoh']);
    rookieDraft(g);
    expect(g.region).toBe('kanto');
    expect(g.teams.slice(1).map((t) => t.name)).toEqual(regionTeams(REGIONS[0]).map((t) => t.name));
    expect(g.news.join(' ')).toContain("The Sinnoh teams' players are now free agents.");
  }, 60000);

  it('entering Sinnoh needs Sinnoh unlocked: a Hoenn league without it is refused', () => {
    const f = inHoenn();
    finish(f, [], 0);
    rookieDraft(f);
    expect(regionStatus(f)).toMatchObject({ next: SINNOH, unlocked: false, canEnter: false });
    expect(enterRegion(f, 'sinnoh')).toBe(false);
    expect(regionOf(f)).toBe(HOENN);
    expect(JOHTO.index).toBe(1);
  });
});
