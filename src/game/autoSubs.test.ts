// Auto-subs are position-aware: PG for PG ... C for C, one spot away only as small-ball cover.
import { describe, expect, it } from 'vitest';
import { COURTS } from '../data/courts';
import { POKEMON, type Mon, type Pos } from '../data/pokemon';
import { Game } from './game';
import type { GameConfig, Player, TeamDef } from './types';

let n = 0;
const mon = (pos: Pos, ovr: number): Mon => ({ ...POKEMON[0], name: `${pos}${n++}`, pos, ovr });
const def = (name: string, roster: Mon[], bench: Mon[], human = false): TeamDef =>
  ({ name, abbr: name.slice(0, 3).toUpperCase(), color: '#3b6fd8', color2: '#16224a', human, roster, bench });
const STARTERS: Pos[] = ['PG', 'SG', 'SF', 'PF', 'C'];
const away = () => def('Away', STARTERS.map((p) => mon(p, 70)), STARTERS.map((p) => mon(p, 60)));

function build(starters: Pos[], bench: [Pos, number][], over: Partial<GameConfig> = {}, human = false) {
  const home = def('Home', starters.map((p) => mon(p, 70)), bench.map(([p, o]) => mon(p, o)), human);
  const g = new Game({ home, away: away(), quarterLen: 60, difficulty: 'pro', court: COURTS['Indigo Elite'], stamina: true, seed: 3, ...over });
  g.players.forEach((q) => { q.state = 'free'; });
  g.ball.owner = g.players.find((q) => q.team === 1)!;
  return g;
}
const home = (g: Game) => g.players.filter((p) => p.team === 0);
const benchOf = (g: Game) => g.bench.filter((p) => p.team === 0);
const auto = (g: Game, qb = false) => (g as unknown as { autoSubs(t: 0 | 1, qb: boolean): void }).autoSubs(0, qb);
const byPos = (g: Game, pos: Pos): Player => home(g).find((p) => p.mon.pos === pos)!;
const countPos = (g: Game, pos: Pos) => home(g).filter((p) => p.mon.pos === pos).length;
const tire = (_g: Game, ...ps: Player[]) => ps.forEach((p) => (p.energy = 0.3));

describe('autoSubs position matching', () => {
  it('subs like for like, never two PGs or two Cs, even with a better bench C ahead in the rotation', () => {
    // Bench order puts a monster C first and the backup PG last.
    const g = build(STARTERS, [['C', 90], ['PF', 60], ['SF', 60], ['SG', 60], ['PG', 55]]);
    benchOf(g).forEach((b) => (b.energy = 1));
    tire(g, ...home(g));
    auto(g, true);
    for (const p of STARTERS) expect(countPos(g, p)).toBe(1);
    expect(byPos(g, 'PG').rotation).toBe(9);
    expect(byPos(g, 'C').mon.ovr).toBe(90);
    home(g).forEach((p) => expect(p.slot).toBe(STARTERS.indexOf(p.mon.pos)));
  });

  it('a rested starter returns to their own spot, not a tired C', () => {
    const g = build(STARTERS, [['PG', 60], ['C', 60], ['SG', 60], ['SF', 60], ['PF', 60]]);
    const pg = byPos(g, 'PG');
    // Starter PG sits; a backup PG and backup C are on the floor.
    const subPG = benchOf(g).find((b) => b.mon.pos === 'PG')!;
    (g as unknown as { swap(o: Player, s: Player): void }).swap(pg, subPG);
    const starterC = byPos(g, 'C');
    const subC = benchOf(g).find((b) => b.mon.pos === 'C')!;
    (g as unknown as { swap(o: Player, s: Player): void }).swap(starterC, subC);
    pg.energy = 0.9; starterC.energy = 0.5; // starter C is not rested enough to return
    subC.energy = 0.3; // tired backup C
    auto(g, false);
    // The starter PG (rested) is never used at C; the PF covers the tired backup C one spot away.
    expect(pg.slot).toBe(0);
    expect(countPos(g, 'PG')).toBe(1);
    expect(countPos(g, 'PF')).toBe(2);
    expect(countPos(g, 'C')).toBe(0);
  });

  it('a rested PG starter takes back the PG spot', () => {
    const g = build(STARTERS, [['PG', 60], ['C', 60]]);
    const pg = byPos(g, 'PG');
    const subPG = benchOf(g).find((b) => b.mon.pos === 'PG')!;
    (g as unknown as { swap(o: Player, s: Player): void }).swap(pg, subPG);
    pg.energy = 1; subPG.energy = 0.8;
    auto(g, false);
    expect(home(g)).toContain(pg);
    expect(countPos(g, 'PG')).toBe(1);
  });

  it('SF covers a tired PF when no PF is on the bench, and a bench C is not used with a C already out there', () => {
    const g = build(STARTERS, [['C', 95], ['SF', 60], ['SG', 60]]);
    benchOf(g).forEach((b) => (b.energy = 1));
    tire(g, byPos(g, 'PF'));
    auto(g);
    expect(countPos(g, 'C')).toBe(1);
    expect(countPos(g, 'SF')).toBe(2);
    expect(countPos(g, 'PF')).toBe(0);
  });

  it('adjacent fill for SG avoids a second PG by taking the SF', () => {
    const g = build(STARTERS, [['PG', 80], ['SF', 60]]);
    benchOf(g).forEach((b) => (b.energy = 1));
    tire(g, byPos(g, 'SG'));
    auto(g);
    expect(countPos(g, 'PG')).toBe(1);
    expect(countPos(g, 'SF')).toBe(2);
  });

  it('keeps a tired PG in rather than playing a C there (and vice versa)', () => {
    const g = build(STARTERS, [['C', 90], ['PF', 60]]);
    benchOf(g).forEach((b) => (b.energy = 1));
    const pg = byPos(g, 'PG');
    tire(g, pg);
    auto(g, true);
    expect(home(g)).toContain(pg);
    expect(countPos(g, 'C')).toBe(1);

    const g2 = build(STARTERS, [['PG', 90], ['SG', 60]]);
    benchOf(g2).forEach((b) => (b.energy = 1));
    const c = byPos(g2, 'C');
    tire(g2, c);
    auto(g2, true);
    expect(home(g2)).toContain(c);
    expect(countPos(g2, 'PG')).toBe(1);
  });
});

describe('autoSubs injuries', () => {
  it('prefers exact, then adjacent, then anything only when forced', () => {
    let g = build(STARTERS, [['C', 90], ['PF', 55], ['PG', 80]]);
    byPos(g, 'PF').hurt = 2; auto(g);
    expect(byPos(g, 'PF').mon.ovr).toBe(55);

    g = build(STARTERS, [['C', 90], ['SF', 55], ['PG', 80]]);
    byPos(g, 'PF').hurt = 2; auto(g);
    expect(countPos(g, 'SF')).toBe(2); // adjacent SF over the better C (already a C on the floor)

    g = build(STARTERS, [['C', 90]]);
    byPos(g, 'PG').hurt = 2; auto(g);
    expect(countPos(g, 'C')).toBe(2); // forced last resort
    expect(countPos(g, 'PG')).toBe(0);
  });

  it('injured players still come out when the user turned auto subs off; fatigue subs do not', () => {
    const g = build(STARTERS, [['PG', 60], ['SG', 60]], { userAutoSubs: false }, true);
    benchOf(g).forEach((b) => (b.energy = 1));
    const sg = byPos(g, 'SG');
    tire(g, byPos(g, 'PG'), sg);
    byPos(g, 'PG').hurt = 1;
    auto(g, true);
    expect(countPos(g, 'PG')).toBe(1);
    expect(byPos(g, 'PG').hurt).toBe(0); // injured PG replaced
    expect(home(g)).toContain(sg); // tired SG stays
  });
});
