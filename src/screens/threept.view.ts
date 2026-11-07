// 3-Point Contest court view: a broadcast angle from half court looking at the home hoop. Canvas only, no game state
// of its own beyond short-lived animations (ball flights, net, floating text), which freeze when dt is 0.
import { HOOP_Y, RIM_Z, hoopX } from '../game/types';
import { getSprite } from '../game/sprites';
import { isMoneyBall, rackSpots } from '../threept/contest';
import { FLIGHT_TIME, MOVE_TIME, type ContestRun } from '../threept/run';
import { IDEAL_RELEASE, contestGreenWindow, type ContestGrade } from '../threept/shot';
import { BALLS_PER_RACK, type RackId, type ShotResult } from '../threept/types';

export const VIEW_W = 800;
export const VIEW_H = 480;

const HX = hoopX(0);
const SPOTS = rackSpots();
const DEPTH = 36; // feet from the baseline to the bottom of the view
const Y0 = 118; // baseline on screen
const KY = (VIEW_H - Y0 - 8) / DEPTH;
const KX = VIEW_W / 50;
const KZ = 9;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const ease = (t: number) => t * t * (3 - 2 * t);

/** Lateral shrink with distance: far (baseline) is narrower than near (half court). */
const scaleAt = (x: number) => 0.6 + 0.4 * clamp((94 - x) / DEPTH, -0.2, 1.2);

/** Court feet (x baseline->half court, y sideline, z height) to view pixels. */
export function project(x: number, y: number, z = 0): { x: number; y: number; s: number } {
  const s = scaleAt(x);
  return { x: VIEW_W / 2 + (y - HOOP_Y) * KX * s, y: Y0 + (94 - x) * KY - z * KZ * s, s };
}

interface Flight {
  t: number;
  x0: number; y0: number; z0: number;
  x1: number; y1: number; z1: number;
  result: ShotResult;
  airball: boolean;
  money: boolean;
  /** Sideways drift of a missed ball off the rim. */
  by: number;
}

interface Float { text: string; color: string; x: number; y: number; t: number; big: boolean }

const BALL = '#f07a1f';
const GOLD = '#ffcb05';

export class CourtView {
  private ctx: CanvasRenderingContext2D;
  private flights: Flight[] = [];
  private floats: Float[] = [];
  private net = 0;
  private rimShake = 0;
  private meterGhost = { v: 0, t: 0 };
  private jump = 0;
  private time = 0;

  constructor(canvas: HTMLCanvasElement, private dex: number) {
    const dpr = Math.min(2, Math.max(1, Math.round(window.devicePixelRatio || 1)));
    canvas.width = VIEW_W * dpr;
    canvas.height = VIEW_H * dpr;
    this.ctx = canvas.getContext('2d')!;
    this.ctx.scale(dpr, dpr);
  }

  /** A ball leaves the shooter's hands. */
  release(run: ContestRun, grade: ContestGrade, result: ShotResult) {
    const spot = SPOTS[run.rack];
    const airball = result === 'miss' && grade.startsWith('very');
    let x1 = HX, y1 = HOOP_Y, z1 = RIM_Z + 0.2;
    const ax = spot.x - HX, ay = spot.y - HOOP_Y;
    const l = Math.hypot(ax, ay) || 1;
    if (airball) { x1 = HX + (ax / l) * 3.2; y1 = HOOP_Y + (ay / l) * 3.2; z1 = 7; }
    else if (result === 'miss') {
      const side = (run.s.ballIndex % 2 ? 1 : -1);
      x1 = HX + 0.3; y1 = HOOP_Y + side * 0.85;
    }
    const idx = run.s.ballIndex % BALLS_PER_RACK;
    this.flights.push({
      t: 0, x0: spot.x + 0.4, y0: spot.y, z0: 8.4, x1, y1, z1, result, airball,
      money: isMoneyBall(run.rack, idx, run.s.moneyRack),
      by: (y1 - HOOP_Y) * 2 || (Math.random() - 0.5) * 2,
    });
    this.jump = 0.32;
    this.meterGhost = { v: run.shot?.meter ?? 0, t: 0.55 };
    if (grade === 'perfect') this.float('GREEN', '#21d07a', run.rack, false, -26);
  }

  /** The ball reaches the rim: net and floating points. */
  landed(points: number, money: boolean, result: ShotResult) {
    if (result === 'make') {
      this.net = 0.45;
      this.float(money ? `+${points} MONEY!` : `+${points}`, money ? GOLD : '#ffffff', null, true);
    } else {
      this.rimShake = 0.25;
    }
  }

  private float(text: string, color: string, rack: RackId | null, big: boolean, dy = 0) {
    const at = rack === null ? project(HX, HOOP_Y, RIM_Z + 3) : project(SPOTS[rack].x, SPOTS[rack].y, 9);
    this.floats.push({ text, color, x: at.x, y: at.y + dy, t: 0, big });
  }

  draw(run: ContestRun, dt: number) {
    this.time += dt;
    const ctx = this.ctx;
    ctx.clearRect(0, 0, VIEW_W, VIEW_H);
    this.drawArena(ctx);
    this.drawFloor(ctx, run.s.moneyRack);
    this.drawRacks(ctx, run);
    const at = this.shooterAt(run);
    this.drawShooter(ctx, run, at);
    this.drawHoop(ctx);
    this.drawFlights(ctx, dt);
    this.drawMeter(ctx, run, at, dt);
    this.drawFloats(ctx, dt);
    this.net = Math.max(0, this.net - dt);
    this.rimShake = Math.max(0, this.rimShake - dt);
    this.jump = Math.max(0, this.jump - dt);
  }

  private drawArena(ctx: CanvasRenderingContext2D) {
    const g = ctx.createLinearGradient(0, 0, 0, Y0 + 10);
    g.addColorStop(0, '#070918');
    g.addColorStop(1, '#141a44');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VIEW_W, Y0 + 10);
    // Crowd: rows of dim dots.
    for (let row = 0; row < 5; row++) {
      for (let i = 0; i < 64; i++) {
        const x = (i * 12.7 + row * 6.3) % VIEW_W;
        const y = 18 + row * 13 + ((i * 7) % 3);
        const h = (i * 37 + row * 11) % 5;
        ctx.fillStyle = ['#2a3170', '#3b2f6a', '#26407a', '#4a2a55', '#30386e'][h];
        ctx.fillRect(x, y, 6, 7);
      }
    }
    ctx.fillStyle = '#0b0e26';
    ctx.fillRect(0, Y0 - 30, VIEW_W, 30);
    ctx.fillStyle = GOLD;
    ctx.font = '12px "Press Start 2P", monospace';
    ctx.textAlign = 'left';
    ctx.fillText('3-POINT CONTEST', 18, Y0 - 11);
    ctx.textAlign = 'right';
    ctx.fillText('POKé JAM', VIEW_W - 18, Y0 - 11);
  }

  private path(ctx: CanvasRenderingContext2D, pts: [number, number][]) {
    ctx.beginPath();
    pts.forEach(([x, y], i) => {
      const p = project(x, y);
      if (i) ctx.lineTo(p.x, p.y); else ctx.moveTo(p.x, p.y);
    });
  }

  private drawFloor(ctx: CanvasRenderingContext2D, moneyRack: RackId) {
    const far = 94 - DEPTH - 2;
    this.path(ctx, [[94, 0], [94, 50], [far, 50], [far, 0]]);
    const g = ctx.createLinearGradient(0, Y0, 0, VIEW_H);
    g.addColorStop(0, '#8a5a32');
    g.addColorStop(1, '#c68a52');
    ctx.fillStyle = g;
    ctx.fill();
    // Floor boards.
    ctx.strokeStyle = 'rgba(60, 30, 10, 0.18)';
    ctx.lineWidth = 1;
    for (let y = 2; y < 50; y += 2.5) { this.path(ctx, [[94, y], [far, y]]); ctx.stroke(); }
    // Paint.
    this.path(ctx, [[94, 17], [94, 33], [75, 33], [75, 17]]);
    ctx.fillStyle = 'rgba(227, 53, 13, 0.55)';
    ctx.fill();
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.85)';
    ctx.lineWidth = 2;
    ctx.stroke();
    // Free-throw circle (half toward half court).
    const fc: [number, number][] = [];
    for (let a = 0; a <= Math.PI; a += Math.PI / 24) fc.push([75 - Math.sin(a) * 6, 25 - Math.cos(a) * 6]);
    this.path(ctx, fc);
    ctx.stroke();
    // Three-point line: corner straights then the 23.75 ft arc.
    const a0 = Math.asin(22 / 23.75);
    const cornerX = HX - Math.cos(a0) * 23.75;
    const arc: [number, number][] = [[94, 3], [cornerX, 3]];
    for (let a = -a0; a <= a0 + 1e-6; a += a0 / 30) arc.push([HX - Math.cos(a) * 23.75, HOOP_Y + Math.sin(a) * 23.75]);
    arc.push([94, 47]);
    this.path(ctx, arc);
    ctx.lineWidth = 3;
    ctx.stroke();
    // Baseline and sidelines.
    ctx.lineWidth = 2;
    this.path(ctx, [[far, 0], [94, 0], [94, 50], [far, 50]]);
    ctx.stroke();
    // Spot markers: the money rack glows gold.
    for (const sp of SPOTS) {
      const p = project(sp.x, sp.y);
      const money = sp.rack === moneyRack;
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, 22 * p.s, 8 * p.s, 0, 0, Math.PI * 2);
      ctx.fillStyle = money ? 'rgba(255, 203, 5, 0.45)' : 'rgba(255, 255, 255, 0.18)';
      ctx.fill();
      if (money) { ctx.strokeStyle = GOLD; ctx.lineWidth = 2; ctx.stroke(); }
    }
  }

  /** Racks sit on the centre side of each spot (the top rack to the shooter's right); the meter goes the other way. */
  private side(r: RackId): 1 | -1 { return r <= 2 ? 1 : -1; }

  private rackPos(r: RackId) {
    const sp = SPOTS[r];
    return { x: sp.x - 1.2, y: sp.y + this.side(r) * 4.2 };
  }

  private drawRacks(ctx: CanvasRenderingContext2D, run: ContestRun) {
    const cur = run.rack;
    const idx = run.s.ballIndex % BALLS_PER_RACK;
    const inHand = run.stage === 'aim' || run.stage === 'hold' || run.stage === 'flight';
    const done = run.s.ballIndex >= BALLS_PER_RACK * 5;
    for (const sp of SPOTS) {
      const r = sp.rack;
      const at = this.rackPos(r);
      const p = project(at.x, at.y);
      const w = 46 * p.s;
      // Stand.
      ctx.fillStyle = '#2b2f45';
      ctx.fillRect(p.x - w / 2, p.y - 10 * p.s, w, 10 * p.s);
      ctx.fillStyle = '#5a6080';
      ctx.fillRect(p.x - w / 2, p.y - 12 * p.s, w, 3 * p.s);
      // Balls still on the rack.
      let first = 0;
      if (done || r < cur) first = BALLS_PER_RACK;
      else if (r === cur) first = idx + (inHand ? 1 : 0);
      for (let i = first; i < BALLS_PER_RACK; i++) {
        const bx = p.x - w / 2 + (i + 0.5) * (w / BALLS_PER_RACK);
        this.ball(ctx, bx, p.y - 16 * p.s, 4.6 * p.s, isMoneyBall(r, i, run.s.moneyRack));
      }
      // Label under the rack.
      ctx.font = `${Math.round(9 * p.s + 2)}px "Press Start 2P", monospace`;
      ctx.textAlign = 'center';
      ctx.fillStyle = r === run.s.moneyRack ? GOLD : 'rgba(255, 255, 255, 0.75)';
      ctx.fillText(r === run.s.moneyRack ? 'MONEY' : sp.label.toUpperCase(), p.x, p.y + 12 * p.s);
    }
  }

  private ball(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, money: boolean) {
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = money ? GOLD : BALL;
    ctx.fill();
    ctx.strokeStyle = money ? '#fff6d6' : '#5a2a08';
    ctx.lineWidth = Math.max(1, r * 0.28);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - r, y);
    ctx.lineTo(x + r, y);
    ctx.stroke();
  }

  private shooterAt(run: ContestRun): { x: number; y: number } {
    const sp = SPOTS[run.rack];
    if (run.stage === 'move' && run.rack > 0) {
      const from = SPOTS[run.rack - 1];
      const t = ease(clamp(run.t / MOVE_TIME, 0, 1));
      return { x: lerp(from.x, sp.x, t), y: lerp(from.y, sp.y, t) };
    }
    return { x: sp.x, y: sp.y };
  }

  private drawShooter(ctx: CanvasRenderingContext2D, run: ContestRun, at: { x: number; y: number }) {
    const p = project(at.x, at.y);
    const hop = this.jump > 0 ? Math.sin((1 - this.jump / 0.32) * Math.PI) * 14 * p.s : 0;
    const crouch = run.stage === 'hold' ? 0.93 : 1;
    // Shadow.
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, 18 * p.s, 6 * p.s, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0, 0, 0, 0.35)';
    ctx.fill();
    const spr = getSprite(this.dex, true);
    const h = 96 * p.s;
    if (spr) {
      const w = h * (spr.w / spr.h);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(spr.img, p.x - w / 2, p.y - h * crouch - hop, w, h * crouch);
      ctx.imageSmoothingEnabled = true;
    } else {
      ctx.fillStyle = '#3b6fd8';
      ctx.fillRect(p.x - 14 * p.s, p.y - h * crouch - hop, 28 * p.s, h * crouch);
    }
    // Ball in hands while aiming or holding.
    if ((run.stage === 'aim' || run.stage === 'hold') && run.s.ballIndex < 25) {
      const idx = run.s.ballIndex % BALLS_PER_RACK;
      const lift = run.stage === 'hold' ? h * 0.92 : h * 0.55;
      this.ball(ctx, p.x + 10 * p.s, p.y - lift - hop, 7 * p.s, isMoneyBall(run.rack, idx, run.s.moneyRack));
    }
  }

  private drawHoop(ctx: CanvasRenderingContext2D) {
    // Stanchion and backboard.
    const base = project(HX + 4.2, HOOP_Y, 0);
    const top = project(HX + 4.2, HOOP_Y, 12.5);
    ctx.fillStyle = '#20243a';
    ctx.fillRect(base.x - 5, top.y, 10, base.y - top.y);
    const bl = project(HX + 1.25, HOOP_Y - 3, 13.5);
    const br = project(HX + 1.25, HOOP_Y + 3, 9.5);
    ctx.fillStyle = 'rgba(230, 240, 255, 0.85)';
    ctx.fillRect(bl.x, bl.y, br.x - bl.x, br.y - bl.y);
    ctx.strokeStyle = '#e3350d';
    ctx.lineWidth = 3;
    ctx.strokeRect(bl.x, bl.y, br.x - bl.x, br.y - bl.y);
    const sl = project(HX + 1.25, HOOP_Y - 1, 12);
    const sr = project(HX + 1.25, HOOP_Y + 1, 10.3);
    ctx.lineWidth = 2;
    ctx.strokeRect(sl.x, sl.y, sr.x - sl.x, sr.y - sl.y);
    // Rim and net.
    const shake = this.rimShake > 0 ? Math.sin(this.rimShake * 80) * 2 : 0;
    const rim = project(HX, HOOP_Y, RIM_Z);
    const rw = 0.85 * KX * rim.s;
    const stretch = this.net > 0 ? Math.sin((1 - this.net / 0.45) * Math.PI) * 9 : 0;
    const nh = 20 + stretch;
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.lineWidth = 1.5;
    for (let i = 0; i <= 6; i++) {
      const tx = rim.x - rw + (i / 6) * rw * 2;
      const bx = rim.x - rw * 0.55 + (i / 6) * rw * 1.1;
      ctx.beginPath();
      ctx.moveTo(tx + shake, rim.y);
      ctx.lineTo(bx + shake, rim.y + nh);
      ctx.stroke();
    }
    for (let k = 1; k <= 2; k++) {
      const f = k / 3;
      const w = lerp(rw, rw * 0.55, f);
      ctx.beginPath();
      ctx.moveTo(rim.x - w + shake, rim.y + nh * f);
      ctx.lineTo(rim.x + w + shake, rim.y + nh * f);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.ellipse(rim.x + shake, rim.y, rw, rw * 0.28, 0, 0, Math.PI * 2);
    ctx.strokeStyle = '#ff5a1f';
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  private drawFlights(ctx: CanvasRenderingContext2D, dt: number) {
    const live: Flight[] = [];
    for (const f of this.flights) {
      f.t += dt;
      let x: number, y: number, z: number;
      if (f.t <= FLIGHT_TIME) {
        const u = f.t / FLIGHT_TIME;
        x = lerp(f.x0, f.x1, u);
        y = lerp(f.y0, f.y1, u);
        z = lerp(f.z0, f.z1, u) + 4 * (f.airball ? 6 : 8.5) * u * (1 - u);
      } else {
        const k = f.t - FLIGHT_TIME;
        if (k > 0.75) continue;
        if (f.result === 'make') {
          x = f.x1; y = f.y1; z = f.z1 - Math.min(1, k / 0.25) * 3.2 - Math.max(0, k - 0.25) * 14;
        } else if (f.airball) {
          x = f.x1 - k * 3; y = f.y1; z = Math.max(0.4, f.z1 - k * 22 + Math.abs(Math.sin(k * 9)) * 1.5);
        } else {
          x = f.x1 - k * 7; y = f.y1 + f.by * k * 3; z = f.z1 + Math.sin(Math.min(1, k / 0.5) * Math.PI) * 3 - k * 6;
        }
      }
      live.push(f);
      const sh = project(x, y, 0);
      ctx.beginPath();
      ctx.ellipse(sh.x, sh.y, 6 * sh.s, 2.2 * sh.s, 0, 0, Math.PI * 2);
      ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
      ctx.fill();
      const p = project(x, y, z);
      this.ball(ctx, p.x, p.y, 7 * p.s, f.money);
    }
    this.flights = live;
  }

  /** The in-game meter's look (dark frame, slate track, green band, white/yellow marker), sized for this view. */
  private drawMeter(ctx: CanvasRenderingContext2D, run: ContestRun, at: { x: number; y: number }, dt: number) {
    const holding = run.stage === 'hold';
    const aiming = run.stage === 'aim' && run.s.ballIndex < 25;
    const m = this.meterGhost;
    if (!holding) m.t = Math.max(0, m.t - dt);
    if (!holding && !aiming && m.t <= 0) return;
    const v = holding ? run.meter : m.t > 0 ? m.v : 0;
    const p = project(at.x, at.y);
    const h = 104;
    const w = 14;
    const dir = -this.side(run.rack);
    const x = Math.round(clamp(p.x + dir * (44 * p.s + 8) - (dir < 0 ? w : 0), 8, VIEW_W - w - 8));
    const y = Math.round(clamp(p.y - 96 * p.s - 10, Y0 - 20, VIEW_H - h - 8));
    ctx.globalAlpha = holding ? 1 : m.t > 0 ? clamp(m.t * 3, 0, 1) : 0.55;
    ctx.fillStyle = '#05060f';
    ctx.fillRect(x - 2, y - 2, w + 4, h + 4);
    const gw = contestGreenWindow(run.s.shooter.r);
    const lo = clamp(IDEAL_RELEASE - gw, 0, 1);
    const hi = clamp(IDEAL_RELEASE + gw, 0, 1);
    ctx.fillStyle = '#2f3560';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#21d07a';
    ctx.fillRect(x, Math.round(y + h - hi * h), w, Math.max(2, Math.round((hi - lo) * h)));
    if (holding || m.t > 0) {
      const fill = clamp(v, 0, 1);
      ctx.fillStyle = 'rgba(255, 255, 255, 0.18)';
      ctx.fillRect(x, Math.round(y + h - fill * h), w, Math.round(fill * h));
      const inGreen = v >= lo && v <= hi;
      ctx.fillStyle = inGreen ? '#ffffff' : '#ffcb05';
      ctx.fillRect(x - 3, Math.round(y + h - Math.min(1.05, v) * h) - 2, w + 6, 4);
    }
    ctx.globalAlpha = 1;
  }

  private drawFloats(ctx: CanvasRenderingContext2D, dt: number) {
    const live: Float[] = [];
    ctx.textAlign = 'center';
    for (const f of this.floats) {
      f.t += dt;
      if (f.t > 1.1) continue;
      live.push(f);
      ctx.globalAlpha = clamp((1.1 - f.t) * 3, 0, 1);
      ctx.font = `${f.big ? 18 : 12}px "Press Start 2P", monospace`;
      ctx.fillStyle = '#05060f';
      ctx.fillText(f.text, f.x + 2, f.y - f.t * 34 + 2);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, f.x, f.y - f.t * 34);
    }
    ctx.globalAlpha = 1;
    this.floats = live;
  }
}
