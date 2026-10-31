import { describe, expect, it } from 'vitest';
import { DRILLS, DRILL_IDS, coachLine, type DrillId, type DrillSignal } from './drills';
import {
  COUNTDOWN_S,
  INTRO_S,
  TIP_AFTER_S,
  currentDrill,
  markersFor,
  run,
  startRun,
  startRunAll,
  step,
  timeLeft,
  type RunnerAction,
  type RunnerEmit,
  type RunnerState,
} from './runner';

const tick = (dt: number): RunnerAction => ({ type: 'tick', dt });
const sig = (signal: DrillSignal): RunnerAction => ({ type: 'signal', signal });
const ev = (kind: Extract<DrillSignal, { type: 'event' }>['kind'], extra: object = {}, byUser = true): RunnerAction =>
  sig({ type: 'event', kind, byUser, ...extra });
const times = <T,>(n: number, x: T): T[] => Array.from({ length: n }, () => x);
const coachIds = (emits: RunnerEmit[]) => emits.flatMap((e) => (e.kind === 'coach' ? [e.line] : []));

/** Advances a fresh drill through intro + countdown into 'active'. */
const toActive = (s: RunnerState): RunnerState => {
  const r = run(s, [{ type: 'start' }, tick(COUNTDOWN_S)]);
  expect(r.state.phase).toBe('active');
  return r.state;
};

/** Scripted perfect-ish input per drill. */
const script: Record<DrillId, RunnerAction[]> = {
  movement: [tick(5), ...times(6, sig({ type: 'spot' }))],
  layups: [...times(10, [ev('release'), ev('score', { how: 'layup' })]).flat(), tick(45)],
  jumpshots: [...times(10, [ev('release'), ev('score', { how: 'jump' })]).flat(), tick(60)],
  passing: [tick(5), ...times(8, ev('pass'))],
  defense: [ev('block'), ev('steal'), ...times(30, [sig({ type: 'defending', dt: 1 }), tick(1)]).flat()],
  steals: [tick(5), ...times(3, ev('steal'))],
};

describe('runner phases', () => {
  it('starts in intro with the intro coach line and no markers', () => {
    const { state, emits } = startRun('layups');
    expect(state.phase).toBe('intro');
    expect(currentDrill(state)).toBe('layups');
    expect(emits).toEqual([
      { kind: 'drill', id: 'layups' },
      { kind: 'coach', line: 'layups.intro' },
      { kind: 'markers', markers: [] },
    ]);
    expect(coachLine('layups.intro')).toBe(DRILLS.layups.coach.intro);
  });

  it('intro → countdown after INTRO_S, counting 3,2,1,GO into active', () => {
    let { state } = startRun('passing');
    let r = step(state, tick(INTRO_S - 0.01));
    expect(r.state.phase).toBe('intro');
    r = step(r.state, tick(0.02));
    expect(r.state.phase).toBe('countdown');
    expect(r.emits).toContainEqual({ kind: 'countdown', n: 3 });
    expect(r.emits).toContainEqual({ kind: 'markers', markers: [{ kind: 'passLane' }] });
    const ns: number[] = [];
    state = r.state;
    for (let i = 0; i < 4 * 60 && state.phase === 'countdown'; i++) {
      r = step(state, tick(1 / 60));
      state = r.state;
      for (const e of r.emits) if (e.kind === 'countdown') ns.push(e.n);
    }
    expect(ns).toEqual([2, 1, 0]);
    expect(state.phase).toBe('active');
    expect(state.stats.elapsed).toBe(0);
  });

  it('start skips the intro; ignores signals before active', () => {
    const { state } = startRun('steals');
    const r = run(state, [ev('steal'), { type: 'start' }, ev('steal')]);
    expect(r.state.phase).toBe('countdown');
    expect(r.state.stats.reps).toBe(0);
  });

  it('ignores bad dt and returns the same state for no-op actions', () => {
    const s = toActive(startRun('layups').state);
    for (const dt of [0, -1, NaN, Infinity]) expect(step(s, tick(dt)).state).toBe(s);
    expect(step(s, ev('steal')).state).toBe(s);
    expect(step(s, { type: 'next' }).state).toBe(s);
    expect(step(s, { type: 'start' }).state).toBe(s);
  });
});

describe('active drill', () => {
  it('tracks reps, emits rep lines and advances the movement spot marker', () => {
    const s = toActive(startRun('movement').state);
    expect(markersFor('movement', 'active', s.stats)).toEqual([{ kind: 'spot', index: 0, of: 6 }]);
    const r = step(s, sig({ type: 'spot' }));
    expect(r.state.stats.reps).toBe(1);
    expect(coachIds(r.emits)).toEqual(['movement.rep']);
    expect(r.emits).toContainEqual({ kind: 'markers', markers: [{ kind: 'spot', index: 1, of: 6 }] });
  });

  it('counts attempts without a rep line, and time with ticks', () => {
    const s = toActive(startRun('jumpshots').state);
    const r = run(s, [ev('release'), tick(2)]);
    expect(r.state.stats).toMatchObject({ attempts: 1, reps: 0, elapsed: 2 });
    expect(coachIds(r.emits)).toEqual([]);
    expect(timeLeft(r.state)).toBe(DRILLS.jumpshots.timeLimit - 2);
  });

  it('gives the tip once if no rep lands by TIP_AFTER_S', () => {
    const s = toActive(startRun('steals').state);
    const r = run(s, [tick(TIP_AFTER_S), tick(1), tick(1)]);
    expect(coachIds(r.emits)).toEqual(['steals.tip']);
    const s2 = run(s, [ev('steal'), tick(TIP_AFTER_S + 1)]);
    expect(coachIds(s2.emits)).toEqual(['steals.rep']);
  });

  it('ends at the time limit with a graded result and clamps elapsed', () => {
    const s = toActive(startRun('defense').state);
    const r = run(s, [ev('score', {}, false), tick(100)]);
    expect(r.state.phase).toBe('done');
    expect(r.state.stats.elapsed).toBe(DRILLS.defense.timeLimit);
    expect(r.state.result).toEqual({ id: 'defense', score: 0, stars: 0, skipped: false });
    expect(coachIds(r.emits)).toEqual(['defense.retry']);
    expect(r.emits).toContainEqual({ kind: 'markers', markers: [] });
  });

  it('ends early when the rep target is hit', () => {
    const s = toActive(startRun('steals').state);
    const r = run(s, [tick(5), ...times(3, ev('steal'))]);
    expect(r.state.phase).toBe('done');
    expect(r.state.result).toMatchObject({ id: 'steals', score: 300 + 40 * 5, stars: 3 });
    expect(coachIds(r.emits)).toEqual(['steals.rep', 'steals.rep', 'steals.great']);
  });

  it.each(DRILL_IDS)('%s completes with 3 stars from a scripted run', (id) => {
    const s = toActive(startRun(id).state);
    const r = run(s, script[id]);
    expect(r.state.phase).toBe('done');
    expect(r.state.result).toMatchObject({ id, stars: 3, skipped: false });
    expect(r.emits.filter((e) => e.kind === 'result')).toHaveLength(1);
  });
});

describe('sequencing', () => {
  it('single drill: next finishes the run', () => {
    let s = toActive(startRun('steals').state);
    s = run(s, times(3, ev('steal'))).state;
    const r = step(s, { type: 'next' });
    expect(r.state.finished).toBe(true);
    expect(currentDrill(r.state)).toBeNull();
    expect(r.emits).toContainEqual({ kind: 'finished', exited: false, outcomes: [r.state.outcomes[0]] });
    // Finished runners ignore everything.
    expect(step(r.state, tick(1)).state).toBe(r.state);
  });

  it('retry restarts the same drill from its intro with fresh stats', () => {
    let s = toActive(startRun('passing').state);
    s = run(s, [ev('pass'), tick(40)]).state;
    expect(s.phase).toBe('done');
    const r = step(s, { type: 'retry' });
    expect(r.state.phase).toBe('intro');
    expect(r.state.stats.reps).toBe(0);
    expect(currentDrill(r.state)).toBe('passing');
    expect(coachIds(r.emits)).toEqual(['passing.intro']);
    // Retrying and finishing again replaces the earlier outcome.
    const again = run(toActive(r.state), script.passing).state;
    expect(again.outcomes).toHaveLength(1);
    expect(again.outcomes[0].stars).toBe(3);
  });

  it('Run all advances through all six drills in order', () => {
    let { state } = startRunAll();
    expect(state.runAll).toBe(true);
    const seen: DrillId[] = [];
    let finished: RunnerEmit | undefined;
    for (const id of DRILL_IDS) {
      expect(currentDrill(state)).toBe(id);
      seen.push(id);
      state = run(toActive(state), script[id]).state;
      expect(state.phase).toBe('done');
      const r = step(state, { type: 'next' });
      state = r.state;
      finished = r.emits.find((e) => e.kind === 'finished');
    }
    expect(seen).toEqual([...DRILL_IDS]);
    expect(state.finished).toBe(true);
    expect(state.exited).toBe(false);
    expect(state.outcomes.map((o) => [o.id, o.stars])).toEqual(DRILL_IDS.map((id) => [id, 3]));
    expect(finished).toMatchObject({ kind: 'finished', exited: false });
  });

  it('skip mid-drill records a skipped outcome and moves to the next intro', () => {
    let s = toActive(startRunAll().state);
    s = run(s, [sig({ type: 'spot' })]).state;
    const r = step(s, { type: 'skip' });
    expect(r.state.phase).toBe('intro');
    expect(currentDrill(r.state)).toBe('layups');
    expect(r.state.outcomes).toEqual([{ id: 'movement', score: 0, stars: 0, skipped: true }]);
    expect(r.emits[0]).toEqual({ kind: 'result', outcome: { id: 'movement', score: 0, stars: 0, skipped: true } });
    expect(coachIds(r.emits)).toEqual(['layups.intro']);
  });

  it('skip works in every phase, and from results acts like next', () => {
    const intro = step(startRunAll().state, { type: 'skip' });
    expect(currentDrill(intro.state)).toBe('layups');
    const cd = step(step(startRunAll().state, { type: 'start' }).state, { type: 'skip' });
    expect(currentDrill(cd.state)).toBe('layups');
    let s = run(toActive(startRunAll().state), script.movement).state;
    const fromDone = step(s, { type: 'skip' });
    expect(currentDrill(fromDone.state)).toBe('layups');
    expect(fromDone.state.outcomes[0]).toMatchObject({ id: 'movement', stars: 3, skipped: false });
    // Skipping a retry keeps the earlier real result.
    s = step(s, { type: 'retry' }).state;
    expect(step(s, { type: 'skip' }).state.outcomes[0]).toMatchObject({ id: 'movement', stars: 3, skipped: false });
  });

  it('skipping the last drill finishes the run', () => {
    let { state } = startRunAll();
    for (let i = 0; i < DRILL_IDS.length; i++) state = step(state, { type: 'skip' }).state;
    expect(state.finished).toBe(true);
    expect(state.outcomes.every((o) => o.skipped)).toBe(true);
  });

  it('exit ends the run from any phase and clears markers', () => {
    const active = toActive(startRunAll().state);
    const r = step(active, { type: 'exit' });
    expect(r.state).toMatchObject({ finished: true, exited: true });
    expect(r.emits).toEqual([
      { kind: 'markers', markers: [] },
      { kind: 'finished', exited: true, outcomes: [] },
    ]);
    expect(step(startRun('layups').state, { type: 'exit' }).state.exited).toBe(true);
  });

  it('legacy skip signals map to skip / exit', () => {
    const s = startRunAll().state;
    expect(currentDrill(step(s, sig({ type: 'skipStep' })).state)).toBe('layups');
    expect(step(s, sig({ type: 'skipAll' })).state.exited).toBe(true);
  });
});

describe('markersFor', () => {
  it('shows markers only in countdown/active, per drill', () => {
    const empty = startRun('movement').state.stats;
    expect(markersFor('layups', 'intro', empty)).toEqual([]);
    expect(markersFor('layups', 'done', empty)).toEqual([]);
    expect(markersFor('layups', 'active', empty)).toEqual([{ kind: 'zone', zone: 'layup' }]);
    expect(markersFor('jumpshots', 'active', empty).map((m) => m.kind === 'zone' && m.zone)).toEqual(['mid', 'three']);
    expect(markersFor('defense', 'active', empty)).toEqual([]);
    expect(markersFor('movement', 'active', { ...empty, reps: 6 })).toEqual([]);
    expect(markersFor(null, 'active', empty)).toEqual([]);
  });
});
