import { describe, expect, it } from 'vitest';
import type { Mon } from '../data/pokemon';
import { coachMon, fitLine, praiseFor } from './coach';
import { DRILLS, MAX_LINE } from './drills';
import { STEPS } from './steps';

const mon = (dex: number, ovr: number) => ({ dex, ovr, name: `M${dex}` }) as Mon;

describe('coachMon', () => {
  it('picks the top-rated player, first on ties', () => {
    expect(coachMon([mon(1, 70), mon(4, 82), mon(7, 82)])?.dex).toBe(4);
  });
  it('is null for an empty roster', () => {
    expect(coachMon([])).toBeNull();
  });
});

describe('fitLine', () => {
  it('leaves short lines alone and collapses whitespace', () => {
    expect(fitLine('  Tap A   to pass ')).toBe('Tap A to pass');
  });
  it('trims long lines at a word, with an ellipsis, within MAX_LINE', () => {
    const long = 'On defense: use the stick to stay between your man and the hoop';
    const out = fitLine(long);
    expect(out.length).toBeLessThanOrEqual(MAX_LINE);
    expect(out.endsWith('…')).toBe(true);
    expect(long.startsWith(out.slice(0, -1))).toBe(true);
  });
  it('hard-cuts a line with no spaces', () => {
    expect(fitLine('x'.repeat(100))).toHaveLength(MAX_LINE);
  });
  it('every step prompt and drill line fits once fitted', () => {
    const lines = [
      ...STEPS.flatMap((s) => [s.prompt.keys, s.prompt.touch, `${praiseFor(0)} Next: ${s.title}`]),
      ...Object.values(DRILLS).flatMap((d) => [...Object.values(d.goal), ...Object.values(d.coach)]),
    ];
    for (const l of lines) expect(fitLine(l).length).toBeLessThanOrEqual(MAX_LINE);
  });
});

describe('praiseFor', () => {
  it('is short and deterministic', () => {
    expect(praiseFor(1)).toBe(praiseFor(5));
    for (let i = 0; i < 8; i++) expect(praiseFor(i).length).toBeLessThanOrEqual(12);
  });
});
