/**
 * Pure court-space geometry for training markers (see `Marker` in types.ts). Everything here is in
 * court feet; the renderer projects the points, so shapes come out perspective-correct on the floor.
 */
import { COURT_L, COURT_W, HOOP_Y, clamp, hoopX, type ShotZone, type TeamId } from './types';

export type CourtPt = [number, number];

/** Radius in feet of a target spot's core. */
export const SPOT_R = 1.6;
/** How far from each player's center the pass-lane arrow starts and stops, in feet. */
export const LANE_GAP = 2.2;
/** Arrowhead length and half-width in feet. */
export const HEAD_LEN = 2.4;
export const HEAD_HALF = 1.3;

/** Inner and outer radius (feet from the rim center) of each shot-zone band. */
export const ZONE_BANDS: Record<ShotZone, [number, number]> = {
  layup: [0, 6],
  mid: [10, 17],
  three: [23.75, 27],
};

/** The court-space polygon of a shot-zone band around the hoop `team` attacks, clipped to the court. */
export function zonePoly(zone: ShotZone, team: TeamId, n = 32): CourtPt[] {
  const [r0, r1] = ZONE_BANDS[zone];
  const hx = hoopX(team);
  // Open toward half court: right hoop faces -x, left hoop faces +x.
  const mid = team === 0 ? Math.PI : 0;
  const a0 = mid - Math.PI / 2;
  const a1 = mid + Math.PI / 2;
  const base = team === 0 ? COURT_L : 0;
  const pt = (r: number, a: number): CourtPt => [
    team === 0 ? clamp(hx + Math.cos(a) * r, COURT_L / 2, base) : clamp(hx + Math.cos(a) * r, base, COURT_L / 2),
    clamp(HOOP_Y + Math.sin(a) * r, 0, COURT_W),
  ];
  const outer: CourtPt[] = [];
  const inner: CourtPt[] = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + ((a1 - a0) * i) / n;
    outer.push(pt(r1, a));
    inner.push(pt(r0, a));
  }
  // Close the band behind the rim along the baseline so the layup zone reaches it.
  if (r0 === 0) return [...outer, [base, outer[n][1]], [base, outer[0][1]]];
  return [...outer, ...inner.reverse()];
}

export interface Arrow {
  /** Shaft from `tail` to `neck`, then the head triangle `neck`-side corners `left`/`right` meeting at `tip`. */
  tail: CourtPt;
  neck: CourtPt;
  tip: CourtPt;
  left: CourtPt;
  right: CourtPt;
}

/** A pass-lane arrow between two court points, trimmed so it doesn't run under either player. Null if they're too close. */
export function laneArrow(from: { x: number; y: number }, to: { x: number; y: number }): Arrow | null {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const d = Math.hypot(dx, dy);
  if (d < LANE_GAP * 2 + HEAD_LEN) return null;
  const ux = dx / d;
  const uy = dy / d;
  const at = (k: number): CourtPt => [from.x + ux * k, from.y + uy * k];
  const tip = at(d - LANE_GAP);
  const neck = at(d - LANE_GAP - HEAD_LEN);
  return {
    tail: at(LANE_GAP),
    neck,
    tip,
    left: [neck[0] - uy * HEAD_HALF, neck[1] + ux * HEAD_HALF],
    right: [neck[0] + uy * HEAD_HALF, neck[1] - ux * HEAD_HALF],
  };
}

/** 0..1 pulse for glowing markers at time `t` seconds; a steady 1 when the user prefers reduced motion. */
export function markerPulse(t: number, calm: boolean): number {
  return calm ? 1 : 0.5 + 0.5 * Math.sin(t * 5);
}

/** Dash offset for the moving pass-lane dashes (0 = still when calm). */
export function laneDashOffset(t: number, calm: boolean): number {
  return calm ? 0 : -((t * 12) % 8);
}
