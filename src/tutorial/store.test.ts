import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isTutorialDone, markTutorialDone, TUTORIAL_DONE_KEY } from './store';

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
