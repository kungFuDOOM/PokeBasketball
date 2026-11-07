import { beforeAll, describe, expect, it } from 'vitest';
import { POKEMON } from '../data/pokemon';
import { featuredShooter } from './contest';
import { pickerRows } from './picker';

beforeAll(() => { (globalThis as { window?: unknown }).window ??= {}; });

describe('pickerRows', () => {
  it('lists every Pokémon when the search is empty, best Sht first, then by name', () => {
    const rows = pickerRows('', null);
    expect(rows).toHaveLength(POKEMON.length);
    expect(rows[0].r.sht).toBe(Math.max(...POKEMON.map((m) => m.r.sht)));
    for (let i = 1; i < rows.length; i++) {
      const a = rows[i - 1], b = rows[i];
      expect(a.r.sht > b.r.sht || (a.r.sht === b.r.sht && a.name.localeCompare(b.name) <= 0)).toBe(true);
    }
  });
  it('filters by name (case-insensitive) and by dex number', () => {
    const pika = POKEMON.find((m) => m.dex === 25)!;
    expect(pickerRows('PIKA', null).map((m) => m.dex)).toContain(25);
    expect(pickerRows('pika', null).every((m) => m.name.toLowerCase().includes('pika'))).toBe(true);
    expect(pickerRows('#25', null)[0]?.dex === 25 || pickerRows('#25', null).some((m) => m.dex === 25)).toBe(true);
    expect(pickerRows('25', null).some((m) => m.name === pika.name)).toBe(true);
    expect(pickerRows('zzzz-no-such-mon', null)).toEqual([]);
  });
  it('the featured hook is off outside the window and a featured dex would go first', () => {
    expect(featuredShooter(Date.parse('2026-01-01T00:00:00-08:00'))).toBeNull();
    const all = pickerRows('', null);
    const last = all[all.length - 1];
    expect(pickerRows('', { dex: last.dex, badge: 'x' })[0].dex).toBe(last.dex);
  });
});
