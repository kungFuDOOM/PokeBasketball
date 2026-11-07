import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { THREEPT_KEY, loadBest, saveIfBest } from './save';

const g = globalThis as { localStorage?: Storage };
const original = g.localStorage;
const store = new Map<string, string>();
const memoryStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
} as Storage;
const throwing = {
  getItem: () => { throw new Error('blocked'); },
  setItem: () => { throw new Error('blocked'); },
  removeItem: () => { throw new Error('blocked'); },
  clear: () => { throw new Error('blocked'); },
  key: () => null,
  length: 0,
} as unknown as Storage;

describe('3-point high score', () => {
  beforeEach(() => { store.clear(); g.localStorage = memoryStorage; });
  afterEach(() => { g.localStorage = original; });

  it('uses a pokejam.* key so Delete saved data clears it', () => {
    expect(THREEPT_KEY).toBe('pokejam.threept.v1');
    expect(THREEPT_KEY.startsWith('pokejam.')).toBe(true);
  });
  it('round-trips score, dex, name and time', () => {
    expect(loadBest()).toBeNull();
    expect(saveIfBest(21, 25, 'Pikachu', 1000)).toBe(true);
    expect(loadBest()).toEqual({ score: 21, dex: 25, name: 'Pikachu', at: 1000 });
    expect(JSON.parse(store.get(THREEPT_KEY)!)).toEqual({ score: 21, dex: 25, name: 'Pikachu', at: 1000 });
  });
  it('saves only a better score; ties keep the old best', () => {
    saveIfBest(20, 1, 'A', 1);
    expect(saveIfBest(19, 2, 'B', 2)).toBe(false);
    expect(saveIfBest(20, 2, 'B', 2)).toBe(false);
    expect(loadBest()?.name).toBe('A');
    expect(saveIfBest(21, 2, 'B', 3)).toBe(true);
    expect(loadBest()).toEqual({ score: 21, dex: 2, name: 'B', at: 3 });
  });
  it('a first-ever 0 is not a new high score and is not saved', () => {
    expect(saveIfBest(0, 25, 'Pikachu')).toBe(false);
    expect(loadBest()).toBeNull();
    expect(saveIfBest(1, 25, 'Pikachu')).toBe(true);
  });
  it('rejects scores below 0, above 34 and non-integers', () => {
    for (const s of [-1, 35, 12.5, NaN, Infinity]) expect(saveIfBest(s, 1, 'A')).toBe(false);
    expect(store.size).toBe(0);
    expect(saveIfBest(34, 1, 'A')).toBe(true);
  });
  it('corrupt, wrong-shape and wrong-type data reads as null and can be overwritten', () => {
    for (const raw of ['{not json', 'null', '42', '"x"', '[]', '{}', '{"score":"10","dex":1,"name":"A","at":1}',
      '{"score":10,"dex":"1","name":"A","at":1}', '{"score":10,"dex":1,"name":5,"at":1}', '{"score":99,"dex":1,"name":"A","at":1}']) {
      store.set(THREEPT_KEY, raw);
      expect(loadBest()).toBeNull();
    }
    expect(saveIfBest(5, 1, 'A')).toBe(true);
  });
  it('never throws when storage is blocked', () => {
    g.localStorage = throwing;
    expect(loadBest()).toBeNull();
    expect(saveIfBest(10, 1, 'A')).toBe(false);
    g.localStorage = { ...memoryStorage, getItem: () => null, setItem: () => { throw new Error('quota'); } } as unknown as Storage;
    expect(saveIfBest(10, 1, 'A')).toBe(false);
  });
});
