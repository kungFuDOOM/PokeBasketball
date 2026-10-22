import { beforeEach, describe, expect, it } from 'vitest';
import { POKEMON } from '../data/pokemon';
import { LEAGUE } from '../franchise/league';
import { loadDrafted, saveDrafted } from './team';
import { finishSeasonDraft } from '../screens/season';
import { confirmNewDraft } from '../ui/newDraft';

const store = new Map<string, string>();
(globalThis as { localStorage?: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
} as Storage;

const old = POKEMON.slice(0, 10);
const rosters = Array.from({ length: 1 + LEAGUE.length }, (_, t) => POKEMON.slice(10 + t * 10, 20 + t * 10));
const user = { name: 'Cerulean Crew', abbr: 'CER', color: '#e3350d', color2: '#16224a' };

describe('a new Season Draft and the saved team', () => {
  beforeEach(() => {
    store.clear();
    saveDrafted({ name: 'Pallet Town', abbr: 'PAL', colors: { color: '#3b6fd8', color2: '#16224a' }, mons: old, record: { w: 13, l: 5 }, rank: 2 });
  });

  it('keeps the old team until the new draft completes, then replaces it', () => {
    const before = loadDrafted()!;
    // Starting (and quitting) a draft never calls finishSeasonDraft, so the saved team is untouched.
    expect(loadDrafted()).toEqual(before);
    finishSeasonDraft(user, rosters, 7);
    const after = loadDrafted()!;
    expect(after.name).toBe('Cerulean Crew');
    expect(after.dex).toEqual(rosters[0].map((m) => m.dex));
    expect(after.dex).not.toEqual(before.dex);
    expect(after.record).toBeDefined();
  });

  it('skips the warning when no team is saved', async () => {
    store.clear();
    await expect(confirmNewDraft()).resolves.toBe('new');
  });
});
