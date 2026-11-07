import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { POKEMON, monByDex, withBonus } from '../data/pokemon';
import { THREEPT_KEY, loadBest, saveIfBest } from '../threept/save';
import { kingKabutoMon } from './king';

const store = new Map<string, string>();
beforeAll(() => {
  (globalThis as { window?: unknown }).window ??= {};
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  };
});
afterEach(() => store.clear());

describe('saves and the regular roster do not see King Kabuto', () => {
  it('POKEMON has no King Kabuto and exactly one plain Kabuto', () => {
    expect(POKEMON.some((m) => m.name === 'King Kabuto')).toBe(false);
    const k = POKEMON.filter((m) => m.dex === 140);
    expect(k).toHaveLength(1);
    expect(k[0].name).toBe('Kabuto');
  });
  it('monByDex(140) is plain Kabuto, not the buffed card', () => {
    expect(monByDex(140).name).toBe('Kabuto');
    expect(monByDex(140).r.sht).toBeLessThan(kingKabutoMon().r.sht);
  });
  it('a stored franchise-style roster with dex 140 resolves to plain Kabuto', () => {
    const roster = JSON.parse(JSON.stringify([{ dex: 140, bonus: {} }]));
    const m = withBonus(roster[0].dex, roster[0].bonus);
    expect(m.name).toBe('Kabuto');
    expect(m.r).toEqual(monByDex(140).r);
  });
  for (const [label, iso] of [['before', '2026-11-08T12:00:00-08:00'], ['during', '2026-11-15T12:00:00-08:00'], ['after', '2026-12-01T12:00:00-08:00']] as const) {
    it(`3pt high score with dex 140 round-trips ${label} the window`, () => {
      const at = Date.parse(iso);
      expect(saveIfBest(20, 140, 'Kabuto', at)).toBe(true);
      expect(JSON.parse(store.get(THREEPT_KEY)!)).toEqual({ score: 20, dex: 140, name: 'Kabuto', at });
      expect(loadBest()).toEqual({ score: 20, dex: 140, name: 'Kabuto', at });
    });
  }
});
