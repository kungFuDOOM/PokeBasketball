import { describe, expect, it } from 'vitest';
import { POSITIONS, type Ratings } from '../../data/pokemon';
import { isRankedLegal, teamOvr } from '../shared/roster';
import { RANKED_PRESETS, presetRoster } from './presets';

const KEYS: (keyof Ratings)[] = ['spd', 'sht', 'ins', 'pas', 'def', 'blk', 'reb', 'hnd'];
/** Each team's sum of a raw rating may be at most this far from the six teams' mean, as a fraction of the mean.
 * The current teams' worst is about 4.3% (pas), so 8% leaves room for small rating tweaks. */
const RATING_TOLERANCE = 0.08;

describe('Ranked presets', () => {
  const rosters = RANKED_PRESETS.map((p) => presetRoster(p.id));

  it('has six teams A-F, each totalling 425 OVR', () => {
    expect(RANKED_PRESETS.map((p) => p.id)).toEqual(['A', 'B', 'C', 'D', 'E', 'F']);
    const totals = rosters.map(teamOvr);
    expect(totals).toEqual([425, 425, 425, 425, 425, 425]);
    expect(new Set(totals).size).toBe(1);
  });

  it('keeps every member within 81-88 OVR and Ranked-legal', () => {
    for (const m of rosters.flat()) {
      expect(m.ovr).toBeGreaterThanOrEqual(81);
      expect(m.ovr).toBeLessThanOrEqual(88);
      expect(isRankedLegal(m), m.name).toBe(true);
    }
  });

  it('orders each team PG, SG, SF, PF, C', () => {
    for (const r of rosters) expect(r.map((m) => m.pos)).toEqual(POSITIONS);
  });

  it('never puts a Pokémon on two teams', () => {
    const dex = RANKED_PRESETS.flatMap((p) => p.dex);
    expect(new Set(dex).size).toBe(dex.length);
  });

  it('keeps each raw rating close across teams', () => {
    for (const k of KEYS) {
      const sums = rosters.map((r) => r.reduce((s, m) => s + m.r[k], 0));
      const mean = sums.reduce((s, x) => s + x, 0) / sums.length;
      for (const s of sums) expect(Math.abs(s - mean) / mean, k).toBeLessThanOrEqual(RATING_TOLERANCE);
    }
  });
});
