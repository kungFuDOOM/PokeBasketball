// Turbo shove tuning: chance cap, the shover's own cooldown, and who can be a target.
import { describe, expect, it } from 'vitest';
import { COURTS } from '../data/courts';
import { POKEMON } from '../data/pokemon';
import { Game, SHOVE_BALL_R, SHOVE_CD, SHOVE_MAX, bestLineup } from './game';
import type { GameConfig, Player, TeamDef } from './types';

const team = (name: string, off: number): TeamDef => {
  const { starters, bench } = bestLineup(POKEMON.slice(off, off + 10));
  return { name, abbr: name.slice(0, 3).toUpperCase(), color: '#3b6fd8', color2: '#16224a', human: false, roster: starters, bench };
};
const cfg: GameConfig = { home: team('Home', 0), away: team('Away', 20), quarterLen: 60, difficulty: 'pro', court: COURTS['Indigo Elite'], stamina: true, seed: 7 };

/** A game with shover on team 0 next to a team-1 handler holding the ball; everyone else far away. */
function setup() {
  const g = new Game(cfg);
  g.players.forEach((q, i) => { q.x = 5 + i * 8; q.y = 2; q.state = 'free'; });
  const shover = g.players.find((q) => q.team === 0)!;
  const handler = g.players.find((q) => q.team === 1)!;
  shover.x = 40; shover.y = 25; handler.x = 42; handler.y = 25;
  g.ball.mode = 'held'; g.ball.owner = handler; g.ball.x = handler.x; g.ball.y = handler.y;
  shover.intent = { ...shover.intent, turbo: true };
  shover.turbo = 1; shover.stealCd = 0; shover.shoveCd = 0;
  const shove = () => { g.events.length = 0; (g as unknown as { trySteal(p: Player): void }).trySteal(shover); return g.events.filter((e) => e.kind === 'shove'); };
  return { g, shover, handler, shove };
}

describe('turbo shove', () => {
  it('caps the chance at 45% and starts a 1.5s shove cooldown', () => {
    const { g, shover, handler, shove } = setup();
    shover.size = 3; handler.size = 0.5; // huge edge: uncapped chance would be far above the cap
    shover.mon = { ...shover.mon, types: ['Fighting'] }; handler.mon = { ...handler.mon, types: ['Rock'] };
    let hits = 0;
    const N = 2000;
    for (let i = 0; i < N; i++) {
      shover.shoveCd = 0; shover.stealCd = 0; shover.turbo = 1; handler.state = 'free'; handler.fx.phase = 0;
      const [e] = shove();
      if (e && e.kind === 'shove' && e.ok) hits++;
    }
    expect(hits / N).toBeLessThan(SHOVE_MAX + 0.04);
    expect(hits / N).toBeGreaterThan(SHOVE_MAX - 0.06);

    shover.shoveCd = 0; shover.stealCd = 0; shover.turbo = 1; handler.state = 'free';
    expect(shove()).toHaveLength(1);
    expect(shover.shoveCd).toBe(SHOVE_CD);
    shover.stealCd = 0; // the swipe cooldown alone would allow another try; the shove cooldown must not
    expect(shove()).toHaveLength(0);
    // The cooldown ticks down with the game clock like stealCd.
    (g as unknown as { movePlayer(p: Player, dt: number): void }).movePlayer(shover, SHOVE_CD + 0.1);
    expect(shover.shoveCd).toBe(0);
  });

  it('only targets the handler or an opponent near the ball; no target costs nothing', () => {
    const { g, shover, handler, shove } = setup();
    expect(g.shoveTarget(shover)).toBe(handler);

    // Loose ball far from everyone: nobody is shovable, even a close opponent.
    g.ball.mode = 'loose'; g.ball.owner = null; g.ball.x = 10; g.ball.y = 40;
    expect(g.shoveTarget(shover)).toBeNull();
    const turboBefore = shover.turbo;
    expect(shove()).toHaveLength(0);
    expect(shover.turbo).toBe(turboBefore);
    expect(shover.shoveCd).toBe(0);
    expect(shover.stealCd).toBe(0);

    // Loose ball within range of the opponent: shovable. Beyond SHOVE_BALL_R: not.
    g.ball.x = handler.x + SHOVE_BALL_R - 0.2; g.ball.y = handler.y;
    expect(g.shoveTarget(shover)).toBe(handler);
    g.ball.x = handler.x + SHOVE_BALL_R + 0.3;
    expect(g.shoveTarget(shover)).toBeNull();

    // Teammates are never targets.
    const mate = g.players.find((q) => q.team === 0 && q !== shover)!;
    mate.x = 41; mate.y = 25; g.ball.mode = 'loose'; g.ball.owner = null; g.ball.x = 41; g.ball.y = 25;
    expect(g.shoveTarget(shover)).not.toBe(mate);
  });
});
