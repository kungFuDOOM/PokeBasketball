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

type Opts = { redirectThrows?: boolean; hostname?: string; ancestorOrigins?: string[]; referrer?: string };
function run(top: 'self' | 'cross' | 'same', opts: Opts = {}) {
  const doc = { documentElement: el('html'), createElement: el, referrer: opts.referrer ?? '' };
  const hostname = opts.hostname ?? 'pokejam.xyz';
  const origin = opts.hostname ? `https://${hostname}` : ORIGIN;
  const location: any = { href: `${origin}/`, origin, hostname };
  if (opts.ancestorOrigins) location.ancestorOrigins = opts.ancestorOrigins;
  const win: any = {};
  win.self = win;
  const topLoc = { origin };
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
    const [msg, link, plain] = r.overlay!.children;
    expect(r.overlay!.style.cssText).toContain('visibility:visible');
    expect(msg.textContent).toBe('Poké Jam only plays at pokejam.xyz');
    expect(link.tag).toBe('a');
    expect(link.attrs).toEqual({ href: 'https://pokejam.xyz/', target: '_top', rel: 'noopener' });
    expect(link.textContent).toBe('Play at pokejam.xyz');
    expect(plain.textContent).toBe('pokejam.xyz');
  });

  it('leaves top-level pokejam.xyz, www and localhost untouched', () => {
    for (const hostname of ['pokejam.xyz', 'www.pokejam.xyz', 'localhost', '127.0.0.1', 'kungfudoom.github.io']) {
      const r = run('self', { hostname });
      expect(r.win.__framed).toBeUndefined();
      expect(r.overlay).toBeUndefined();
      expect(r.doc.documentElement.style.visibility).toBeUndefined();
    }
  });

  it('blocks a foreign hostname top-level without redirecting', () => {
    for (const hostname of ['evil.example', 'pokejam-test.vercel.app']) {
      const r = run('self', { hostname });
      expect(r.win.__framed).toBe(true);
      expect(r.overlay).toBeDefined();
      expect(r.overlay!.children[1].attrs.target).toBe('_self');
    }
  });

  it('blocks a foreign hostname even in a same-origin frame', () => {
    const r = run('same', { hostname: 'evil.example' });
    expect(r.win.__framed).toBe(true);
    expect(r.overlay).toBeDefined();
  });

  it('blocks a foreign ancestorOrigins entry', () => {
    const r = run('cross', { ancestorOrigins: [ORIGIN, 'https://pokejam.org'], referrer: `${ORIGIN}/` });
    expect(r.win.__framed).toBe(true);
    expect(r.overlay).toBeDefined();
  });

  it('blocks a sandboxed null ancestor', () => {
    expect(run('cross', { ancestorOrigins: ['null'] }).win.__framed).toBe(true);
  });

  it('blocks a cross-origin frame with empty referrer and no ancestorOrigins', () => {
    const r = run('cross', { referrer: '' });
    expect(r.win.__framed).toBe(true);
    expect(r.redirectedTo).toBe(HREF);
  });

  it('blocks a foreign or unparseable referrer', () => {
    expect(run('cross', { referrer: 'https://pokejam.org/' }).win.__framed).toBe(true);
    expect(run('cross', { referrer: 'not a url' }).win.__framed).toBe(true);
  });

  it('allows a pokejam.xyz / www parent', () => {
    expect(run('cross', { ancestorOrigins: ['https://www.pokejam.xyz'] }).win.__framed).toBeUndefined();
    expect(run('cross', { referrer: 'https://pokejam.xyz/page' }).win.__framed).toBeUndefined();
  });
});
