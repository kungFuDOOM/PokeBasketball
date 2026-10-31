// @ts-ignore Node's fs has no type declarations in this project.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync(new URL('../public/framebust.js', import.meta.url), 'utf8');

type El = { tag: string; attrs: Record<string, string>; style: Record<string, string>; textContent: string; children: El[]; appendChild(c: El): El; setAttribute(k: string, v: string): void };
function el(tag: string): El {
  return {
    tag, attrs: {}, style: {}, textContent: '', children: [],
    appendChild(c) { this.children.push(c); return c; },
    setAttribute(k, v) { this.attrs[k] = v; },
  };
}

const HREF = 'https://pokejam.xyz/';
const ORIGIN = 'https://pokejam.xyz';

function run(top: 'self' | 'cross' | 'same', opts: { redirectThrows?: boolean } = {}) {
  const doc = { documentElement: el('html'), createElement: el };
  const location = { href: HREF, origin: ORIGIN };
  const win: any = {};
  win.self = win;
  const topLoc = { origin: ORIGIN };
  let redirectedTo: unknown;
  if (top === 'self') win.top = win;
  else if (top === 'same') win.top = { location: topLoc };
  else {
    win.top = {
      get location() { return { get origin(): string { throw new Error('SecurityError'); } }; },
      set location(v) {
        if (opts.redirectThrows) throw new Error('SecurityError');
        redirectedTo = v;
      },
    };
  }
  new Function('window', 'document', 'location', src)(win, doc, location);
  const overlay = doc.documentElement.children.find((c) => c.attrs.id === 'framebust');
  return { win, doc, overlay, redirectedTo };
}

describe('framebust guard', () => {
  it('does nothing when top-level', () => {
    const r = run('self');
    expect(r.win.__framed).toBeUndefined();
    expect(r.overlay).toBeUndefined();
    expect(r.doc.documentElement.style.visibility).toBeUndefined();
  });

  it('allows a same-origin parent', () => {
    const r = run('same');
    expect(r.win.__framed).toBeUndefined();
    expect(r.overlay).toBeUndefined();
  });

  it('breaks out of a cross-origin frame and shows the overlay', () => {
    const r = run('cross');
    expect(r.win.__framed).toBe(true);
    expect(r.redirectedTo).toBe(HREF);
    expect(r.overlay).toBeDefined();
  });

  it('survives a blocked redirect and shows the overlay', () => {
    const r = run('cross', { redirectThrows: true });
    expect(r.win.__framed).toBe(true);
    expect(r.redirectedTo).toBeUndefined();
    expect(r.doc.documentElement.style.visibility).toBe('hidden');
    const [msg, link] = r.overlay!.children;
    expect(r.overlay!.style.cssText).toContain('visibility:visible');
    expect(msg.textContent).toBe('Poké Jam only plays at pokejam.xyz');
    expect(link.tag).toBe('a');
    expect(link.attrs).toEqual({ href: 'https://pokejam.xyz', target: '_blank', rel: 'noopener' });
  });
});
