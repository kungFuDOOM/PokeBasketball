import { beforeAll, describe, expect, it } from 'vitest';
import { POKEMON, monByDex } from '../data/pokemon';
import { pickerRows } from '../threept/picker';
import { featuredShooter } from '../threept/contest';
import { KING_KABUTO } from './config';
import { kingFeatured, kingKabutoMon, withKingKabuto } from './king';

beforeAll(() => { (globalThis as { window?: unknown }).window ??= {}; });

const t = (iso: string) => Date.parse(iso);
const BEFORE = t('2026-11-08T23:59:59-08:00');
const DURING = t('2026-11-15T12:00:00-08:00');
const AFTER = t('2026-11-23T00:00:00-08:00');

describe('King Kabuto card', () => {
  const k = kingKabutoMon();
  const plain = monByDex(140);
  it('is named, dex 140, SG, inherits types and size', () => {
    expect(k.name).toBe('King Kabuto');
    expect(k.dex).toBe(140);
    expect(k.pos).toBe('SG');
    expect(k.types).toEqual(plain.types);
    expect(k.size).toEqual(plain.size);
  });
  it('stays within the rating bounds', () => {
    expect(k.r.sht).toBeGreaterThanOrEqual(97);
    expect(k.r.sht).toBeLessThanOrEqual(99);
    expect(k.ovr).toBeGreaterThanOrEqual(85);
    expect(k.ovr).toBeLessThanOrEqual(89);
    for (const [key, v] of Object.entries(k.r)) {
      expect(v).toBeGreaterThanOrEqual(25);
      expect(v).toBeLessThanOrEqual(99);
      if (key !== 'sht') expect(v).toBeLessThanOrEqual(85);
    }
  });
  it('is below the top regular player', () => {
    expect(k.ovr).toBeLessThan(Math.max(...POKEMON.map((m) => m.ovr)));
  });
  it('leaves the regular Kabuto untouched', () => {
    expect(plain.name).toBe('Kabuto');
    expect(plain.r).not.toEqual(k.r);
    expect(POKEMON.filter((m) => m.dex === 140)).toHaveLength(1);
  });
});

describe('pool + featured hook', () => {
  it('before the window nothing changes', () => {
    expect(withKingKabuto(POKEMON, BEFORE)).toEqual(POKEMON);
    expect(kingFeatured(BEFORE)).toBeNull();
    expect(pickerRows('', kingFeatured(BEFORE))[0].name).not.toBe('King Kabuto');
  });
  it('during the window he replaces Kabuto and is first', () => {
    const pool = withKingKabuto(POKEMON, DURING);
    expect(pool).toHaveLength(POKEMON.length);
    expect(kingFeatured(DURING)).toEqual({ dex: 140, badge: KING_KABUTO.badge });
    const rows = pickerRows('', kingFeatured(DURING), pool);
    expect(rows[0].name).toBe('King Kabuto');
    expect(rows.filter((m) => m.dex === 140)).toHaveLength(1);
    expect(pickerRows('kabuto', kingFeatured(DURING), pool).some((m) => m.name === 'King Kabuto')).toBe(true);
  });
  it('after the window he is gone', () => {
    expect(withKingKabuto(POKEMON, AFTER).some((m) => m.name === 'King Kabuto')).toBe(false);
    expect(kingFeatured(AFTER)).toBeNull();
  });
  it('does not insert when dex 140 is absent', () => {
    const pool = POKEMON.filter((m) => m.dex !== 140);
    expect(withKingKabuto(pool, DURING)).toHaveLength(pool.length);
  });
  it('featuredShooter() follows kingFeatured()', () => {
    expect(featuredShooter(DURING)).toEqual(kingFeatured(DURING));
    expect(featuredShooter(BEFORE)).toBeNull();
  });
});
