import { describe, expect, it } from 'vitest';
import { POKEMON, POSITIONS, type Mon } from '../data/pokemon';
import { Game } from '../game/game';
import type { GameConfig, TeamDef } from '../game/types';

// GameConfig.practice (the tutorial): the CPU never steals or shoves and reacts slowly; unset, nothing changes.
const by = (p: string) => POKEMON.filter((m) => m.pos === p).sort((a, b) => b.ovr - a.ovr);
const five = (i: number): Mon[] => POSITIONS.map((p) => by(p)[i]);
const team = (name: string, roster: Mon[], human: boolean): TeamDef =>
  ({ name, abbr: name.slice(0, 3).toUpperCase(), color: '#e33', color2: '#222', roster, human });
const cfg = (practice?: boolean): GameConfig => ({
  home: team('You', five(0), true), away: team('Cpu', five(1), false),
  quarterLen: 30, difficulty: 'rookie', seed: 7, stamina: false, autoSwitch: true, ...(practice ? { practice } : {}),
});

/** Plays a whole seeded game with the user idle; returns CPU steals and the final score. */
function run(c: GameConfig) {
  const g = new Game(c);
  let cpuSteals = 0;
  for (let n = 0; g.phase !== 'final' && n < 400000; n++) {
    g.update(1 / 60);
    for (const e of g.events) if (e.kind === 'steal' && e.player.team === 1) cpuSteals++;
    g.events.length = 0;
    g.sfx.length = 0;
  }
  return { cpuSteals, score: [...g.score] };
}

describe('practice CPU', () => {
  it('has no aggression and slow reactions only on the CPU side', () => {
    const g = new Game(cfg(true));
    const cpu = g.teamPlayers(1)[0];
    const me = g.teamPlayers(0)[0];
    expect(g.aggro(cpu)).toBe(0);
    expect(g.reactTime(cpu)).toBeGreaterThanOrEqual(1.5);
    expect(g.aggro(me)).toBe(new Game(cfg()).aggro(me));
  });

  it('never steals from an idle user over a whole game', () => {
    expect(run(cfg(true)).cpuSteals).toBe(0);
  });
});
