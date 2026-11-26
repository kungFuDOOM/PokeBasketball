import { describe, expect, it } from 'vitest';
import { POKEMON, monByDex, overall, type Pos } from './pokemon';
import { RANKED_LEGENDARIES, RANKED_MAX_OVR, isRankedLegal } from '../multiplayer/shared/roster';
import { RANKED_PRESETS, presetRoster } from '../multiplayer/ranked/presets';

/** Targets for the legendary ladder. OVR is whatever overall() returns for the hand-tuned attributes. */
const LADDER: { dex: number; name: string; pos: Pos; ovr: number; role: string }[] = [
  { dex: 493, name: 'Arceus', pos: 'C', ovr: 97, role: 'Rim Protector' },
  { dex: 150, name: 'Mewtwo', pos: 'SF', ovr: 96, role: 'Three-Level Scorer' },
  { dex: 384, name: 'Rayquaza', pos: 'PF', ovr: 96, role: 'Stretch Big' },
  { dex: 386, name: 'Deoxys', pos: 'SG', ovr: 95, role: 'Three-Level Scorer' },
  { dex: 483, name: 'Dialga', pos: 'PF', ovr: 95, role: 'Rim Protector' },
  { dex: 249, name: 'Lugia', pos: 'PF', ovr: 95, role: 'Rim Protector' },
  { dex: 250, name: 'Ho-Oh', pos: 'SF', ovr: 94, role: 'Three-Level Scorer' },
  { dex: 484, name: 'Palkia', pos: 'SF', ovr: 94, role: 'Three-Level Scorer' },
  { dex: 487, name: 'Giratina', pos: 'PF', ovr: 94, role: 'Rim Protector' },
  { dex: 151, name: 'Mew', pos: 'PG', ovr: 93, role: 'Floor General' },
  { dex: 486, name: 'Regigigas', pos: 'C', ovr: 93, role: 'Glass Cleaner' },
  { dex: 381, name: 'Latios', pos: 'SG', ovr: 93, role: 'Three-Level Scorer' },
  { dex: 244, name: 'Entei', pos: 'PF', ovr: 88, role: 'Post Scorer' },
];

const LADDER_DEX = new Set(LADDER.map((x) => x.dex));

describe('legendary OVR ladder', () => {
  it('prints the ladder from overall(), and each target is that number', () => {
    const lines = LADDER.map((want) => {
      const m = monByDex(want.dex);
      const computed = overall(m.pos, m.r);
      return `${String(computed).padStart(2)} ${m.pos} ${m.name}`;
    });
    console.log(['legendary ladder', ...lines].join('\n'));
    for (const want of LADDER) {
      const m = monByDex(want.dex);
      expect(m.name).toBe(want.name);
      expect(m.pos, m.name).toBe(want.pos);
      expect(overall(m.pos, m.r), m.name).toBe(want.ovr);
      expect(m.ovr, m.name).toBe(want.ovr);
      expect(m.archetype, m.name).toBe(want.role);
    }
  });

  it('Arceus is the only 97 and nothing in the game is 98 or above', () => {
    expect(POKEMON.filter((m) => m.ovr >= 98)).toEqual([]);
    expect(POKEMON.filter((m) => m.ovr === 97).map((m) => m.dex)).toEqual([493]);
  });

  it('every other legendary is 92 or below, and Suicune and Cresselia are untouched centers', () => {
    for (const dex of RANKED_LEGENDARIES) {
      if (LADDER_DEX.has(dex)) continue;
      const m = monByDex(dex);
      expect(m.ovr, m.name).toBeLessThanOrEqual(92);
    }
    expect(monByDex(245)).toMatchObject({
      name: 'Suicune', pos: 'C', ovr: 85,
      r: { spd: 74, sht: 74, ins: 76, pas: 76, def: 81, blk: 91, reb: 83, hnd: 74 },
    });
    expect(monByDex(488)).toMatchObject({
      name: 'Cresselia', pos: 'C', ovr: 84,
      r: { spd: 74, sht: 69, ins: 75, pas: 75, def: 80, blk: 87, reb: 86, hnd: 73 },
    });
    // Centers the ladder leaves at center.
    for (const dex of [493, 486, 382, 377, 378, 379, 485]) expect(monByDex(dex).pos, monByDex(dex).name).toBe('C');
  });

  it('Ranked presets stay at 88 or below and include no lore legendary', () => {
    for (const p of RANKED_PRESETS) {
      const team = presetRoster(p.id);
      expect(team.reduce((s, m) => s + m.ovr, 0), p.name).toBeLessThanOrEqual(RANKED_MAX_OVR * team.length);
      for (const m of team) {
        expect(m.ovr, `${p.name} ${m.name}`).toBeLessThanOrEqual(RANKED_MAX_OVR);
        expect(isRankedLegal(m), `${p.name} ${m.name}`).toBe(true);
        expect(RANKED_LEGENDARIES, `${p.name} ${m.name}`).not.toContain(m.dex);
      }
    }
  });
});
