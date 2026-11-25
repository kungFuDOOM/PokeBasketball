import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EVOLUTIONS, POKEMON, monByDex, withBonus } from '../data/pokemon';
import { THREEPT_KEY, loadBest } from '../threept/save';
import { KING_KABUTO, kingKabutoActive } from '../kabuto/config';
import { isKingKabuto, kingKabutoCard, withKingKabuto } from '../kabuto/king';
import { poolMons } from './regions';
import { featuredShooter } from '../threept/contest';
import { LEAGUE, createFranchise, evolutionOf, loadFranchise, monOf, saveFranchise, type Franchise } from './league';

const store = new Map<string, string>();
vi.stubGlobal('localStorage', {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => { store.set(k, v); },
  removeItem: (k: string) => { store.delete(k); },
});
beforeEach(() => store.clear());

function league(): Franchise {
  const pick = (dexes: number[]) => dexes.map((d) => POKEMON.find((m) => m.dex === d)!);
  const teams = [
    { name: 'Pallet Town', abbr: 'PAL', color: '#3b6fd8', color2: '#16224a', human: true },
    { ...LEAGUE[0], human: false },
  ];
  const rosters = [pick([25, 140, 6, 9, 143]), pick([74, 95, 111, 76, 142])];
  const used = new Set(rosters.flat().map((m) => m.dex));
  return createFranchise(teams, rosters, POKEMON.filter((m) => !used.has(m.dex)));
}

const OLD_WINDOW = Date.parse('2026-11-15T12:00:00-08:00');
const kingUid = (f: Franchise) => Object.values(f.players).find((p) => p.dex === 140)!.uid;

describe('existing saves keep King Kabuto', () => {
  it('a saved king-flagged Kabuto loads as King Kabuto with level, xp, bonus, uid and roster spot kept', () => {
    const f = league();
    const uid = kingUid(f);
    const spot = f.teams[0].roster.indexOf(uid);
    Object.assign(f.players[uid], { king: true, level: 4, xp: 3, bonus: { pas: 2, spd: 1 }, ovrStart: 87 });
    saveFranchise(f);

    const loaded = loadFranchise()!;
    expect(loaded).not.toBeNull();
    const p = loaded.players[uid];
    expect(p).toMatchObject({ uid, dex: 140, king: true, level: 4, xp: 3, bonus: { pas: 2, spd: 1 }, ovrStart: 87 });
    expect(loaded.teams[0].roster.indexOf(uid)).toBe(spot);
    const m = monOf(loaded, uid);
    expect(m.name).toBe(KING_KABUTO.name);
    expect(m.ovr).toBe(kingKabutoCard({ pas: 2, spd: 1 }).ovr);
    expect(m.ovr).toBeGreaterThan(withBonus(140, { pas: 2, spd: 1 }).ovr + 15);
    expect(m.r.sht).toBe(98);
    expect(evolutionOf(p)).toBeUndefined();
    expect(evolutionOf({ ...p, king: undefined })).toBe(EVOLUTIONS[140]);
  });

  it('a plain Kabuto in a save is still a plain Kabuto', () => {
    const f = league();
    expect(monOf(f, kingUid(f)).name).toBe('Kabuto');
  });
});

describe('new franchises and Quick Play never offer him', () => {
  it('createFranchise never sets the flag, even when handed a King card', () => {
    const f = league();
    expect(Object.values(f.players).some((p) => p.king !== undefined)).toBe(false);
    expect(monOf(f, kingUid(f)).name).toBe('Kabuto');
    const pool = POKEMON.map((m) => (m.dex === 140 ? kingKabutoCard() : m));
    const used = new Set([25, 140, 6, 9, 143]);
    const g = createFranchise(
      [{ name: 'Pallet Town', abbr: 'PAL', color: '#3b6fd8', color2: '#16224a', human: true }],
      [pool.filter((m) => used.has(m.dex))], pool.filter((m) => !used.has(m.dex)),
    );
    expect(Object.values(g.players).every((p) => p.king === undefined)).toBe(true);
  });

  it('the franchise draft pools have no King card', () => {
    for (const regions of [['kanto'], ['kanto', 'johto', 'hoenn', 'sinnoh']]) {
      const pool = poolMons(regions);
      expect(pool.some(isKingKabuto)).toBe(false);
      expect(pool.filter((m) => m.dex === 140).every((m) => m.name === 'Kabuto')).toBe(true);
    }
  });

  it('Quick Play draws from POKEMON, which has only plain Kabuto, with or without the old window date', () => {
    expect(POKEMON.some(isKingKabuto)).toBe(false);
    expect(POKEMON.filter((m) => m.dex === 140).map((m) => m.name)).toEqual(['Kabuto']);
    expect(withKingKabuto(POKEMON, OLD_WINDOW).some(isKingKabuto)).toBe(false);
    expect(withKingKabuto(POKEMON, OLD_WINDOW)).toEqual(POKEMON);
  });
});

describe('slim King card helper', () => {
  it('has the King card ratings and is never active', () => {
    const k = kingKabutoCard();
    expect(k.name).toBe('Kabuto King');
    expect(k.dex).toBe(140);
    expect(k.r).toMatchObject({ sht: 98, hnd: 82, spd: 78 });
    expect(k.ovr).toBe(87);
    expect(isKingKabuto(k)).toBe(true);
    expect(isKingKabuto(monByDex(140))).toBe(false);
    expect(kingKabutoCard({ spd: 2 }).r.spd).toBe(80);
    expect(kingKabutoActive(OLD_WINDOW)).toBe(false);
    expect(kingKabutoActive()).toBe(false);
  });
});

describe('other retired-special hooks', () => {
  it('a stored 3-Point best keeps its saved name', () => {
    store.set(THREEPT_KEY, JSON.stringify({ score: 30, dex: 140, name: 'Kabuto King', at: 1 }));
    expect(loadBest()).toEqual({ score: 30, dex: 140, name: 'Kabuto King', at: 1 });
  });

  it('the 3-Point picker has no featured shooter', () => {
    expect(featuredShooter(OLD_WINDOW)).toBeNull();
  });
});
