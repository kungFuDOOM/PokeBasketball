import { describe, expect, it } from 'vitest';
import { COURTS } from '../data/courts';
import { POKEMON, POSITIONS, type Mon } from '../data/pokemon';
import { Game } from '../game/game';
import { emptyIntent, type GameEvent, type Intent, type Player, type TeamDef } from '../game/types';
import { createWatcher } from './watcher';
import { initialState, reduce, STEPS } from './steps';

const by = (p: string) => POKEMON.filter((m) => m.pos === p).sort((a, b) => b.ovr - a.ovr);
const roster = POSITIONS.map((p) => by(p)[0]);
const court = Object.values(COURTS)[0];
const team = (name: string, r: Mon[], human: boolean): TeamDef => ({ name, abbr: name.slice(0, 3).toUpperCase(), color: '#e33', color2: '#222', roster: r, human });

/** Headless user-vs-CPU game, advanced until play is live. */
function liveGame(): Game {
  const g = new Game({ home: team('User', roster, true), away: team('Bot', roster, false), quarterLen: 60, difficulty: 'rookie', court, seed: 7 });
  for (let n = 0; g.phase !== 'live' && n < 2000; n++) {
    g.update(1 / 60);
    g.events.length = 0;
    g.sfx.length = 0;
  }
  expect(g.phase).toBe('live');
  expect(g.user).not.toBeNull();
  return g;
}

const stick = (mx: number, my = 0): Intent => ({ ...emptyIntent(), mx, my });
const user = (g: Game) => g.user!;
const mate = (g: Game) => g.players.find((p) => p.team === user(g).team && p !== user(g))!;
const foe = (g: Game) => g.players.find((p) => p.team !== user(g).team)!;

/** Puts the ball in `to`'s hands as if a pass just landed this frame. */
function land(g: Game, to: Player) {
  g.ball.mode = 'held';
  g.ball.owner = to;
  g.ball.pass = null;
  to.lastCatch = g.time;
}

describe('tutorial watcher', () => {
  it('reports movement only while the stick is pushed', () => {
    const g = liveGame();
    const w = createWatcher();
    const u = user(g);
    u.vx = 12;
    u.vy = 0;
    expect(w(g, [], stick(0), 0.5)).not.toContainEqual(expect.objectContaining({ type: 'moved' }));
    const s = w(g, [], stick(1), 0.5);
    expect(s).toContainEqual({ type: 'moved', dist: 6 });
  });

  it('reports a completed pass thrown by the user, not one thrown by a teammate', () => {
    const g = liveGame();
    const w = createWatcher();
    const u = user(g);
    const m = mate(g);
    g.ball.mode = 'pass';
    g.ball.pass = { from: u, to: m, oop: false, t: 0, speed: 40, tested: new Set() } as unknown as typeof g.ball.pass;
    expect(w(g, [], stick(0), 1 / 60)).not.toContainEqual(expect.objectContaining({ kind: 'pass' }));
    land(g, m);
    expect(w(g, [], stick(0), 1 / 60)).toContainEqual({ type: 'event', kind: 'pass', byUser: true });
    // Only once.
    expect(w(g, [], stick(0), 1 / 60)).not.toContainEqual(expect.objectContaining({ kind: 'pass' }));

    // Teammate-to-teammate pass: no signal.
    const w2 = createWatcher();
    const others = g.players.filter((p) => p.team === u.team && p !== u);
    g.ball.mode = 'pass';
    g.ball.pass = { from: others[0], to: others[1], oop: false, t: 0, speed: 40, tested: new Set() } as unknown as typeof g.ball.pass;
    w2(g, [], stick(0), 1 / 60);
    land(g, others[1]);
    expect(w2(g, [], stick(0), 1 / 60)).not.toContainEqual(expect.objectContaining({ kind: 'pass' }));
  });

  it('does not count an intercepted pass', () => {
    const g = liveGame();
    const w = createWatcher();
    const u = user(g);
    g.ball.mode = 'pass';
    g.ball.pass = { from: u, to: mate(g), oop: false, t: 0, speed: 40, tested: new Set() } as unknown as typeof g.ball.pass;
    w(g, [], stick(0), 1 / 60);
    land(g, foe(g));
    expect(w(g, [], stick(0), 1 / 60)).not.toContainEqual(expect.objectContaining({ kind: 'pass' }));
  });

  it('maps score / release / special / steal events with byUser', () => {
    const g = liveGame();
    const w = createWatcher();
    const u = user(g);
    const f = foe(g);
    const m = mate(g);
    const events: GameEvent[] = [
      { kind: 'release', player: u, grade: 'perfect' },
      { kind: 'score', player: u, points: 2, how: 'dunk' },
      { kind: 'score', player: m, points: 2, how: 'jump' },
      { kind: 'special', player: u, hits: [] },
      { kind: 'steal', player: u, victim: f },
      { kind: 'steal', player: f, victim: u },
      { kind: 'sub', out: u, in: m },
    ];
    const s = w(g, events, stick(0), 1 / 60).filter((x) => x.type === 'event');
    expect(s).toEqual([
      { type: 'event', kind: 'release', byUser: true },
      { type: 'event', kind: 'score', byUser: true, how: 'dunk' },
      { type: 'event', kind: 'score', byUser: false, how: 'jump' },
      { type: 'event', kind: 'special', byUser: true },
      { type: 'event', kind: 'steal', byUser: true },
      { type: 'event', kind: 'steal', byUser: false },
    ]);
  });

  it('reports defending time only while the other team has the ball in live play', () => {
    const g = liveGame();
    const w = createWatcher();
    const ut = user(g).team;
    g.offense = ut;
    expect(w(g, [], stick(0), 0.1)).not.toContainEqual(expect.objectContaining({ type: 'defending' }));
    g.offense = ut === 0 ? 1 : 0;
    expect(w(g, [], stick(0), 0.1)).toContainEqual({ type: 'defending', dt: 0.1 });
    g.phase = 'dead';
    expect(w(g, [], stick(0), 0.1)).not.toContainEqual(expect.objectContaining({ type: 'defending' }));
  });

  it('never mutates the game', () => {
    const g = liveGame();
    const w = createWatcher();
    const snap = () =>
      JSON.stringify({
        ball: { ...g.ball, owner: g.ball.owner?.id, shot: null, pass: null },
        players: g.players.map((p) => [p.x, p.y, p.vx, p.vy, p.human, p.lastCatch, p.lastPasser?.id, p.state]),
        score: g.score, offense: g.offense, phase: g.phase, time: g.time, users: g.users.map((u) => u?.id),
      });
    const events: GameEvent[] = [{ kind: 'release', player: user(g), grade: 'good' }];
    const before = snap();
    const evBefore = JSON.stringify(events.map((e) => e.kind));
    for (let i = 0; i < 30; i++) w(g, events, stick(1, 0.5), 1 / 60);
    expect(snap()).toBe(before);
    expect(JSON.stringify(events.map((e) => e.kind))).toBe(evBefore);
  });

  it('drives the step reducer through a real headless game without errors', () => {
    const g = liveGame();
    const w = createWatcher();
    let st = initialState();
    const it = stick(1, 0.3);
    for (let n = 0; n < 600; n++) {
      g.userInput = it;
      g.update(1 / 60);
      for (const s of w(g, g.events, it, 1 / 60)) st = reduce(st, s);
      g.events.length = 0;
      g.sfx.length = 0;
    }
    // Holding the stick for ten seconds completes the move step.
    expect(st.index).toBeGreaterThanOrEqual(STEPS.findIndex((s) => s.id === 'pass'));
  });
});
