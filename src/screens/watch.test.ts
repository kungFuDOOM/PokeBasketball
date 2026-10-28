import { describe, expect, it } from 'vitest';
import { COURTS } from '../data/courts';
import { monByDex } from '../data/pokemon';
import { Game } from '../game/game';
import type { GameConfig, TeamDef } from '../game/types';
import { finishGame, nextSpeed, resultTag, stepHeadless } from './watch';

const team = (name: string, dexes: number[]): TeamDef => ({
  name, abbr: name.slice(0, 3).toUpperCase(), color: '#3b6fd8', color2: '#16224a', human: false, roster: dexes.map(monByDex),
});
const config = (seed = 11): GameConfig => ({
  home: team('Pallet Town', [25, 381, 6, 445, 382]),
  away: team('Indigo Elite', [94, 130, 149, 248, 150]),
  quarterLen: 30, difficulty: 'pro', court: COURTS['Indigo Elite'], stamina: true, seed,
});

describe('watch helpers', () => {
  it('cycles 1x → 2x → 4x → 1x and recovers from odd values', () => {
    expect(nextSpeed(1)).toBe(2);
    expect(nextSpeed(2)).toBe(4);
    expect(nextSpeed(4)).toBe(1);
    expect(nextSpeed(8)).toBe(1);
  });

  it('tags results by how the game was decided', () => {
    expect(resultTag('Week 3', 'played')).toBe('Week 3');
    expect(resultTag('Week 3', 'simmed')).toBe('Week 3 · Simulated');
    expect(resultTag('Week 3', 'watched')).toBe('Week 3 · Watched');
  });

  it('skip finishes a game from mid-game with a final score', () => {
    const g = new Game(config());
    expect(stepHeadless(g, 600)).toBe(false);
    expect(g.phase).not.toBe('final');
    finishGame(g);
    expect(g.phase).toBe('final');
    expect(g.score[0] + g.score[1]).toBeGreaterThan(0);
    expect(g.events).toHaveLength(0);
  });

  it('is the same deterministic step: chunked or all at once gives one result', () => {
    const a = new Game(config(7));
    const b = new Game(config(7));
    finishGame(a);
    while (!stepHeadless(b, 997));
    expect(b.score).toEqual(a.score);
  });

  it('a spectator game has no player: junk written to the user input changes nothing', () => {
    const a = new Game(config(3));
    const b = new Game(config(3));
    b.userInput = { ...b.userInput, mx: 1, shoot: true, pass: true, turbo: true };
    finishGame(a);
    finishGame(b);
    expect(b.score).toEqual(a.score);
  });
});
