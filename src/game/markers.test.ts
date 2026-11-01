import { describe, expect, it } from 'vitest';
import { HEAD_LEN, LANE_GAP, ZONE_BANDS, laneArrow, laneDashOffset, markerPulse, zonePoly } from './markers';
import { COURT_L, COURT_W, HOOP_Y, hoopX, type ShotZone, type TeamId } from './types';

const inCourt = ([x, y]: [number, number]) => x >= 0 && x <= COURT_L && y >= 0 && y <= COURT_W;

describe('zonePoly', () => {
  const zones: ShotZone[] = ['layup', 'mid', 'three'];
  const teams: TeamId[] = [0, 1];

  it('stays on the court and on the attacking half', () => {
    for (const z of zones) for (const t of teams) {
      const pts = zonePoly(z, t);
      expect(pts.length).toBeGreaterThan(8);
      for (const p of pts) {
        expect(inCourt(p)).toBe(true);
        if (t === 0) expect(p[0]).toBeGreaterThanOrEqual(COURT_L / 2);
        else expect(p[0]).toBeLessThanOrEqual(COURT_L / 2);
      }
    }
  });

  it('bands sit at their radii from the rim (unclipped points)', () => {
    for (const z of zones) for (const t of teams) {
      const [r0, r1] = ZONE_BANDS[z];
      const hx = hoopX(t);
      for (const [x, y] of zonePoly(z, t)) {
        if (x === 0 || x === COURT_L || y === 0 || y === COURT_W || x === COURT_L / 2) continue;
        const d = Math.hypot(x - hx, y - HOOP_Y);
        expect(d).toBeGreaterThanOrEqual(r0 - 1e-6);
        expect(d).toBeLessThanOrEqual(r1 + 1e-6);
      }
    }
  });

  it('the three band starts at the three-point arc and is outside the mid band', () => {
    expect(ZONE_BANDS.three[0]).toBe(23.75);
    expect(ZONE_BANDS.mid[1]).toBeLessThan(ZONE_BANDS.three[0]);
    expect(ZONE_BANDS.layup[1]).toBeLessThan(ZONE_BANDS.mid[0]);
  });

  it('the layup zone closes along the baseline', () => {
    const pts = zonePoly('layup', 0);
    expect(pts.slice(-2).every(([x]) => x === COURT_L)).toBe(true);
    const left = zonePoly('layup', 1);
    expect(left.slice(-2).every(([x]) => x === 0)).toBe(true);
  });
});

describe('laneArrow', () => {
  it('runs from passer toward teammate, trimmed at both ends', () => {
    const a = laneArrow({ x: 40, y: 25 }, { x: 60, y: 25 })!;
    expect(a.tail).toEqual([40 + LANE_GAP, 25]);
    expect(a.tip).toEqual([60 - LANE_GAP, 25]);
    expect(a.neck[0]).toBeCloseTo(60 - LANE_GAP - HEAD_LEN);
    // Head corners sit either side of the shaft, symmetric about it.
    expect(a.left[0]).toBeCloseTo(a.neck[0]);
    expect(a.right[0]).toBeCloseTo(a.neck[0]);
    expect(a.left[1] - 25).toBeCloseTo(-(a.right[1] - 25));
    expect(Math.abs(a.left[1] - 25)).toBeGreaterThan(0.5);
  });

  it('works on diagonals (tip lies on the segment)', () => {
    const from = { x: 10, y: 5 };
    const to = { x: 30, y: 40 };
    const a = laneArrow(from, to)!;
    const cross = (to.x - from.x) * (a.tip[1] - from.y) - (to.y - from.y) * (a.tip[0] - from.x);
    expect(Math.abs(cross)).toBeLessThan(1e-9);
    expect(Math.hypot(a.tip[0] - to.x, a.tip[1] - to.y)).toBeCloseTo(LANE_GAP);
  });

  it('returns null when teammates are on top of each other', () => {
    expect(laneArrow({ x: 10, y: 10 }, { x: 12, y: 10 })).toBeNull();
    expect(laneArrow({ x: 10, y: 10 }, { x: 10, y: 10 })).toBeNull();
  });
});

describe('motion', () => {
  it('pulses in 0..1, holds steady when reduced motion is on', () => {
    for (let t = 0; t < 3; t += 0.1) {
      const v = markerPulse(t, false);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      expect(markerPulse(t, true)).toBe(1);
      expect(laneDashOffset(t, true)).toBe(0);
    }
    expect(markerPulse(0, false)).not.toBe(markerPulse(0.3, false));
  });
});
