import { describe, expect, it } from 'vitest';
import { POKEMON, POSITIONS, type Mon } from '../data/pokemon';
import { Game } from '../game/game';
import type { PracticeDrill } from '../game/practice';
import { HOOP_Y, emptyIntent, hoopX, type GameConfig, type TeamDef } from '../game/types';

// Training drills never put anyone on fire, and the layups drill lays it in instead of dunking.
// Normal games (and free practice) keep streak fire and dunks exactly as before.
const by = (p: string) => POKEMON.filter((m) => m.pos === p).sort((a, b) => b.ovr - a.ovr);
const five = (i: number): Mon[] => POSITIONS.map((p) => by(p)[i]);
const team = (name: string, roster: Mon[], human: boolean): TeamDef =>
  ({ name, abbr: name.slice(0, 3).toUpperCase(), color: '#e33', color2: '#222', roster, human });
const cfg = (drill?: PracticeDrill): GameConfig => ({
  home: team('You', five(0), true), away: team('Cpu', five(1), false),
  quarterLen: 30, difficulty: 'rookie', seed: 7, stamina: false, autoSwitch: true,
  ...(drill ? { practice: true, drill } : {}),
});
function live(g: Game) {
  for (let i = 0; i < 120 && g.phase !== 'live'; i++) g.update(1 / 60);
  expect(g.phase).toBe('live');
}
// scoreBasket / setFire are private: tests poke them directly to simulate a long run of makes.
type Internals = { scoreBasket(p: unknown, pts: number, how: string): void; setFire(p: unknown): void };

describe('training drills: no on-fire', () => {
  it.each(['layups', 'jumpshots', 'passing', 'alleyoop', 'movement', 'defense', 'steals'] as PracticeDrill[])(
    '%s: ten straight makes (and a blaze special) never set fire', (d) => {
      const g = new Game(cfg(d));
      const me = g.teamPlayers(0)[0];
      const gi = g as unknown as Internals;
      for (let i = 0; i < 10; i++) gi.scoreBasket(me, 2, 'layup');
      gi.setFire(me);
      expect(me.fire).toBe(false);
      expect(g.events.some((e) => e.kind === 'fire')).toBe(false);
    });

  it('normal games still catch fire on the third straight make', () => {
    const g = new Game(cfg());
    const me = g.teamPlayers(0)[0];
    const gi = g as unknown as Internals;
    for (let i = 0; i < 3; i++) gi.scoreBasket(me, 2, 'layup');
    expect(me.fire).toBe(true);
  });
});

/** The user takes the ball 3 ft from the rim with turbo held and presses shoot; returns the resulting state. */
function shootAtRim(c: GameConfig) {
  const g = new Game(c);
  live(g);
  const me = g.ball.owner!;
  expect(me.team).toBe(0);
  me.x = hoopX(0) - 3; me.y = HOOP_Y; me.vx = 0; me.vy = 0;
  g.userInput = { ...emptyIntent(), mx: 1, turbo: true, shoot: true, shootHeld: true };
  g.update(1 / 60);
  return me.state;
}

describe('layups drill: lay it in, no dunk', () => {
  it('a shot at the rim in the layups drill is a layup', () => {
    expect(shootAtRim(cfg('layups'))).toBe('layup');
  });
  it('the same shot still dunks in other drills and normal games', () => {
    expect(shootAtRim(cfg('passing'))).toBe('dunk');
    const n = new Game(cfg());
    expect(n.dunkRange(n.teamPlayers(0)[0], true)).toBeGreaterThan(3);
  });
});
