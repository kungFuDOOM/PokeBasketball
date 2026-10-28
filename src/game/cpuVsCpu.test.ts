import { describe, expect, it } from 'vitest';
import { COURTS } from '../data/courts';
import { POKEMON, POSITIONS, type Mon } from '../data/pokemon';
import { Game } from './game';
import type { Difficulty, TeamDef } from './types';

// Watch and Sim run both teams as CPU (human: false on both sides): ratings alone must decide the game.
const by = (p: string) => POKEMON.filter((m) => m.pos === p).sort((a, b) => b.ovr - a.ovr);
const strong = POSITIONS.map((p) => by(p)[0]);
const weak = POSITIONS.map((p) => by(p).find((m) => m.ovr <= 90)!);
const court = Object.values(COURTS)[0];
const team = (name: string, roster: Mon[]): TeamDef => ({ name, abbr: name.slice(0, 3).toUpperCase(), color: '#e33', color2: '#222', roster, human: false });

/** Strong team's margin over a seeded CPU-vs-CPU game, with the strong side home or away. */
function margin(seed: number, difficulty: Difficulty, strongAway: boolean): number {
  const s = team('Strong', strong);
  const w = team('Weak', weak);
  const g = new Game({ home: strongAway ? w : s, away: strongAway ? s : w, quarterLen: 30, difficulty, court, seed });
  for (let n = 0; g.phase !== 'final' && n < 400000; n++) {
    g.update(1 / 60);
    g.events.length = 0;
    g.sfx.length = 0;
  }
  const i = strongAway ? 1 : 0;
  return g.score[i] - g.score[1 - i];
}

describe('CPU vs CPU games (Watch / Sim)', () => {
  it('the stronger team wins most seeded games, home or away', () => {
    const margins = Array.from({ length: 40 }, (_, i) => margin(1000 + i, 'pro', i % 2 === 1));
    expect(margins.filter((m) => m > 0).length / margins.length).toBeGreaterThan(0.6);
  });

  it('the difficulty setting does not change the result', () => {
    for (let seed = 1; seed <= 4; seed++) {
      const base = margin(seed, 'pro', false);
      for (const d of ['rookie', 'allstar', 'legend'] as Difficulty[]) expect(margin(seed, d, false)).toBe(base);
    }
  });
});
