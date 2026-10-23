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

  it('the bigger moment wins when several land at once: on fire over the basket that lit it', () => {
    const a = new Announcer(() => 0);
    expect(a.next([ev.fire, ev.dunk], 0, len)?.call).toBe('fire');
    expect(new Announcer(() => 0).next([ev.heating, ev.three], 0, len)?.call).toBe('heating');
  });

  it('never talks over himself unless the moment is much bigger', () => {
    const a = new Announcer(() => 0);
    expect(a.next([ev.steal], 0, len)?.call).toBe('steal');
    expect(a.next([ev.dunk], 0.5, len)).toBeNull(); // still on the steal
    expect(a.next([ev.fire], 0.6, len)?.call).toBe('fire'); // cuts in
    expect(a.next([ev.final], 0.7, len)?.call).toBe('final');
    expect(a.next([ev.dunk], 3, len)?.call).toBe('dunk');
  });

  it('a run of dunks gets a call, then a breather, and never the same line twice in a row', () => {
    const a = new Announcer(() => 0);
    const said: (string | undefined)[] = [];
    for (let t = 0; t < 60; t += 2) said.push(a.next([ev.dunk], t, len)?.clip);
    const calls = said.filter(Boolean) as string[];
    expect(calls.length).toBeGreaterThan(5);
    expect(calls.length).toBeLessThan(said.length / 2);
    for (let i = 1; i < calls.length; i++) expect(calls[i]).not.toBe(calls[i - 1]);
    expect(calls.every((c) => (CALLS.dunk as readonly string[]).includes(c))).toBe(true);
  });

  it('every call has a priority and lines', () => {
    for (const c of Object.keys(CALLS) as Call[]) expect(CALLS[c].length).toBeGreaterThan(0);
  });
});
