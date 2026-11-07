import { describe, expect, it } from 'vitest';
import { POKEMON, type Mon } from '../data/pokemon';
import { DIFFICULTIES } from '../game/types';
import { ballPoints } from './contest';
import { ContestRun, type RunEvent } from './run';
import { CONTEST_DIFFICULTY, IDEAL_RELEASE, METER_TIME } from './shot';

const sharp: Mon = { ...POKEMON[0], r: { ...POKEMON[0].r, sht: 100 } };

/** Hold until the main game's meter reaches the perfect fill, release, and wait for the next ball. Returns every event. */
function scripted(run: ContestRun, fps: number, maxSeconds = 120) {
  const dt = 1 / fps;
  const events: RunEvent[] = [];
  for (let i = 0; i < maxSeconds * fps && run.stage !== 'over'; i++) {
    let inp = { pressed: false, held: false };
    if (run.stage === 'aim') { inp = { pressed: true, held: true }; }
    else if (run.stage === 'hold') {
      inp = { pressed: false, held: run.meter + dt / METER_TIME < IDEAL_RELEASE };
    }
    events.push(...run.step(dt, inp));
  }
  return events;
}

describe('ContestRun (play loop on the real game)', () => {
  it('plays inside a real Game: one player, the game default green window, no defenders', () => {
    const run = new ContestRun(sharp, 2, () => 0);
    expect(CONTEST_DIFFICULTY).toBe('pro');
    expect(run.game.players).toEqual([run.player]);
    expect(run.game.greenWindow(run.player)).toBeCloseTo((0.022 + (run.player.r.sht / 100) * 0.034) * DIFFICULTIES.pro.green, 10);
    expect(run.game.contest(run.player)).toBe(1);
  });
  it('a perfect 100-Sht shooter takes all 25 and scores the sum of ballPoints', () => {
    const run = new ContestRun(sharp, 2, () => 0);
    const ev = scripted(run, 60);
    expect(run.stage).toBe('over');
    expect(run.s.phase).toBe('done');
    expect(run.s.results).toHaveLength(25);
    const sum = run.s.results.reduce((n, b) => n + ballPoints(b.rack, b.index, 2, b.result), 0);
    expect(run.s.results.reduce((n, b) => n + b.points, 0)).toBe(sum);
    expect(sum).toBe(34);
    expect(ev.filter((e) => e.kind === 'release').every((e) => e.kind === 'release' && e.grade === 'perfect')).toBe(true);
    expect(ev.filter((e) => e.kind === 'rack')).toHaveLength(4);
    expect(ev.filter((e) => e.kind === 'start')).toHaveLength(1);
    expect(run.s.timeLeft).toBeGreaterThan(0);
  });
  it('the shooter really shoots from each rack spot: the real game counts a three-point attempt every ball', () => {
    const run = new ContestRun(sharp, 2, () => 0);
    scripted(run, 60);
    expect(run.player.stats.fga).toBe(25);
    expect(run.player.stats.tpa).toBe(25);
  });
  it('the clock waits for the first hold', () => {
    const run = new ContestRun(sharp, 2, () => 0);
    for (let i = 0; i < 100; i++) run.step(0.05, { pressed: false, held: false });
    expect(run.s.timeLeft).toBe(60);
    expect(run.step(0.05, { pressed: true, held: true })).toEqual([{ kind: 'start' }]);
    run.step(0.05, { pressed: false, held: true });
    expect(run.s.timeLeft).toBeCloseTo(59.95, 6);
  });
  it('a held button does not start a new shot; release without a hold does nothing', () => {
    const run = new ContestRun(sharp, 2, () => 0);
    run.step(0.016, { pressed: false, held: true });
    expect(run.stage).toBe('aim');
    run.step(0.05, { pressed: true, held: true });
    run.step(0.3, { pressed: false, held: false });
    expect(run.stage).toBe('flight');
    // Holding through the flight and settle does not carry over into the next ball.
    for (let i = 0; i < 60; i++) run.step(0.05, { pressed: false, held: true });
    expect(run.stage).toBe('aim');
    expect(run.s.results).toHaveLength(1);
  });
  it('a press shorter than one game step still fires a shot', () => {
    const run = new ContestRun(sharp, 2, () => 0);
    run.step(0.004, { pressed: true, held: true });
    run.step(0.004, { pressed: false, held: false });
    for (let i = 0; i < 400 && run.stage !== 'flight'; i++) run.step(0.004, { pressed: false, held: false });
    expect(run.stage).toBe('flight');
  });
  it('the game auto-releases a hold that runs on (the shooter lands): a late miss', () => {
    const run = new ContestRun(sharp, 2, () => 0.999);
    run.step(0.016, { pressed: true, held: true });
    let ev: RunEvent[] = [];
    for (let i = 0; i < 100 && run.stage === 'hold'; i++) ev = run.step(0.02, { pressed: false, held: true });
    const rel = ev.find((e) => e.kind === 'release');
    expect(rel).toBeDefined();
    expect(rel!.kind === 'release' && rel!.result).toBe('miss');
    expect(run.shot!.meter).toBeGreaterThan(1);
    expect(rel!.kind === 'release' && /late/.test(rel!.grade)).toBe(true);
  });
  it('pause freezes clock, meter and flight; pausing mid-hold cancels the hold', () => {
    const run = new ContestRun(sharp, 2, () => 0);
    run.step(0.016, { pressed: true, held: true });
    run.step(0.2, { pressed: false, held: true });
    run.pause();
    expect(run.stage).toBe('aim');
    expect(run.meter).toBe(0);
    const t = run.s.timeLeft;
    for (let i = 0; i < 50; i++) expect(run.step(0.05, { pressed: true, held: true })).toEqual([]);
    expect(run.s.timeLeft).toBe(t);
    run.resume();
    run.step(0.016, { pressed: false, held: true }); // still held from before: no shot
    expect(run.stage).toBe('aim');
    run.step(0.016, { pressed: true, held: true });
    run.step(0.05, { pressed: false, held: false });
    expect(run.stage).toBe('flight');
    run.step(0.3, { pressed: false, held: false });
    run.pause();
    const b = { x: run.game.ball.x, z: run.game.ball.z };
    run.step(1, { pressed: false, held: false });
    expect(run.game.ball.x).toBe(b.x);
    expect(run.game.ball.z).toBe(b.z);
    expect(run.stage).toBe('flight');
  });
  it('a ball in the air at the buzzer still scores, then the run is over', () => {
    const run = new ContestRun(sharp, 2, () => 0);
    run.step(0.016, { pressed: true, held: true });
    run.s.timeLeft = 0.1;
    run.step(0.05, { pressed: false, held: false });
    expect(run.stage).toBe('flight');
    const ev: RunEvent[] = [];
    for (let i = 0; i < 100 && run.stage !== 'over'; i++) ev.push(...run.step(0.05, { pressed: false, held: false }));
    expect(ev.map((e) => e.kind)).toEqual(['buzzer', 'result', 'over']);
    expect(run.s.results).toHaveLength(1);
    expect(run.s.results[0].points).toBe(1);
  });
  it('a hold at the buzzer does not count', () => {
    const run = new ContestRun(sharp, 2, () => 0);
    run.step(0.016, { pressed: true, held: true });
    run.s.timeLeft = 0.01;
    const ev = run.step(0.05, { pressed: false, held: true });
    expect(ev.map((e) => e.kind)).toEqual(['buzzer', 'over']);
    expect(run.s.results).toHaveLength(0);
  });
  it('30 fps and 144 fps scripted runs both take all 25 balls', () => {
    const a = new ContestRun(sharp, 2, () => 0);
    const b = new ContestRun(sharp, 2, () => 0);
    scripted(a, 30);
    scripted(b, 144);
    expect(a.s.results).toHaveLength(25);
    expect(b.s.results).toHaveLength(25);
    expect(Math.abs(a.s.timeLeft - b.s.timeLeft)).toBeLessThan(25 * 2 / 30);
  });
  it('never goes on fire, even over a long make streak', () => {
    const run = new ContestRun(sharp, 2, () => 0);
    const kinds: string[] = [];
    const dt = 1 / 60;
    let best = 0;
    for (let i = 0; i < 120 * 60 && run.stage !== 'over'; i++) {
      let inp = { pressed: false, held: false };
      if (run.stage === 'aim') inp = { pressed: true, held: true };
      else if (run.stage === 'hold') inp = { pressed: false, held: run.meter + dt / METER_TIME < IDEAL_RELEASE };
      run.step(dt, inp);
      expect(run.player.fire).toBe(false);
      best = Math.max(best, run.player.streak);
      kinds.push(...run.game.events.map((e) => e.kind));
    }
    expect(best).toBeGreaterThanOrEqual(3);
    expect(kinds).not.toContain('fire');
  });
});
