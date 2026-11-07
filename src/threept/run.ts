// The play step as a pure state machine: hold -> release -> flight -> settle -> (walk to next rack) -> aim.
// The screen feeds it dt and the shoot button each frame and draws whatever it reports. No DOM.
import type { Mon } from '../data/pokemon';
import { beginShot, newContest, pause, rackOf, recordShot, resume, start, tick } from './contest';
import { METER_MAX, METER_TIME, gradeRelease, resolveShot, type ContestGrade } from './shot';
import { BALLS_PER_RACK, type BallResult, type ContestState, type RackId, type ShotResult } from './types';

/** Seconds the ball is in the air. */
export const FLIGHT_TIME = 0.55;
/** Seconds after the ball lands before the next ball is ready (grabbing it off the rack). */
export const SETTLE_TIME = 0.15;
/** Seconds to walk to the next rack. */
export const MOVE_TIME = 0.45;

export type Stage = 'aim' | 'hold' | 'flight' | 'settle' | 'move' | 'over';

export type RunEvent =
  | { kind: 'start' }
  | { kind: 'release'; grade: ContestGrade; result: ShotResult }
  | { kind: 'result'; ball: BallResult; grade: ContestGrade }
  | { kind: 'rack'; rack: RackId }
  | { kind: 'buzzer' }
  | { kind: 'over' };

export interface ShootInput {
  /** The shoot button went down this frame (an edge, not a held key's auto-repeat). */
  pressed: boolean;
  /** The shoot button is down. */
  held: boolean;
}

export class ContestRun {
  readonly s: ContestState;
  stage: Stage = 'aim';
  /** Meter fill while holding (0..1.2). */
  meter = 0;
  /** Seconds into the current flight / settle / move stage. */
  t = 0;
  /** The last released shot, for the flight animation. */
  shot: { grade: ContestGrade; result: ShotResult; meter: number } | null = null;
  private rng: () => number;

  constructor(shooter: Mon, moneyRack: RackId, rng: () => number = Math.random) {
    this.s = newContest(shooter, moneyRack);
    this.rng = rng;
  }

  get paused() { return this.s.phase === 'paused'; }

  /** The rack the shooter stands at (or is walking to). */
  get rack(): RackId { return rackOf(this.s.ballIndex); }

  /** Pausing mid-hold drops the hold: nothing fires on resume until shoot is pressed again. */
  pause(): boolean {
    if (this.stage === 'hold') { this.stage = 'aim'; this.meter = 0; }
    return pause(this.s);
  }

  resume(): boolean { return resume(this.s); }

  step(dt: number, inp: ShootInput): RunEvent[] {
    const ev: RunEvent[] = [];
    if (this.stage === 'over' || this.paused) return ev;
    const s = this.s;
    const wasLive = s.phase === 'live';
    tick(s, dt);
    if (wasLive && s.phase === 'done' && s.timeLeft <= 0) {
      ev.push({ kind: 'buzzer' });
      // A hold that never left the hands at the buzzer does not count.
      if (this.stage === 'hold') { this.stage = 'aim'; this.meter = 0; }
    }

    switch (this.stage) {
      case 'aim':
        if (inp.pressed && (s.phase === 'ready' || s.phase === 'live')) {
          if (start(s)) ev.push({ kind: 'start' });
          this.stage = 'hold';
          this.meter = 0;
        }
        break;
      case 'hold':
        this.meter = Math.min(METER_MAX, this.meter + dt / METER_TIME);
        if (!inp.held || this.meter >= METER_MAX) {
          const grade = gradeRelease(this.meter, s.shooter.r);
          const result = resolveShot(grade, s.shooter.r, this.rng);
          beginShot(s);
          this.shot = { grade, result, meter: this.meter };
          ev.push({ kind: 'release', grade, result });
          this.stage = 'flight';
          this.t = 0;
        }
        break;
      case 'flight':
        this.t += dt;
        if (this.t >= FLIGHT_TIME && this.shot) {
          const ball = recordShot(s, this.shot.result);
          if (ball) ev.push({ kind: 'result', ball, grade: this.shot.grade });
          this.stage = 'settle';
          this.t -= FLIGHT_TIME;
        }
        break;
      case 'settle':
        this.t += dt;
        if (this.t >= SETTLE_TIME) {
          this.t -= SETTLE_TIME;
          if (s.phase === 'done') this.stage = 'over';
          else if (s.ballIndex % BALLS_PER_RACK === 0) { this.stage = 'move'; ev.push({ kind: 'rack', rack: this.rack }); }
          else this.stage = 'aim';
        }
        break;
      case 'move':
        this.t += dt;
        if (this.t >= MOVE_TIME) { this.t = 0; this.stage = 'aim'; }
        break;
    }
    // The buzzer ends everything except a ball already in the air.
    if (s.phase === 'done' && this.stage !== 'flight' && this.stage !== 'settle') this.stage = 'over';
    if (this.stage === 'over') ev.push({ kind: 'over' });
    return ev;
  }
}
