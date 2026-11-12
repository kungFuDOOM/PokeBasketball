import { describe, expect, it } from 'vitest';
import { GENERATED_ROWS } from './generated';
import { monByDex, overall } from './pokemon';

/**
 * Slaking, Rayquaza and Deoxys are tuned to fixed overalls.
 * The live card is the hand-tuned row in pokemon.ts. overall() is the only rating math.
 * Generated rows stay as the generator wrote them and lose to the hand-tuned row.
 */
describe('tuned overalls', () => {
  it('Slaking is 91, still a rebounding center, and the generated row is not the live card', () => {
    const m = monByDex(289);
    const generated = GENERATED_ROWS.find((r) => r[0] === 289);
    expect(generated?.slice(4)).toEqual([83, 76, 99, 67, 88, 82, 99, 74]);
    expect(m).toMatchObject({
      name: 'Slaking', pos: 'C', types: ['Normal'], ovr: 91, archetype: 'Glass Cleaner',
      r: { spd: 81, sht: 74, ins: 97, pas: 65, def: 86, blk: 80, reb: 97, hnd: 72 },
    });
    expect(overall(m.pos, m.r)).toBe(91);
    expect(m.r.ins).toBe(m.r.reb);
    expect(m.r.ins).toBeGreaterThan(m.r.def);
  });

  it('Rayquaza is 97 and stays a Stretch Big power forward', () => {
    const m = monByDex(384);
    expect(GENERATED_ROWS.some((r) => r[0] === 384)).toBe(false);
    expect(m).toMatchObject({
      name: 'Rayquaza', pos: 'PF', types: ['Dragon', 'Flying'], ovr: 97, archetype: 'Stretch Big',
      r: { spd: 88, sht: 89, ins: 99, pas: 68, def: 86, blk: 89, reb: 94, hnd: 70 },
    });
    expect(overall(m.pos, m.r)).toBe(97);
    expect(m.r.blk).toBeLessThan(90);
    expect(m.r.sht).toBeGreaterThanOrEqual(85);
    expect(m.r.ins).toBeGreaterThan(m.r.reb);
    expect(m.r.pas).toBeLessThan(m.r.hnd);
  });

  it('Deoxys is 97 and stays a three-level shooting guard', () => {
    const m = monByDex(386);
    const generated = GENERATED_ROWS.find((r) => r[0] === 386);
    expect(generated?.slice(4)).toEqual([99, 97, 99, 76, 85, 54, 64, 91]);
    expect(m).toMatchObject({
      name: 'Deoxys', pos: 'SG', types: ['Psychic'], ovr: 97, archetype: 'Three-Level Scorer',
      r: { spd: 97, sht: 96, ins: 97, pas: 74, def: 83, blk: 54, reb: 64, hnd: 89 },
    });
    expect(overall(m.pos, m.r)).toBe(97);
    expect(m.r.spd).toBe(m.r.ins);
    expect(m.r.ins).toBeGreaterThan(m.r.sht);
    expect(m.r.sht).toBeGreaterThanOrEqual(90);
  });
});