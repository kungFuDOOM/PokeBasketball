import { describe, expect, it } from 'vitest';
// @ts-ignore Node's fs has no type declarations in this project; vitest strips CSS from ?raw imports, so read the file directly.
import { readFileSync } from 'node:fs';

const css: string = readFileSync('src/style.css', 'utf8');
const main: string = readFileSync('src/main.ts', 'utf8');
const rule = (sel: string) => css.match(new RegExp(`${sel.replace(/[.[\]():]/g, '\\$&')} \\{([^}]*)\\}`))?.[1] ?? '';

describe('music button vs pause button', () => {
  it('both are at least 40x40 tap targets', () => {
    expect(rule('.music-btn')).toMatch(/width: 40px; height: 40px/);
    expect(rule('.icon-btn')).toMatch(/width: 40px; height: 40px/);
  });
  it('is hidden on the game screen', () => {
    expect(main).toMatch(/musicBtn\.hidden = app\.classList\.contains\('screen-game'\)/);
  });
  it('if shown next to a pause button, sits left of it with a 10px gap and honours the safe area', () => {
    const r = rule('body:has(.pause-btn) .music-btn:not(.docked)');
    expect(r).toMatch(/right: calc\(max\(10px, env\(safe-area-inset-right, 0px\)\) \+ 40px \+ 10px\)/);
    expect(r).toMatch(/top: max\(8px, env\(safe-area-inset-top, 0px\)\)/);
  });
  it('docked music buttons in menus keep their static layout', () => {
    expect(rule('.music-btn.docked')).toMatch(/position: static/);
  });
});
