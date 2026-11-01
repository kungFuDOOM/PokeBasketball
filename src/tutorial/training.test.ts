import { describe, expect, it } from 'vitest';
// @ts-ignore Node's fs has no type declarations in this project.
import { readFileSync } from 'node:fs';
import { DRILL_IDS } from './drills';
import { starText, trainingHtml } from '../screens/training';
import type { BestStars } from './store';

// The Training menu (src/screens/training.ts) and its routing from the main menu.
const none = Object.fromEntries(DRILL_IDS.map((id) => [id, 0])) as BestStars;

describe('training menu', () => {
  it('lists all seven drills in order as buttons with best stars', () => {
    const html = trainingHtml({ ...none, layups: 2, steals: 3 });
    const ids = [...html.matchAll(/<button[^>]*data-drill="(\w+)"/g)].map((m) => m[1]);
    expect(ids).toEqual([...DRILL_IDS]);
    expect(html).toContain('aria-label="Layups, drill 2 of 7, best 2 of 3 stars"');
    expect(html).toContain(starText(2));
    expect(html).toContain(starText(3));
    expect(html).toContain('5/21 stars');
  });
  it('has an Alley-Oop tile (drill 5 of 7) and Run all covers all seven', () => {
    const html = trainingHtml({ ...none, alleyoop: 2 });
    expect(html).toContain('data-drill="alleyoop"');
    expect(html).toContain('<span class="trn-name">Alley-Oop</span>');
    expect(html).toContain('aria-label="Alley-Oop, drill 5 of 7, best 2 of 3 stars"');
    expect(html).toContain('run all 7');
  });
  it('has Run all and Back buttons', () => {
    const html = trainingHtml(none);
    expect(html).toMatch(/<button[^>]*data-trn="all"[^>]*>Run all<\/button>/);
    expect(html).toMatch(/<button[^>]*data-trn="back"/);
    expect(html).toContain('0/21 stars');
  });
  it('the menu button opens Training; first-time players go straight into Run all', () => {
    const menu: string = readFileSync('src/screens/menu.ts', 'utf8');
    const main: string = readFileSync('src/main.ts', 'utf8');
    expect(menu).toMatch(/data-go="tutorial" aria-label="Training: [^"]+">Training<\/button>/);
    expect(main).toMatch(/onTutorial: \(\) => training\(\)/);
    expect(main).toMatch(/function training\(\) \{\n\s+if \(!isTutorialDone\(\)\) return tutorial\('all'\);/);
    expect(main).toMatch(/tutorialScreen\(app, settings, audio, \{[^}]*training[^}]*\}, start\)/);
  });
});
