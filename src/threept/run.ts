// The play step as a state machine on top of a REAL main-game Game: one shooter (no defenders) on the real court.
// Hold -> release -> flight -> settle -> (walk to next rack) -> aim. The shot meter, green window, make odds, ball arc
// and rim/net behaviour all come from src/game/game.ts (the shooter's Intent drives startShot/releaseShot/updateShot);
// this file only sequences the contest rules around it. The screen feeds it dt and the shoot button each frame.
import type { Mon } from '../data/pokemon';
import { Game } from '../game/game';
import { emptyIntent, type GameEvent, type Grade, type Player } from '../game/types';
import { USER_STYLE } from '../multiplayer/shared/matchSetup';
import { beginShot, newContest, pause, rackOf, rackSpots, recordShot, resume, start, tick } from './contest';
import { CONTEST_DIFFICULTY } from './shot';
import { BALLS_PER_RACK, type BallResult, type ContestState, type RackId, type ShotResult } from './types';

/** Seconds after the ball reaches the rim before the next ball is ready (the net swishes / the rim rattles). */
export const SETTLE_TIME = 0.4;
/** Seconds to walk to the next rack. */
export const MOVE_TIME = 0.5;
/** The game simulates at this fixed step, like the main game. */
const STEP = 1 / 60;
const SPOTS = rackSpots();

export type Stage = 'aim' | 'hold' | 'flight' | 'settle' | 'move' | 'over';

export type RunEvent =
  | { kind: 'start' }
  | { kind: 'release'; grade: Grade; result: ShotResult }
  | { kind: 'result'; ball: BallResult; grade: Grade }
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
  /** The real game this contest plays inside: one player, no opponents, a fixed camera on the home hoop. */
  readonly game: Game;
  /** The shooter's player in `game`. */
  readonly player: Player;
  stage: Stage = 'aim';
  /** Seconds into the current settle / move stage. */
  t = 0;
  /** The last released shot. */
  shot: { grade: Grade; result: ShotResult; meter: number } | null = null;
  private acc = 0;
  /** A shoot press waiting for the next fixed game step (a frame can be shorter than one step). */
  private pendingShoot = false;
  /** The shooter's meter on the last step it was still held (the game zeroes it on release). */
  private lastMeter = 0;

  /** `rng` replaces the game's roll source (tests: `() => 0` makes every non-zero-odds shot); `seed` seeds it. */
  constructor(shooter: Mon, moneyRack: RackId, rng?: () => number, seed?: number) {
    this.s = newContest(shooter, moneyRack);
    const team = (human: boolean) => ({ name: 'Pallet Town', abbr: 'PAL', ...USER_STYLE, roster: [shooter, shooter, shooter, shooter, shooter], human });
    this.game = new Game({
      home: team(true),
      // Both sides "human" keeps the sim out of its CPU-only rules (defensive assist, comeback easing, CPU boosts).
      away: team(true),
      quarterLen: 99999,
      difficulty: CONTEST_DIFFICULTY,
      stamina: false,
      practice: true,
      noFire: true,
      seed: seed ?? Math.floor(Math.random() * 2 ** 32),
    });
    if (rng) (this.game as { rng: () => number }).rng = rng;
    const g = this.game;
    this.player = g.ball.owner ?? g.players.find((p) => p.team === 0)!;
    // No teammates, no defenders: just the shooter.
    g.players = [this.player];
    g.bench = [];
    g.phase = 'live';
    g.phaseT = 0;
    g.tipoff = null;
    g.events.length = 0;
    g.sfx.length = 0;
    this.placeAt(0);
    this.handBall();
  }

  get paused() { return this.s.phase === 'paused'; }

  /** The rack the shooter stands at (or is walking to). */
  get rack(): RackId { return rackOf(this.s.ballIndex); }

  /** The shooter's shot meter while holding (0..1.25, the main game's Player.meter), else 0. */
  get meter() { return this.stage === 'hold' ? this.player.meter : 0; }

  /** Pausing mid-hold drops the hold: nothing fires on resume until shoot is pressed again. */
  pause(): boolean {
    if (this.stage === 'hold') this.dropHold();
    return pause(this.s);
  }

  resume(): boolean { return resume(this.s); }

  private dropHold() {
    this.stage = 'aim';
    this.pendingShoot = false;
    const p = this.player;
    p.state = 'free';
    p.meter = 0;
  }

  private placeAt(rack: number, x?: number, y?: number) {
    const p = this.player;
    const sp = SPOTS[rack];
    p.x = x ?? sp.x; p.y = y ?? sp.y; p.z = 0;
    p.vx = 0; p.vy = 0; p.vz = 0;
    p.facing = 1; p.back = false;
  }

  /** The ball back in the shooter's hands, ready for the next shot. */
  private handBall() {
    const g = this.game;
    const b = g.ball;
    const p = this.player;
    p.state = 'free'; p.stateT = 0; p.meter = 0;
    b.owner = p; b.mode = 'held'; b.shot = null; b.pass = null;
    b.vx = 0; b.vy = 0; b.vz = 0; b.noPickup = 0; b.fromShot = -1;
    this.keepLive();
  }

  /** The contest owns the rules: no dead balls, turnovers, shot clock or game clock inside the game. */
  private keepLive() {
    const g = this.game;
    g.phase = 'live';
    g.offense = 0;
    g.shotClock = 24;
    g.clock = 99999;
    g.score[0] = 0; g.score[1] = 0;
    this.player.human = true;
    g.users[0] = this.player;
  }

  /** Runs the game for `dt` at its fixed step; returns the events it raised (left in `game.events` for the screen too). */
  private simulate(dt: number, held: boolean, afterEach?: () => void): GameEvent[] {
    const g = this.game;
    const out: GameEvent[] = [];
    this.acc += dt;
    while (this.acc >= STEP - 1e-9) {
      this.acc -= STEP;
      g.userInput = { ...emptyIntent(), shoot: this.pendingShoot, shootHeld: held || this.pendingShoot };
      this.pendingShoot = false;
      if (this.player.state === 'shoot') this.lastMeter = this.player.meter;
      const n = g.events.length;
      g.update(STEP);
      out.push(...g.events.slice(n));
      this.keepLive();
      afterEach?.();
    }
    return out;
  }

  step(dt: number, inp: ShootInput): RunEvent[] {
    const ev: RunEvent[] = [];
    if (this.stage === 'over' || this.paused) return ev;
    const s = this.s;
    const p = this.player;
    const wasLive = s.phase === 'live';
    tick(s, dt);
    if (wasLive && s.phase === 'done' && s.timeLeft <= 0) {
      ev.push({ kind: 'buzzer' });
      // A hold that never left the hands at the buzzer does not count.
      if (this.stage === 'hold') this.dropHold();
    }

    if (this.stage === 'aim' && inp.pressed && (s.phase === 'ready' || s.phase === 'live')) {
      if (start(s)) ev.push({ kind: 'start' });
      this.pendingShoot = true;
      this.stage = 'hold';
    }

    const moving = this.stage === 'move';
    let from = 0, to = 0, k = 0;
    if (moving) {
      from = Math.max(0, this.rack - 1); to = this.rack;
      this.t += dt;
      k = Math.min(1, this.t / MOVE_TIME);
    }
    const walk = () => {
      if (!moving) return;
      const a = SPOTS[from], b = SPOTS[to];
      const e = k * k * (3 - 2 * k);
      p.x = a.x + (b.x - a.x) * e; p.y = a.y + (b.y - a.y) * e; p.z = 0;
      // Run animation: the velocity the walk implies (feet / second).
      p.vx = (b.x - a.x) / MOVE_TIME; p.vy = (b.y - a.y) / MOVE_TIME;
      p.facing = 1;
    };
    walk();

    const events = this.simulate(dt, inp.held, walk);
    // The game refused the shot (no ball in hand): back to aiming.
    if (this.stage === 'hold' && !this.pendingShoot && p.state !== 'shoot' && this.game.ball.mode !== 'shot') this.stage = 'aim';

    for (const e of events) {
      if (e.kind === 'release' && this.stage === 'hold') {
        const make = !!this.game.ball.shot?.make;
        const result: ShotResult = make ? 'make' : 'miss';
        beginShot(s);
        this.shot = { grade: e.grade, result, meter: this.lastMeter };
        ev.push({ kind: 'release', grade: e.grade, result });
        this.stage = 'flight';
        this.t = 0;
      } else if ((e.kind === 'score' || e.kind === 'miss') && this.stage === 'flight' && this.shot) {
        const ball = recordShot(s, this.shot.result);
        if (ball) ev.push({ kind: 'result', ball, grade: this.shot.grade });
        this.stage = 'settle';
        this.t = 0;
        this.game.ball.noPickup = 5; // the shooter never grabs his own rebound: the next ball comes off the rack
      }
    }

    if (this.stage === 'settle') {
      this.t += dt;
      this.game.ball.noPickup = Math.max(this.game.ball.noPickup, 1);
      if (this.t >= SETTLE_TIME) {
        this.t = 0;
        const done = s.phase === 'done';
        this.placeAt(this.rack);
        this.handBall();
        if (done) this.stage = 'over';
        else if (s.ballIndex % BALLS_PER_RACK === 0) { this.stage = 'move'; ev.push({ kind: 'rack', rack: this.rack }); this.placeAt(this.rack - 1); }
        else this.stage = 'aim';
      }
    } else if (this.stage === 'move' && k >= 1) {
      this.t = 0;
      this.placeAt(this.rack);
      this.stage = 'aim';
    }

    // The buzzer ends everything except a ball already in the air.
    if (s.phase === 'done' && this.stage !== 'flight' && this.stage !== 'settle') this.stage = 'over';
    if (this.stage === 'over') ev.push({ kind: 'over' });
    return ev;
  }
}
