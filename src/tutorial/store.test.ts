import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DRILL_IDS } from './drills';
import {
  DRILL_STARS_KEY,
  getBestStars,
  isTutorialDone,
  loadBestStars,
  markTutorialDone,
  recordDrillStars,
  TUTORIAL_DONE_KEY,
} from './store';

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

describe('tutorial store', () => {
  beforeEach(() => { store.clear(); g.localStorage = memoryStorage; });
  afterEach(() => { g.localStorage = original; });

  it('uses the pokejam.tutorialDone key', () => {
    expect(TUTORIAL_DONE_KEY).toBe('pokejam.tutorialDone');
    expect(TUTORIAL_DONE_KEY.startsWith('pokejam.')).toBe(true);
  });

  it('is not done by default', () => {
    expect(isTutorialDone()).toBe(false);
  });

  it('is done after markTutorialDone', () => {
    markTutorialDone();
    expect(isTutorialDone()).toBe(true);
    expect(store.get(TUTORIAL_DONE_KEY)).toBe('1');
  });

  it('marking twice is harmless', () => {
    markTutorialDone();
    markTutorialDone();
    expect(isTutorialDone()).toBe(true);
  });

  it('is cleared when pokejam.* keys are removed (Delete saved data)', () => {
    markTutorialDone();
    for (const k of [...store.keys()]) if (k.startsWith('pokejam.')) memoryStorage.removeItem(k);
    expect(isTutorialDone()).toBe(false);
  });

  it('ignores unexpected stored values', () => {
    store.set(TUTORIAL_DONE_KEY, 'nope');
    expect(isTutorialDone()).toBe(false);
  });

  it('survives blocked storage', () => {
    g.localStorage = throwing;
    expect(() => markTutorialDone()).not.toThrow();
    expect(isTutorialDone()).toBe(false);
  });

  it('survives missing localStorage', () => {
    delete g.localStorage;
    expect(() => markTutorialDone()).not.toThrow();
    expect(isTutorialDone()).toBe(false);
  });
});

describe('drill best stars', () => {
  beforeEach(() => { store.clear(); g.localStorage = memoryStorage; });
  afterEach(() => { g.localStorage = original; });

  it('uses a pokejam.* key so Delete saved data clears it', () => {
    expect(DRILL_STARS_KEY.startsWith('pokejam.')).toBe(true);
  });

  it('defaults every drill to 0 stars', () => {
    const all = loadBestStars();
    expect(Object.keys(all).sort()).toEqual([...DRILL_IDS].sort());
    for (const id of DRILL_IDS) expect(all[id]).toBe(0);
  });

  it('records and persists stars per drill', () => {
    expect(recordDrillStars('layups', 2)).toBe(2);
    expect(getBestStars('layups')).toBe(2);
    expect(getBestStars('passing')).toBe(0);
    expect(JSON.parse(store.get(DRILL_STARS_KEY)!)).toMatchObject({ layups: 2 });
  });

  it('never decreases the best', () => {
    recordDrillStars('steals', 3);
    expect(recordDrillStars('steals', 1)).toBe(3);
    expect(recordDrillStars('steals', 0)).toBe(3);
    expect(getBestStars('steals')).toBe(3);
    recordDrillStars('defense', 1);
    recordDrillStars('defense', 2);
    expect(getBestStars('defense')).toBe(2);
  });

  it('does not write when nothing improved', () => {
    recordDrillStars('movement', 0);
    expect(store.has(DRILL_STARS_KEY)).toBe(false);
  });

  it('tolerates corrupt JSON and recovers on the next record', () => {
    store.set(DRILL_STARS_KEY, '{not json');
    expect(getBestStars('layups')).toBe(0);
    expect(recordDrillStars('layups', 1)).toBe(1);
    expect(getBestStars('layups')).toBe(1);
  });

  it('ignores wrong shapes and sanitizes values', () => {
    for (const bad of ['null', '[3,3]', '"3"', '42']) {
      store.set(DRILL_STARS_KEY, bad);
      expect(getBestStars('movement')).toBe(0);
    }
    store.set(DRILL_STARS_KEY, JSON.stringify({ layups: 9, jumpshots: -2, passing: '3', defense: 2.7, steals: null, bogus: 3 }));
    const all = loadBestStars();
    expect(all).toEqual({ movement: 0, layups: 3, jumpshots: 0, passing: 0, alleyoop: 0, defense: 2, steals: 0 });
    expect('bogus' in all).toBe(false);
  });

  it('keeps the tutorial-seen flag independent', () => {
    recordDrillStars('layups', 3);
    expect(isTutorialDone()).toBe(false);
    markTutorialDone();
    expect(getBestStars('layups')).toBe(3);
  });

  it('survives blocked storage', () => {
    g.localStorage = throwing;
    expect(() => recordDrillStars('layups', 2)).not.toThrow();
    expect(recordDrillStars('layups', 2)).toBe(2);
    expect(getBestStars('layups')).toBe(0);
  });

  it('survives missing localStorage', () => {
    delete g.localStorage;
    expect(() => recordDrillStars('passing', 3)).not.toThrow();
    expect(loadBestStars().passing).toBe(0);
  });
});
