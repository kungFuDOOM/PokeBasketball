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
    expect(screen).toMatch(/gameEl\.insertAdjacentHTML\('afterbegin', stripHtml\(coach\)\)/);
    expect(screen).toMatch(/querySelector<HTMLElement>\('\.game'\)/);
  });
  it('reserves right padding (110px + safe area) for the pause/music/X corner', () => {
    expect(rule('.tut-strip')).toMatch(/margin: 0 calc\(110px \+ env\(safe-area-inset-right, 0px\)\) auto 0/);
    // The X link and music button sit within that reserved 110px: 10px + 40px + 10px + 40px = 100px.
    expect(rule('.x-link')).toMatch(/right: calc\(max\(10px, env\(safe-area-inset-right, 0px\)\) \+ 40px \+ 10px\)/);
    expect(rule('.x-link')).toMatch(/width: 40px/);
  });
  it('puts the Telegram link left of the X link on the menu', () => {
    expect(rule('.x-link.tg-link')).toMatch(/right: calc\(max\(10px, env\(safe-area-inset-right, 0px\)\) \+ 40px \+ 10px \+ 40px \+ 10px\)/);
    expect(menu).toMatch(/class="x-link tg-link" href="https:\/\/t\.me\/PokeJamSol" target="_blank" rel="noopener noreferrer" aria-label="PokeJam on Telegram" title="PokeJam on Telegram"/);
  });
  it('only its buttons take pointer events', () => {
    expect(rule('.tut-strip')).toMatch(/pointer-events: none/);
    expect(rule('.tut-btn')).toMatch(/pointer-events: auto/);
  });
});

/** The body of `sel`'s rule inside the first @media block whose query matches `query`. */
const mediaRule = (query: RegExp, sel: string): string => {
  for (const m of css.matchAll(/@media ([^{]*)\{((?:[^{}]*\{[^}]*\})*)\s*\}/g)) {
    if (!query.test(m[1])) continue;
    const r = m[2].match(new RegExp(`(?:^|\\n)\\s*${esc(sel)} \\{([^}]*)\\}`));
    if (r) return r[1];
  }
  return '';
};
const px = (s: string) => Number(s.match(/calc\((\d+)px/)?.[1] ?? s.match(/(\d+)px/)?.[1] ?? NaN);

describe('tutorial coach in the prompt strip', () => {
  it('uses existing sprite art via spriteUrl (no new assets) and drops the portrait if it fails to load', () => {
    expect(screen).toMatch(/import \{ POKEMON, spriteUrl \} from '\.\.\/data\/pokemon'/);
    expect(screen).toMatch(/<img class="tut-coach" src="\$\{spriteUrl\(coach\.dex\)\}" alt="" aria-hidden="true"/);
    expect(screen).toMatch(/\.tut-coach'\)\?\.addEventListener\('error'/);
  });
  it('sits inside the strip (its own flex item), never positioned over the court', () => {
    expect(screen).toMatch(/<div class="tut-text">\$\{face\}<div class="tut-lines">/);
    const coach = rule('.tut-coach');
    expect(coach).toMatch(/flex: none/);
    expect(coach).not.toMatch(/position:/);
    expect(coach).toMatch(/pointer-events: none/);
    expect(rule('.tut-strip')).toMatch(/overflow: hidden/);
  });
  it('is sized from the strip height (minus the top safe area) so it fits on desktop and landscape phones', () => {
    const coach = rule('.tut-coach');
    expect(coach).toMatch(/width: var\(--coach\); height: var\(--coach\)/);
    expect(coach).toMatch(/--coach: calc\(var\(--tut-h\) - env\(safe-area-inset-top, 0px\) - 6px\)/);
    // Desktop 44px and short-landscape 38px strips leave a 38px / 32px portrait: both inside the strip.
    expect(px(rule('.game.tut-on'))).toBe(44);
    expect(px(mediaRule(/orientation: landscape\) and \(max-height: 500px/, '.game.tut-on'))).toBe(38);
  });
  it('portrait phones: coach + lines on one row, buttons on the next, all inside the 88px strip', () => {
    const portrait = /orientation: portrait\) and \(max-width: 700px/;
    const h = px(mediaRule(portrait, '.game.tut-on'));
    const coach = px(mediaRule(portrait, '.tut-coach'));
    expect(h).toBe(88);
    expect(mediaRule(portrait, '.tut-strip')).toMatch(/flex-wrap: wrap/);
    expect(mediaRule(portrait, '.tut-lines')).toMatch(/flex-direction: column/);
    // coach row + 6px row gap + ~28px button row + 4px bottom padding must fit.
    expect(coach + 6 + 28 + 4).toBeLessThanOrEqual(h);
  });
  it('clamps every shown line to the strip length', () => {
    expect(screen).toMatch(/hint\.textContent = fitLine\(/);
  });
});

describe('tutorial menu wiring', () => {
  it('main.ts wires onTutorial to the lazy-loaded Training menu and tutorial screen', () => {
    expect(main).toMatch(/onTutorial: \(\) => training\(\)/);
    expect(main).toMatch(/function tutorial\(start: TutorialStart = 'all'\)/);
    expect(main).toMatch(/import\('\.\/screens\/tutorial'\)/);
    expect(main).toMatch(/import\('\.\/screens\/training'\)/);
  });
  it('menu has a Training button bound to onTutorial', () => {
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
