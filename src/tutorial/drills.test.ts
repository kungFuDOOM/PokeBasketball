import { describe, expect, it } from 'vitest';
import {
  DRILLS,
  DRILL_IDS,
  MAX_LINE,
  applySignal,
  coachLine,
  coachLineId,
  emptyStats,
  goalFor,
  grade,
  gradeStars,
  isComplete,
  isDrillId,
  resultSlot,
  type DrillId,
  type DrillSignal,
  type DrillStats,
} from './drills';

const ev = (
  kind: Extract<DrillSignal, { type: 'event' }>['kind'],
  extra: Partial<Extract<DrillSignal, { type: 'event' }>> = {},
): DrillSignal => ({ type: 'event', kind, byUser: true, ...extra });

const stats = (p: Partial<DrillStats>): DrillStats => ({ ...emptyStats(), ...p });

const run = (id: DrillId, signals: DrillSignal[], elapsed = 0): DrillStats => {
  let st = emptyStats();
  for (const s of signals) st = applySignal(DRILLS[id], st, s);
  return { ...st, elapsed };
};

const times = <T,>(n: number, x: T): T[] => Array.from({ length: n }, () => x);

describe('drill definitions', () => {
  it('has the seven drills in order, keyed by id', () => {
    expect(DRILL_IDS).toEqual(['movement', 'layups', 'jumpshots', 'passing', 'alleyoop', 'defense', 'steals']);
    for (const id of DRILL_IDS) expect(DRILLS[id].id).toBe(id);
  });

  it('every drill has a time limit, ascending star thresholds and short lines', () => {
    for (const id of DRILL_IDS) {
      const d = DRILLS[id];
      expect(d.timeLimit).toBeGreaterThan(0);
      if (d.repTarget !== null) expect(d.repTarget).toBeGreaterThan(0);
      expect(d.stars[0]).toBeGreaterThan(0);
      expect(d.stars[1]).toBeGreaterThan(d.stars[0]);
      expect(d.stars[2]).toBeGreaterThan(d.stars[1]);
      for (const line of [...Object.values(d.coach), d.goal.keys, d.goal.touch]) {
        expect(line.length, `${id}: "${line}"`).toBeGreaterThan(0);
        expect(line.length, `${id}: "${line}"`).toBeLessThanOrEqual(MAX_LINE);
      }
    }
  });

  it('3 stars is reachable and an empty run scores 0 stars', () => {
    const best: Record<DrillId, DrillStats> = {
      movement: run('movement', times(6, { type: 'spot' }), 15),
      layups: run('layups', times(10, ev('score', { how: 'layup' })), 45),
      jumpshots: run('jumpshots', [...times(10, ev('release')), ...times(10, ev('score', { how: 'jump' }))], 60),
      passing: run('passing', times(8, ev('pass')), 20),
      alleyoop: run('alleyoop', [...times(5, ev('oop')), ...times(5, ev('score', { how: 'dunk', oop: true }))], 20),
      defense: run('defense', [{ type: 'defending', dt: 30 }, ev('steal'), ev('block')], 30),
      steals: run('steals', times(3, ev('steal')), 20),
    };
    for (const id of DRILL_IDS) {
      expect(grade(DRILLS[id], best[id]).stars, id).toBe(3);
      expect(grade(DRILLS[id], stats({ elapsed: DRILLS[id].timeLimit })), id).toEqual({ score: 0, stars: 0 });
    }
  });

  it('goal text differs by input and isDrillId guards ids', () => {
    expect(goalFor('passing', 'keys')).toContain('K');
    expect(goalFor('passing', 'touch')).toContain('A');
    expect(isDrillId('steals')).toBe(true);
    expect(isDrillId('dunk')).toBe(false);
    expect(isDrillId(null)).toBe(false);
  });
});

describe('counting signals', () => {
  it('ignores signals a drill does not care about (same object back)', () => {
    const st = emptyStats();
    expect(applySignal(DRILLS.movement, st, ev('pass'))).toBe(st);
    expect(applySignal(DRILLS.passing, st, { type: 'moved', dist: 5 })).toBe(st);
    expect(applySignal(DRILLS.steals, st, ev('steal', { byUser: false }))).toBe(st);
    expect(applySignal(DRILLS.layups, st, ev('score', { how: 'jump' }))).toBe(st);
    expect(applySignal(DRILLS.jumpshots, st, ev('score', { how: 'layup' }))).toBe(st);
  });

  it('counts reps and attempts for shooting drills', () => {
    const st = run('jumpshots', [ev('release'), ev('release'), ev('score', { how: 'jump' })]);
    expect(st).toMatchObject({ reps: 1, attempts: 2 });
    expect(run('layups', [ev('score', { how: 'dunk' })]).reps).toBe(1);
  });

  it('defense tracks time, stops and points allowed', () => {
    const st = run('defense', [
      { type: 'defending', dt: 1.5 },
      { type: 'defending', dt: 1.5 },
      ev('block'),
      ev('score', { byUser: false, how: 'jump' }),
      ev('score', { byUser: true, how: 'jump' }),
    ]);
    expect(st).toMatchObject({ defendS: 3, reps: 1, allowed: 2 });
  });

  it('completes on rep target or time limit', () => {
    const d = DRILLS.steals;
    expect(isComplete(d, stats({ reps: 2, elapsed: 10 }))).toBe(false);
    expect(isComplete(d, stats({ reps: 3, elapsed: 10 }))).toBe(true);
    expect(isComplete(d, stats({ reps: 0, elapsed: d.timeLimit }))).toBe(true);
    // Time-only drills never end early on reps.
    expect(isComplete(DRILLS.layups, stats({ reps: 99, elapsed: 1 }))).toBe(false);
  });
});

describe('scoring', () => {
  it('movement: 100 per spot, time bonus only when all spots hit', () => {
    expect(DRILLS.movement.score(stats({ reps: 3, elapsed: 40 }))).toBe(300);
    expect(DRILLS.movement.score(stats({ reps: 5, elapsed: 10 }))).toBe(500);
    expect(DRILLS.movement.score(stats({ reps: 6, elapsed: 30 }))).toBe(700);
    // Elapsed past the limit gives no negative bonus.
    expect(DRILLS.movement.score(stats({ reps: 6, elapsed: 99 }))).toBe(600);
  });

  it('layups: 2 per make', () => {
    expect(DRILLS.layups.score(stats({ reps: 7, attempts: 12 }))).toBe(14);
  });

  it('jump shots reward accuracy', () => {
    expect(DRILLS.jumpshots.score(stats({ reps: 4, attempts: 4 }))).toBe(600);
    expect(DRILLS.jumpshots.score(stats({ reps: 4, attempts: 8 }))).toBe(500);
    expect(DRILLS.jumpshots.score(stats({ reps: 0, attempts: 0 }))).toBe(0);
  });

  it('passing and steals: time bonus after the rep target', () => {
    expect(DRILLS.passing.score(stats({ reps: 8, elapsed: 20 }))).toBe(1100);
    expect(DRILLS.passing.score(stats({ reps: 7, elapsed: 20 }))).toBe(700);
    expect(DRILLS.steals.score(stats({ reps: 3, elapsed: 25 }))).toBe(400);
  });

  it('defense never goes negative', () => {
    expect(DRILLS.defense.score(stats({ defendS: 20, reps: 1 }))).toBe(300);
    expect(DRILLS.defense.score(stats({ defendS: 2, allowed: 10 }))).toBe(0);
  });

  it('scores are always non-negative integers', () => {
    const weird = [stats({ elapsed: Number.NaN }), stats({ defendS: 1.234 }), stats({ reps: 1, attempts: 3 })];
    for (const id of DRILL_IDS) {
      for (const st of weird) {
        const s = DRILLS[id].score(st);
        expect(Number.isInteger(s), `${id} ${s}`).toBe(true);
        expect(s).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('star grading', () => {
  const t = [10, 20, 30] as const;
  it('grades at and around each threshold', () => {
    expect(gradeStars(0, t)).toBe(0);
    expect(gradeStars(9.99, t)).toBe(0);
    expect(gradeStars(10, t)).toBe(1);
    expect(gradeStars(19, t)).toBe(1);
    expect(gradeStars(20, t)).toBe(2);
    expect(gradeStars(30, t)).toBe(3);
    expect(gradeStars(1e9, t)).toBe(3);
  });

  it('treats NaN/negative as 0 stars', () => {
    expect(gradeStars(Number.NaN, t)).toBe(0);
    expect(gradeStars(-5, t)).toBe(0);
  });

  it('grade() matches each drill thresholds exactly', () => {
    const d = DRILLS.steals; // thresholds 100/250/400
    expect(grade(d, stats({ reps: 1, elapsed: 45 }))).toEqual({ score: 100, stars: 1 });
    expect(grade(d, stats({ reps: 2, elapsed: 45 }))).toEqual({ score: 200, stars: 1 });
    expect(grade(d, stats({ reps: 3, elapsed: 45 }))).toEqual({ score: 300, stars: 2 });
  });
});

describe('coach lines', () => {
  it('resolves ids and picks a result slot from stars', () => {
    expect(coachLineId('layups', 'intro')).toBe('layups.intro');
    expect(coachLine('layups.intro')).toBe(DRILLS.layups.coach.intro);
    expect(resultSlot(0)).toBe('retry');
    expect(resultSlot(1)).toBe('good');
    expect(resultSlot(2)).toBe('good');
    expect(resultSlot(3)).toBe('great');
  });
});
