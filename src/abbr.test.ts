import { beforeEach, describe, expect, it } from 'vitest';
import { POKEMON } from './data/pokemon';
import { DRAFTED_KEY, loadDrafted, saveDrafted } from './season/team';
import { abbr, cleanAbbr, fixAbbr, isAbbr } from './util';
import html from '../index.html?raw';
// @ts-ignore Node's fs has no type declarations in this project; vitest strips CSS from ?raw imports, so read the file directly.
import { readFileSync } from 'node:fs';
import { VIEWPORT, guardZoom, isDoubleTap } from './ui/noZoom';

const css: string = readFileSync('src/style.css', 'utf8');
const store = new Map<string, string>();
(globalThis as { localStorage?: Storage }).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, String(v)),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
  key: (i: number) => [...store.keys()][i] ?? null,
  get length() { return store.size; },
} as Storage;

describe('scoreboard abbreviation rules', () => {
  it('is valid only as exactly three letters A-Z', () => {
    for (const ok of ['DOO', 'PEW', 'AAA']) expect(isAbbr(ok)).toBe(true);
    for (const bad of ['', 'DO', 'D', 'DOOM', 'doo', 'D0O', 'DO ', 'D-O']) expect(isAbbr(bad)).toBe(false);
  });
  it('typing keeps A-Z and caps at three', () => {
    expect(cleanAbbr('d1o-o m')).toBe('DOO');
    expect(cleanAbbr('ab')).toBe('AB');
  });
  it('derived from a name is always three letters', () => {
    for (const n of ['DOOM SQUAD', 'Al', 'Z', 'Pallet Town', '42', '', 'Mr. Mime', 'é']) expect(isAbbr(abbr(n))).toBe(true);
    expect(abbr('DOOM SQUAD')).toBe('DOO');
    expect(abbr('Al')).toBe('ALX');
    expect(abbr('Z')).toBe('ZXX');
    expect(abbr('42')).toBe('YOU');
  });
});

describe('old saves with short abbreviations', () => {
  beforeEach(() => store.clear());
  it('fixAbbr keeps valid ones and re-derives the rest from the name', () => {
    expect(fixAbbr('PEW', 'Pewter Boulders')).toBe('PEW');
    expect(fixAbbr('DO', 'DOOM SQUAD')).toBe('DOO');
    expect(fixAbbr('D', 'DOOM SQUAD')).toBe('DOO');
    expect(fixAbbr('DOOM', 'DOOM SQUAD')).toBe('DOO');
    expect(fixAbbr(undefined, 'Al')).toBe('ALX');
  });
  it('loadDrafted migrates a 2-letter saved abbreviation', () => {
    saveDrafted({ name: 'DOOM SQUAD', abbr: 'DO', colors: { color: '#3b6fd8', color2: '#16224a' }, mons: POKEMON.slice(0, 10) });
    expect(JSON.parse(store.get(DRAFTED_KEY)!).abbr).toBe('DO');
    expect(loadDrafted()!.abbr).toBe('DOO');
  });
});

describe('scoreboard layout', () => {
  const rule = (sel: string) => css.match(new RegExp(`${sel.replace(/[.]/g, '\\.')}\\s*\\{([^}]*)\\}`))![1];
  it('never clips the abbreviation and keeps a gap before the score', () => {
    expect(rule('.bug-team .abbr')).not.toMatch(/overflow:\s*hidden/);
    expect(rule('.bug-team .abbr')).toMatch(/min-width:\s*3ch/);
    expect(rule('.bug-team')).toMatch(/column-gap:\s*10px/);
  });
  it('gives the score slot room for three digits', () => {
    // 3 digits of the pixel font are 3em of .pts; the box (8.2em of the bug font) must hold name + gap + slot.
    const box = 8.2 * 18.4 - 24; // 1.15rem bug font, 10px side padding + 4px border
    const name = 3 * 0.75 * 18.4 + 3; // generous 3-letter width incl. letter-spacing
    const pts = 3 * 0.95 * 16;
    expect(name + 10 + pts).toBeLessThan(box);
  });
});

describe('no zoom', () => {
  it('viewport meta forbids scaling', () => {
    expect(html).toContain(`content="${VIEWPORT}"`);
    for (const k of ['maximum-scale=1', 'user-scalable=no', 'viewport-fit=cover', 'initial-scale=1']) expect(VIEWPORT).toContain(k);
  });
  it('css sets touch-action on the page and the controls', () => {
      expect(css).toMatch(/html, body \{[^}]*touch-action: manipulation/);
    expect(css).toMatch(/\.stick-zone \{[^}]*touch-action: none/);
    expect(css).toMatch(/\.game \.tb[^{]*\{[^}]*touch-action: none/);
  });
  it('double touchend within 350ms counts as a double tap', () => {
    expect(isDoubleTap(0, 100)).toBe(false);
    expect(isDoubleTap(1000, 1200)).toBe(true);
    expect(isDoubleTap(1000, 1400)).toBe(false);
  });
  it('guardZoom cancels gestures, dblclick and a quick second tap on controls, but not menus', () => {
    const handlers: Record<string, ((e: Event) => void)[]> = {};
    const doc = {
      addEventListener: (t: string, f: (e: Event) => void) => void (handlers[t] ??= []).push(f),
      querySelector: () => null,
    };
    guardZoom({ addEventListener: () => {} }, doc as never);
    const ev = (target: string | null, timeStamp = 0) => {
      const e = { target: { closest: (s: string) => (target && s.includes(target) ? {} : null) }, timeStamp, prevented: false, preventDefault() { this.prevented = true; } };
      return e;
    };
    for (const t of ['gesturestart', 'gesturechange', 'gestureend']) { const e = ev(null); handlers[t][0](e as never); expect(e.prevented).toBe(true); }
    const dbl = ev('canvas'); handlers.dblclick[0](dbl as never); expect(dbl.prevented).toBe(true);
    const inp = ev('input'); handlers.dblclick[0](inp as never); expect(inp.prevented).toBe(false);
    const a = ev('.stick-zone', 1000), b = ev('.stick-zone', 1150);
    handlers.touchend[0](a as never); handlers.touchend[0](b as never);
    expect(a.prevented).toBe(false);
    expect(b.prevented).toBe(true);
    const m1 = ev('.nothing', 2000), m2 = ev('.nothing', 2100);
    handlers.touchend[0](m1 as never); handlers.touchend[0](m2 as never);
    expect(m2.prevented).toBe(false);
  });
});
