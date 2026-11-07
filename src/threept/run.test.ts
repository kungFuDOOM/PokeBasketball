import { describe, expect, it } from 'vitest';
import { POKEMON, type Mon } from '../data/pokemon';
import { ballPoints } from './contest';
import { FLIGHT_TIME, ContestRun, type RunEvent } from './run';
import { IDEAL_RELEASE, METER_TIME } from './shot';

const sharp: Mon = { ...POKEMON[0], r: { ...POKEMON[0].r, sht: 100 } };

/** Hold for exactly the perfect fill, release, and wait for the next ball. Returns every event. */
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

describe('ContestRun (play loop)', () => {
  it('a perfect 100-Sht shooter with an always-make rng takes all 25 and scores the sum of ballPoints', () => {
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
    run.step(0.016, { pressed: true, held: true });
    run.step(0.3, { pressed: false, held: false });
    expect(run.stage).toBe('flight');
    // Holding through the flight and settle does not carry over into the next ball.
    for (let i = 0; i < 20; i++) run.step(0.05, { pressed: false, held: true });
    expect(run.stage).toBe('aim');
    expect(run.s.results).toHaveLength(1);
  });
  it('the meter auto-releases very late at 1.2', () => {
    const run = new ContestRun(sharp, 2, () => 0.999);
    run.step(0.016, { pressed: true, held: true });
    let ev: RunEvent[] = [];
    for (let i = 0; i < 100 && run.stage === 'hold'; i++) ev = run.step(0.02, { pressed: false, held: true });
    expect(ev).toContainEqual({ kind: 'release', grade: 'very-late', result: 'miss' });
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
    run.step(0.016, { pressed: false, held: false });
    expect(run.stage).toBe('flight');
    run.step(FLIGHT_TIME / 2, { pressed: false, held: false });
    run.pause();
    const ft = run.t;
    run.step(1, { pressed: false, held: false });
    expect(run.t).toBe(ft);
    expect(run.stage).toBe('flight');
  });
  it('a ball in the air at the buzzer still scores, then the run is over', () => {
    const run = new ContestRun(sharp, 2, () => 0);
    run.step(0.016, { pressed: true, held: true });
    run.s.timeLeft = 0.1;
    run.step(0.016, { pressed: false, held: false });
    expect(run.stage).toBe('flight');
    const ev: RunEvent[] = [];
    for (let i = 0; i < 40 && run.stage !== 'over'; i++) ev.push(...run.step(0.05, { pressed: false, held: false }));
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
  it('30 fps and 144 fps scripted runs end within 0.1 s of each other', () => {
    const a = new ContestRun(sharp, 2, () => 0);
    const b = new ContestRun(sharp, 2, () => 0);
    scripted(a, 30);
    scripted(b, 144);
    expect(a.s.results).toHaveLength(25);
    expect(b.s.results).toHaveLength(25);
    // Stage timers carry their remainder; only the press/release frames quantize (about one frame per ball at 30 fps).
    expect(Math.abs(a.s.timeLeft - b.s.timeLeft)).toBeLessThan(25 * 2 / 30);
  });
});
