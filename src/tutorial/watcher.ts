/**
 * Signal adapter: turns engine state + this frame's GameEvents into tutorial Signals.
 * Strictly read-only: it never writes to the Game, its players, ball or events.
 */
import type { Game } from '../game/game';
import type { GameEvent, Intent, Player } from '../game/types';
import type { Signal } from './drills';

/** Stick deflection below this is treated as idle (no deliberate movement). */
const STICK_DEADZONE = 0.2;

export type Watch = (g: Game, events: readonly GameEvent[], intent: Intent, dt: number) => Signal[];

/**
 * Creates a per-game watcher. It remembers a little of the previous frame (who the user was,
 * the pass in flight) so a completed pass and actions taken just before an auto-switch still count.
 */
export function createWatcher(): Watch {
  let prevUser: Player | null = null;
  let pass: { from: Player; to: Player } | null = null;
  /** The user's teammate going up off a user-team alley-oop, until that dunk scores, misses or is blocked. */
  let oopBy: Player | null = null;

  return (g, events, intent, dt) => {
    const out: Signal[] = [];
    const user = g.user;
    const userTeam = g.viewTeam;
    const isUser = (p: Player | null | undefined) => !!p && (p === user || p === prevUser);
    const ball = g.ball;
    const live = g.phase === 'live';

    // Movement: the user's player covered ground while the stick was pushed.
    if (user && dt > 0 && Math.hypot(intent.mx, intent.my) > STICK_DEADZONE) {
      const dist = Math.hypot(user.vx, user.vy) * dt;
      if (dist > 0) out.push({ type: 'moved', dist });
    }

    // Pass: a pass the user threw reached a teammate (caught this frame).
    if (pass && ball.mode === 'held' && ball.owner === pass.to && pass.to.lastCatch === g.time && pass.to.team === pass.from.team) {
      out.push({ type: 'event', kind: 'pass', byUser: true });
      pass = null;
    } else if (ball.mode !== 'pass') {
      pass = null;
    }
    if (ball.mode === 'pass' && ball.pass && isUser(ball.pass.from)) pass = { from: ball.pass.from, to: ball.pass.to };

    // Defense: the other team has the ball in live play.
    if (live && dt > 0 && user && g.teams[userTeam].human && g.offense !== userTeam) {
      out.push({ type: 'defending', dt });
    }

    for (const e of events) {
      switch (e.kind) {
        case 'score':
          if (oopBy && e.player === oopBy) {
            // An alley-oop finish counts for the user's team (the user threw the lob; auto-switch may or may not
            // have handed them the dunker yet).
            out.push({ type: 'event', kind: 'score', byUser: true, how: e.how, oop: true });
            oopBy = null;
          } else out.push({ type: 'event', kind: 'score', byUser: isUser(e.player), how: e.how });
          break;
        case 'oop':
          if (e.player.team === userTeam && g.teams[userTeam].human) {
            oopBy = e.player;
            out.push({ type: 'event', kind: 'oop', byUser: true });
          }
          break;
        case 'miss':
          if (e.player === oopBy) oopBy = null;
          break;
        case 'release':
        case 'special':
        case 'steal':
        case 'block':
          if (e.kind === 'block' && e.victim === oopBy) oopBy = null;
          out.push({ type: 'event', kind: e.kind, byUser: isUser(e.player) });
          break;
      }
    }

    prevUser = user;
    return out;
  };
}
