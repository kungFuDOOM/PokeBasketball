import { describe, expect, it } from 'vitest';
import { POKEMON, monByDex, overall, type Ratings } from '../data/pokemon';
import { kingKabutoMon } from './king';

const KEYS = Object.keys(monByDex(140).r) as (keyof Ratings)[];

describe('King Kabuto card', () => {
  const k = kingKabutoMon();

  it('is a derived Kabuto: name, dex, SG, inherited types', () => {
    expect(k.name).toBe('King Kabuto');
    expect(k.dex).toBe(140);
    expect(k.pos).toBe('SG');
    expect(k.types).toEqual(monByDex(140).types);
    expect(k.special).toBe(monByDex(140).special);
    expect(k.size).toBeGreaterThan(0.8);
  });

  it('is an elite shooter with a moderate rest', () => {
    expect(k.r.sht).toBeGreaterThanOrEqual(97);
    expect(k.r.sht).toBeLessThanOrEqual(99);
    for (const key of KEYS) {
      expect(k.r[key]).toBeGreaterThanOrEqual(25);
      expect(k.r[key]).toBeLessThanOrEqual(99);
      if (key !== 'sht') expect(k.r[key]).toBeLessThanOrEqual(85);
    }
  });

  it('OVR comes from overall() and sits in the high 80s', () => {
    expect(k.ovr).toBe(overall(k.pos, k.r));
    expect(k.ovr).toBeGreaterThanOrEqual(85);
    expect(k.ovr).toBeLessThanOrEqual(89);
    expect(k.archetype).toBe('Sharpshooter');
  });

  it('is not broken in normal games: below the top regular OVR', () => {
    expect(k.ovr).toBeLessThan(Math.max(...POKEMON.map((m) => m.ovr)));
  });

  it('leaves the plain Kabuto untouched', () => {
    const plain = monByDex(140);
    expect(plain.name).toBe('Kabuto');
    expect(plain.r).toEqual({ spd: 57, sht: 61, ins: 68, pas: 54, def: 73, blk: 57, reb: 53, hnd: 56 });
  });
});
