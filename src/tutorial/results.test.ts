import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
// @ts-ignore Node's fs has no type declarations in this project.
import { readFileSync } from 'node:fs';
import { DRILL_IDS } from './drills';

// The drill results card (src/screens/tutorial.ts): pure HTML builder + helpers, and its CSS placement.
type Screen = typeof import('../screens/tutorial');
let t: Screen;
beforeAll(async () => {
  vi.stubGlobal('location', { search: '' }); // play.ts reads ?speed at import
  t = await import('../screens/tutorial');
});
afterAll(() => vi.unstubAllGlobals());

const css: string = readFileSync('src/style.css', 'utf8');
const screen: string = readFileSync('src/screens/tutorial.ts', 'utf8');
const rule = (sel: string) => css.match(new RegExp(`(?:^|\\n)${sel.replace(/[.[\]():]/g, '\\$&')} \\{([^}]*)\\}`))?.[1] ?? '';

describe('results card helpers', () => {
  it('starText always shows three glyphs, clamped', () => {
    expect(t.starText(0)).toBe('☆☆☆');
    expect(t.starText(2)).toBe('★★☆');
    expect(t.starText(3)).toBe('★★★');
    expect(t.starText(9)).toBe('★★★');
    expect(t.starText(-1)).toBe('☆☆☆');
  });
  it('nextDrillId walks the training order and ends after the last drill', () => {
    for (let i = 0; i < DRILL_IDS.length - 1; i++) expect(t.nextDrillId(DRILL_IDS[i])).toBe(DRILL_IDS[i + 1]);
    expect(t.nextDrillId(DRILL_IDS[DRILL_IDS.length - 1])).toBeNull();
  });
});

describe('resultHtml', () => {
  const base = { outcome: { id: 'layups' as const, score: 14, stars: 2 as const, skipped: false }, prevBest: 1 as const, best: 2 as const, line: 'Nice finishing!', next: 'Next drill' };

  it('shows the drill, score, star grade, best stars and the coach line', () => {
    const h = t.resultHtml(base);
    expect(h).toContain('>Layups</h2>');
    expect(h).toContain('Score <b>14</b>');
    expect(h).toMatch(/class="tut-stars" role="img" aria-label="2 of 3 stars">★★☆</);
    expect(h).toMatch(/Best <span aria-label="2 of 3 stars">★★☆<\/span> <b class="tut-new">New best!<\/b>/);
    expect(h).toContain('Nice finishing!');
  });
  it('has Next drill, Retry and Training menu buttons', () => {
    const h = t.resultHtml(base);
    expect(h).toMatch(/data-res="next">Next drill</);
    expect(h).toMatch(/data-res="retry">Retry</);
    expect(h).toMatch(/data-res="training">Training menu</);
  });
  it('no "New best!" when the best did not improve', () => {
    expect(t.resultHtml({ ...base, prevBest: 3, best: 3 })).not.toContain('New best!');
  });
  it('without a next drill, Retry is the primary button and there is no Next', () => {
    const h = t.resultHtml({ ...base, next: null });
    expect(h).not.toContain('data-res="next"');
    expect(h).toMatch(/class="btn primary" data-res="retry"/);
  });
  it('labels the last drill of Run all "Finish"', () => {
    expect(t.resultHtml({ ...base, next: 'Finish' })).toMatch(/data-res="next">Finish</);
  });
  it('escapes and clamps the coach line', () => {
    const h = t.resultHtml({ ...base, line: '<b>x</b> ' + 'word '.repeat(30) });
    expect(h).not.toContain('<b>x</b>');
    const line = h.match(/class="tut-res-line">([^<]*)</)![1];
    expect(line.length).toBeLessThanOrEqual(80); // 60 chars, a few may be &lt;/&gt; entities
  });
});

describe('results card placement and buttons', () => {
  it('sits below the prompt strip so Skip and Exit stay usable', () => {
    const r = rule('.tut-result');
    expect(r).toMatch(/position: absolute/);
    expect(r).toMatch(/top: var\(--tut-h\)/);
    // Only the completion overlay (game stopped) hides the strip buttons; the results card never does.
    expect(css).not.toMatch(/:has\(\.tut-result\)[^{]*\.tut-acts/);
  });
  it('Skip and Exit are wired in every phase, Retry / Next / Training menu on the card', () => {
    expect(screen).toMatch(/if \(a === 'skip'\) send\(\{ type: 'skip' \}\)/);
    expect(screen).toMatch(/if \(a === 'exit'\) leave\(act\.menu\)/);
    expect(screen).toMatch(/if \(a === 'retry'\) send\(\{ type: 'retry' \}\)/);
    expect(screen).toMatch(/if \(rs\.runAll\) send\(\{ type: 'next' \}\)/);
    expect(screen).toMatch(/if \(a === 'training'\) leave\(toTraining\)/);
  });
  it('records best stars when a drill result comes in (skips never count)', () => {
    expect(screen).toMatch(/if \(!e\.outcome\.skipped\) showResult\(e\.outcome\)/);
    expect(screen).toMatch(/recordDrillStars\(o\.id, o\.stars\)/);
  });
});
