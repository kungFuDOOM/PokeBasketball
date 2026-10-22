import { describe, expect, it } from 'vitest';
import { POKEMON, POSITIONS, type Mon, type Pos } from '../data/pokemon';
import { bestLineup } from './game';

const byPos = (p: Pos) => POKEMON.filter((m) => m.pos === p).sort((a, b) => b.ovr - a.ovr);
const top = (p: Pos, n = 1) => byPos(p).slice(0, n);
const mid = (p: Pos, i: number) => byPos(p)[i];

describe('starters by position (one shared rule)', () => {
  it('two centres: the better C starts at C, the other goes to the bench even with a higher OVR than other starters', () => {
    const [c1, c2] = top('C', 2);
    const team: Mon[] = [c1, c2, mid('PG', 30), mid('SG', 30), mid('SF', 30), mid('PF', 30), ...top('PG', 2).slice(1), mid('SG', 40), mid('SF', 40), mid('PF', 40)];
    const { starters, bench, slots } = bestLineup(team);
    expect(slots).toEqual(POSITIONS);
    expect(starters.map((m) => m.pos)).toEqual(POSITIONS);
    expect(starters[4]).toBe(c1);
    expect(bench).toContain(c2);
    expect(starters.length + bench.length).toBe(team.length);
  });

  it('the highest OVR wins each slot', () => {
    const team = POSITIONS.flatMap((p) => [mid(p, 5), mid(p, 1)]);
    const { starters } = bestLineup(team);
    POSITIONS.forEach((p, k) => expect(starters[k]).toBe(mid(p, 1)));
  });

  it('a missing position is filled by the best nearby player and shown in that slot', () => {
    // No SF drafted: an SG or PF covers it (SG first), never a duplicate C ahead of them.
    const team: Mon[] = [...top('C', 3), mid('PG', 2), mid('SG', 2), mid('SG', 8), mid('PF', 2), mid('PF', 8), mid('PG', 8), mid('C', 10)];
    const { starters, slots, bench } = bestLineup(team);
    expect(slots).toEqual(POSITIONS);
    expect(starters[2].pos).toBe('SG');
    expect(starters[2]).toBe(mid('SG', 8));
    expect(starters.filter((m) => m.pos === 'C').length).toBe(1);
    expect(bench.length).toBe(5);
  });

  it('a short roster still fills slots in order and never invents players', () => {
    const team = [mid('C', 0), mid('C', 1), mid('PG', 0)];
    const { starters, bench, slots } = bestLineup(team);
    expect(starters.length).toBe(3);
    expect(bench.length).toBe(0);
    expect(slots[0]).toBe('PG');
    expect(new Set(starters).size).toBe(3);
  });
});
