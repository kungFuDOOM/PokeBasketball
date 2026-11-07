import { describe, expect, it } from 'vitest';
import { COURT_L, COURT_W, HOOP_Y, hoopX, isThree } from '../game/types';
import { rackSpots } from './contest';

describe('rackSpots', () => {
  const spots = rackSpots();
  it('returns five spots, rack 0..4 in order, left corner to right corner', () => {
    expect(spots).toHaveLength(5);
    expect(spots.map((s) => s.rack)).toEqual([0, 1, 2, 3, 4]);
    expect(spots.map((s) => s.label)).toEqual(['Corner L', 'Wing L', 'Top', 'Wing R', 'Corner R']);
  });
  it('every spot is a three for the home team, just outside the line', () => {
    for (const s of spots) {
      expect(isThree(s.x, s.y, 0)).toBe(true);
      const dx = s.x - hoopX(0);
      const dy = s.y - HOOP_Y;
      if (Math.abs(dy) >= 22 && Math.abs(dx) < 9) {
        expect(Math.abs(dy)).toBeGreaterThanOrEqual(22);
        expect(Math.abs(dy)).toBeLessThanOrEqual(24.5);
      } else {
        const d = Math.hypot(dx, dy);
        expect(d).toBeGreaterThanOrEqual(23.75);
        expect(d).toBeLessThanOrEqual(23.75 + 1.5);
      }
    }
  });
  it('stays in bounds with y strictly increasing and the top spot on the centre line', () => {
    for (const s of spots) {
      expect(s.x).toBeGreaterThan(0); expect(s.x).toBeLessThan(COURT_L);
      expect(s.y).toBeGreaterThan(0); expect(s.y).toBeLessThan(COURT_W);
    }
    for (let i = 1; i < 5; i++) expect(spots[i].y).toBeGreaterThan(spots[i - 1].y);
    expect(spots[2].y).toBeCloseTo(25, 6);
  });
  it('is symmetric about HOOP_Y', () => {
    expect(Math.abs(spots[0].y - HOOP_Y)).toBeCloseTo(Math.abs(spots[4].y - HOOP_Y), 6);
    expect(Math.abs(spots[1].y - HOOP_Y)).toBeCloseTo(Math.abs(spots[3].y - HOOP_Y), 6);
    expect(spots[0].x).toBeCloseTo(spots[4].x, 6);
    expect(spots[1].x).toBeCloseTo(spots[3].x, 6);
  });
});
