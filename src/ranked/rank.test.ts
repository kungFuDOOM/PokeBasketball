import { describe, expect, it } from 'vitest';
import {
  applyPlacement, applyResult, fromLadderScore, ladderScore, leaverCost, lossCost, marginOf, newLadderState, NO_MARGIN, opponentAdj,
  placementShift, placementStartScore, placementWeight, rankLabel, rankName, registerLeave, seedScore, stayerGain, tierName, tierRanges,
  validScore, winGain, zenithDecay, type LadderState,
} from './rank';

const at = (divIdx: number, points: number, over: Partial<LadderState> = {}): LadderState => ({ ...newLadderState(divIdx, points), ...over });
const m = (w: number, l: number) => marginOf(w, l);

describe('names and ladder score', () => {
  it('names every division from Bronze 3 up to Zenith', () => {
    expect(rankName(0)).toBe('Bronze 3');
    expect(rankName(2)).toBe('Bronze 1');
    expect(rankName(3)).toBe('Silver 3');
    expect(rankName(8)).toBe('Gold 1');
    expect(rankName(7)).toBe('Gold 2');
    expect(rankName(15)).toBe('Prism 3');
    expect(rankName(18)).toBe('Eclipse 3');
    expect(rankName(21)).toBe('Pokémon Master 3');
    expect(rankName(23)).toBe('Pokémon Master 1');
    expect(rankName(24)).toBe('Zenith');
    expect(tierName(14)).toBe('Diamond');
    expect(rankLabel(7, 40)).toBe('Gold 2 - 40 pts');
    expect(rankLabel(24, 340)).toBe('Zenith 340');
  });
  it('ladder score is div_idx * 100 + points, Zenith adds 2400', () => {
    expect(ladderScore(0, 0)).toBe(0);
    expect(ladderScore(23, 99)).toBe(2399);
    expect(ladderScore(24, 340)).toBe(2740);
    expect(fromLadderScore(1234)).toEqual({ divIdx: 12, points: 34 });
    expect(fromLadderScore(99999)).toEqual({ divIdx: 23, points: 99 });
    expect(fromLadderScore(-5)).toEqual({ divIdx: 0, points: 0 });
  });
});

describe('performance formula', () => {
  it('computes the margin share and validates scores', () => {
    expect(m(42, 38)).toEqual({ diff: 4, total: 80 });
    expect(validScore(42, 38)).toBe(true);
    expect(validScore(38, 42)).toBe(false);
    expect(validScore(301, 3)).toBe(false);
    expect(validScore(40.5, 3)).toBe(false);
    expect(marginOf(10, 10)).toEqual(NO_MARGIN);
  });
  it('clamps the opponent modifier to +-3', () => {
    expect(opponentAdj(5, 20)).toBe(3);
    expect(opponentAdj(20, 5)).toBe(-3);
    expect(opponentAdj(5, 6)).toBe(1);
  });
  it('matches hand-computed Bronze results (W 30, L 19)', () => {
    expect(winGain(30, m(42, 38), 0)).toBe(26); // m .05 -> Mw .87 -> 26.1
    expect(lossCost(19, m(42, 38), 0)).toBe(13); // m .05 -> Ml .68 -> 12.92
  });
});

describe('per-tier ranges match the plan table', () => {
  const rows: [number, number, number, number, number][] = [
    [0, 24, 45, 11, 19], [3, 22, 41, 11, 19], [6, 20, 38, 11, 19], [9, 19, 36, 12, 20],
    [12, 18, 35, 12, 20], [15, 18, 33, 13, 21], [18, 17, 32, 13, 21], [21, 16, 30, 13, 22], [24, 16, 30, 13, 22],
  ];
  it.each(rows)('div %i: win %i..%i, loss %i..%i', (div, wmin, wmax, lmin, lmax) => {
    expect(tierRanges(div)).toEqual({ winMin: wmin, winMax: wmax, lossMin: lmin, lossMax: lmax });
  });
  it('every division in a tier shares the tier ranges', () => {
    for (let d = 0; d <= 24; d++) expect(tierRanges(d)).toEqual(tierRanges(Math.min(d, 23) - (Math.min(d, 23) % 3)));
  });
  it('no input can leave the min..max range, for any margin and opponent', () => {
    for (let div = 0; div <= 24; div++) {
      const r = tierRanges(div);
      for (let loser = 0; loser < 60; loser += 3) for (const winner of [loser + 1, loser + 4, loser + 15, loser + 60, 300]) {
        const mg = marginOf(winner, loser);
        for (let opp = 0; opp <= 24; opp++) {
          const w = applyResult(at(div, 10), { won: true, margin: mg, oppIdx: opp }).delta;
          expect(w).toBeGreaterThanOrEqual(r.winMin);
          expect(w).toBeLessThanOrEqual(r.winMax);
          const l = -applyResult(at(div, 99), { won: false, margin: mg, oppIdx: opp }).delta;
          expect(l).toBeGreaterThanOrEqual(r.lossMin);
          expect(l).toBeLessThanOrEqual(r.lossMax);
        }
      }
    }
  });
  it('hits the extremes: dominant win vs +3 is max, close win vs -3 is min', () => {
    expect(applyResult(at(0, 0), { won: true, margin: m(70, 20), oppIdx: 3 }).delta).toBe(45);
    expect(applyResult(at(3, 0), { won: true, margin: NO_MARGIN, oppIdx: 0 }).delta).toBe(22); // 22 - 3 clamps to the Silver minimum
    expect(applyResult(at(0, 50), { won: false, margin: m(70, 20), oppIdx: 0 }).delta).toBe(-19); // blowout loss: full L
    expect(applyResult(at(0, 50), { won: false, margin: m(41, 40), oppIdx: 3 }).delta).toBe(-11); // photo finish vs stronger
  });
});

describe('win and loss maths', () => {
  it('uses half-up rounding and the documented multipliers', () => {
    // Gold W 25: m = 0.5 -> Mw 1.5 -> 37.5 -> 38 (half-up)
    expect(winGain(25, m(75, 25), 0)).toBe(38);
    // m = 0.2 -> Mw 1.08 -> 27 for W 25
    expect(winGain(25, m(60, 40), 0)).toBe(27);
    // m = 0 -> Mw 0.8 -> 20
    expect(winGain(25, NO_MARGIN, 0)).toBe(20);
    // adj adds to wins, subtracts from losses
    expect(winGain(25, m(60, 40), 3)).toBe(30);
    expect(lossCost(19, m(60, 40), 3)).toBe(14);
    expect(lossCost(19, m(60, 40), -3)).toBe(19); // 17 + 3 clamps at L
  });
  it('loss multiplier runs from 0.6 (photo finish) to 1.0 (m >= 0.25)', () => {
    expect(lossCost(20, NO_MARGIN, 0)).toBe(12);
    expect(lossCost(20, m(50, 30), 0)).toBe(20); // m = .25 exactly
    expect(lossCost(20, m(45, 35), 0)).toBe(16); // m = .125 -> Ml .8
  });
  it('leaver and stayer values', () => {
    expect(leaverCost(19, false)).toBe(19);
    expect(leaverCost(19, true)).toBe(24); // 23.75
    expect(leaverCost(22, true)).toBe(28); // 27.5 half-up
    expect(stayerGain(30)).toBe(24);
    expect(stayerGain(27)).toBe(22);
  });
});

describe('promotion and demotion', () => {
  it('promotes with the remainder carried over', () => {
    const r = applyResult(at(0, 90), { won: true, margin: NO_MARGIN, oppIdx: 0 }); // +24
    expect(r.state).toMatchObject({ divIdx: 1, points: 14 });
    expect(r.event).toBe('promoted');
  });
  it('promotes across a tier boundary (Bronze 1 -> Silver 3)', () => {
    const r = applyResult(at(2, 95), { won: true, margin: NO_MARGIN, oppIdx: 2 });
    expect(rankName(r.state.divIdx)).toBe('Silver 3');
    expect(r.event).toBe('promoted');
  });
  it('stays put just under 100', () => {
    const r = applyResult(at(4, 70), { won: true, margin: NO_MARGIN, oppIdx: 4 }); // +22 -> 92
    expect(r.state).toMatchObject({ divIdx: 4, points: 92 });
    expect(r.event).toBeNull();
  });
  it('demotes to 75 in the division below when the loss crosses 0 (Platinum, no shield)', () => {
    const r = applyResult(at(10, 5), { won: false, margin: m(70, 20), oppIdx: 10 });
    expect(r.state).toMatchObject({ divIdx: 9, points: 75 });
    expect(r.event).toBe('demoted');
    expect(r.delta).toBe(-20);
  });
  it('demotes across a tier boundary (Platinum 3 -> Gold 1) and the shield does not apply from Platinum', () => {
    const r = applyResult(at(9, 3), { won: false, margin: m(70, 20), oppIdx: 9 });
    expect(rankName(r.state.divIdx)).toBe('Gold 1');
    expect(r.state.points).toBe(75);
    expect(r.state.shieldCharge).toBe(1); // untouched
  });
  it('a loss that lands exactly on 0 does not demote', () => {
    const r = applyResult(at(10, 20), { won: false, margin: m(70, 20), oppIdx: 10 });
    expect(r.state).toMatchObject({ divIdx: 10, points: 0 });
    expect(r.event).toBeNull();
  });
});

describe('rank shield', () => {
  const blowout = m(70, 20);
  it('blocks one demotion at Gold or below, leaving 0 points', () => {
    const r = applyResult(at(7, 5), { won: false, margin: blowout, oppIdx: 7 });
    expect(r.state).toMatchObject({ divIdx: 7, points: 0, shieldCharge: 0, lossesSinceShield: 0 });
    expect(r.event).toBe('shielded');
  });
  it('is active in Gold 1 (div 8) but not Platinum 3 (div 9)', () => {
    expect(applyResult(at(8, 0), { won: false, margin: blowout, oppIdx: 8 }).event).toBe('shielded');
    expect(applyResult(at(9, 0), { won: false, margin: blowout, oppIdx: 9 }).event).toBe('demoted');
  });
  it('protects the drop from Gold 3 to Silver 1 (div 6, while still in Gold)', () => {
    const r = applyResult(at(6, 4), { won: false, margin: blowout, oppIdx: 6 });
    expect(r.event).toBe('shielded');
    expect(r.state.divIdx).toBe(6);
  });
  it('a second demotion goes through while the charge is empty', () => {
    const r = applyResult(at(7, 5, { shieldCharge: 0, lossesSinceShield: 0 }), { won: false, margin: blowout, oppIdx: 7 });
    expect(r.event).toBe('demoted');
    expect(r.state).toMatchObject({ divIdx: 6, points: 75, lossesSinceShield: 1 });
  });
  it('recharges after 3 losses; wins do not count', () => {
    let s = at(7, 90, { shieldCharge: 0 });
    s = applyResult(s, { won: true, margin: NO_MARGIN, oppIdx: 7 }).state; // promotes, no count
    expect(s.lossesSinceShield).toBe(0);
    for (let i = 1; i <= 2; i++) { s = applyResult(s, { won: false, margin: NO_MARGIN, oppIdx: s.divIdx }).state; expect(s.shieldCharge).toBe(0); expect(s.lossesSinceShield).toBe(i); }
    s = applyResult(s, { won: false, margin: NO_MARGIN, oppIdx: s.divIdx }).state;
    expect(s).toMatchObject({ shieldCharge: 1, lossesSinceShield: 0 });
  });
  it('does nothing for leaver losses: the demotion goes through and the charge stays', () => {
    const r = applyResult(at(7, 5), { won: false, mode: 'leave', oppIdx: 7 });
    expect(r.event).toBe('demoted');
    expect(r.state.shieldCharge).toBe(1);
  });
  it('a leave counts toward the recharge', () => {
    const r = applyResult(at(7, 50, { shieldCharge: 0, lossesSinceShield: 2 }), { won: false, mode: 'leave', oppIdx: 7 });
    expect(r.state).toMatchObject({ shieldCharge: 1, lossesSinceShield: 0 });
  });
});

describe('Bronze 3 floor', () => {
  it('never goes below 0 points and does not spend the shield', () => {
    const r = applyResult(at(0, 5), { won: false, margin: m(70, 20), oppIdx: 0 });
    expect(r.state).toMatchObject({ divIdx: 0, points: 0, shieldCharge: 1 });
    expect(r.event).toBeNull();
    const l = applyResult(at(0, 0), { won: false, mode: 'leave', oppIdx: 0 });
    expect(l.state).toMatchObject({ divIdx: 0, points: 0 });
  });
});

describe('Zenith', () => {
  it('enters at exactly 100 points on promotion from Pokémon Master 1', () => {
    const r = applyResult(at(23, 95), { won: true, margin: NO_MARGIN, oppIdx: 23 });
    expect(r.state).toMatchObject({ divIdx: 24, points: 100 });
    expect(r.event).toBe('zenith');
  });
  it('has no cap and uses Pokémon Master values', () => {
    const r = applyResult(at(24, 1000), { won: true, margin: m(70, 20), oppIdx: 24 });
    expect(r.delta).toBe(30);
    expect(r.state.points).toBe(1030);
  });
  it('a single loss right after entry does not drop you out', () => {
    const r = applyResult(at(24, 100), { won: false, margin: m(70, 20), oppIdx: 24 });
    expect(r.state).toMatchObject({ divIdx: 24, points: 78 });
  });
  it('drops to Pokémon Master 1 at 75 points when a loss takes points below 0 (no shield)', () => {
    const r = applyResult(at(24, 10), { won: false, margin: m(70, 20), oppIdx: 24 });
    expect(r.state).toMatchObject({ divIdx: 23, points: 75 });
    expect(r.event).toBe('demoted');
  });
  it('0 points exactly stays in Zenith', () => {
    expect(applyResult(at(24, 22), { won: false, margin: m(70, 20), oppIdx: 24 }).state).toMatchObject({ divIdx: 24, points: 0 });
  });
  it('decays 25 points per full idle 7 days after the first 7, never below 50', () => {
    expect(zenithDecay(300, 6)).toBe(300);
    expect(zenithDecay(300, 7)).toBe(275);
    expect(zenithDecay(300, 20)).toBe(250);
    expect(zenithDecay(300, 365)).toBe(50);
    expect(zenithDecay(60, 30)).toBe(50);
    expect(zenithDecay(40, 30)).toBe(40);
  });
});

describe('placements', () => {
  it('seeds from the last archived final score', () => {
    expect(seedScore(null)).toBe(0);
    expect(seedScore(700)).toBe(100); // Gold 2 0 pts
    expect(seedScore(1100)).toBe(500); // Platinum 1
    expect(seedScore(300)).toBe(0);
    expect(seedScore(2400 + 500)).toBe(1400); // Zenith and PM seed at the cap
    expect(seedScore(2000)).toBe(1400);
  });
  it('weighs a placement between about 0.48 and 1.2', () => {
    expect(placementWeight({ won: true, margin: NO_MARGIN, oppScore: 0, seed: 1000 })).toBeCloseTo(0.6 * 0.8, 9);
    expect(placementWeight({ won: true, margin: m(70, 20), oppScore: 3000, seed: 0 })).toBeCloseTo(1.2, 9);
    expect(placementWeight({ won: true, kind: 'leave', oppScore: 0, seed: 0 })).toBe(1);
    expect(placementWeight({ won: true, kind: 'stay', oppScore: 0, seed: 0 })).toBe(0.6);
  });
  it('shift is clamp(round(20 * raw), -100, 100)', () => {
    expect(placementShift(0)).toBe(0);
    expect(placementShift(0.05)).toBe(1);
    expect(placementShift(-0.05)).toBe(-1);
    expect(placementShift(5.9)).toBe(100);
    expect(placementShift(-9)).toBe(-100);
    expect(placementStartScore(1400, 6)).toBe(1500);
    expect(placementStartScore(0, -3)).toBe(0);
    expect(placementStartScore(2200, 6)).toBe(2299);
  });
  it('a 5-0 sweep with strong margins shifts about +100; 0-5 about -100', () => {
    let s = { played: 0, raw: 0, seed: 500 };
    let placed;
    for (let i = 0; i < 5; i++) { const r = applyPlacement(s, { won: true, margin: m(60, 30), oppScore: 500 }); s = r.state; placed = r.placed; if (i < 4) expect(r.placed).toBeNull(); }
    expect(placed!.shift).toBe(100);
    expect(placed).toMatchObject({ divIdx: 6, points: 0 });
    s = { played: 0, raw: 0, seed: 500 };
    for (let i = 0; i < 5; i++) { const r = applyPlacement(s, { won: false, margin: m(60, 30), oppScore: 500 }); s = r.state; placed = r.placed; }
    expect(placed!.shift).toBe(-100);
    expect(placed).toMatchObject({ divIdx: 4, points: 0 });
  });
  it('a 3-2 record lands near +20', () => {
    let s = { played: 0, raw: 0, seed: 500 };
    let placed;
    for (const won of [true, false, true, false, true]) { const r = applyPlacement(s, { won, margin: m(46, 40), oppScore: 500 }); s = r.state; placed = r.placed; }
    expect(placed!.shift).toBeGreaterThan(0);
    expect(placed!.shift).toBeLessThan(40);
  });
  it('a brand-new player (seed 0) cannot place below Bronze 3 0 pts, and never reaches Zenith', () => {
    let s = { played: 0, raw: 0, seed: 0 };
    let placed;
    for (let i = 0; i < 5; i++) { const r = applyPlacement(s, { won: false, margin: m(60, 30), oppScore: 0 }); s = r.state; placed = r.placed; }
    expect(placed).toMatchObject({ divIdx: 0, points: 0 });
    s = { played: 0, raw: 0, seed: 1400 };
    for (let i = 0; i < 5; i++) { const r = applyPlacement(s, { won: true, margin: m(90, 10), oppScore: 3000 }); s = r.state; placed = r.placed; }
    expect(placed!.divIdx).toBeLessThanOrEqual(15);
  });
  it('a leaver weighs -1.0 and the stayer +0.6', () => {
    const a = applyPlacement({ played: 0, raw: 0, seed: 0 }, { won: false, kind: 'leave', oppScore: 0 });
    const b = applyPlacement({ played: 0, raw: 0, seed: 0 }, { won: true, kind: 'stay', oppScore: 0 });
    expect(a.state.raw).toBe(-1);
    expect(b.state.raw).toBe(0.6);
  });
});

describe('leavers', () => {
  const H = 3600_000;
  it('first leave: warning only', () => {
    expect(registerLeave({ leaves: 0, windowStartMs: null }, 0)).toMatchObject({ leaves: 1, cooldownMin: 0, heavy: false, flag: false });
  });
  it('escalates 5 / 15 / 60 minutes and x1.25 from the 3rd', () => {
    let s = { leaves: 0, windowStartMs: null as number | null };
    const out = [1, 2, 3, 4, 5].map((i) => { const r = registerLeave(s, i * H); s = { leaves: r.leaves, windowStartMs: r.windowStartMs }; return r; });
    expect(out.map((o) => o.cooldownMin)).toEqual([0, 5, 15, 60, 60]);
    expect(out.map((o) => o.heavy)).toEqual([false, false, true, true, true]);
    expect(out.map((o) => o.flag)).toEqual([false, false, false, true, true]);
  });
  it('the window resets 24 h after its first leave', () => {
    const r = registerLeave({ leaves: 3, windowStartMs: 0 }, 25 * H);
    expect(r).toMatchObject({ leaves: 1, windowStartMs: 25 * H, heavy: false });
    expect(registerLeave({ leaves: 3, windowStartMs: 0 }, 24 * H).leaves).toBe(4);
  });
  it('leaver loses the max cost with no performance reduction and the stayer gets the minimum gain', () => {
    expect(applyResult(at(6, 80), { won: false, mode: 'leave', oppIdx: 20 }).delta).toBe(-19);
    expect(applyResult(at(6, 80), { won: false, mode: 'leave', heavy: true, oppIdx: 20 }).delta).toBe(-24);
    expect(applyResult(at(6, 20), { won: true, mode: 'stay', oppIdx: 20 }).delta).toBe(20);
  });
});
