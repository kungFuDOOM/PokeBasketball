// 3-Point Contest court view. It IS the main game's view: the game's own Renderer draws the court, hoop, net, ball, shooter
// sprite and shot meter from the ContestRun's real Game (side camera fixed on the home hoop). This file only adds what the
// contest has and a normal game does not: the five ball racks, rack spots on the floor, and floating text.
import { Renderer } from '../game/render';
import { RIM_Z, hoopX, HOOP_Y, type GameEvent } from '../game/types';
import { isMoneyBall, rackSpots } from '../threept/contest';
import type { ContestRun } from '../threept/run';
import { BALLS_PER_RACK, RACKS, type RackId } from '../threept/types';

const SPOTS = rackSpots();
const GOLD = '#ffcb05';
/** The camera sits here (the game's own right-most camera stop) so every rack and the hoop stay in frame. */
const CAM_X = 73;

interface Float { text: string; color: string; x: number; y: number; t: number; big: boolean }

export class CourtView {
  private renderer: Renderer;
  private floats: Float[] = [];
  private run: ContestRun | null = null;
  private time = 0;
  private dt = 0;

  constructor(canvas: HTMLCanvasElement, run: ContestRun) {
    this.run = run;
    const r = new Renderer(canvas);
    r.camTarget = CAM_X;
    r.showUser = false;
    r.snap(run.game);
    r.underlay = (ctx) => this.drawRacks(ctx);
    r.overlay = (ctx) => this.drawFloats(ctx);
    this.renderer = r;
  }

  destroy() { this.run = null; this.renderer.underlay = null; this.renderer.overlay = null; }

  /** Feeds the game's events (made baskets, bursts) to the renderer; the caller clears them. */
  handle(events: GameEvent[], run: ContestRun) { this.renderer.handle(events, run.game); }

  /** A shot was released: the main game's own grade word floats over the shooter on an excellent release. */
  released(grade: string) {
    if (grade === 'perfect' && this.run) {
      const p = this.run.player;
      const at = this.renderer.view(p.x, p.y, p.heightFt + 1.5);
      this.floats.push({ text: 'EXCELLENT', color: '#21d07a', x: at.x, y: at.y, t: 0, big: false });
    }
  }

  /** The ball reached the rim: floating points at the hoop. */
  landed(points: number, money: boolean, make: boolean) {
    if (!make) return;
    const at = this.renderer.view(hoopX(0), HOOP_Y, RIM_Z + 3.5);
    this.floats.push({ text: money ? `+${points} MONEY!` : `+${points}`, color: money ? GOLD : '#ffffff', x: at.x, y: at.y, t: 0, big: true });
  }

  draw(run: ContestRun, dt: number) {
    this.run = run;
    this.time += dt;
    this.dt = dt;
    this.renderer.draw(run.game, dt);
  }

  /** Where rack `r`'s ball stand sits: beside the spot on the half-court side, outside the line. */
  private rackAt(r: RackId) {
    const sp = SPOTS[r];
    return { x: sp.x - 5.5, y: sp.y };
  }

  private drawRacks(ctx: CanvasRenderingContext2D) {
    const run = this.run;
    if (!run) return;
    const R = this.renderer;
    const idx = run.s.ballIndex;
    const inHand = run.stage === 'aim' || run.stage === 'hold' || run.stage === 'flight' || run.stage === 'move';
    ctx.save();
    ctx.textAlign = 'center';
    for (const sp of SPOTS) {
      const r = sp.rack;
      const money = r === run.s.moneyRack;
      // The spot the shooter stands on: a disc on the floor, gold for the money rack, white pulse on the current one.
      const f = R.view(sp.x, sp.y);
      const cur = r === run.rack && run.stage !== 'over';
      ctx.beginPath();
      ctx.ellipse(f.x, f.y, 1.5 * f.s, 0.6 * f.s, 0, 0, Math.PI * 2);
      ctx.fillStyle = money ? 'rgba(255,203,5,0.5)' : cur ? `rgba(255,255,255,${0.35 + 0.15 * Math.sin(this.time * 6)})` : 'rgba(255,255,255,0.22)';
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.strokeStyle = money ? GOLD : 'rgba(255,255,255,0.6)';
      ctx.stroke();

      // The rack: a little cart with the balls still on it.
      const at = this.rackAt(r);
      const p = R.view(at.x, at.y);
      const w = 5.2 * p.s;
      const taken = Math.max(0, Math.min(BALLS_PER_RACK, idx - r * BALLS_PER_RACK));
      const left = BALLS_PER_RACK - taken - (r === run.rack && inHand && idx < RACKS * BALLS_PER_RACK ? 1 : 0);
      ctx.fillStyle = '#20243a';
      ctx.fillRect(Math.round(p.x - w / 2), Math.round(p.y - 2.1 * p.s), Math.round(w), Math.max(2, Math.round(0.5 * p.s)));
      ctx.fillStyle = '#3a3f5c';
      ctx.fillRect(Math.round(p.x - w / 2), Math.round(p.y - 2.1 * p.s), Math.round(w), 1);
      ctx.fillRect(Math.round(p.x - w / 2 + 1), Math.round(p.y - 1.6 * p.s), 1, Math.round(1.6 * p.s));
      ctx.fillRect(Math.round(p.x + w / 2 - 2), Math.round(p.y - 1.6 * p.s), 1, Math.round(1.6 * p.s));
      for (let i = BALLS_PER_RACK - left; i < BALLS_PER_RACK; i++) {
        const bx = p.x - w / 2 + (i + 0.5) * (w / BALLS_PER_RACK);
        const gold = isMoneyBall(r, i, run.s.moneyRack);
        ctx.beginPath();
        ctx.arc(Math.round(bx), Math.round(p.y - 2.1 * p.s - 0.5 * p.s), Math.max(2, 0.5 * p.s), 0, Math.PI * 2);
        ctx.fillStyle = gold ? GOLD : '#e8762c';
        ctx.fill();
        ctx.strokeStyle = gold ? '#fff6d6' : '#5a2a0a';
        ctx.stroke();
      }
      ctx.font = '5px "Press Start 2P", monospace';
      ctx.fillStyle = '#05060f';
      const label = money ? 'MONEY' : sp.label.toUpperCase();
      ctx.fillText(label, Math.round(p.x) + 1, Math.round(p.y + 6) + 1);
      ctx.fillStyle = money ? GOLD : 'rgba(255,255,255,0.85)';
      ctx.fillText(label, Math.round(p.x), Math.round(p.y + 6));
    }
    ctx.restore();
  }

  private drawFloats(ctx: CanvasRenderingContext2D) {
    const dt = this.dt;
    const live: Float[] = [];
    ctx.save();
    ctx.textAlign = 'center';
    for (const f of this.floats) {
      f.t += dt;
      if (f.t > 1.1) continue;
      live.push(f);
      ctx.globalAlpha = Math.max(0, Math.min(1, (1.1 - f.t) * 3));
      ctx.font = `${f.big ? 9 : 6}px "Press Start 2P", monospace`;
      const y = Math.round(f.y - f.t * 16);
      ctx.fillStyle = '#05060f';
      ctx.fillText(f.text, Math.round(f.x) + 1, y + 1);
      ctx.fillStyle = f.color;
      ctx.fillText(f.text, Math.round(f.x), y);
    }
    ctx.restore();
    this.floats = live;
  }
}
