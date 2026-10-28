import { describe, expect, it } from 'vitest';
import { applyResult, newRank, view, PLACEMENTS, TIER_START, DEMOTION_SHIELD, type RankState } from './rank';

const placed = (ladder: number, extra: Partial<RankState> = {}): RankState => ({ ...newRank(), placements: PLACEMENTS, mmr: ladder, ladder, ...extra });

describe('placements', () => {
  it('shows Unranked until 5 games are played', () => {
    let s = newRank();
    expect(view(s).label).toBe('Unranked, placements 0/5');
    for (let i = 0; i < 4; i++) s = applyResult(s, 1000, true).state;
    expect(view(s).label).toBe('Unranked, placements 4/5');
    const o = applyResult(s, 1000, true);
    expect(o.event).toBe('placed');
    expect(o.after.placed).toBe(true);
  });
  it('uses bigger swings during placements', () => {
    const p = applyResult(newRank(), 1000, true).mmrDelta;
    const r = applyResult(placed(1000), 1000, true).mmrDelta;
    expect(p).toBeGreaterThan(r);
  });
  it('5 wins place higher than 5 losses', () => {
    let w = newRank(), l = newRank();
    for (let i = 0; i < 5; i++) { w = applyResult(w, 1000, true).state; l = applyResult(l, 1000, false).state; }
    expect(w.ladder).toBeGreaterThan(1100);
    expect(l.ladder).toBeLessThan(900);
  });
});

describe('tier boundaries', () => {
  it.each([
    [699, 'Bronze III'], [799, 'Bronze III'], [800, 'Bronze II'], [999, 'Bronze I'], [1000, 'Silver III'],
    [1299, 'Silver I'], [1300, 'Gold III'], [1600, 'Platinum III'], [1900, 'Diamond III'], [2199, 'Diamond I'],
  ])('%i -> %s', (ladder, label) => {
    const v = view(placed(ladder));
    expect(`${v.tier} ${v.division}`).toBe(label);
  });
  it('Pokémon Master has no divisions', () => {
    const v = view(placed(TIER_START['Pokémon Master'] + 40));
    expect(v.tier).toBe('Pokémon Master');
    expect(v.division).toBeNull();
    expect(v.rp).toBe(40);
  });
});

describe('promotion and demotion', () => {
  it('promotes across a division line', () => {
    const o = applyResult(placed(1095), 1095, true);
    expect(o.after.label.startsWith('Silver II')).toBe(true);
    expect(o.event).toBe('promoted');
  });
  it('promotes into Pokémon Master', () => {
    const o = applyResult(placed(2195), 2195, true);
    expect(o.after.tier).toBe('Pokémon Master');
    expect(o.event).toBe('promoted');
  });
  it('shields at a division floor, then demotes', () => {
    let s = placed(1302);
    for (let i = 0; i < DEMOTION_SHIELD; i++) {
      const o = applyResult(s, 1300, false);
      expect(o.event).toBe('shielded');
      expect(o.after.label).toBe('Gold III · 0 RP');
      s = o.state;
    }
    const o = applyResult(s, 1300, false);
    expect(o.event).toBe('demoted');
    expect(o.after.tier).toBe('Silver');
  });
  it('winning resets the shield', () => {
    const s = applyResult(placed(1302), 1300, false).state;
    expect(applyResult(s, 1300, true).state.shield).toBe(0);
  });
  it('Pokémon Master drops back to Diamond when losing below 2200', () => {
    const o = applyResult(placed(2205), 2205, false);
    expect(o.after.tier).toBe('Diamond');
    expect(o.event).toBe('demoted');
  });
});
