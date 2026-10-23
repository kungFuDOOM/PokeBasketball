import { beforeEach, describe, expect, it } from 'vitest';
import { POKEMON } from './data/pokemon';
import { DRAFTED_KEY, loadDrafted, saveDrafted } from './season/team';
import { abbr, cleanAbbr, fixAbbr, isAbbr } from './util';
import html from '../index.html?raw';
// @ts-ignore Node's fs has no type declarations in this project; vitest strips CSS from ?raw imports, so read the file directly.
import { readFileSync } from 'node:fs';
import { VIEWPORT, guardZoom, isDoubleTap } from './ui/noZoom';

const css: string = readFileSync('src/style.css', 'utf8');
const hud: string = readFileSync('src/game/hud.ts', 'utf8');
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
  it('gives abbreviation and score their own flex boxes with a gap', () => {
    const team = rule('.bug-team'), abbr = rule('.bug-team .abbr'), pts = rule('.bug-team .pts');
    expect(team).toMatch(/display:\s*flex/);
    expect(team).toMatch(/gap:\s*0\.6em/);
    expect(abbr).toMatch(/flex:\s*none/);
    expect(abbr).not.toMatch(/overflow:\s*hidden|position:\s*absolute|width:\s*\d/);
    expect(pts).toMatch(/min-width:\s*3ch/);
    expect(pts).toMatch(/tabular-nums/);
    expect(pts).not.toMatch(/position:\s*absolute|[^-]width:\s*\d/);
  });
  it('score flash uses its own class, not the absolutely positioned global .pop', () => {
    expect(hud).not.toMatch(/classList\.(add|remove)\('pop'\)/);
    expect(hud).toContain("classList.add('pts-flash')");
    expect(css).toMatch(/\.pts\.pts-flash\s*\{/);
    expect(css).not.toMatch(/\.pts\.pop/);
  });
  it('shrinks on short landscape screens and leaves room for the player card', () => {
    const m = css.match(/@media \(orientation: landscape\) and \(max-height: 500px\) \{([\s\S]*?)\n\}/)![1];
    expect(m).toMatch(/\.bug \{[^}]*font-size/);
    expect(m).toMatch(/\.bug \{[^}]*max-width:[^;]*safe-area-inset-left/);
    expect(m).toMatch(/\.bug-team \{[^}]*min-width/);
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
    const ev = (target: string | null, timeStamp = 0, cancelable = true) => {
      const e = { target: { closest: (s: string) => (target && s.includes(target) ? {} : null) }, timeStamp, cancelable, prevented: false, preventDefault() { this.prevented = true; } };
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
  it('guardZoom never swallows a quick tap on the pause button (its action runs on click) or a non-cancelable touchend', () => {
    const handlers: Record<string, ((e: Event) => void)[]> = {};
    const doc = {
      addEventListener: (t: string, f: (e: Event) => void) => void (handlers[t] ??= []).push(f),
      querySelector: () => null,
    };
    guardZoom({ addEventListener: () => {} }, doc as never);
    const ev = (target: string, timeStamp: number, cancelable = true) =>
      ({ target: { closest: (s: string) => (s.includes(target) ? {} : null) }, timeStamp, cancelable, prevented: false, preventDefault() { this.prevented = true; } });
    // Shoot, then pause 200ms later: the pause click must survive.
    const shoot = ev('.tb', 1000), pause = ev('.pause-btn', 1200);
    handlers.touchend[0](shoot as never); handlers.touchend[0](pause as never);
    expect(pause.prevented).toBe(false);
    // Scrolling in progress: the browser ignores preventDefault and logs a console error, so don't call it.
    const s1 = ev('.tb', 3000), s2 = ev('.tb', 3100, false);
    handlers.touchend[0](s1 as never); handlers.touchend[0](s2 as never);
    expect(s2.prevented).toBe(false);
  });
});
