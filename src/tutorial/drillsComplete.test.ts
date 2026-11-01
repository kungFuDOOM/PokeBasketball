import { describe, expect, it } from 'vitest';
import { POKEMON, POSITIONS } from '../data/pokemon';
import { Game } from '../game/game';
import { movementSpot, reachedSpot } from '../game/practice';
import { HOOP_Y, emptyIntent, hoopX, type GameConfig, type GameEvent, type Intent, type TeamDef } from '../game/types';
import { DRILLS, DRILL_IDS, type DrillId } from './drills';
import { activeTag, runPos, startRun, startRunAll, step, type DrillOutcome, type RunnerAction, type RunnerState } from './runner';
import { createWatcher } from './watcher';

// Plays every training drill to completion in a real practice Game, wired like src/screens/tutorial.ts's
// onFrame (restage on a new drill, tick, watcher signals with the frame's intent, movement cones), with
// scripted user input. Regression for "Jump Shots stopped counting after 3 makes and I caught fire":
// a long run of makes must keep counting, never set fire, and end on a results card.

// Fixed rosters (tutorialConfig drafts randomly, which would make these runs differ): the best mon at each
// position for the user, the next best for the CPU, like the other tutorial game tests.
const by = (p: string) => POKEMON.filter((m) => m.pos === p).sort((a, b) => b.ovr - a.ovr);
const MINE = POSITIONS.map((p) => by(p)[0]);
const THEIRS = POSITIONS.map((p) => by(p)[1]);
const team = (name: string, roster: TeamDef['roster'], human: boolean): TeamDef =>
  ({ name, abbr: name.slice(0, 3).toUpperCase(), color: '#e33', color2: '#222', roster, human });
const cfgFor = (drill: DrillId): GameConfig => ({
  home: team('You', MINE, true),
  away: team('Gym', THEIRS, false),
  quarterLen: 600, difficulty: 'rookie', seed: 20261031, stamina: false, autoSwitch: true, practice: true, drill,
});

const DT = 1 / 60;
type Script = (g: Game, s: RunnerState, frame: number) => Intent;

/** Jump shots: alternate a free-throw-line jumper with a turbo drive into the inner mid-range ring (11 ft). */
function jumpShooter(): Script {
  let rep = 0;
  let wasShooting = false;
  return (g, s) => {
    const it = emptyIntent();
    const u = g.user;
    if (!u || s.phase !== 'active' || g.phase !== 'live') return it;
    // The best finishers dunk from furthest out: give every user player elite inside scoring.
    for (const p of g.teamPlayers(0)) p.r.ins = 99;
    if (u.state === 'shoot') {
      wasShooting = true;
      return { ...it, shootHeld: u.meter < 0.8 }; // let go at the top: a green release
    }
    if (wasShooting) { wasShooting = false; rep++; }
    if (g.ball.owner !== u || u.state !== 'free') return it;
    const drive = rep % 2 === 1;
    // Every rep shoots from a ring: the free-throw line (mid ring, 15 ft) or the inner mid ring (11 ft).
    u.x = hoopX(0) - (drive ? 11 : 15); u.y = HOOP_Y;
    return { ...it, shoot: true, shootHeld: true, turbo: drive, mx: drive ? 1 : 0 };
  };
}

/** Layups: take the ball to the rim and go up. */
const layupMaker: Script = (g, s) => {
  const u = g.user;
  if (!u || s.phase !== 'active' || g.phase !== 'live' || g.ball.owner !== u || u.state !== 'free') return emptyIntent();
  u.x = hoopX(0) - 3; u.y = HOOP_Y;
  return { ...emptyIntent(), mx: 1, shoot: true, shootHeld: true };
};

/** Movement: walk straight to the current cone. */
const coneRunner: Script = (g, s) => {
  const u = g.user;
  const c = u && s.phase === 'active' ? movementSpot(s.stats.reps, 0) : null;
  if (!u || !c) return emptyIntent();
  const dx = c.x - u.x;
  const dy = c.y - u.y;
  const d = Math.hypot(dx, dy) || 1;
  const k = Math.min(1, (20 * DT) / d);
  u.x += dx * k; u.y += dy * k;
  return { ...emptyIntent(), mx: dx / d, my: dy / d };
};

/** Passing: tap pass whenever the user has the ball (one press, then let go). */
const passer: Script = (g, s, frame) => {
  const u = g.user;
  const pass = !!u && s.phase === 'active' && g.phase === 'live' && g.ball.owner === u && frame % 2 === 0;
  return { ...emptyIntent(), pass };
};

/** Steals: stay on the dribbler's hip and swipe. */
const thief: Script = (g, s) => {
  const u = g.user;
  const o = g.ball.owner;
  if (!u || !o || o.team === 0 || s.phase !== 'active' || g.phase !== 'live') return emptyIntent();
  u.x = o.x - 1.5; u.y = o.y;
  return { ...emptyIntent(), steal: true };
};

const idle: Script = () => emptyIntent();

const scripts: Record<DrillId, () => Script> = {
  movement: () => coneRunner,
  layups: () => layupMaker,
  jumpshots: jumpShooter,
  passing: () => passer,
  defense: () => idle,
  steals: () => thief,
};

interface Played {
  state: RunnerState;
  results: DrillOutcome[];
  drills: DrillId[];
  finished: { exited: boolean; outcomes: DrillOutcome[] } | null;
  /** Every game event, in order. */
  events: GameEvent[];
  /** Strip tags seen while each drill was active. */
  tags: string[];
}

/** Drives a real Game + runner + watcher like the tutorial screen does, pressing Next on every results card. */
function play(first: ReturnType<typeof startRun>, maxFrames = 60 * 500): Played {
  const out: Played = { state: first.state, results: [], drills: [], finished: null, events: [], tags: [] };
  const game = new Game(cfgFor(first.state.queue[0]));
  const watch = createWatcher();
  let staged = 0;
  let script = scripts[first.state.queue[0]]();
  const send = (a: RunnerAction) => {
    const r = step(out.state, a);
    out.state = r.state;
    for (const e of r.emits) {
      if (e.kind === 'drill') out.drills.push(e.id);
      if (e.kind === 'result') out.results.push(e.outcome);
      if (e.kind === 'finished') out.finished = { exited: e.exited, outcomes: e.outcomes };
    }
  };
  for (const e of first.emits) if (e.kind === 'drill') out.drills.push(e.id);
  staged = out.drills.length; // the config already staged the first drill
  for (let n = 0; n < maxFrames && !out.state.finished; n++) {
    const s = out.state;
    if (out.drills.length > staged) {
      game.setDrill(s.queue[s.index]);
      staged = out.drills.length;
      script = scripts[s.queue[s.index]]();
    }
    if (s.phase === 'intro') send({ type: 'start' });
    const intent = script(game, out.state, n);
    game.userInput = intent;
    game.update(DT);
    send({ type: 'tick', dt: DT });
    for (const signal of watch(game, game.events, intent, DT)) send({ type: 'signal', signal });
    const t = out.state;
    if (!t.finished && t.queue[t.index] === 'movement' && t.phase === 'active' && game.user && reachedSpot(game.user, t.stats.reps, 0)) {
      send({ type: 'signal', signal: { type: 'spot' } });
    }
    if (out.state.phase === 'active') out.tags.push(activeTag(out.state));
    out.events.push(...game.events);
    game.events.length = 0;
    game.sfx.length = 0;
    if (out.state.phase === 'done' && !out.state.finished) send({ type: 'next' });
  }
  return out;
}

const userScores = (p: Played) => p.events.filter((e): e is Extract<GameEvent, { kind: 'score' }> => e.kind === 'score' && e.player.team === 0);

describe('Jump Shots: every make counts, all drill long', () => {
  it('a long streak of makes (jumpers and turbo drives into the mid ring) all count and the drill ends on its results card', () => {
    const p = play(startRun('jumpshots'));
    const made = userScores(p);
    // Well past the old stall at 3 makes.
    expect(made.length).toBeGreaterThanOrEqual(10);
    // No dunks and no fire in the drill: every make is a jumper and every one counted.
    expect(made.filter((e) => e.how !== 'jump')).toEqual([]);
    expect(p.events.some((e) => e.kind === 'fire')).toBe(false);
    expect(p.results).toHaveLength(1);
    expect(p.results[0]).toMatchObject({ id: 'jumpshots', skipped: false });
    expect(p.results[0].score).toBeGreaterThanOrEqual(made.length * 100);
    expect(p.results[0].stars).toBe(3);
    expect(p.finished?.exited).toBe(false);
    // The strip counted each make as it landed.
    expect(p.tags).toContain(` 0:01 · ${made.length} made`);
  });

  it('a turbo drive into the mid-range ring is a jump shot in the drill but still a dunk in normal games', () => {
    const shootFrom11 = (c: GameConfig) => {
      const g = new Game(c);
      for (let i = 0; i < 120 && g.phase !== 'live'; i++) g.update(DT);
      const me = g.ball.owner!;
      me.r.ins = 99;
      me.x = hoopX(0) - 11; me.y = HOOP_Y; me.vx = 0; me.vy = 0;
      g.userInput = { ...emptyIntent(), mx: 1, turbo: true, shoot: true, shootHeld: true };
      g.update(DT);
      return me.state;
    };
    expect(shootFrom11(cfgFor('jumpshots'))).toBe('shoot');
    // Free practice (no drill staged) runs the normal shot rules: the same drive dunks.
    expect(shootFrom11({ ...cfgFor('jumpshots'), drill: undefined })).toBe('dunk');
  });
});

describe('every scored drill plays to its goal and shows results', () => {
  it.each(DRILL_IDS.filter((id) => DRILLS[id].repTarget !== null))('%s: reaches its rep target before time runs out', (id) => {
    const p = play(startRun(id));
    const target = DRILLS[id].repTarget!;
    expect(p.results).toHaveLength(1);
    expect(p.results[0]).toMatchObject({ id, skipped: false });
    expect(p.results[0].stars).toBeGreaterThanOrEqual(1);
    // Done by reps, not the clock, and the strip ticked through every rep up to the goal.
    expect(p.tags.some((t) => t.endsWith(` · ${target - 1}/${target}`))).toBe(true);
    expect(p.tags.some((t) => t.startsWith(' 0:00'))).toBe(false);
  });

  it('layups: makes keep counting past three (no fire), then the results card', () => {
    const p = play(startRun('layups'));
    const made = userScores(p);
    expect(made.length).toBeGreaterThanOrEqual(10);
    expect(made.every((e) => e.how === 'layup')).toBe(true);
    expect(p.events.some((e) => e.kind === 'fire')).toBe(false);
    expect(p.results).toHaveLength(1);
    expect(p.results[0]).toMatchObject({ id: 'layups', skipped: false, score: made.length * 2, stars: 3 });
  });

  it('defense: the timed drill runs its clock out and shows results', () => {
    const p = play(startRun('defense'));
    expect(p.results).toHaveLength(1);
    expect(p.results[0]).toMatchObject({ id: 'defense', skipped: false });
    // Seconds on defense kept counting through the drill (the score itself can be 0 if the CPU scores a lot).
    expect(p.state.stats.elapsed).toBe(DRILLS.defense.timeLimit);
    expect(p.state.stats.defendS).toBeGreaterThan(DRILLS.defense.timeLimit / 2);
  });

  it('Run all: every drill completes with a real result, then the run finishes', () => {
    const p = play(startRunAll(), 60 * 900);
    expect(p.drills).toEqual([...DRILL_IDS]);
    expect(p.results.map((r) => r.id)).toEqual([...DRILL_IDS]);
    for (const r of p.results) expect(r.skipped).toBe(false);
    for (const r of p.results) if (r.id !== 'defense') expect(r.stars).toBeGreaterThanOrEqual(1);
    expect(p.finished).toMatchObject({ exited: false });
    expect(p.events.some((e) => e.kind === 'fire')).toBe(false);
  });
});

describe('strip label', () => {
  it('spells out the Run all position so it never reads as a make counter', () => {
    const all = startRunAll().state;
    expect(runPos({ ...all, index: 2 })).toBe('Drill 3/6 · ');
    expect(runPos(startRun('jumpshots').state)).toBe('');
  });
  it('shows makes for the timed shooting drills and reps/target for goal drills', () => {
    const s = (id: DrillId, reps: number) => ({ ...startRun(id).state, phase: 'active' as const, stats: { ...startRun(id).state.stats, reps, elapsed: 15 } });
    expect(activeTag(s('jumpshots', 7))).toBe(' 0:45 · 7 made');
    expect(activeTag(s('layups', 4))).toBe(' 0:30 · 4 made');
    expect(activeTag(s('passing', 3))).toBe(' 0:25 · 3/8');
    expect(activeTag(s('defense', 1))).toBe(' 0:15');
  });
});
