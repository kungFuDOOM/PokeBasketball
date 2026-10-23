import { describe, expect, it } from 'vitest';
import { POKEMON, isRetired, monByDex } from './pokemon';

const REQUESTED = [
  ['Tyrantrum', 'C'],
  ['Leafeon', 'PG'],
  ['Braviary', 'PF'],
  ['Tinkaton', 'SG'],
  ['Mawile', 'PG'],
] as const;

describe('requested roster additions', () => {
  for (const [name, pos] of REQUESTED) {
    it(`${name} is draftable at ${pos}`, () => {
      const m = POKEMON.find((p) => p.name === name);
      expect(m).toBeDefined();
      expect(m!.pos).toBe(pos);
      expect(isRetired(m!.dex)).toBe(false);
      expect(m!.size).toBeGreaterThanOrEqual(0.8);
      expect(m!.size).toBeLessThanOrEqual(1.3);
    });
  }

  it('still resolves a retired dex for old saves', () => {
    expect(isRetired(658)).toBe(true);
    expect(monByDex(658).name).toBe('Greninja');
  });
});
