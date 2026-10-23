import { describe, expect, it } from 'vitest';
import { Announcer, CALLS, CLIPS, callFor, type Call } from './announcer';
import type { GameEvent, Player } from './types';

const p = {} as Player;
const ev = {
  dunk: { kind: 'score', player: p, points: 2, how: 'dunk' },
  three: { kind: 'score', player: p, points: 3, how: 'jump' },
  two: { kind: 'score', player: p, points: 2, how: 'jump' },
  heating: { kind: 'heating', player: p },
  fire: { kind: 'fire', player: p, on: true },
  steal: { kind: 'steal', player: p, victim: p },
  final: { kind: 'final' },
} satisfies Record<string, GameEvent>;
const len = () => 1;

describe('announcer', () => {
  it('has a recorded line for every call', () => {
    const files = Object.keys(import.meta.glob('../../public/announcer/*.mp3'));
    for (const c of CLIPS) expect(files, c).toContain(`../../public/announcer/${c}.mp3`);
  });

  it('calls the same moments as the popups', () => {
    expect(callFor(ev.dunk)).toBe('dunk');
    expect(callFor(ev.three)).toBe('three');
    expect(callFor(ev.two)).toBeNull();
    expect(callFor(ev.heating)).toBe('heating');
    expect(callFor({ kind: 'quarter', label: '1ST QUARTER', sub: 'JUMP BALL' })).toBe('tipoff');
    expect(callFor({ kind: 'quarter', label: '2ND QUARTER', sub: 'PAL BALL' })).toBeNull();
    expect(callFor({ kind: 'quarter', label: 'HALFTIME', sub: '' })).toBe('half');
    expect(callFor({ kind: 'quarter', label: 'END OF REGULATION', sub: 'TIED! GOING TO OVERTIME' })).toBe('ot');
    expect(callFor({ kind: 'special', player: p, hits: [{ victim: p, mult: 2 }] })).toBe('super');
    expect(callFor({ kind: 'special', player: p, hits: [{ victim: p, mult: 1 }] })).toBeNull();
  });

  /** Frames at 30 fps up to `to` seconds, with each plan entry's events landing at its time; returns what he said. */
  const run = (a: Announcer, plan: [number, GameEvent[]][], to: number, clip = len) => {
    const said: { t: number; call: string; clip: string }[] = [];
    for (let f = 0; f <= to * 30; f++) {
      const t = f / 30;
      const evs = plan.filter(([at]) => Math.round(at * 30) === f).flatMap(([, e]) => e);
      const line = a.next(evs, t, clip);
      if (line) said.push({ t: +t.toFixed(2), ...line });
    }
    return said;
  };

  it('the bigger moment goes first when several land at once, and the other follows right after', () => {
    const said = run(new Announcer(() => 0), [[0, [ev.dunk, ev.fire]]], 3);
    expect(said.map((s) => s.call)).toEqual(['fire', 'dunk']);
    expect(said[1].t).toBeLessThan(1.2);
  });

  it('a call that lands mid-line is said as soon as he finishes, not dropped', () => {
    const said = run(new Announcer(() => 0), [[0, [ev.steal]], [0.5, [ev.dunk]]], 3);
    expect(said.map((s) => [s.call, s.t])).toEqual([['steal', 0], ['dunk', 1.07]]);
  });

  it('only a much bigger moment cuts in; a call that would be stale by the time he is free is dropped', () => {
    const said = run(new Announcer(() => 0), [[0, [ev.steal]], [0.3, [ev.fire]], [0.4, [ev.final]]], 4);
    expect(said.map((s) => s.call)).toEqual(['steal', 'fire', 'final']); // each cuts the last one off
    const slow = run(new Announcer(() => 0), [[0, [ev.steal]], [0.2, [ev.dunk]]], 5, () => 2);
    expect(slow.map((s) => s.call)).toEqual(['steal']); // the dunk was 1.8 s old by then
  });

  it('a run of dunks gets every call, never the same line twice in a row', () => {
    const plan: [number, GameEvent[]][] = Array.from({ length: 20 }, (_, i) => [i * 2.5, [ev.dunk]]);
    const said = run(new Announcer(Math.random), plan, 50);
    expect(said).toHaveLength(20);
    for (let i = 1; i < said.length; i++) expect(said[i].clip).not.toBe(said[i - 1].clip);
    expect(said.every((s) => (CALLS.dunk as readonly string[]).includes(s.clip))).toBe(true);
  });

  it('every call has a priority and lines', () => {
    for (const c of Object.keys(CALLS) as Call[]) expect(CALLS[c].length).toBeGreaterThan(0);
  });
});
