import { describe, expect, it } from 'vitest';
import { POKEMON } from '../data/pokemon';
import { ballPoints, beginShot, isMoneyBall, newContest, pause, rackPreview, recordShot, resume, start, summarize, tick } from './contest';
import { CONTEST_SECONDS, MAX_SCORE, TOTAL_BALLS, type RackId, type ShotResult } from './types';

const mon = POKEMON[0];
const racks: RackId[] = [0, 1, 2, 3, 4];

function rackTotal(rack: RackId, moneyRack: RackId, result: ShotResult = 'make') {
  let n = 0;
  for (let i = 0; i < 5; i++) n += ballPoints(rack, i, moneyRack, result);
  return n;
}

function play(moneyRack: RackId, results: ShotResult[]) {
  const s = newContest(mon, moneyRack);
  start(s);
  for (const r of results) recordShot(s, r);
  return s;
}

describe('scoring', () => {
  it('money balls: the last ball of every rack, or all of the chosen rack', () => {
    for (const r of racks) for (const m of racks) for (let i = 0; i < 5; i++) expect(isMoneyBall(r, i, m)).toBe(r === m || i === 4);
  });
  it('ball points: 0 miss, 2 money make, 1 otherwise', () => {
    expect(ballPoints(0, 0, 2, 'miss')).toBe(0);
    expect(ballPoints(0, 4, 2, 'miss')).toBe(0);
    expect(ballPoints(0, 0, 2, 'make')).toBe(1);
    expect(ballPoints(0, 4, 2, 'make')).toBe(2);
    expect(ballPoints(2, 0, 2, 'make')).toBe(2);
  });
  it('normal rack = 6, chosen rack = 10', () => {
    expect(rackTotal(0, 2)).toBe(6);
    expect(rackTotal(2, 2)).toBe(10);
  });
  it('all 25 makes = 34 for every money rack; all misses = 0', () => {
    for (const m of racks) {
      expect(summarize(play(m, Array(25).fill('make'))).score).toBe(MAX_SCORE);
      expect(summarize(play(m, Array(25).fill('miss'))).score).toBe(0);
    }
    expect(MAX_SCORE).toBe(34);
  });
  it('rackPreview marks the chosen rack 10 and the rest 6, always summing to 34', () => {
    expect(rackPreview(2)).toEqual([6, 6, 10, 6, 6]);
    expect(rackPreview(0)).toEqual([10, 6, 6, 6, 6]);
    for (const m of racks) expect(rackPreview(m).reduce((a, b) => a + b, 0)).toBe(34);
  });
  it('summarize reports score, makes, attempts, money makes, time left and finishedEarly', () => {
    // Money rack 1. Rack 0: make, make, miss, miss, make(money). Rack 1: make (money) then stop.
    const s = play(1, ['make', 'make', 'miss', 'miss', 'make', 'make']);
    tick(s, 12.5);
    const sum = summarize(s);
    expect(sum).toEqual({ score: 1 + 1 + 2 + 2, makes: 4, attempts: 6, moneyMakes: 2, timeLeft: CONTEST_SECONDS - 12.5, finishedEarly: false });
    const all = play(3, Array(25).fill('make'));
    expect(summarize(all).finishedEarly).toBe(true);
    expect(summarize(all).moneyMakes).toBe(4 + 5);
  });
});

describe('contest phases and clock', () => {
  it('the clock does not run before the first hold', () => {
    const s = newContest(mon, 2);
    tick(s, 5);
    expect(s.timeLeft).toBe(CONTEST_SECONDS);
    expect(s.phase).toBe('ready');
    expect(recordShot(s, 'make')).toBeNull();
    expect(start(s)).toBe(true);
    expect(start(s)).toBe(false);
    expect(s.phase).toBe('live');
  });
  it('runs 60.0 -> 0 in repeated ticks, clamps and ends done', () => {
    const s = newContest(mon, 2);
    start(s);
    for (let i = 0; i < 1300; i++) tick(s, 1 / 20);
    expect(s.timeLeft).toBe(0);
    expect(s.phase).toBe('done');
    tick(s, 1);
    expect(s.timeLeft).toBe(0);
  });
  it('pause freezes the clock exactly; resume continues', () => {
    const s = newContest(mon, 2);
    start(s);
    tick(s, 10);
    expect(pause(s)).toBe(true);
    for (const dt of [0.016, 1, 100]) tick(s, dt);
    expect(s.timeLeft).toBe(50);
    expect(recordShot(s, 'make')).toBeNull();
    expect(resume(s)).toBe(true);
    tick(s, 0.5);
    expect(s.timeLeft).toBe(49.5);
  });
  it('records rack, index, money and points; 25 shots finish early; no 26th', () => {
    const s = newContest(mon, 4);
    start(s);
    for (let i = 0; i < 25; i++) {
      const b = recordShot(s, 'make')!;
      expect(b).toMatchObject({ rack: Math.floor(i / 5), index: i % 5, money: Math.floor(i / 5) === 4 || i % 5 === 4 });
      expect(s.ballIndex).toBe(i + 1);
    }
    expect(s.phase).toBe('done');
    expect(summarize(s).finishedEarly).toBe(true);
    expect(recordShot(s, 'make')).toBeNull();
    expect(s.results).toHaveLength(TOTAL_BALLS);
  });
  it('a shot in the air at the buzzer still counts, but only that one', () => {
    const s = newContest(mon, 2);
    start(s);
    tick(s, 59.9);
    expect(beginShot(s)).toBe(true);
    expect(beginShot(s)).toBe(false); // one ball at a time
    tick(s, 0.2);
    expect(s.phase).toBe('done');
    expect(recordShot(s, 'make')?.points).toBe(1);
    expect(recordShot(s, 'make')).toBeNull();
    expect(beginShot(s)).toBe(false);
    expect(summarize(s)).toMatchObject({ score: 1, attempts: 1, finishedEarly: false, timeLeft: 0 });
  });
  it('is frame-rate independent: 30 fps and 144 fps agree within 0.1 s', () => {
    const at = (fps: number, seconds: number) => {
      const s = newContest(mon, 2);
      start(s);
      for (let i = 0; i < Math.round(seconds * fps); i++) tick(s, 1 / fps);
      return s.timeLeft;
    };
    expect(Math.abs(at(30, 45) - at(144, 45))).toBeLessThan(0.1);
    expect(at(30, 60)).toBeLessThan(0.1);
    expect(at(144, 60)).toBeLessThan(0.1);
  });
});
