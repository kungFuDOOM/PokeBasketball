import { beforeEach, describe, expect, it } from 'vitest';
import { POKEMON } from '../data/pokemon';
import { DRAFTED_KEY, loadDrafted, renameDrafted, saveDrafted } from './team';

// Node has no localStorage; a tiny in-memory one is enough for the saved-team helpers.
const store = new Map<string, string>();
(globalThis as { localStorage?: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
} as Storage;

describe('renaming My Drafted Team', () => {
  beforeEach(() => {
    store.clear();
    saveDrafted({ name: 'Pallet Town', abbr: 'PAL', colors: { color: '#3b6fd8', color2: '#16224a' }, mons: POKEMON.slice(0, 10), record: { w: 13, l: 5 }, rank: 2 });
  });

  it('persists the new name and abbreviation and keeps the rest of the team', () => {
    const before = loadDrafted()!;
    renameDrafted('Cerulean Crew');
    const after = loadDrafted()!;
    expect(after.name).toBe('Cerulean Crew');
    expect(after.abbr).toBe('CER');
    expect(after.dex).toEqual(before.dex);
    expect(after.starters).toEqual(before.starters);
    expect(after.record).toEqual({ w: 13, l: 5 });
    expect(after.rank).toBe(2);
    expect(JSON.parse(store.get(DRAFTED_KEY)!).name).toBe('Cerulean Crew');
  });

  it('sanitises the name and ignores an empty one', () => {
    renameDrafted('  <b>Mt.\u0000 Moon</b>   Rockets and more letters  ');
    const t = loadDrafted()!;
    expect(t.name).not.toMatch(/[<>\u0000]/);
    expect(t.name.length).toBeLessThanOrEqual(20);
    renameDrafted('   ');
    expect(loadDrafted()!.name).toBe(t.name);
  });

  it('does nothing when there is no saved team', () => {
    store.clear();
    expect(renameDrafted('Anything')).toBeNull();
    expect(store.has(DRAFTED_KEY)).toBe(false);
  });
});
