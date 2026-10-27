import { describe, expect, it } from 'vitest';
import { COURTS } from '../data/courts';
import { monByDex } from '../data/pokemon';
import { Game } from './game';
import { TICK, packInput, restore, snapshot, stateHash, stepGame, unpackInput, type WireInput } from './sync';
import { ENGINE_VERSION, emptyIntent, seededRng, type GameConfig, type TeamDef } from './types';

const team = (name: string, human: boolean, dexes: number[]): TeamDef => ({
  name, abbr: name.slice(0, 3).toUpperCase(), color: '#3b6fd8', color2: '#16224a', human, roster: dexes.map(monByDex),
});

const config = (seed: number, humans: [boolean, boolean]): GameConfig => ({
  home: team('Pallet Town', humans[0], [25, 381, 6, 445, 382]),
  away: team('Indigo Elite', humans[1], [94, 130, 149, 248, 150]),
  quarterLen: 30,
  difficulty: 'pro',
  court: COURTS['Indigo Elite'],
  stamina: true,
  seed,
});

/** A scripted controller: the same (script seed, tick) always gives the same input. */
function script(seed: number) {
  const rng = seededRng(seed);
  let held = emptyIntent();
  return (): WireInput => {
    if (rng() < 0.08) {
      held = emptyIntent();
      held.mx = rng() * 2 - 1;
      held.my = rng() * 2 - 1;
      held.turbo = rng() < 0.3;
    }
    const i = { ...held, shoot: rng() < 0.02, pass: rng() < 0.01, steal: rng() < 0.01, swap: rng() < 0.005 };
    i.shootHeld = i.shoot;
    return packInput(i);
  };
}

const MAX_TICKS = 200_000;

/** Plays to the final buzzer, returning the state hash after every tick. */
function play(g: Game, inputs: [() => WireInput, () => WireInput], from = 0, onTick?: (tick: number) => void): number[] {
  const hashes: number[] = [];
  for (let tick = from; g.phase !== 'final' && tick < MAX_TICKS; tick++) {
    stepGame(g, [inputs[0](), inputs[1]()]);
    g.events.length = 0;
    g.sfx.length = 0;
    hashes.push(stateHash(g));
    onTick?.(tick);
  }
  return hashes;
}

const full = (g: Game) => JSON.stringify(snapshot(g));

describe.each([
  ['one human vs the CPU', [true, false] as [boolean, boolean]],
  ['two humans', [true, true] as [boolean, boolean]],
])('deterministic engine (%s)', (_label, humans) => {
  it('the same seed and inputs give identical state on every tick of a full game', () => {
    const states: string[][] = [[], []];
    const runs = [0, 1].map((r) => {
      const g = new Game(config(1234, humans));
      const hashes = play(g, [script(1), script(2)], 0, (t) => { if (t % 600 === 0) states[r].push(full(g)); });
      return { g, hashes };
    });
    const [a, b] = runs;
    expect(a.g.phase).toBe('final');
    expect(a.hashes.length).toBeGreaterThan(30 * 4 / TICK);
    expect(b.hashes).toEqual(a.hashes);
    expect(states[1]).toEqual(states[0]);
    expect(full(b.g)).toBe(full(a.g));
    expect(b.g.score).toEqual(a.g.score);
    expect(a.g.score[0] + a.g.score[1]).toBeGreaterThan(0);
  });

  it('a game restored from a mid-game snapshot finishes identically', () => {
    const inA: [() => WireInput, () => WireInput] = [script(3), script(4)];
    const a = new Game(config(99, humans));
    let snap = '';
    let cut = 0;
    const tail: number[] = [];
    play(a, inA, 0, (t) => {
      if (!snap && a.phase === 'live' && a.quarter === 2 && a.ball.mode === 'held') { snap = full(a); cut = t + 1; }
      else if (snap) tail.push(stateHash(a));
    });
    expect(snap).not.toBe('');
    expect(a.phase).toBe('final');

    // Replay the same input scripts up to the cut, then hand them to a fresh game restored from the snapshot.
    const inB: [() => WireInput, () => WireInput] = [script(3), script(4)];
    for (let t = 0; t < cut; t++) { inB[0](); inB[1](); }
    const b = new Game(config(99, humans));
    restore(b, JSON.parse(snap));
    expect(full(b)).toBe(snap);
    const hashes = play(b, inB, cut);
    expect(hashes).toEqual(tail);
    expect(full(b)).toBe(full(a));
    expect(b.score).toEqual(a.score);
  });
});

describe('seeds and engine versions', () => {
  it('different seeds play out differently', () => {
    const run = (seed: number) => play(new Game(config(seed, [false, false])), [script(1), script(2)]);
    expect(run(1)).not.toEqual(run(2));
  });

  it('a CPU-only game (franchise sims) is repeatable from its seed', () => {
    const run = () => { const g = new Game(config(7, [false, false])); play(g, [script(1), script(2)]); return full(g); };
    expect(run()).toBe(run());
  });

  it('records the engine version and refuses other versions', () => {
    const g = new Game(config(5, [true, false]));
    expect(g.engineVersion).toBe(ENGINE_VERSION);
    expect(g.seed).toBe(5);
    expect(() => new Game({ ...config(5, [true, false]), engineVersion: ENGINE_VERSION })).not.toThrow();
    expect(() => new Game({ ...config(5, [true, false]), engineVersion: ENGINE_VERSION + 1 })).toThrow(/engine/);
    const s = snapshot(g);
    expect(s.engine).toBe(ENGINE_VERSION);
    expect(() => restore(new Game(config(5, [true, false])), { ...s, engine: ENGINE_VERSION + 1 })).toThrow(/engine/);
  });
});

describe('input packing', () => {
  it('round-trips buttons and rounds the stick to 1/100', () => {
    const i = { ...emptyIntent(), mx: 0.12345, my: -2, turbo: true, shoot: true, swap: true };
    const back = unpackInput(JSON.parse(JSON.stringify(packInput(i))));
    expect(back).toEqual({ ...emptyIntent(), mx: 0.12, my: -1, turbo: true, shoot: true, swap: true });
    expect(unpackInput(null)).toEqual(emptyIntent());
  });
});
