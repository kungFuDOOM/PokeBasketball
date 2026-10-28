import { courtFor, type CourtStyle } from '../data/courts';
import { BANNER_ADS, boardAfterAd } from '../data/ads';
import { badgeSvg } from '../ui/badges';
import { IDEAL_RELEASE, type Game } from './game';
import { getSprite } from './sprites';
import { BALL_R, COURT_L, COURT_W, HOOP_Y, RIM_R, RIM_Z, clamp, rand, type GameEvent, type Player } from './types';

/** The user's marker color (the game's accent yellow). */
const USER_YELLOW = '#ffcb05';
/** "P1" in a 3x5 pixel font. */
const P1_GLYPH = ['###..#.', '#.#.##.', '###..#.', '#....#.', '#...###'];

export const VW = 480;
export const VH = 270;
// Broadcast-style camera from the near sideline: the far sideline is higher and smaller on screen.
const Y_FAR = 98;
const Y_NEAR = 258;
const S_FAR = 5.9;
const S_NEAR = 8.0;
const DEPTH_PX = (Y_NEAR - Y_FAR) / COURT_W;
/** On-screen sprite height in feet; bigger Pokémon draw bigger. */
const spriteFt = (p: Player) => p.heightFt - 0.5;

interface Particle {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  life: number; max: number;
  color: string; size: number;
  gravity: number;
}

interface Pt { x: number; y: number; s: number }

export class Renderer {
  private ctx: CanvasRenderingContext2D;
  private camX = 47;
  /** The yellow ring and "P1" tag on the user's player (off in replays: nobody is playing). */
  showUser = true;
  private crowd: HTMLCanvasElement[] = [];
  private particles: Particle[] = [];
  private flash = 0;
  private hype = 0;
  private meterGhost = { v: 0, w: 0, t: 0, p: null as Player | null };
  private t = 0;
  private court: CourtStyle | null = null;
  private logo: HTMLCanvasElement | null = null;

  constructor(canvas: HTMLCanvasElement) {
    canvas.width = VW;
    canvas.height = VH;
    this.ctx = canvas.getContext('2d')!;
    this.ctx.imageSmoothingEnabled = false;
  }

  /** Builds the crowd and center logo for this game's home floor. */
  private useCourt(court: CourtStyle) {
    this.court = court;
    this.crowd = [this.buildCrowd(0, court.crowd), this.buildCrowd(1, court.crowd)];
    if (court.logo === 'pokeball') return;
    const img = new Image();
    img.onload = () => {
      const c = document.createElement('canvas');
      c.width = 64;
      c.height = 64;
      c.getContext('2d')!.drawImage(img, 0, 0, 64, 64);
      this.logo = c;
    };
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(badgeSvg(court.logo, true, 64))}`;
  }

  private proj(x: number, y: number, z = 0): Pt {
    const d = y / COURT_W;
    const s = S_FAR + (S_NEAR - S_FAR) * d;
    return { x: VW / 2 + (x - this.camX) * s, y: Y_FAR + (Y_NEAR - Y_FAR) * d - z * s * 0.95, s };
  }

  private buildCrowd(frame: number, home: string[]): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = 1200;
    c.height = Y_FAR - 12;
    const g = c.getContext('2d')!;
    g.fillStyle = '#141833';
    g.fillRect(0, 0, c.width, c.height);
    // Mostly home colors, with some visiting fans mixed in.
    const shirts = [...home, ...home, ...home, '#e3350d', '#3b5ba7', '#ffcb05', '#f4f1e8', '#7ac74c', '#2a2f55'];
    const skins = ['#f1c27d', '#c68642', '#8d5524', '#ffdbac', '#e0ac69'];
    let seed = 1337;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let row = 0; row < 12; row++) {
      const y = 6 + row * 6.5;
      g.fillStyle = row % 2 ? '#1c2145' : '#20264f';
      g.fillRect(0, y + 3, c.width, 4);
      for (let x = 2; x < c.width; x += 4 + Math.floor(rnd() * 2)) {
        if (rnd() < 0.12) continue;
        const up = frame === 1 && rnd() < 0.45 ? 1 : 0;
        g.fillStyle = shirts[Math.floor(rnd() * shirts.length)];
        g.fillRect(x, y + 2 - up, 3, 3);
        g.fillStyle = skins[Math.floor(rnd() * skins.length)];
        g.fillRect(x + 1, y - up, 2, 2);
      }
    }
    return c;
  }

  /** Where a court point lands on the 480×270 canvas. */
  screenOf(x: number, y: number, z = 0): { x: number; y: number } {
    const p = this.proj(x, y, z);
    return { x: p.x, y: p.y };
  }

  /** Where a court point lands on the canvas, with the sprite scale (pixels per foot) there. */
  view(x: number, y: number, z = 0): Pt {
    return this.proj(x, y, z);
  }

  /** Just the arena and floor, no game: used for cutscenes. `hype` lights up the stands and the LED board. */
  backdrop(court: CourtStyle, dt: number, hype: boolean) {
    if (this.court !== court) this.useCourt(court);
    this.t += dt;
    this.hype = hype ? 1 : 0;
    this.drawArena(this.ctx);
    this.drawFloor(this.ctx);
  }

  /** Jumps the camera straight to the action instead of easing toward it. */
  snap(g: Game) {
    this.camX = clamp(g.focusX(), 21, COURT_L - 21);
  }

  handle(events: GameEvent[], g: Game) {
    for (const e of events) {
      if (e.kind === 'score') {
        this.hype = 2.5;
        if (e.how === 'dunk') {
          this.flash = 0.18;
          this.burst(g.ball.x, g.ball.y, 10, 26, ['#ffcb05', '#ffffff', '#ee8130'], 9);
        } else if (e.points === 3) {
          this.burst(g.ball.x, g.ball.y, 10, 16, ['#ffcb05', '#f4f1e8'], 6);
        }
      } else if (e.kind === 'block' || e.kind === 'steal') {
        this.burst(g.ball.x, g.ball.y, g.ball.z, 10, ['#ffffff', '#ffcb05'], 6);
      } else if (e.kind === 'special') {
        const p = e.player;
        this.flash = 0.12;
        const k = p.mon.special;
        const col = k === 'freeze' ? ['#96d9d6', '#ffffff'] : k === 'quake' ? ['#e2bf65', '#8a6a3a'] : k === 'phase' ? ['#735797', '#c9b6ff'] : ['#ffcb05', '#ffffff'];
        this.burst(p.x, p.y, 3, 30, col, 12);
      } else if (e.kind === 'shove' && e.ok) {
        this.burst(e.victim.x, e.victim.y, 4, 10, ['#ffffff', '#ff6b6b'], 7);
      }
    }
  }

  private burst(x: number, y: number, z: number, n: number, colors: string[], speed: number) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, Math.PI * 2);
      const sp = rand(speed * 0.4, speed);
      this.particles.push({
        x, y, z,
        vx: Math.cos(a) * sp, vy: Math.sin(a) * sp, vz: rand(2, speed),
        life: rand(0.4, 0.9), max: 0.9,
        color: colors[i % colors.length], size: rand(1, 2.5), gravity: 18,
      });
    }
  }

  draw(g: Game, dt: number) {
    this.t += dt;
    const ctx = this.ctx;
    this.flash = Math.max(0, this.flash - dt);
    this.hype = Math.max(0, this.hype - dt);

    const target = clamp(g.focusX(), 21, COURT_L - 21);
    this.camX += (target - this.camX) * Math.min(1, dt * 3.5);

    ctx.save();
    if (g.shake > 0) ctx.translate(Math.round(rand(-1, 1) * g.shake * 3), Math.round(rand(-1, 1) * g.shake * 3));

    if (!this.court) this.useCourt(g.cfg.court ?? courtFor(g.teams[0]));
    this.drawArena(ctx);
    this.drawFloor(ctx);

    // Shadows first, then depth-sorted players, ball and hoops.
    for (const p of g.players) this.shadow(ctx, p.x, p.y, p.z, 1.1 * p.size);
    const b = g.ball;
    this.shadow(ctx, b.x, b.y, b.z, 0.6);

    const items: { y: number; draw: () => void }[] = [];
    for (const p of g.players) items.push({ y: p.y, draw: () => this.drawPlayer(ctx, g, p) });
    items.push({ y: b.y + (b.owner ? 0.01 : 0), draw: () => this.drawBall(ctx, g) });
    items.push({ y: HOOP_Y + 0.02, draw: () => this.drawHoop(ctx, g, 0) });
    items.push({ y: HOOP_Y + 0.02, draw: () => this.drawHoop(ctx, g, 1) });
    items.sort((a, c) => a.y - c.y);
    for (const it of items) it.draw();

    this.updateParticles(ctx, g, dt);
    this.drawMeter(ctx, g, dt);
    this.drawJumpMeter(ctx, g, dt);
    this.drawUserMarker(ctx, g);
    ctx.restore();

    if (this.flash > 0) {
      ctx.fillStyle = `rgba(255,255,255,${this.flash * 2.5})`;
      ctx.fillRect(0, 0, VW, VH);
    }
  }

  private drawArena(ctx: CanvasRenderingContext2D) {
    ctx.fillStyle = '#0b0e22';
    ctx.fillRect(0, 0, VW, VH);
    const frame = this.hype > 0 ? Math.floor(this.t * 8) % 2 : Math.floor(this.t * 1.5) % 2;
    const crowd = this.crowd[Math.abs(frame) % 2];
    const off = -((this.camX * S_FAR * 0.85) % crowd.width) - 200;
    for (let x = off; x < VW; x += crowd.width) ctx.drawImage(crowd, Math.round(x), 0);
    // LED ad board along the far sideline: 20px tall, bottom edge at Y_FAR-2, growing up over the crowd. It runs a little past both edges so screen shake never uncovers the ends.
    const top = Y_FAR - 22;
    ctx.fillStyle = '#05060f';
    ctx.fillRect(-4, top, VW + 8, 20);
    const edge = this.court!.boardColor;
    const color = this.hype > 0 && Math.floor(this.t * 6) % 2 ? '#ffffff' : edge;
    ctx.fillStyle = edge;
    ctx.fillRect(-4, top, VW + 8, 1);
    ctx.fillRect(-4, top + 19, VW + 8, 1);
    ctx.font = '8px "Press Start 2P", monospace';
    ctx.textBaseline = 'alphabetic';
    const base = top + 13;
    const ads = this.hype > 0 ? [] : BANNER_ADS.filter((a) => a.enabled);
    const ad = ads.length > 0;
    const msg = this.hype > 0 ? '  BUCKETS!  ★  BUCKETS!  ★ ' : ad ? `  ★ ${boardAfterAd(this.court!.board)}  ★ ` : `  ${this.court!.board}  ★ `;
    // Whole-pixel layout: [lead] then one equal-width half per enabled ad, each [frame 2px][pad][tag box][gap][text][pad][frame 2px], then the board text, so every repeat is identical and joins cleanly. Long ad text is condensed horizontally to fit its half.
    const lead = 4, pad = 4, gap = 4, tagPad = 3, halfW = 190;
    const blockW = halfW * ads.length;
    const msgX = ad ? lead + blockW : 0;
    const w = msgX + Math.ceil(ctx.measureText(msg).width || 400);
    const scroll = -Math.floor((this.camX * S_FAR + this.t * 12) % w);
    const pulse = 0.8 + 0.2 * (Math.floor(this.t * 2) % 2);
    for (let x = scroll - w; x < VW + 4; x += w) {
      ads.forEach((a, i) => {
        const bx = x + lead + i * halfW;
        const tx = bx + 2 + pad;
        const tagW = Math.ceil(ctx.measureText(a.tag).width) + tagPad * 2;
        const room = halfW - 4 - pad * 2 - tagW - gap;
        const textW = Math.ceil(ctx.measureText(a.text).width);
        const k = Math.min(1, room / textW);
        ctx.globalAlpha = pulse;
        ctx.fillStyle = a.border;
        ctx.fillRect(bx, top + 2, halfW, 16);
        ctx.globalAlpha = 1;
        ctx.fillStyle = '#05060f';
        ctx.fillRect(bx + 1, top + 3, halfW - 2, 14);
        ctx.fillStyle = a.bg;
        ctx.fillRect(bx + 2, top + 4, halfW - 4, 12);
        ctx.fillStyle = a.tagBg;
        ctx.fillRect(tx, top + 5, tagW, 10);
        ctx.fillStyle = '#ffffff';
        ctx.fillText(a.tag, tx + tagPad, base);
        ctx.fillStyle = a.color;
        ctx.save();
        ctx.translate(tx + tagW + gap + Math.floor((room - textW * k) / 2), base);
        ctx.scale(k, 1);
        ctx.fillText(a.text, 0, 0);
        ctx.restore();
      });
      ctx.fillStyle = color;
      ctx.fillText(msg, x + msgX, base);
    }
  }

  private poly(ctx: CanvasRenderingContext2D, pts: [number, number][], z = 0) {
    ctx.beginPath();
    pts.forEach(([x, y], i) => {
      const p = this.proj(x, y, z);
      if (i) ctx.lineTo(p.x, p.y);
      else ctx.moveTo(p.x, p.y);
    });
    ctx.closePath();
  }

  private arcPts(cx: number, cy: number, r: number, a0: number, a1: number, n = 28): [number, number][] {
    const pts: [number, number][] = [];
    for (let i = 0; i <= n; i++) {
      const a = a0 + ((a1 - a0) * i) / n;
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
    }
    return pts;
  }

  private line(ctx: CanvasRenderingContext2D, pts: [number, number][]) {
    ctx.beginPath();
    pts.forEach(([x, y], i) => {
      const p = this.proj(x, y);
      if (i) ctx.lineTo(Math.round(p.x) + 0.5, Math.round(p.y) + 0.5);
      else ctx.moveTo(Math.round(p.x) + 0.5, Math.round(p.y) + 0.5);
    });
    ctx.stroke();
  }

  /** Draws an image flat on the floor, centered on court point (x, y), `w` by `h` feet. */
  private floorImage(ctx: CanvasRenderingContext2D, draw: () => void, x: number, y: number, w: number, h: number) {
    const p = this.proj(x, y);
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.scale(p.s * w, DEPTH_PX * h);
    draw();
    ctx.restore();
  }

  private drawFloor(ctx: CanvasRenderingContext2D) {
    const court = this.court!;
    // Apron
    ctx.fillStyle = court.apron;
    this.poly(ctx, [[-30, -2], [COURT_L + 30, -2], [COURT_L + 30, COURT_W + 6], [-30, COURT_W + 6]]);
    ctx.fill();
    // Hardwood
    ctx.fillStyle = court.wood;
    this.poly(ctx, [[0, 0], [COURT_L, 0], [COURT_L, COURT_W], [0, COURT_W]]);
    ctx.fill();
    ctx.fillStyle = 'rgba(40,20,0,0.07)';
    for (let y = 0; y < COURT_W; y += 2.5) {
      this.poly(ctx, [[0, y], [COURT_L, y], [COURT_L, y + 1.25], [0, y + 1.25]]);
      ctx.fill();
    }
    // Paint
    ctx.fillStyle = court.paint;
    ctx.globalAlpha = 0.8;
    this.poly(ctx, [[0, 17], [19, 17], [19, 33], [0, 33]]);
    ctx.fill();
    this.poly(ctx, [[COURT_L - 19, 17], [COURT_L, 17], [COURT_L, 33], [COURT_L - 19, 33]]);
    ctx.fill();
    ctx.globalAlpha = 1;

    if (court.logo === 'pokeball') {
      // Center court Poké Ball
      ctx.fillStyle = '#e3350d';
      this.poly(ctx, this.arcPts(47, 25, 6, Math.PI, Math.PI * 2));
      ctx.fill();
      ctx.fillStyle = '#f4f1e8';
      this.poly(ctx, this.arcPts(47, 25, 6, 0, Math.PI));
      ctx.fill();
      ctx.fillStyle = '#1b1b1b';
      this.poly(ctx, [[41, 24.4], [53, 24.4], [53, 25.6], [41, 25.6]]);
      ctx.fill();
      this.poly(ctx, this.arcPts(47, 25, 2, 0, Math.PI * 2, 20));
      ctx.fill();
      ctx.fillStyle = '#f4f1e8';
      this.poly(ctx, this.arcPts(47, 25, 1.3, 0, Math.PI * 2, 20));
      ctx.fill();
    } else {
      // The home gym's badge at center court
      ctx.fillStyle = court.paint;
      this.poly(ctx, this.arcPts(47, 25, 6, 0, Math.PI * 2, 40));
      ctx.fill();
      const logo = this.logo;
      if (logo) this.floorImage(ctx, () => ctx.drawImage(logo, -0.5, -0.5, 1, 1), 47, 25, 9.5, 9.5);
    }
    // Home name painted near the far sideline
    ctx.font = '10px "Press Start 2P", monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(court.floorText).width || 100;
    const fh = Math.min(3.2, (34 / tw) * 10);
    ctx.globalAlpha = 0.45;
    ctx.fillStyle = court.lines;
    this.floorImage(ctx, () => ctx.fillText(court.floorText, 0, 0), 47, 9, fh / 10, fh / 10);
    ctx.globalAlpha = 1;
    ctx.textAlign = 'start';

    ctx.strokeStyle = court.lines;
    ctx.lineWidth = 1;
    this.line(ctx, [[0, 0], [COURT_L, 0], [COURT_L, COURT_W], [0, COURT_W], [0, 0]]);
    this.line(ctx, [[47, 0], [47, COURT_W]]);
    this.line(ctx, this.arcPts(47, 25, 6, 0, Math.PI * 2, 40));
    for (const side of [0, 1]) {
      const base = side ? COURT_L : 0;
      const dir = side ? -1 : 1;
      const hx = base + dir * 5.25;
      this.line(ctx, [[base, 17], [base + dir * 19, 17], [base + dir * 19, 33], [base, 33]]);
      this.line(ctx, this.arcPts(base + dir * 19, 25, 6, 0, Math.PI * 2, 32));
      // Three-point line: straight corners, then the arc
      const a = Math.asin(22 / 23.75);
      const cornerX = hx + dir * Math.cos(a) * 23.75;
      this.line(ctx, [[base, 3], [cornerX, 3]]);
      this.line(ctx, [[base, 47], [cornerX, 47]]);
      this.line(ctx, side ? this.arcPts(hx, 25, 23.75, Math.PI - a, Math.PI + a, 40) : this.arcPts(hx, 25, 23.75, -a, a, 40));
      this.line(ctx, side ? this.arcPts(hx, 25, 4, Math.PI / 2, Math.PI * 1.5, 16) : this.arcPts(hx, 25, 4, -Math.PI / 2, Math.PI / 2, 16));
    }
  }

  private shadow(ctx: CanvasRenderingContext2D, x: number, y: number, z: number, r: number) {
    const p = this.proj(x, y);
    const k = clamp(1 - z / 16, 0.35, 1);
    ctx.fillStyle = `rgba(20,10,0,${0.32 * k})`;
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, r * p.s * k, r * DEPTH_PX * 0.55 * k + 0.5, 0, 0, Math.PI * 2);
    ctx.fill();
  }

  private drawPlayer(ctx: CanvasRenderingContext2D, g: Game, p: Player) {
    const team = g.teams[p.team];
    const foot = this.proj(p.x, p.y);
    // Team ring under the feet
    const rx = 1.15 * p.size * foot.s;
    const ry = 1.15 * p.size * DEPTH_PX * 0.6;
    // Dark outline first so the ring reads on light and dark floors alike.
    ctx.beginPath();
    ctx.ellipse(foot.x, foot.y, rx + 1, ry + 1, 0, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(foot.x, foot.y, rx, ry, 0, 0, Math.PI * 2);
    // Only the player this screen controls gets the yellow ring (an online opponent's pick stays plain).
    const mine = this.showUser && p.human && p.team === g.viewTeam;
    ctx.fillStyle = team.color + (mine ? 'cc' : '88');
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = mine ? USER_YELLOW : team.color;
    ctx.stroke();
    if (mine) {
      // A pulsing yellow halo around the user's ring so they stand out in a crowded paint.
      const k = 1.25 + 0.15 * Math.sin(this.t * 8);
      ctx.beginPath();
      ctx.ellipse(foot.x, foot.y, rx * k + 1, ry * k + 1, 0, 0, Math.PI * 2);
      ctx.lineWidth = 1.5;
      ctx.strokeStyle = 'rgba(255,203,5,0.75)';
      ctx.stroke();
    }

    const pos = this.proj(p.x, p.y, p.z);
    const spr = getSprite(p.mon.dex, p.back);
    const targetPx = spriteFt(p) * pos.s;
    let bob = 0;
    const moving = Math.hypot(p.vx, p.vy) > 2;
    if (moving && p.z === 0 && p.state === 'free') bob = Math.abs(Math.sin(p.runPhase * 2.2)) * 1.6;

    ctx.save();
    ctx.translate(Math.round(pos.x), Math.round(pos.y - bob));
    if (p.fx.phase > 0) ctx.globalAlpha = 0.35 + 0.2 * Math.sin(this.t * 30);
    if (p.state === 'stun') ctx.rotate((Math.PI / 2) * -p.facing * Math.min(1, (1.2 - p.stateT) * 6));
    if (p.state === 'dunk' && p.dunk?.spin) {
      const k = p.dunk.t / p.dunk.T;
      ctx.translate(0, -targetPx / 2);
      ctx.rotate(k * Math.PI * 2 * p.facing);
      ctx.translate(0, targetPx / 2);
    }
    if (spr) {
      const k = targetPx / Math.max(spr.w, spr.h);
      const w = spr.w * k;
      const h = spr.h * k;
      let sx = p.facing === 1 ? -1 : 1;
      if (p.back) sx = -sx;
      const squash = p.vz > 4 ? 1.08 : 1;
      ctx.scale(sx, squash);
      ctx.drawImage(spr.img, Math.round(-w / 2), Math.round(-h), Math.round(w), Math.round(h));
    } else {
      // Sprite failed to load: a team-colored token with the initial.
      ctx.fillStyle = team.color;
      ctx.beginPath();
      ctx.arc(0, -targetPx / 2, targetPx / 2.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#fff';
      ctx.font = '8px "Press Start 2P", monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(p.mon.name[0], 0, -targetPx / 2);
    }
    ctx.restore();

    const head = this.proj(p.x, p.y, p.z + spriteFt(p) + 0.3);
    if (p.state === 'stun') {
      for (let i = 0; i < 3; i++) {
        const a = this.t * 6 + (i * Math.PI * 2) / 3;
        ctx.fillStyle = '#ffcb05';
        ctx.fillRect(Math.round(foot.x + Math.cos(a) * 7), Math.round(foot.y - 10 + Math.sin(a) * 2), 2, 2);
      }
    }
    if (p.fire && Math.random() < 0.7) this.emit(p, ['#ff4d00', '#ffcb05', '#ff8a00'], 6);
    if (p.fx.surge > 0 && Math.random() < 0.5) this.emit(p, ['#ffe066', '#ffffff'], 3);
    if (p.fx.slow > 0 && Math.random() < 0.3) this.emit(p, ['#bfefff', '#ffffff'], 2);
    if (p.turboOn && p.z === 0 && Math.random() < 0.4) {
      this.particles.push({ x: p.x, y: p.y, z: 0.2, vx: -p.vx * 0.1, vy: -p.vy * 0.1, vz: 1, life: 0.3, max: 0.3, color: 'rgba(255,255,255,0.7)', size: 1.5, gravity: 0 });
    }
    if (p.fx.lockin) {
      ctx.strokeStyle = '#f95587';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(head.x, head.y - 3, 3 + Math.sin(this.t * 8), 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  private emit(p: Player, colors: string[], up: number) {
    this.particles.push({
      x: p.x + rand(-0.8, 0.8), y: p.y + rand(-0.3, 0.3), z: p.z + rand(0.5, p.heightFt),
      vx: rand(-1, 1), vy: rand(-0.5, 0.5), vz: rand(up * 0.5, up),
      life: rand(0.3, 0.6), max: 0.6,
      color: colors[Math.floor(Math.random() * colors.length)], size: rand(1, 2.2), gravity: 0,
    });
  }

  private drawBall(ctx: CanvasRenderingContext2D, g: Game) {
    const b = g.ball;
    const p = this.proj(b.x, b.y, b.z);
    const r = Math.max(2.5, BALL_R * 1.6 * p.s);
    const onFire = b.owner?.fire || b.shot?.shooter.fire;
    if (onFire && Math.random() < 0.8) {
      this.particles.push({ x: b.x, y: b.y, z: b.z, vx: rand(-1, 1), vy: 0, vz: rand(1, 4), life: 0.35, max: 0.35, color: Math.random() < 0.5 ? '#ff4d00' : '#ffcb05', size: 2, gravity: 0 });
    }
    ctx.fillStyle = '#e8762c';
    ctx.beginPath();
    ctx.arc(Math.round(p.x), Math.round(p.y), r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#5a2a0a';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.beginPath();
    const a = b.spin;
    ctx.moveTo(p.x + Math.cos(a) * r, p.y + Math.sin(a) * r);
    ctx.lineTo(p.x - Math.cos(a) * r, p.y - Math.sin(a) * r);
    ctx.stroke();
    ctx.fillStyle = 'rgba(255,255,255,0.45)';
    ctx.fillRect(Math.round(p.x - r * 0.45), Math.round(p.y - r * 0.55), 1, 1);
  }

  private drawHoop(ctx: CanvasRenderingContext2D, g: Game, idx: 0 | 1) {
    const base = idx ? COURT_L : 0;
    const dir = idx ? -1 : 1;
    const hx = base + dir * 5.25;
    const bx = base + dir * 4;
    const shake = Math.sin(this.t * 50) * g.rimShake[idx] * 0.35;
    // Stanchion and arm
    const poleBase = this.proj(base - dir * 3, HOOP_Y);
    const poleTop = this.proj(base - dir * 3, HOOP_Y, 12.5);
    const armEnd = this.proj(bx, HOOP_Y, 12.5);
    ctx.fillStyle = '#2b2f45';
    ctx.fillRect(Math.round(poleBase.x - 3), Math.round(poleTop.y), 6, Math.round(poleBase.y - poleTop.y));
    ctx.fillStyle = this.court!.paint;
    ctx.fillRect(Math.round(poleBase.x - 4), Math.round(poleBase.y - 18), 8, 18);
    ctx.strokeStyle = '#3a3f5c';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(poleTop.x, poleTop.y);
    ctx.lineTo(armEnd.x, armEnd.y);
    ctx.stroke();
    // Backboard (glass face toward the court, drawn a little thick so it reads from the side camera)
    const corners: [number, number, number][] = [[bx, 22, 9 + shake], [bx, 28, 9 + shake], [bx, 28, 13.5 + shake], [bx, 22, 13.5 + shake]];
    const pts = corners.map(([x, y, z]) => this.proj(x, y, z));
    const thick = 2.5 * dir;
    ctx.fillStyle = 'rgba(220,235,255,0.55)';
    ctx.beginPath();
    pts.forEach((q, i) => (i ? ctx.lineTo(q.x + thick * (i === 1 || i === 2 ? 1 : 0), q.y) : ctx.moveTo(q.x, q.y)));
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 1;
    ctx.stroke();
    const inner = [[bx, 24, 10], [bx, 26, 10], [bx, 26, 11.5], [bx, 24, 11.5]].map(([x, y, z]) => this.proj(x, y, z + shake));
    ctx.strokeStyle = '#e3350d';
    ctx.beginPath();
    inner.forEach((q, i) => (i ? ctx.lineTo(q.x, q.y) : ctx.moveTo(q.x, q.y)));
    ctx.closePath();
    ctx.stroke();

    // Net
    const rim = this.proj(hx, HOOP_Y, RIM_Z + shake);
    const rrx = RIM_R * rim.s;
    const rry = RIM_R * DEPTH_PX;
    const swish = g.netT[idx];
    const netLen = 1.6 * rim.s * 0.95 * (1 + swish * 0.6);
    ctx.strokeStyle = 'rgba(255,255,255,0.85)';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 6; i++) {
      const a = (i / 6) * Math.PI;
      const x0 = rim.x + Math.cos(a) * rrx;
      const y0 = rim.y + Math.sin(a) * rry;
      const x1 = rim.x + Math.cos(a) * rrx * 0.55 + Math.sin(this.t * 40) * swish * 2;
      const y1 = rim.y + netLen + Math.sin(a) * rry * 0.5;
      ctx.beginPath();
      ctx.moveTo(x0, y0);
      ctx.lineTo(x1, y1);
      ctx.stroke();
    }
    ctx.beginPath();
    ctx.ellipse(rim.x, rim.y + netLen * 0.55, rrx * 0.75, rry * 0.7, 0, 0, Math.PI * 2);
    ctx.stroke();
    // Rim
    ctx.strokeStyle = '#ff5a1f';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(rim.x, rim.y, rrx, rry, 0, 0, Math.PI * 2);
    ctx.stroke();
  }

  private updateParticles(ctx: CanvasRenderingContext2D, g: Game, dt: number) {
    const live: Particle[] = [];
    for (const q of this.particles) {
      if (!g.paused) {
        q.life -= dt;
        q.vz -= q.gravity * dt;
        q.x += q.vx * dt;
        q.y += q.vy * dt;
        q.z = Math.max(0, q.z + q.vz * dt);
      }
      if (q.life <= 0) continue;
      live.push(q);
      const p = this.proj(q.x, q.y, q.z);
      ctx.globalAlpha = clamp(q.life / q.max * 1.5, 0, 1);
      ctx.fillStyle = q.color;
      const s = Math.max(1, Math.round(q.size));
      ctx.fillRect(Math.round(p.x), Math.round(p.y), s, s);
    }
    ctx.globalAlpha = 1;
    this.particles = live.length > 400 ? live.slice(-400) : live;
  }

  private drawMeter(ctx: CanvasRenderingContext2D, g: Game, dt: number) {
    const u = g.user;
    const m = this.meterGhost;
    if (u && u.state === 'shoot') {
      m.v = u.meter; m.w = g.greenWindow(u); m.t = 0.5; m.p = u;
    } else m.t -= dt;
    if (m.t <= 0 || !m.p) return;
    const p = m.p;
    const at = this.proj(p.x, p.y, p.z + spriteFt(p));
    const x = Math.round(at.x + 10 * (p.facing === 1 ? -1 : 1) - 3);
    const h = 30;
    const y = Math.round(at.y - 4);
    ctx.globalAlpha = clamp(m.t * 3, 0, 1);
    ctx.fillStyle = '#05060f';
    ctx.fillRect(x - 1, y - 1, 7, h + 2);
    const lo = clamp(IDEAL_RELEASE - m.w, 0, 1);
    const hi = clamp(IDEAL_RELEASE + m.w, 0, 1);
    ctx.fillStyle = '#2f3560';
    ctx.fillRect(x, y, 5, h);
    ctx.fillStyle = '#21d07a';
    ctx.fillRect(x, Math.round(y + h - hi * h), 5, Math.max(1, Math.round((hi - lo) * h)));
    const v = clamp(m.v, 0, 1.1);
    const inGreen = m.v >= lo && m.v <= hi;
    ctx.fillStyle = inGreen ? '#ffffff' : '#ffcb05';
    ctx.fillRect(x - 1, Math.round(y + h - Math.min(1, v) * h), 7, 2);
    ctx.globalAlpha = 1;
  }

  private jumpGhost = { v: 0, w: 0, t: 0 };

  /** Tip-off timing meter over the user's jumper: fill to the green band (the ball's peak) and jump. */
  private drawJumpMeter(ctx: CanvasRenderingContext2D, g: Game, dt: number) {
    const j = g.tipoff;
    const m = this.jumpGhost;
    const vt = g.viewTeam;
    const p = j?.jumpers[vt];
    if (j && p?.human && j.t >= -0.4) {
      m.v = j.at[vt] ?? g.jumpMeter();
      m.w = j.window;
      m.t = j.at[vt] === null ? 0.7 : m.t - dt;
    } else m.t -= dt;
    if (m.t <= 0) return;
    const top = 1.5;
    const who = j?.jumpers[vt] ?? g.user;
    if (!who) return;
    const at = this.proj(who.x, who.y, who.z + spriteFt(who));
    const x = Math.round(at.x - 18);
    const h = 36;
    const y = Math.round(at.y - 10);
    ctx.globalAlpha = clamp(m.t * 3, 0, 1);
    ctx.fillStyle = '#05060f';
    ctx.fillRect(x - 1, y - 1, 8, h + 2);
    ctx.fillStyle = '#2f3560';
    ctx.fillRect(x, y, 6, h);
    const lo = (1 - m.w) / top;
    const hi = (1 + m.w) / top;
    ctx.fillStyle = '#21d07a';
    ctx.fillRect(x, Math.round(y + h - hi * h), 6, Math.max(2, Math.round((hi - lo) * h)));
    const v = clamp(m.v / top, 0, 1);
    const inGreen = m.v >= 1 - m.w && m.v <= 1 + m.w;
    ctx.fillStyle = inGreen ? '#ffffff' : '#ffcb05';
    ctx.fillRect(x - 1, Math.round(y + h - v * h) - 1, 8, 2);
    if (j && j.at[0] === null) {
      ctx.font = '6px "Press Start 2P", monospace';
      ctx.textAlign = 'center';
      ctx.fillStyle = '#05060f';
      ctx.fillText(j.t < 0 ? 'JUMP BALL' : 'JUMP AT THE TOP!', Math.round(at.x) + 1, y - 5);
      ctx.fillStyle = j.t < 0 ? '#ffffff' : '#ffcb05';
      ctx.fillText(j.t < 0 ? 'JUMP BALL' : 'JUMP AT THE TOP!', Math.round(at.x), y - 6);
      ctx.textAlign = 'start';
    }
    ctx.globalAlpha = 1;
  }

  /** A yellow "P1" tag with a pointer over the user's player, drawn above everything else. */
  private drawUserMarker(ctx: CanvasRenderingContext2D, g: Game) {
    const u = g.user;
    if (!u || !this.showUser) return;
    const head = this.proj(u.x, u.y, u.z + spriteFt(u) + 1.2);
    const x = clamp(Math.round(head.x), 11, VW - 11);
    const y = Math.max(16, Math.round(head.y - 3 + Math.sin(this.t * 6)));
    // Pointer
    ctx.fillStyle = '#05060f';
    ctx.beginPath();
    ctx.moveTo(x - 5, y - 4);
    ctx.lineTo(x + 5, y - 4);
    ctx.lineTo(x, y + 2);
    ctx.closePath();
    ctx.fill();
    ctx.fillStyle = USER_YELLOW;
    ctx.beginPath();
    ctx.moveTo(x - 3.5, y - 4);
    ctx.lineTo(x + 3.5, y - 4);
    ctx.lineTo(x, y);
    ctx.closePath();
    ctx.fill();
    // "P1" tag, lettered pixel by pixel so it stays crisp at this size
    ctx.fillStyle = '#05060f';
    ctx.fillRect(x - 7, y - 13, 15, 9);
    ctx.fillStyle = USER_YELLOW;
    ctx.fillRect(x - 6, y - 12, 13, 7);
    ctx.fillStyle = '#05060f';
    P1_GLYPH.forEach((row, j) => [...row].forEach((c, i) => { if (c === '#') ctx.fillRect(x - 4 + i, y - 11 + j, 1, 1); }));
    if (head.x < 0 || head.x > VW) {
      ctx.fillStyle = '#ffffff';
      ctx.font = '6px "Press Start 2P", monospace';
      ctx.textAlign = head.x < 0 ? 'left' : 'right';
      ctx.fillText(head.x < 0 ? '◀ P1' : 'P1 ▶', head.x < 0 ? 2 : VW - 2, y + 10);
      ctx.textAlign = 'start';
    }
  }
}
