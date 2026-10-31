import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { POKEMON, POSITIONS, type Mon } from '../data/pokemon';
import { Game } from '../game/game';
import { reachedSpot, movementSpot } from '../game/practice';
import { emptyIntent, type GameConfig, type TeamDef } from '../game/types';
import { DRILLS, DRILL_IDS, type DrillId, type DrillSignal, type Stars } from './drills';
import { COUNTDOWN_S, run, startRun, startRunAll, type DrillOutcome, type RunnerAction, type RunnerEmit, type RunnerState } from './runner';
import { DRILL_STARS_KEY, TUTORIAL_DONE_KEY, getBestStars, isTutorialDone, loadBestStars, markTutorialDone, recordDrillStars } from './store';
import { createWatcher } from './watcher';

// Integration-style flow tests (no browser): runner + drills + store (+ a real practice Game for Movement),
// wired the way src/screens/tutorial.ts wires them.

// --- in-memory localStorage -------------------------------------------------------------------------------
const g = globalThis as { localStorage?: Storage };
const original = g.localStorage;
const mem = new Map<string, string>();
const memoryStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, String(v)),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() { return mem.size; },
} as Storage;
beforeEach(() => { mem.clear(); g.localStorage = memoryStorage; });
afterEach(() => { g.localStorage = original; });

/** The only keys the tutorial may ever write: never a franchise, draft, season or settings save. */
const TUTORIAL_KEYS = [TUTORIAL_DONE_KEY, DRILL_STARS_KEY];

// --- scripted input -----------------------------------------------------------------------------------------
const tick = (dt: number): RunnerAction => ({ type: 'tick', dt });
const sig = (signal: DrillSignal): RunnerAction => ({ type: 'signal', signal });
const ev = (kind: Extract<DrillSignal, { type: 'event' }>['kind'], extra: object = {}, byUser = true): RunnerAction =>
  sig({ type: 'event', kind, byUser, ...extra });
const times = <T,>(n: number, x: T): T[] => Array.from({ length: n }, () => x);

/** Scripted "good player" input per drill, played after GO. Each one should earn 3 stars. */
const perfect: Record<DrillId, RunnerAction[]> = {
  movement: [tick(5), ...times(6, sig({ type: 'spot' }))],
  layups: [...times(9, [ev('release'), ev('score', { how: 'layup' })]).flat(), tick(45)],
  jumpshots: [...times(10, [ev('release'), ev('score', { how: 'jump' })]).flat(), tick(60)],
  passing: [tick(5), ...times(8, ev('pass'))],
  defense: [ev('block'), ev('steal'), ...times(30, [sig({ type: 'defending', dt: 1 }), tick(1)]).flat()],
  steals: [tick(5), ...times(3, ev('steal'))],
};

/** A weak attempt per drill: completes (by time or reps) with exactly 1 star. */
const weak: Record<DrillId, RunnerAction[]> = {
  movement: [...times(3, sig({ type: 'spot' })), tick(40)],
  layups: [...times(3, [ev('release'), ev('score', { how: 'dunk' })]).flat(), tick(45)],
  jumpshots: [...times(4, [ev('release'), ev('score', { how: 'jump' })]).flat(), ...times(4, ev('release')), tick(60)],
  passing: [...times(4, ev('pass')), tick(40)],
  defense: [...times(20, [sig({ type: 'defending', dt: 1 }), tick(1)]).flat(), tick(10)],
  steals: [ev('steal'), tick(45)],
};

/**
 * A tiny stand-in for the tutorial screen's emit handling: best stars are recorded on non-skipped results,
 * finishing or exiting marks the tutorial done. Nothing else is persisted.
 */
function harness(first: { state: RunnerState; emits: RunnerEmit[] }) {
  let state = first.state;
  const results: DrillOutcome[] = [];
  const drills: DrillId[] = [];
  let finished: { exited: boolean; outcomes: DrillOutcome[] } | null = null;
  const handle = (emits: RunnerEmit[]) => {
    for (const e of emits) {
      if (e.kind === 'drill') drills.push(e.id);
      if (e.kind === 'result') {
        results.push(e.outcome);
        if (!e.outcome.skipped) recordDrillStars(e.outcome.id, e.outcome.stars);
      }
      if (e.kind === 'finished') {
        finished = { exited: e.exited, outcomes: e.outcomes };
        markTutorialDone();
      }
    }
  };
  handle(first.emits);
  return {
    get state() { return state; },
    results,
    drills,
    get finished() { return finished; },
    send(...actions: RunnerAction[]) {
      const r = run(state, actions);
      state = r.state;
      handle(r.emits);
    },
    /** Skips the intro, counts down to GO, then plays `script`. */
    play(script: readonly RunnerAction[]) {
      this.send({ type: 'start' }, tick(COUNTDOWN_S), ...script);
    },
  };
}

describe('each drill completes and awards stars', () => {
  for (const id of DRILL_IDS) {
    it(`${id}: scripted input → done with 3 stars, saved as best`, () => {
      const h = harness(startRun(id));
      h.play(perfect[id]);
      expect(h.state.phase).toBe('done');
      expect(h.results).toHaveLength(1);
      const o = h.results[0];
      expect(o).toMatchObject({ id, skipped: false, stars: 3 });
      expect(o.score).toBeGreaterThanOrEqual(DRILLS[id].stars[2]);
      expect(getBestStars(id)).toBe(3);
    });

    it(`${id}: a weak attempt still completes with 1 star`, () => {
      const h = harness(startRun(id));
      h.play(weak[id]);
      expect(h.state.phase).toBe('done');
      expect(h.results[0]).toMatchObject({ id, skipped: false, stars: 1 });
      expect(getBestStars(id)).toBe(1);
    });
  }

  it('an idle player times out with 0 stars on every drill', () => {
    for (const id of DRILL_IDS) {
      const h = harness(startRun(id));
      h.play([tick(DRILLS[id].timeLimit)]);
      expect(h.state.phase).toBe('done');
      expect(h.results[0]).toMatchObject({ id, score: 0, stars: 0, skipped: false });
    }
    expect(Object.values(loadBestStars())).toEqual(times(6, 0));
  });

  it('a single drill run finishes after Next with that one outcome and marks the tutorial done', () => {
    const h = harness(startRun('steals'));
    h.play(perfect.steals);
    expect(isTutorialDone()).toBe(false);
    h.send({ type: 'next' });
    expect(h.finished).toEqual({ exited: false, outcomes: [h.results[0]] });
    expect(isTutorialDone()).toBe(true);
  });
});

describe('Run all', () => {
  it('advances through all six drills in order and finishes', () => {
    const h = harness(startRunAll());
    for (const id of DRILL_IDS) {
      expect(h.drills[h.drills.length - 1]).toBe(id);
      expect(h.state.phase).toBe('intro');
      h.play(perfect[id]);
      expect(h.state.phase).toBe('done');
      expect(h.finished).toBeNull();
      h.send({ type: 'next' });
    }
    expect(h.drills).toEqual([...DRILL_IDS]);
    expect(h.finished?.exited).toBe(false);
    expect(h.finished?.outcomes.map((o) => [o.id, o.stars])).toEqual(DRILL_IDS.map((id) => [id, 3]));
    expect(loadBestStars()).toEqual(Object.fromEntries(DRILL_IDS.map((id) => [id, 3])));
    expect(isTutorialDone()).toBe(true);
  });

  it('a retry mid-run replays the same drill and replaces its outcome', () => {
    const h = harness(startRunAll());
    h.play(weak.movement);
    h.send({ type: 'retry' });
    expect(h.drills).toEqual(['movement', 'movement']);
    h.play(perfect.movement);
    h.send({ type: 'next' });
    expect(h.drills[h.drills.length - 1]).toBe('layups');
    expect(h.state.outcomes).toEqual([expect.objectContaining({ id: 'movement', stars: 3 })]);
  });

  it('skipping every drill (intro, countdown, mid-drill, results) still reaches the end', () => {
    const h = harness(startRunAll());
    h.send({ type: 'skip' }); // movement: on the intro
    h.send({ type: 'start' }, tick(1), { type: 'skip' }); // layups: mid-countdown
    h.send({ type: 'start' }, tick(COUNTDOWN_S), tick(3), ev('release'), { type: 'skip' }); // jumpshots: mid-drill
    h.play(perfect.passing);
    h.send({ type: 'skip' }); // passing: on its results card → advances, keeps the real result
    h.send({ type: 'skip' }, { type: 'skip' }); // defense, steals
    expect(h.drills).toEqual([...DRILL_IDS]);
    expect(h.finished?.exited).toBe(false);
    expect(h.finished?.outcomes.map((o) => [o.id, o.skipped])).toEqual([
      ['movement', true], ['layups', true], ['jumpshots', true], ['passing', false], ['defense', true], ['steals', true],
    ]);
    expect(loadBestStars()).toEqual({ movement: 0, layups: 0, jumpshots: 0, passing: 3, defense: 0, steals: 0 });
  });
});

describe('Skip and Exit leave no saved game state', () => {
  const onlyTutorialKeys = () => expect([...mem.keys()].every((k) => TUTORIAL_KEYS.includes(k))).toBe(true);

  it('Exit mid-drill during Run all: no stars recorded, only the tutorial-done flag', () => {
    const h = harness(startRunAll());
    h.send({ type: 'start' }, tick(COUNTDOWN_S), tick(2), sig({ type: 'spot' }), sig({ type: 'spot' }));
    h.send({ type: 'exit' });
    expect(h.finished).toEqual({ exited: true, outcomes: [] });
    expect([...mem.keys()]).toEqual([TUTORIAL_DONE_KEY]);
    expect(mem.has(DRILL_STARS_KEY)).toBe(false);
    // Nothing happens after an exit.
    const before = h.state;
    h.send(tick(60), sig({ type: 'spot' }), { type: 'next' }, { type: 'skip' });
    expect(h.state).toBe(before);
  });

  it('Exit on the intro, the countdown and the results card writes no game saves', () => {
    for (const actions of [
      [] as RunnerAction[],
      [{ type: 'start' }, tick(1)] as RunnerAction[],
      [{ type: 'start' }, tick(COUNTDOWN_S), ...perfect.layups] as RunnerAction[],
    ]) {
      mem.clear();
      const h = harness(startRun('layups'));
      h.send(...actions, { type: 'exit' });
      expect(h.finished?.exited).toBe(true);
      onlyTutorialKeys();
    }
  });

  it('skipped drills never write best stars', () => {
    const h = harness(startRun('defense'));
    h.send({ type: 'start' }, tick(COUNTDOWN_S), ev('block'), ev('steal'), { type: 'skip' });
    expect(h.results).toEqual([{ id: 'defense', score: 0, stars: 0, skipped: true }]);
    expect(mem.has(DRILL_STARS_KEY)).toBe(false);
    onlyTutorialKeys();
  });

  it('a whole Run all with skips and exits touches no franchise, draft, season or settings key', () => {
    mem.set('pokejam.settings', '{"teamName":"Mine"}');
    mem.set('pokejam.franchise.v1', '{"x":1}');
    const snapshot = new Map(mem);
    const h = harness(startRunAll());
    h.play(perfect.movement);
    h.send({ type: 'next' }, { type: 'skip' });
    h.play(perfect.jumpshots);
    h.send({ type: 'exit' });
    for (const [k, v] of snapshot) expect(mem.get(k)).toBe(v);
    expect([...mem.keys()].filter((k) => !snapshot.has(k)).sort()).toEqual([...TUTORIAL_KEYS].sort());
  });
});

describe('best stars persist and never decrease', () => {
  it('a worse retry keeps the best; a better one raises it', () => {
    const play = (id: DrillId, script: RunnerAction[]): Stars => {
      const h = harness(startRun(id));
      h.play(script);
      return h.results[0].stars;
    };
    expect(play('passing', perfect.passing)).toBe(3);
    expect(play('passing', weak.passing)).toBe(1);
    expect(getBestStars('passing')).toBe(3);
    expect(play('passing', [tick(40)])).toBe(0);
    expect(getBestStars('passing')).toBe(3);

    expect(play('steals', weak.steals)).toBe(1);
    expect(getBestStars('steals')).toBe(1);
    expect(play('steals', perfect.steals)).toBe(3);
    expect(getBestStars('steals')).toBe(3);
  });

  it('survives a "reload": stars are read back from storage, not memory', () => {
    const h = harness(startRunAll());
    h.play(weak.movement);
    h.send({ type: 'next' });
    h.play(perfect.layups);
    h.send({ type: 'exit' });
    const raw = mem.get(DRILL_STARS_KEY)!;
    mem.clear();
    mem.set(DRILL_STARS_KEY, raw);
    expect(loadBestStars()).toMatchObject({ movement: 1, layups: 3, jumpshots: 0 });
  });

  it('best stars never decrease over many random runs', () => {
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
    const best = Object.fromEntries(DRILL_IDS.map((id) => [id, 0])) as Record<DrillId, Stars>;
    for (let i = 0; i < 60; i++) {
      const id = DRILL_IDS[Math.floor(rnd() * DRILL_IDS.length)];
      const pick = rnd();
      const script = pick < 0.33 ? perfect[id] : pick < 0.66 ? weak[id] : [tick(DRILLS[id].timeLimit)];
      const h = harness(startRun(id));
      h.play(script);
      const now = loadBestStars();
      for (const d of DRILL_IDS) expect(now[d]).toBeGreaterThanOrEqual(best[d]);
      best[id] = Math.max(best[id], h.results[0].stars) as Stars;
      expect(now).toEqual(best);
    }
  });
});

// --- with a real practice Game ------------------------------------------------------------------------------
const by = (p: string) => POKEMON.filter((m) => m.pos === p).sort((a, b) => b.ovr - a.ovr);
const five = (i: number): Mon[] => POSITIONS.map((p) => by(p)[i]);
const team = (name: string, roster: Mon[], human: boolean): TeamDef =>
  ({ name, abbr: name.slice(0, 3).toUpperCase(), color: '#e33', color2: '#222', roster, human });
const drillCfg = (drill: DrillId): GameConfig => ({
  home: team('You', five(0), true), away: team('Cpu', five(1), false),
  quarterLen: 600, difficulty: 'rookie', seed: 20261031, stamina: false, autoSwitch: true, practice: true, drill,
});

/**
 * Drives a real practice Game through the runner like the tutorial screen's onFrame does: restage on a new drill,
 * tick, feed watcher signals, count cones. `act` may move the user each frame (scripted input).
 */
function playInGame(first: { state: RunnerState; emits: RunnerEmit[] }, act: (g: Game, s: RunnerState) => void, maxFrames = 60 * 400) {
  const game = new Game(drillCfg(first.state.queue[0]));
  const watch = createWatcher();
  const h = harness(first);
  let staged = h.drills.length; // the config already staged the first drill
  const send = (a: RunnerAction) => h.send(a);
  const dt = 1 / 60;
  for (let n = 0; n < maxFrames && !h.state.finished; n++) {
    const s = h.state;
    if (h.drills.length > staged) { game.setDrill(s.queue[s.index]); staged = h.drills.length; }
    if (s.phase === 'intro') send({ type: 'start' });
    act(game, h.state);
    game.update(dt);
    send(tick(dt));
    for (const signal of watch(game, game.events, emptyIntent(), dt)) send(sig(signal));
    const u = game.teams[0].human ? 0 : 1;
    const t = h.state;
    if (!t.finished && t.queue[t.index] === 'movement' && t.phase === 'active' && game.user && reachedSpot(game.user, t.stats.reps, u)) {
      send(sig({ type: 'spot' }));
    }
    game.events.length = 0;
    game.sfx.length = 0;
    if (h.state.phase === 'done' && !h.state.finished) send({ type: 'next' });
  }
  return h;
}

describe('in a real practice game', () => {
  it('Movement: stepping onto each cone completes the drill with stars', () => {
    const h = playInGame(startRun('movement'), (g, s) => {
      // Scripted input: walk the user's player straight to the current cone, ~20 ft/s.
      if (s.phase !== 'active' || !g.user) return;
      const c = movementSpot(s.stats.reps, 0);
      if (!c) return;
      const dx = c.x - g.user.x;
      const dy = c.y - g.user.y;
      const d = Math.hypot(dx, dy);
      const k = Math.min(1, (20 / 60) / (d || 1));
      g.user.x += dx * k;
      g.user.y += dy * k;
    });
    expect(h.finished?.exited).toBe(false);
    expect(h.results).toHaveLength(1);
    expect(h.results[0]).toMatchObject({ id: 'movement', skipped: false });
    expect(h.results[0].stars).toBeGreaterThanOrEqual(2);
    expect(getBestStars('movement')).toBe(h.results[0].stars);
  });

  it('Run all with an idle user advances through all six staged drills and finishes', () => {
    const h = playInGame(startRunAll(), () => {});
    expect(h.drills).toEqual([...DRILL_IDS]);
    expect(h.finished?.exited).toBe(false);
    expect(h.finished?.outcomes.map((o) => o.id)).toEqual([...DRILL_IDS]);
    for (const o of h.finished!.outcomes) expect(o.skipped).toBe(false);
    expect([...mem.keys()].every((k) => TUTORIAL_KEYS.includes(k))).toBe(true);
  });
});
