import { describe, expect, it } from 'vitest';
import { monByDex, overall, type Ratings } from './pokemon';

/** Speed, shot, inside, pass, defense, block, rebound, handle. */
type Card = { pos: string; role: string; ovr: number; r: Ratings };

const rate = (spd: number, sht: number, ins: number, pas: number, def: number, blk: number, reb: number, hnd: number): Ratings =>
  ({ spd, sht, ins, pas, def, blk, reb, hnd });

/** Ratings before this buff. Used to prove every change is a buff or a hold. */
const BEFORE: Record<number, Ratings> = {
  152: rate(52, 58, 58, 57, 64, 55, 51, 55),
  153: rate(60, 64, 65, 63, 70, 65, 59, 62),
  154: rate(52, 60, 80, 80, 72, 84, 88, 58),
  155: rate(63, 63, 58, 57, 63, 42, 47, 60),
  156: rate(71, 70, 65, 64, 69, 54, 57, 67),
  157: rate(80, 86, 86, 64, 72, 66, 66, 76),
  158: rate(51, 56, 64, 52, 65, 50, 55, 52),
  159: rate(59, 62, 72, 59, 71, 63, 63, 59),
  160: rate(76, 70, 90, 58, 84, 74, 80, 70),
  252: rate(66, 65, 55, 59, 61, 40, 46, 62),
  253: rate(80, 73, 65, 66, 69, 49, 53, 72),
  254: rate(95, 82, 76, 80, 74, 48, 52, 88),
  255: rate(52, 65, 61, 56, 60, 41, 50, 55),
  256: rate(57, 71, 73, 61, 67, 54, 60, 60),
  257: rate(88, 76, 95, 68, 78, 74, 70, 80),
  258: rate(49, 58, 65, 53, 62, 45, 54, 52),
  259: rate(55, 62, 74, 60, 68, 58, 65, 58),
  260: rate(66, 60, 92, 60, 78, 84, 88, 62),
};

const AFTER: Record<number, Card> = {
  152: { pos: 'SG', role: 'Role Player', ovr: 57, r: rate(54, 60, 60, 59, 66, 57, 53, 57) },
  153: { pos: 'SF', role: 'Role Player', ovr: 67, r: rate(63, 67, 68, 66, 73, 68, 62, 65) },
  154: { pos: 'C', role: 'Glass Cleaner', ovr: 87, r: rate(54, 62, 84, 81, 76, 88, 92, 60) },
  155: { pos: 'PG', role: 'Role Player', ovr: 61, r: rate(65, 65, 60, 59, 65, 44, 49, 62) },
  156: { pos: 'SG', role: 'Role Player', ovr: 72, r: rate(74, 73, 68, 67, 72, 57, 60, 70) },
  157: { pos: 'SF', role: 'Three-Level Scorer', ovr: 85, r: rate(84, 90, 90, 68, 78, 70, 70, 80) },
  158: { pos: 'SG', role: 'Role Player', ovr: 57, r: rate(53, 59, 66, 54, 67, 52, 57, 54) },
  159: { pos: 'SF', role: 'Role Player', ovr: 68, r: rate(62, 65, 75, 62, 74, 66, 66, 62) },
  160: { pos: 'SF', role: 'Rim Runner', ovr: 86, r: rate(80, 74, 94, 62, 88, 78, 84, 74) },
  252: { pos: 'PG', role: 'Role Player', ovr: 63, r: rate(68, 67, 57, 61, 63, 42, 48, 64) },
  253: { pos: 'PG', role: 'Role Player', ovr: 75, r: rate(82, 75, 67, 68, 71, 51, 55, 74) },
  254: { pos: 'PG', role: 'Speedster', ovr: 88, r: rate(96, 82, 76, 80, 74, 48, 52, 88) },
  255: { pos: 'SG', role: 'Role Player', ovr: 60, r: rate(54, 67, 63, 58, 62, 43, 52, 57) },
  256: { pos: 'SG', role: 'Role Player', ovr: 69, r: rate(60, 74, 76, 64, 70, 57, 63, 63) },
  257: { pos: 'SF', role: 'Slasher', ovr: 84, r: rate(90, 76, 95, 68, 78, 74, 70, 80) },
  258: { pos: 'SG', role: 'Role Player', ovr: 57, r: rate(51, 60, 67, 55, 64, 47, 56, 54) },
  259: { pos: 'SF', role: 'Role Player', ovr: 67, r: rate(58, 65, 77, 63, 71, 61, 68, 61) },
  260: { pos: 'PF', role: 'Post Scorer', ovr: 87, r: rate(68, 62, 96, 62, 82, 88, 89, 64) },
};

const LINES: [string, number[]][] = [
  ['Chikorita', [152, 153, 154]],
  ['Cyndaquil', [155, 156, 157]],
  ['Totodile', [158, 159, 160]],
  ['Treecko', [252, 253, 254]],
  ['Torchic', [255, 256, 257]],
  ['Mudkip', [258, 259, 260]],
];

const GEN1: Record<number, Card> = {
  1: { pos: 'SG', role: 'Role Player', ovr: 57, r: rate(52, 63, 58, 59, 61, 48, 49, 56) },
  2: { pos: 'SG', role: 'Role Player', ovr: 65, r: rate(60, 69, 65, 65, 67, 58, 58, 63) },
  3: { pos: 'C', role: 'Rim Protector', ovr: 88, r: rate(52, 66, 89, 74, 74, 90, 93, 56) },
  4: { pos: 'PG', role: 'Role Player', ovr: 59, r: rate(63, 63, 58, 57, 63, 43, 47, 60) },
  5: { pos: 'SG', role: 'Role Player', ovr: 68, r: rate(71, 70, 66, 64, 69, 55, 57, 67) },
  6: { pos: 'SF', role: 'Three-Level Scorer', ovr: 91, r: rate(90, 90, 96, 72, 82, 80, 80, 80) },
  7: { pos: 'PG', role: 'Role Player', ovr: 64, r: rate(66, 70, 52, 64, 60, 40, 46, 66) },
  8: { pos: 'PG', role: 'Role Player', ovr: 74, r: rate(74, 78, 60, 72, 68, 46, 52, 74) },
  9: { pos: 'PF', role: 'Stretch Big', ovr: 88, r: rate(62, 92, 88, 72, 80, 88, 90, 64) },
};

const keys = ['spd', 'sht', 'ins', 'pas', 'def', 'blk', 'reb', 'hnd'] as const;

describe('Johto and Hoenn starter buffs', () => {
  it('lands each of the 18 cards on the tuned ratings, overall, and role', () => {
    for (const [dex, want] of Object.entries(AFTER)) {
      const m = monByDex(Number(dex));
      expect(m.pos, m.name).toBe(want.pos);
      expect(m.r, m.name).toEqual(want.r);
      expect(m.ovr, m.name).toBe(want.ovr);
      expect(overall(m.pos, m.r), m.name).toBe(want.ovr);
      expect(m.archetype, m.name).toBe(want.role);
    }
  });

  it('only buffs or holds, and each evolution is a higher overall than the last', () => {
    for (const [, dexes] of LINES) {
      const ovrs = dexes.map((d) => monByDex(d).ovr);
      expect(ovrs[1], String(dexes)).toBeGreaterThan(ovrs[0]);
      expect(ovrs[2], String(dexes)).toBeGreaterThan(ovrs[1]);
      expect(ovrs[2] - ovrs[1], String(dexes)).toBeGreaterThan(ovrs[1] - ovrs[0]);
      for (const d of dexes) {
        const now = monByDex(d).r;
        for (const k of keys) expect(now[k], `${d} ${k}`).toBeGreaterThanOrEqual(BEFORE[d][k]);
      }
    }
  });

  it('keeps each line\'s signature and the deliberate final roles', () => {
    const top = (d: number) => keys.reduce((a, b) => (monByDex(d).r[b] > monByDex(d).r[a] ? b : a));
    expect(top(154)).toBe('reb');
    expect(monByDex(154).r.blk).toBeLessThan(90);
    expect(monByDex(154).r.pas).toBeLessThan(82);
    expect(top(157)).toBe('sht');
    expect(monByDex(157).r.sht).toBe(monByDex(157).r.ins);
    expect(top(160)).toBe('ins');
    expect(monByDex(160).r.spd).toBeLessThan(84);
    expect(monByDex(160).r.def).toBeLessThan(90);
    expect(top(254)).toBe('spd');
    expect(monByDex(254).r.ins).toBeLessThan(88);
    expect(monByDex(254).r.pas).toBeLessThan(88);
    expect(top(257)).toBe('ins');
    expect(monByDex(257).r.sht).toBeLessThan(88);
    expect(top(260)).toBe('ins');
    expect(monByDex(260).r.reb).toBeLessThan(90);
    expect(monByDex(260).r.blk).toBeLessThan(90);
  });

  it('leaves the Kanto starters and the tuned legendaries exactly as they are', () => {
    for (const [dex, want] of Object.entries(GEN1)) {
      const m = monByDex(Number(dex));
      expect(m.pos, m.name).toBe(want.pos);
      expect(m.r, m.name).toEqual(want.r);
      expect(m.ovr, m.name).toBe(want.ovr);
      expect(m.archetype, m.name).toBe(want.role);
    }
    expect(monByDex(289)).toMatchObject({ name: 'Slaking', ovr: 91, r: rate(81, 74, 97, 65, 86, 80, 97, 72) });
    expect(monByDex(384)).toMatchObject({ name: 'Rayquaza', ovr: 97, r: rate(88, 89, 99, 68, 86, 89, 94, 70) });
    expect(monByDex(386)).toMatchObject({ name: 'Deoxys', ovr: 97, r: rate(97, 96, 97, 74, 83, 54, 64, 89) });
    expect(monByDex(6).ovr).toBeGreaterThan(monByDex(157).ovr);
    expect(monByDex(3).ovr).toBeGreaterThan(monByDex(154).ovr);
    expect(monByDex(9).ovr).toBeGreaterThan(monByDex(160).ovr);
    expect(monByDex(9).ovr).toBeGreaterThan(monByDex(260).ovr);
    expect(monByDex(6).ovr).toBeGreaterThan(monByDex(254).ovr);
    expect(monByDex(6).ovr).toBeGreaterThan(monByDex(257).ovr);
  });
});
