import { describe, expect, it } from 'vitest';
import { CROWN_COLORS, CROWN_PIXELS } from './crown';

describe('crown pixels', () => {
  it('has rows of equal width', () => {
    expect(CROWN_PIXELS.length).toBeGreaterThanOrEqual(5);
    expect(CROWN_PIXELS.length).toBeLessThanOrEqual(6);
    const w = CROWN_PIXELS[0].length;
    expect(w).toBeGreaterThanOrEqual(9);
    expect(w).toBeLessThanOrEqual(11);
    for (const r of CROWN_PIXELS) expect(r).toHaveLength(w);
  });
  it('uses only legal characters', () => {
    for (const r of CROWN_PIXELS) expect(r).toMatch(/^[.ogdh]+$/);
  });
  it('contains gold, a dark shade and a highlight, and every colour is defined', () => {
    const all = CROWN_PIXELS.join('');
    for (const c of 'gdho') expect(all).toContain(c);
    for (const c of 'gdh') expect(CROWN_COLORS[c]).toMatch(/^#[0-9a-f]{6}$/i);
  });
  it('has three points on the top rows', () => {
    expect(CROWN_PIXELS[1].match(/g/g)).toHaveLength(3);
  });
});
