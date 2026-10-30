import { beforeEach, describe, expect, it } from 'vitest';
import { POKEMON } from '../data/pokemon';
import { LEAGUE, loadDraft } from '../franchise/league';
import { isNameBlocked } from '../nameFilter';
import { abbr } from '../util';
import { decodeShare, encodeShare } from './share';
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

describe('blocked team names from storage or links', () => {
  beforeEach(() => {
    store.clear();
    saveDrafted({ name: 'Pallet Town', abbr: 'PAL', colors: { color: '#3b6fd8', color2: '#16224a' }, mons: POKEMON.slice(0, 10), record: { w: 13, l: 5 }, rank: 2 });
  });

  it('refuses to rename the saved team to a blocked name', () => {
    renameDrafted('f u c k');
    expect(loadDrafted()!.name).toBe('Pallet Town');
  });

  it('a hand-edited saved team with a blocked name loads under the default name', () => {
    const raw = JSON.parse(store.get(DRAFTED_KEY)!);
    store.set(DRAFTED_KEY, JSON.stringify({ ...raw, name: 'Kissass', abbr: 'ASS' }));
    const t = loadDrafted()!;
    expect(t.name).toBe('Pallet Town');
    expect(t.abbr).toBe('PAL');
  });

  it('a share link carrying a blocked name shows the default name', () => {
    const t = { name: 'shiiit', color: '#3b6fd8', color2: '#16224a', dex: POKEMON.slice(0, 5).map((m) => m.dex), w: 0, l: 0, rank: 0, teams: 0, seed: 0, playoff: 'missed' as const, noRecord: true };
    expect(decodeShare(encodeShare(t))!.name).toBe('Pallet Town');
    expect(decodeShare(encodeShare({ ...t, name: 'Titans' }))!.name).toBe('Titans');
  });

  it('a saved league draft with a blocked team name gets the default name', () => {
    const team = (name: string, human: boolean) => ({ name, abbr: 'FUC', color: '#3b6fd8', color2: '#16224a', human });
    store.set('pokejam.draft.v1', JSON.stringify({ teams: [team('f u c k', true), team('asshole', false)], order: [0, 1], taken: [], rounds: 10 }));
    const d = loadDraft()!;
    expect(d.teams[0].name).toBe('Pallet Town');
    expect(d.teams[1].name).toBe(LEAGUE[0].name);
    expect(isNameBlocked(d.teams[0].abbr)).toBe(false);
  });

  it('a derived scoreboard abbreviation is never rude', () => {
    expect(abbr('Assassins')).not.toBe('ASS');
    expect(isNameBlocked(abbr('Titans'))).toBe(false);
    expect(abbr('Pallet Town')).toBe('PAL');
  });
});
