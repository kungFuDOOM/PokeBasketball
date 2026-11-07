import { describe, expect, it } from 'vitest';
import type { Ratings } from '../data/pokemon';
import { CONTEST_GREEN_MULT, IDEAL_RELEASE, METER_MAX, contestGreenWindow, gradeRelease, makeProbability, resolveShot, type ContestGrade } from './shot';

const R = (sht: number): Ratings => ({ spd: 50, sht, ins: 50, pas: 50, def: 50, blk: 50, reb: 50, hnd: 50 });
const GRADES: ContestGrade[] = ['perfect', 'good', 'early', 'late', 'very-early', 'very-late'];

/** Small seeded PRNG (mulberry32). */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('contest shot meter', () => {
  it('uses one fixed friendly multiplier on the game green window', () => {
    expect(CONTEST_GREEN_MULT).toBeGreaterThanOrEqual(1.3);
    expect(contestGreenWindow(R(50))).toBeCloseTo((0.022 + 0.5 * 0.034) * CONTEST_GREEN_MULT, 10);
  });
  it('higher Sht: wider window and higher or equal make odds for every grade', () => {
    for (let s = 0; s < 100; s += 5) {
      expect(contestGreenWindow(R(s + 5))).toBeGreaterThan(contestGreenWindow(R(s)));
      for (const g of GRADES) expect(makeProbability(g, R(s + 5))).toBeGreaterThanOrEqual(makeProbability(g, R(s)));
    }
  });
  it('odds are ordered perfect > good > early/late > very, all within 0..1', () => {
    for (const s of [0, 40, 75, 100]) {
      const p = (g: ContestGrade) => makeProbability(g, R(s));
      expect(p('perfect')).toBe(0.86);
      expect(p('perfect')).toBeGreaterThan(p('good'));
      expect(p('good')).toBeGreaterThan(p('early'));
      expect(p('early')).toBe(p('late'));
      expect(p('late')).toBeGreaterThan(p('very-late'));
      expect(p('very-early')).toBe(p('very-late'));
      for (const g of GRADES) { expect(p(g)).toBeGreaterThanOrEqual(0); expect(p(g)).toBeLessThanOrEqual(1); }
    }
    const base = Math.min(0.6, 0.1 + 80 * 0.0037);
    expect(makeProbability('good', R(80))).toBeCloseTo(base + 0.06, 10);
    expect(makeProbability('early', R(80))).toBeCloseTo(base * 0.8, 10);
    expect(makeProbability('very-late', R(80))).toBeCloseTo(base * 0.3, 10);
  });
  it('grade boundaries sit exactly at w, 2.3w and 4.5w', () => {
    const r = R(70);
    const w = contestGreenWindow(r);
    const e = 1e-9;
    expect(gradeRelease(IDEAL_RELEASE, r)).toBe('perfect');
    expect(gradeRelease(IDEAL_RELEASE + w - e, r)).toBe('perfect');
    expect(gradeRelease(IDEAL_RELEASE - w + e, r)).toBe('perfect');
    expect(gradeRelease(IDEAL_RELEASE + w + e, r)).toBe('good');
    expect(gradeRelease(IDEAL_RELEASE + 2.3 * w - e, r)).toBe('good');
    expect(gradeRelease(IDEAL_RELEASE + 2.3 * w + e, r)).toBe('late');
    expect(gradeRelease(IDEAL_RELEASE - 2.3 * w - e, r)).toBe('early');
    expect(gradeRelease(IDEAL_RELEASE + 4.5 * w - e, r)).toBe('late');
    expect(gradeRelease(IDEAL_RELEASE + 4.5 * w + e, r)).toBe('very-late');
    expect(gradeRelease(IDEAL_RELEASE - 4.5 * w - e, r)).toBe('very-early');
  });
  it('a full meter (auto-release) is very late even at 100 Sht', () => {
    expect(gradeRelease(METER_MAX, R(100))).toBe('very-late');
  });
  it('resolveShot uses the injected rng', () => {
    expect(resolveShot('perfect', R(50), () => 0)).toBe('make');
    expect(resolveShot('perfect', R(50), () => 0.999)).toBe('miss');
  });
  it('10 000 seeded perfect releases at 100 Sht land within 0.02 of 0.86', () => {
    const rng = seeded(1234);
    let makes = 0;
    for (let i = 0; i < 10000; i++) if (resolveShot('perfect', R(100), rng) === 'make') makes++;
    expect(Math.abs(makes / 10000 - 0.86)).toBeLessThanOrEqual(0.02);
  });
});
