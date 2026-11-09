import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EVOLUTIONS, POKEMON, POSITIONS, bodyOf, isRetired, monByDex, type Mon } from '../data/pokemon';
import { GENERATED_ROWS } from '../data/generated';
import { bestLineup } from '../game/game';
import { RANKED_EXCLUDED, RANKED_LEGENDARIES, RANKED_POOL } from '../multiplayer/shared/roster';
import { autoDraft } from '../season/team';
import { championBannerHtml, regionCardHtml, standingsHtml } from '../screens/hub';
import { badgeSvg } from '../ui/badges';
import {
  LEAGUE, advance, awardRegion, canAcquire, createFranchise, enterRegion, finishRookieDraft, loadFranchise, loadRegionProfile, recordGame,
  regionOf, regionStatus, regionTitles, rookieOnClock, rookiePick, saveFranchise, seasonWeeks, sign, startRookieDraft, venueOf, weekGames,
  type Franchise,
} from './league';
import { shouldPlayMasterCutscene } from './moments';
import { HOENN, JOHTO, REGIONS, inPool, openRegionIds, poolMons, regionTeams } from './regions';
import type { Game } from '../game/game';

vi.stubGlobal('window', {});
const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
});
beforeEach(() => store.clear());

const gen3 = (dex: number) => dex >= 252 && dex <= 386;
/** The fourteen Hoenn Pokémon hand-tuned before Hoenn was added. */
const LEGACY = [254, 257, 260, 282, 303, 310, 350, 373, 376, 380, 381, 382, 383, 384];
const fresh = (dex: number) => gen3(dex) && LEGACY.indexOf(dex) < 0;
const fnv = (s: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16);
};
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
const eliteId = (f: Franchise) => f.teams.find((t) => t.elite)!.id;

function rookieDraft(f: Franchise) {
  startRookieDraft(f);
  while (rookieOnClock(f)) rookiePick(f);
  finishRookieDraft(f, f.teams[0].roster[f.teams[0].roster.length - 1]);
}

/** Kanto won with every badge in season 1, then season 2 in Johto, at its start. */
function inJohto(): Franchise {
  const f = kanto();
  finish(f, gymIds(f), 0);
  rookieDraft(f);
  expect(enterRegion(f, 'johto')).toBe(true);
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

describe('Gen 3 data (#252-386)', () => {
  it('adds exactly 121 generated Pokémon: 135 in Hoenn = the 14 hand-tuned + 121 new', () => {
    expect(POKEMON).toHaveLength(291 + 121);
    const hoenn = POKEMON.filter((m) => gen3(m.dex));
    expect(hoenn.map((m) => m.dex)).toEqual(Array.from({ length: 135 }, (_, i) => 252 + i));
    const generated = GENERATED_ROWS.filter((r) => gen3(r[0])).map((r) => r[0]);
    expect(generated).toHaveLength(121);
    expect(generated.some((d) => LEGACY.indexOf(d) >= 0)).toBe(false);
    expect(HOENN.open).toEqual(LEGACY);
    // Every generated row is #1-386; later generations stay hand-tuned only.
    expect(GENERATED_ROWS.every((r) => r[0] >= 1 && r[0] <= 386)).toBe(true);
    expect(new Set(POKEMON.map((m) => m.dex)).size).toBe(POKEMON.length);
  });

  it('leaves every other Pokémon exactly as it was (digests pinned from the Johto branch)', () => {
    const others = POKEMON.filter((m) => !gen3(m.dex));
    expect(others).toHaveLength(277);
    expect(fnv(JSON.stringify(others))).toBe('931199c9');
    expect(fnv(JSON.stringify(Object.entries(EVOLUTIONS).filter(([k]) => !gen3(Number(k)))))).toBe('922c9a81');
    // Hoenn hand-tuned cards. Sceptile, Blaziken and Swampert were buffed with the other Gen 3 starters.
    expect(fnv(JSON.stringify(POKEMON.filter((m) => LEGACY.indexOf(m.dex) >= 0)))).toBe('9c11d760');
    expect(monByDex(376)).toMatchObject({ name: 'Metagross', pos: 'C', types: ['Steel', 'Psychic'], r: { spd: 58, sht: 64, ins: 90, pas: 70, def: 84, blk: 94, reb: 90, hnd: 60 } });
  });

  it('every Gen 3 card is complete: finite ratings in range, a real body, a position, a move', () => {
    for (const m of POKEMON.filter((x) => gen3(x.dex))) {
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
    expect(monByDex(252).name).toBe('Treecko');
    expect(monByDex(261).name).toBe('Poochyena');
    expect(monByDex(386).name).toBe('Deoxys');
  });

  it('brings the Gen 3 evolutions, cross-generation ones included, without touching the old ones', () => {
    expect(EVOLUTIONS[252].to).toEqual([253]);
    expect(EVOLUTIONS[253].to).toEqual([254]);
    expect(EVOLUTIONS[298].to).toEqual([183]); // Azurill -> Marill
    expect(EVOLUTIONS[183].to).toEqual([184]); // Marill -> Azumarill
    expect(EVOLUTIONS[360].to).toEqual([202]); // Wynaut -> Wobbuffet
    expect(EVOLUTIONS[281].to).toEqual([282, 475]); // Kirlia -> Gardevoir / Gallade
    expect(EVOLUTIONS[375].to).toEqual([376]);
    expect(EVOLUTIONS[176].to).toEqual([468]); // Togetic -> Togekiss, still
    for (const [from, e] of Object.entries(EVOLUTIONS)) {
      monByDex(Number(from));
      for (const to of e.to) monByDex(to);
    }
  });
});

describe('Hoenn region data', () => {
  it('Roxanne to Juan with the Hoenn badges, then the Hoenn Elite Four & Champion Steven', () => {
    expect(HOENN).toMatchObject({ id: 'hoenn', index: 2, name: 'Hoenn', generation: 3, dex: [252, 386] });
    expect(REGIONS.indexOf(HOENN)).toBe(2);
    expect(HOENN.gyms.map((g) => [g.city, g.leader, g.types[0], g.badge])).toEqual([
      ['Rustboro City', 'Roxanne', 'Rock', 'Stone'],
      ['Dewford Town', 'Brawly', 'Fighting', 'Knuckle'],
      ['Mauville City', 'Wattson', 'Electric', 'Dynamo'],
      ['Lavaridge Town', 'Flannery', 'Fire', 'Heat'],
      ['Petalburg City', 'Norman', 'Normal', 'Balance'],
      ['Fortree City', 'Winona', 'Flying', 'Feather'],
      ['Mossdeep City', 'Tate & Liza', 'Psychic', 'Mind'],
      ['Sootopolis City', 'Juan', 'Water', 'Rain'],
    ]);
    expect(HOENN.finale.leader).toBe('Sidney · Phoebe · Glacia · Drake · Champion Steven');
    expect(HOENN.finale.title).toBe('Hoenn Elite Four & Champion Steven');
    // Team names are unique across every region (the venue and the saved region are found by name).
    const names = REGIONS.flatMap((r) => regionTeams(r).map((t) => t.name));
    expect(new Set(names).size).toBe(names.length);
  });

  it('every roster: ten unique Pokémon, Gen 3 plus at most two on-type Gen 1-2 stars, ace first and starting, five natural positions', () => {
    const starters = [252, 253, 254, 255, 256, 257, 258, 259, 260];
    const legendaries = [144, 145, 146, 150, 151, 243, 244, 245, 249, 250, 251, 377, 378, 379, 380, 381, 382, 383, 384, 385, 386];
    for (const t of regionTeams(HOENN)) {
      const roster = t.roster!;
      expect(roster, t.name).toHaveLength(10);
      expect(new Set(roster).size).toBe(10);
      expect(roster[0]).toBe(t.ace);
      // Never a later generation.
      for (const d of roster) expect(d, `${t.name}: #${d}`).toBeLessThanOrEqual(386);
      // Star rule: up to two earlier-generation Pokémon, each of one of the team's types; the finale stays all Gen 3.
      const earlier = roster.map(monByDex).filter((m) => m.dex < 252);
      expect(earlier.length, t.name).toBeLessThanOrEqual(t.elite ? 0 : 2);
      for (const m of earlier) expect(m.types.some((ty) => t.types.indexOf(ty) >= 0), `${t.name}: ${m.name}`).toBe(true);
      // No Hoenn starters, no Geodude/Magnemite roster rows slipped in from the old guidance.
      for (const d of [...starters, 74, 75, 81]) expect(roster).not.toContain(d);
      const mons = roster.map(monByDex);
      const { starters: five } = bestLineup(mons);
      expect(five.map((m) => m.pos).sort(), t.name).toEqual(['C', 'PF', 'PG', 'SF', 'SG']);
      expect(five.map((m) => m.dex)).toContain(t.ace);
      expect(mons.some((m) => m.types.some((ty) => t.types.indexOf(ty) >= 0)), t.name).toBe(true);
      // No legendaries anywhere.
      for (const d of roster) expect(legendaries, `${t.name}: #${d}`).not.toContain(d);
    }
    const stars = (t: { roster?: number[] }) => t.roster!.filter((d) => d < 252);
    const [roxanne] = HOENN.gyms;
    expect(HOENN.finale.ace).toBe(376); // Metagross
    expect(stars(HOENN.finale)).toEqual([]);
    // Rustboro reads as a Rock gym again: Aggron leads, Aerodactyl and Kabutops are its two stars.
    expect(roxanne.ace).toBe(306);
    expect(stars(roxanne)).toEqual([142, 141]);
  });

  it("Hoenn's starting fives are strong, fully evolved and ramp like Kanto's (regression: Nosepass 63 / Baltoy 54 used to start at Rustboro)", () => {
    const eff = (t: (typeof HOENN.gyms)[number]) => {
      const mons = t.roster!.map(monByDex);
      const { starters: five } = bestLineup(mons);
      for (const m of five) {
        expect(m.ovr, `${t.name}: ${m.name} starts`).toBeGreaterThanOrEqual(70);
        expect((EVOLUTIONS[m.dex]?.to ?? []).filter((d) => d <= 386), `${t.name}: ${m.name} is unevolved`).toEqual([]);
      }
      expect(five.filter((m) => m.types.some((ty) => t.types.indexOf(ty) >= 0)).length, `${t.name}: on-type starters`).toBeGreaterThanOrEqual(2);
      return five.reduce((a, m) => a + m.ovr, 0) / 5 + 2 + t.boost; // +2: five positions, as in the game
    };
    const gyms = HOENN.gyms.map(eff);
    const elite = eff(HOENN.finale);
    for (const e of [...gyms, elite]) expect(e).toBeGreaterThanOrEqual(84); // Kanto's gym 1 plays at about 83 once boosted
    expect(gyms[7]).toBeGreaterThan(gyms[0] + 3);
    expect(elite).toBeGreaterThan(Math.max(...gyms));
    gyms.forEach((e, i) => { if (i) expect(e, `badge ${i + 1}`).toBeGreaterThan(gyms[i - 1] - 1.5); });
  });

  it("a Hoenn gym's players never evolve past Gen 3 in the league", () => {
    const f = inJohto();
    finish(f, gymIds(f), 0);
    rookieDraft(f);
    expect(enterRegion(f, 'hoenn')).toBe(true);
    // Give Wattson a Kirlia (Gardevoir in Gen 3, Gallade later) at a level well past its evolution.
    const mau = f.teams.find((t) => t.leader === 'Wattson')!;
    const u = mau.roster[1];
    Object.assign(f.players[u], { dex: 281, level: 9, xp: 255 });
    const kirlia = { ...monByDex(281) };
    const line = { pts: 0, reb: 0, ast: 0, stl: 0, blk: 0, sec: 60, fgm: 0, fga: 0, tpm: 0, tpa: 0, dnk: 0, gs: 1 };
    const g = f.games.find((x) => !x.score)!;
    const box = { score: [80, 70], cfg: { quarterLen: 60 }, quarter: 4, rosterOf: (side: number) => (side === 1 ? [{ mon: kirlia, team: 1, stats: line }] : []) } as unknown as Game;
    for (let i = 0; i < 20 && f.players[u].dex === 281; i++) recordGame(f, { ...g, score: null }, box, [0, mau.id], new Map([[kirlia, u]]));
    expect(f.players[u].dex).toBe(282);
  });

  it('draws every Hoenn badge', () => {
    const neutral = badgeSvg('Nope', true);
    for (const b of HOENN.gyms.map((g) => g.badge!)) {
      const svg = badgeSvg(b, true);
      expect(svg).toContain(`aria-label="${b} Badge"`);
      expect(svg.replace(`${b} Badge`, 'Nope Badge')).not.toBe(neutral);
    }
  });
});

describe('the Hoenn franchise pool', () => {
  it('holds back the 121 new Gen 3 Pokémon until Hoenn unlocks; the 14 already in the game stay open', () => {
    for (const unlocked of [[], ['johto']]) {
      const pool = poolMons(openRegionIds(unlocked));
      expect(pool.filter((m) => gen3(m.dex)).map((m) => m.dex)).toEqual(LEGACY);
    }
    expect(poolMons(openRegionIds(['johto', 'hoenn'])).filter((m) => gen3(m.dex))).toHaveLength(135);
    expect(inPool(252, ['kanto', 'johto'])).toBe(false);
    expect(inPool(376, ['kanto'])).toBe(true);
    expect(inPool(252, ['kanto', 'johto', 'hoenn'])).toBe(true);
    // Quick Play (no boundary) has every Pokémon.
    expect(poolMons(undefined)).toHaveLength(POKEMON.length);
  });

  it('a locked franchise drafts the legacy 14 but no new Gen 3; free agency and rookies follow the lock', () => {
    const f = kanto();
    const owned = f.teams.flatMap((t) => t.roster).map((u) => f.players[u].dex);
    expect(owned.some(fresh)).toBe(false);
    expect(f.freeAgents.filter((u) => fresh(f.players[u].dex))).toHaveLength(121);
    const newFa = f.freeAgents.find((u) => fresh(f.players[u].dex))!;
    expect(canAcquire(f, newFa)).toBe(false);
    sign(f, f.teams[0].roster[9], newFa);
    expect(f.teams[0].roster).not.toContain(newFa);
    const legacyFa = f.freeAgents.find((u) => LEGACY.indexOf(f.players[u].dex) >= 0);
    if (legacyFa) expect(canAcquire(f, legacyFa)).toBe(true);
    for (const u of Object.keys(f.players).filter((x) => LEGACY.indexOf(f.players[x].dex) >= 0)) expect(canAcquire(f, u)).toBe(true);
    finish(f, [], 1);
    startRookieDraft(f);
    expect(f.rookies!.pool.some((u) => fresh(f.players[u].dex))).toBe(false);
  });

  it('a save made before Hoenn, with Sceptile and Blaziken on the roster, loads and keeps them', () => {
    const f = kanto();
    const me = f.teams[0];
    const add = (dex: number) => {
      const u = Object.keys(f.players).find((x) => f.players[x].dex === dex)!;
      for (const t of f.teams) t.roster = t.roster.filter((x) => x !== u);
      f.freeAgents = f.freeAgents.filter((x) => x !== u);
      return u;
    };
    const sceptile = add(254);
    const blaziken = add(257);
    me.roster.splice(0, 2, sceptile, blaziken);
    const raw = JSON.parse(JSON.stringify(f)) as Record<string, unknown>;
    for (const k of ['region', 'titles', 'completedRegions', 'unlockedRegions']) delete raw[k];
    store.set('pokejam.franchise.v1', JSON.stringify(raw));
    const g = loadFranchise()!;
    expect(g.teams[0].roster.slice(0, 2)).toEqual([sceptile, blaziken]);
    expect(g.teams[0].roster.map((u) => g.players[u].dex).slice(0, 2)).toEqual([254, 257]);
    expect(canAcquire(g, sceptile) && canAcquire(g, blaziken)).toBe(true);
    expect(regionOf(g).id).toBe('kanto');
    expect(g.unlockedRegions).toEqual([]);
  });
});

describe('unlocking Hoenn', () => {
  it('needs all eight Johto gym badges and the user title in one Johto season', () => {
    const cases: [number[] | 'all' | 'gyms', number, boolean][] = [
      [[], 1, false],
      [[], 0, false], // Johto title alone
      ['all', 2, false], // every Johto badge, CPU title
      [[1, 2, 3, 4, 5, 6, 7, 9], 0, false], // title + 7/8
      ['gyms', 0, true],
      ['all', 0, true],
    ];
    for (const [beat, champ, unlocks] of cases) {
      const f = inJohto();
      finish(f, beat === 'all' ? [...gymIds(f), eliteId(f)] : beat === 'gyms' ? gymIds(f) : beat, champ);
      expect(regionStatus(f).unlocked, `${beat} / ${champ}`).toBe(unlocks);
      expect((f.unlockedRegions ?? []).indexOf('hoenn') >= 0).toBe(unlocks);
      expect(f.titles).toEqual(champ === 0 ? [{ regionId: 'kanto', season: 1 }, { regionId: 'johto', season: 2 }] : [{ regionId: 'kanto', season: 1 }]);
    }
  });

  it('a Kanto completion never unlocks Hoenn, and a hand-edited Johto record in a Kanto league does not either', () => {
    const f = kanto();
    finish(f, [...gymIds(f), eliteId(f)], 0);
    expect(f.unlockedRegions).toEqual(['johto']);
    // Two Kanto completions are still just Johto.
    f.completedRegions!.push({ regionId: 'kanto', season: 1 });
    expect(regionStatus(f).unlocked).toBe(true);
    expect(f.unlockedRegions).toEqual(['johto']);

    const fake = kanto();
    Object.assign(fake, { season: 3, completedRegions: [{ regionId: 'johto', season: 2 }], unlockedRegions: ['hoenn'] });
    store.set('pokejam.franchise.v1', JSON.stringify(fake));
    const g = loadFranchise()!;
    expect(g.unlockedRegions).toEqual([]);
    expect(loadRegionProfile()).toEqual([]);
  });

  it('a real Johto season through advance unlocks Hoenn for good: saved, reloaded and on the device', () => {
    const f = inJohto();
    saveFranchise(f);
    while (f.phase !== 'done') playWeek(f, () => true);
    expect(f.champion).toBe(0);
    expect(f.unlockedRegions).toEqual(['johto', 'hoenn']);
    expect(f.news.join(' ')).toContain('Hoenn League is unlocked');
    expect(f.history[f.history.length - 1]).toMatchObject({ season: 2, region: 'johto' });
    expect(shouldPlayMasterCutscene(f)).toBe(false);
    saveFranchise(f);
    expect(loadRegionProfile()).toEqual(['johto', 'hoenn']);
    const g = loadFranchise()!;
    expect(g.unlockedRegions).toEqual(['johto', 'hoenn']);
    // A replacement franchise starts in Kanto with both regions open, and all of Gen 3 in its pool.
    store.delete('pokejam.franchise.v1');
    const next = kanto(loadRegionProfile());
    expect(regionOf(next).id).toBe('kanto');
    expect(poolMons(openRegionIds(loadRegionProfile())).filter((m) => gen3(m.dex))).toHaveLength(135);
    expect(next.freeAgents.filter((u) => fresh(next.players[u].dex)).every((u) => canAcquire(next, u))).toBe(true);
    // An old Johto save without region fields gets the unlock its finished season proves.
    store.clear();
    const raw = JSON.parse(JSON.stringify(f)) as Record<string, unknown>;
    for (const k of ['region', 'unlockedRegions']) delete raw[k];
    store.set('pokejam.franchise.v1', JSON.stringify(raw));
    const old = loadFranchise()!;
    expect(old.region).toBe('johto');
    expect(old.unlockedRegions).toEqual(['johto', 'hoenn']);
  }, 60000);
});

describe('entering and playing Hoenn', () => {
  function hoennStart(): Franchise {
    const f = inJohto();
    finish(f, gymIds(f), 0);
    expect(regionStatus(f)).toMatchObject({ next: HOENN, unlocked: true, canEnter: false });
    expect(enterRegion(f, 'hoenn')).toBe(false);
    rookieDraft(f);
    expect(regionStatus(f).canEnter).toBe(true);
    expect(text(regionCardHtml(f))).toContain('Enter Hoenn');
    expect(text(regionCardHtml(f))).toContain('Roxanne to Juan');
    return f;
  }

  it('moves the league to Hoenn with the user team whole and new Hoenn players', () => {
    const f = hoennStart();
    const me = JSON.parse(JSON.stringify(f.teams[0]));
    const before = Object.keys(f.players).length;
    expect(enterRegion(f, 'hoenn')).toBe(true);
    expect(regionOf(f)).toBe(HOENN);
    expect(f.teams[0]).toEqual(me);
    expect(f.teams.slice(1).map((t) => t.name)).toEqual(regionTeams(HOENN).map((t) => t.name));
    f.teams.slice(1).forEach((t, i) => expect(t.roster.map((u) => f.players[u].dex)).toEqual(regionTeams(HOENN)[i].roster));
    expect(Object.keys(f.players)).toHaveLength(before + 90);
    const refs = [...f.teams.flatMap((t) => t.roster), ...f.freeAgents];
    expect(new Set(refs).size).toBe(refs.length);
    for (const u of refs) expect(f.players[u]?.uid).toBe(u);
    expect(seasonWeeks(f)).toBe(9);
    expect(f.games.filter((g) => g.home === 0 || g.away === 0).map((g) => f.teams[g.home === 0 ? g.away : g.home].leader))
      .toEqual(['Roxanne', 'Brawly', 'Wattson', 'Flannery', 'Norman', 'Winona', 'Tate & Liza', 'Juan', 'Sidney · Phoebe · Glacia · Drake · Champion Steven']);
    expect(venueOf(f, 1)).toMatchObject({ venue: 'Rustboro City Gym', logo: 'Stone' });
    expect(venueOf(f, 9)).toMatchObject({ venue: 'Ever Grande City', logo: 'Elite' });
    // There is no region after Hoenn yet: no card, nothing to enter.
    expect(regionStatus(f).next).toBeUndefined();
    expect(regionCardHtml(f)).toBe('');
    // New Gen 3 free agents are open now.
    const newFa = f.freeAgents.find((u) => fresh(f.players[u].dex))!;
    expect(canAcquire(f, newFa)).toBe(true);
    sign(f, f.teams[0].roster[0], newFa);
    expect(f.teams[0].roster).toContain(newFa);
    expect(standingsHtml(f)).toContain('<small title="Sidney · Phoebe · Glacia · Drake · Champion Steven">');
    expect(LEAGUE.map((t) => t.name)).toEqual(regionTeams(REGIONS[0]).map((t) => t.name));
  });

  it('a Hoenn title adds a Hoenn Champion banner next to Kanto and Johto, and never the PokeJam Master scene', () => {
    const f = hoennStart();
    f.pokejamMaster = 1;
    enterRegion(f, 'hoenn');
    saveFranchise(f);
    const g = loadFranchise()!;
    expect(g.region).toBe('hoenn');
    expect(g.teams.slice(1).map((t) => t.badge ?? 'Elite')).toEqual(['Stone', 'Knuckle', 'Dynamo', 'Heat', 'Balance', 'Feather', 'Mind', 'Rain', 'Elite']);
    while (g.phase !== 'done') playWeek(g, () => true);
    expect(g.champion).toBe(0);
    expect(g.completedRegions!.map((c) => c.regionId)).toEqual(['kanto', 'johto', 'hoenn']);
    expect(regionTitles(g).map((t) => `${t.region.name} Champion`)).toEqual(['Kanto Champion', 'Johto Champion', 'Hoenn Champion']);
    expect(text(championBannerHtml(g))).toBe('Kanto Champion Season 1 Johto Champion Season 2 Hoenn Champion Season 3');
    expect(shouldPlayMasterCutscene(g)).toBe(false);
    delete g.pokejamMaster;
    expect(shouldPlayMasterCutscene(g)).toBe(false);
    expect(g.unlockedRegions).toEqual(['johto', 'hoenn']);
    rookieDraft(g);
    // The Hoenn title sends the next season back to Kanto. The banner above was already recorded.
    expect(g.region).toBe('kanto');
    expect(g.teams.slice(1).map((t) => t.name)).toEqual(regionTeams(REGIONS[0]).map((t) => t.name));
    expect(g.titles).toEqual([{ regionId: 'kanto', season: 1 }, { regionId: 'johto', season: 2 }, { regionId: 'hoenn', season: 3 }]);
  }, 60000);

  it('entering Hoenn needs Hoenn unlocked: a Johto league without it is refused', () => {
    const f = inJohto();
    finish(f, [], 0);
    rookieDraft(f);
    expect(regionStatus(f)).toMatchObject({ next: HOENN, unlocked: false, canEnter: false });
    expect(enterRegion(f, 'hoenn')).toBe(false);
    expect(regionOf(f)).toBe(JOHTO);
  });
});

describe('Gen 3 outside the franchise', () => {
  it('Ranked leaves out Deoxys and keeps every Gen 3 legendary off preset teams', () => {
    expect(RANKED_EXCLUDED).toContain(386);
    expect(RANKED_POOL.some((m: Mon) => m.dex === 386)).toBe(false);
    for (const d of [377, 378, 379, 380, 381, 382, 383, 384, 385, 386]) expect(RANKED_LEGENDARIES).toContain(d);
  });
});
