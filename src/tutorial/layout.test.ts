import { describe, expect, it } from 'vitest';
// @ts-ignore Node's fs has no type declarations in this project; vitest strips CSS from ?raw imports, so read the file directly.
import { readFileSync } from 'node:fs';

const css: string = readFileSync('src/style.css', 'utf8');
const main: string = readFileSync('src/main.ts', 'utf8');
const menu: string = readFileSync('src/screens/menu.ts', 'utf8');
const screen: string = readFileSync('src/screens/tutorial.ts', 'utf8');
const esc = (sel: string) => sel.replace(/[.[\]():]/g, '\\$&');
const rule = (sel: string) => css.match(new RegExp(`(?:^|\\n)${esc(sel)} \\{([^}]*)\\}`))?.[1] ?? '';
/** Every rule body whose selector list mentions `.tut-strip` (media-query overrides included). */
const stripRules = (): string[] =>
  [...css.matchAll(/([^{}]*\.tut-strip[^{}]*)\{([^}]*)\}/g)].map((m) => m[2]);

describe('tutorial prompt strip layout', () => {
  it('is a flex row in the game screen, not floated over the stage', () => {
    const strip = rule('.tut-strip');
    expect(strip).not.toBe('');
    for (const body of stripRules()) expect(body).not.toMatch(/position:\s*(absolute|fixed)/);
    expect(strip).toMatch(/flex: none/);
    expect(rule('.game.tut-on')).toMatch(/display: flex/);
    expect(rule('.game.tut-on')).toMatch(/flex-direction: column/);
  });
  it('shrinks the stage by its own height instead of covering it', () => {
    expect(rule('.tut-strip')).toMatch(/height: var\(--tut-h\)/);
    expect(rule('.game.tut-on .stage')).toMatch(/calc\(\(100dvh - var\(--tut-h\)\) \* 16 \/ 9\)/);
    expect(rule('.game.tut-on .hud, .game.tut-on .touch')).toMatch(/top: var\(--tut-h\)/);
  });
  it('is inserted as a sibling of the stage, not inside it', () => {
    expect(screen).toMatch(/gameEl\.classList\.add\('tut-on'\)/);
    expect(screen).toMatch(/gameEl\.insertAdjacentHTML\('afterbegin', stripHtml\(\)\)/);
    expect(screen).toMatch(/querySelector<HTMLElement>\('\.game'\)/);
  });
  it('reserves right padding (110px + safe area) for the pause/music/X corner', () => {
    expect(rule('.tut-strip')).toMatch(/margin: 0 calc\(110px \+ env\(safe-area-inset-right, 0px\)\) auto 0/);
    // The X link and music button sit within that reserved 110px: 10px + 40px + 10px + 40px = 100px.
    expect(rule('.x-link')).toMatch(/right: calc\(max\(10px, env\(safe-area-inset-right, 0px\)\) \+ 40px \+ 10px\)/);
    expect(rule('.x-link')).toMatch(/width: 40px/);
  });
  it('only its buttons take pointer events', () => {
    expect(rule('.tut-strip')).toMatch(/pointer-events: none/);
    expect(rule('.tut-btn')).toMatch(/pointer-events: auto/);
  });
});

describe('tutorial menu wiring', () => {
  it('main.ts wires onTutorial to the lazy-loaded tutorial screen', () => {
    expect(main).toMatch(/onTutorial: \(\) => tutorial\(\)/);
    expect(main).toMatch(/function tutorial\(\)/);
    expect(main).toMatch(/import\('\.\/screens\/tutorial'\)/);
  });
  it('menu has a Tutorial button bound to onTutorial', () => {
    expect(menu).toMatch(/onTutorial: \(\) => void/);
    expect(menu).toMatch(/data-go="tutorial"/);
    expect(menu).toMatch(/\$\('\[data-go="tutorial"\]'\)!\.addEventListener\('click', leave\(opts\.onTutorial\)\)/);
  });
  it('menu hides the "New? Try the tutorial" hint once the tutorial is done', () => {
    expect(menu).toMatch(/import \{ isTutorialDone \} from '\.\.\/tutorial\/store'/);
    expect(menu).toMatch(/<p class="tut-hint-menu"\$\{isTutorialDone\(\) \? ' hidden' : ''\}>New\? Try the tutorial<\/p>/);
    expect(rule('.tut-hint-menu[hidden]')).toMatch(/display: none/);
  });
});
