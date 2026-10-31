// @ts-ignore Node's fs has no type declarations in this project.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const src = readFileSync(new URL('../public/ga.js', import.meta.url), 'utf8');

type El = { tag: string; async?: boolean; src?: string };

function run(framed: boolean) {
  const head: El[] = [];
  const doc = { head: { appendChild(c: El) { head.push(c); return c; } }, createElement: (tag: string): El => ({ tag }) };
  const win: any = {};
  win.self = win;
  win.top = framed ? {} : win;
  new Function('window', 'document', src)(win, doc);
  return { win, head };
}

describe('Google Analytics loader', () => {
  it('does nothing inside a frame', () => {
    const r = run(true);
    expect(r.win.dataLayer).toBeUndefined();
    expect(r.win.gtag).toBeUndefined();
    expect(r.head).toEqual([]);
  });

  it('configures GA4 with Google signals and ad personalization off', () => {
    const { win } = run(false);
    const calls = win.dataLayer.map((a: IArguments) => Array.from(a));
    expect(calls[0][0]).toBe('js');
    expect(calls[0][1]).toBeInstanceOf(Date);
    expect(calls[1]).toEqual(['config', 'G-HHF6EXVVZB', { allow_google_signals: false, allow_ad_personalization_signals: false }]);
    expect(calls).toHaveLength(2);
  });

  it('injects the async gtag.js script into head', () => {
    const { head } = run(false);
    expect(head).toEqual([{ tag: 'script', async: true, src: 'https://www.googletagmanager.com/gtag/js?id=G-HHF6EXVVZB' }]);
  });
});
