import { describe, expect, it } from 'vitest';
import {
  DEFENSE_GOAL_S,
  MOVE_GOAL_FT,
  STEPS,
  currentStep,
  hintFor,
  initialState,
  reduce,
  type Signal,
  type TutorialState,
} from './steps';

const ev = (kind: Extract<Signal, { type: 'event' }>['kind'], extra: Partial<Extract<Signal, { type: 'event' }>> = {}): Signal => ({
  type: 'event',
  kind,
  byUser: true,
  ...extra,
});

/** The signal that completes each step in one go. */
const completing: Record<string, Signal> = {
  move: { type: 'moved', dist: MOVE_GOAL_FT },
  pass: ev('pass'),
  shoot: ev('release'),
  dunk: ev('score', { how: 'dunk' }),
  special: ev('special'),
  defense: { type: 'defending', dt: DEFENSE_GOAL_S },
  steal: ev('steal'),
};

const at = (id: string): TutorialState => {
  const index = STEPS.findIndex((s) => s.id === id);
  return { ...initialState(), index };
};

describe('tutorial steps', () => {
  it('has the steps in order', () => {
    expect(STEPS.map((s) => s.id)).toEqual(['move', 'pass', 'shoot', 'dunk', 'special', 'defense', 'steal']);
  });

  it('advances only on the right signal for every step', () => {
    for (const step of STEPS) {
      const s = at(step.id);
      for (const [id, sig] of Object.entries(completing)) {
        const next = reduce(s, sig);
        if (id === step.id) expect(next.index, `${id} completes ${step.id}`).toBe(s.index + 1);
        else expect(next.index, `${id} should not complete ${step.id}`).toBe(s.index);
      }
    }
  });

  it('ignores events not made by the user', () => {
    const s = at('steal');
    expect(reduce(s, ev('steal', { byUser: false }))).toBe(s);
    expect(reduce(at('pass'), ev('pass', { byUser: false })).index).toBe(at('pass').index);
  });

  it('shoot accepts a non-dunk score but not a dunk; dunk needs how=dunk', () => {
    expect(reduce(at('shoot'), ev('score', { how: 'jump' })).index).toBe(at('shoot').index + 1);
    expect(reduce(at('shoot'), ev('score', { how: 'dunk' })).index).toBe(at('shoot').index);
    expect(reduce(at('dunk'), ev('score', { how: 'layup' })).index).toBe(at('dunk').index);
  });

  it('accumulates movement and defending time across frames', () => {
    let s = initialState();
    s = reduce(s, { type: 'moved', dist: MOVE_GOAL_FT / 2 });
    expect(s.index).toBe(0);
    expect(s.progress).toBeCloseTo(MOVE_GOAL_FT / 2);
    s = reduce(s, { type: 'moved', dist: -5 });
    expect(s.progress).toBeCloseTo(MOVE_GOAL_FT / 2);
    s = reduce(s, { type: 'moved', dist: MOVE_GOAL_FT / 2 });
    expect(currentStep(s)?.id).toBe('pass');
    expect(s.progress).toBe(0);

    let d = at('defense');
    for (let i = 0; i < 10; i++) d = reduce(d, { type: 'defending', dt: DEFENSE_GOAL_S / 20 });
    expect(currentStep(d)?.id).toBe('defense');
    for (let i = 0; i < 11; i++) d = reduce(d, { type: 'defending', dt: DEFENSE_GOAL_S / 20 });
    expect(currentStep(d)?.id).toBe('steal');
  });

  it('skipStep moves to the next step and resets progress', () => {
    let s = reduce(initialState(), { type: 'moved', dist: 3 });
    s = reduce(s, { type: 'skipStep' });
    expect(currentStep(s)?.id).toBe('pass');
    expect(s.progress).toBe(0);
    expect(s.done).toBe(false);
  });

  it('skipAll finishes immediately and marks skipped', () => {
    const s = reduce(initialState(), { type: 'skipAll' });
    expect(s.done).toBe(true);
    expect(s.skipped).toBe(true);
    expect(currentStep(s)).toBeNull();
  });

  it('completes after the last step', () => {
    let s = initialState();
    for (const step of STEPS) s = reduce(s, completing[step.id]);
    expect(s.done).toBe(true);
    expect(s.skipped).toBe(false);
    expect(s.index).toBe(STEPS.length);
    expect(currentStep(s)).toBeNull();

    let k = initialState();
    for (let i = 0; i < STEPS.length; i++) k = reduce(k, { type: 'skipStep' });
    expect(k.done).toBe(true);
    expect(k.skipped).toBe(false);
  });

  it('no-ops once done', () => {
    const done = reduce(initialState(), { type: 'skipAll' });
    for (const sig of [...Object.values(completing), { type: 'skipStep' } as Signal, { type: 'skipAll' } as Signal]) {
      expect(reduce(done, sig)).toBe(done);
    }
  });

  it('does not mutate the input state', () => {
    const s = initialState();
    const snap = { ...s };
    reduce(s, { type: 'moved', dist: 100 });
    reduce(s, { type: 'skipAll' });
    expect(s).toEqual(snap);
  });

  it('hints differ for keys vs touch and are non-empty', () => {
    for (const step of STEPS) {
      const k = hintFor(step.id, 'keys');
      const t = hintFor(step.id, 'touch');
      expect(k.length).toBeGreaterThan(0);
      expect(t.length).toBeGreaterThan(0);
      expect(k).not.toBe(t);
    }
    expect(hintFor('pass', 'keys')).toMatch(/K/);
    expect(hintFor('pass', 'touch')).toMatch(/A/);
  });
});
