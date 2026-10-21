// NBA Jam-style trailer, rendered from the real game engine.
// Seeded CPU-vs-CPU games are scanned for highlights, then replayed frame by frame (with slow motion
// on the big moments) under title cards and callouts. scripts/render-trailer.mjs captures the frames
// and scores the result; open /trailer.html?play in the dev server to preview it in real time.
import '../fonts.css';
import { monByDex, TYPE_COLORS, type Mon } from '../data/pokemon';
import { Game, type Sfx } from '../game/game';
import { DUNK_MOVES } from '../game/hud';
import { Renderer, VH, VW } from '../game/render';
import { getSprite, preload } from '../game/sprites';
import type { GameEvent, TeamDef } from '../game/types';
import { tier } from '../util';

export const FPS = 30;
const W = 1920;
const H = 1080;
const STEP = 1 / 60;

// ---------- deterministic simulation ----------

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A game whose every random roll comes from its own seeded stream, so replays match the scan exactly. */
class SeededGame {
  g: Game;
  private rng: () => number;
  step = 0;

  constructor(seed: number) {
    this.rng = mulberry32(seed);
    this.g = this.seeded(() => new Game({ home: HOME, away: AWAY, quarterLen: 120, difficulty: 'pro' }));
  }

  private seeded<T>(fn: () => T): T {
    const orig = Math.random;
    Math.random = this.rng;
    try {
      return fn();
    } finally {
      Math.random = orig;
    }
  }

  advance(n: number) {
    this.seeded(() => {
      for (let i = 0; i < n; i++) {
        this.g.update(STEP);
        this.step++;
      }
    });
  }
}

const mons = (dexes: number[]) => dexes.map(monByDex);
const HOME: TeamDef = {
  name: 'Pallet Town', abbr: 'PAL', color: '#3b6fd8', color2: '#16224a', human: false,
  roster: mons([25, 448, 6, 445, 143]),
};
const AWAY: TeamDef = {
  name: 'Team Rocket', abbr: 'RKT', color: '#d8343b', color2: '#3a1218', human: false,
  roster: mons([65, 381, 94, 150, 149]),
};

// ---------- highlight scan ----------

interface Highlight {
  seed: number;
  step: number;
  kind: 'dunk' | 'three' | 'block' | 'fire';
  player: number;
  oop: boolean;
  spin: boolean;
  dist: number;
  score: number;
}

interface Scan {
  seed: number;
  quarterSteps: number[];
  end: number;
  highlights: Highlight[];
}

function scanGame(seed: number): Scan {
  const sg = new SeededGame(seed);
  const g = sg.g;
  const quarterSteps: number[] = [];
  const highlights: Highlight[] = [];
  const dunkInfo = new Map<number, { spin: boolean; dist: number; oop: boolean }>();
  const lastOop = new Map<number, number>();
  while (g.phase !== 'final' && sg.step < 60 * 60 * 20) {
    const before = new Set(g.players.filter((p) => p.state === 'dunk').map((p) => p.id));
    sg.advance(1);
    for (const p of g.players) {
      if (p.state === 'dunk' && p.dunk && !before.has(p.id)) {
        dunkInfo.set(p.id, { spin: p.dunk.spin, dist: Math.hypot(p.dunk.x1 - p.dunk.x0, p.dunk.y1 - p.dunk.y0), oop: p.dunk.oop });
      }
    }
    for (const e of g.events.splice(0)) {
      const k = sg.step;
      if (e.kind === 'quarter') quarterSteps.push(k);
      else if (e.kind === 'oop') lastOop.set(e.player.id, k);
      else if (e.kind === 'score' && e.how === 'dunk') {
        const d = dunkInfo.get(e.player.id) ?? { spin: false, dist: 0, oop: false };
        const oop = d.oop || k - (lastOop.get(e.player.id) ?? -999) < 90;
        highlights.push({ seed, step: k, kind: 'dunk', player: e.player.id, oop, spin: d.spin, dist: d.dist, score: (oop ? 4 : 0) + (d.spin ? 2 : 0) + d.dist / 4 });
      } else if (e.kind === 'score' && e.points === 3) {
        highlights.push({ seed, step: k, kind: 'three', player: e.player.id, oop: false, spin: false, dist: 0, score: 1 });
      } else if (e.kind === 'block') {
        highlights.push({ seed, step: k, kind: 'block', player: e.player.id, oop: false, spin: false, dist: 0, score: 2 });
      } else if (e.kind === 'fire' && e.on) {
        highlights.push({ seed, step: k, kind: 'fire', player: e.player.id, oop: false, spin: false, dist: 0, score: 2 });
      }
    }
    g.sfx.length = 0;
  }
  return { seed, quarterSteps, end: sg.step, highlights };
}

// ---------- timeline ----------

interface ClipPlan {
  h: Highlight;
  start: number; // first sim step
  per: number[]; // sim steps advanced on each frame (2 = real time, 1 = half-speed replay)
  eventFrame: number;
}

type Segment =
  | { kind: 'intro' | 'logo' | 'draft' | 'types' | 'evolve' | 'franchise' | 'outro'; t0: number; t1: number }
  | { kind: 'clip'; t0: number; t1: number; plan: ClipPlan; style: 'hero' | 'montage' };

/** Builds the per-frame step schedule so the highlight lands on `eventAt` seconds into the slot. */
function plan(h: Highlight, scan: Scan, seconds: number, eventAt: number, slow: boolean): ClipPlan | null {
  const frames = Math.round(seconds * FPS);
  const eventFrame = Math.round(eventAt * FPS);
  const per = Array.from({ length: frames }, (_, f) => (slow && f >= eventFrame - 40 && f < eventFrame + 14 ? 1 : 2));
  const before = per.slice(0, eventFrame).reduce((a, b) => a + b, 0);
  const after = per.slice(eventFrame).reduce((a, b) => a + b, 0);
  const start = h.step - before;
  const end = h.step + after;
  if (start < 120 || end > scan.end - 30) return null;
  if (scan.quarterSteps.some((q) => q > start - 200 && q < end)) return null;
  return { h, start, per, eventFrame };
}

// ---------- drawing helpers ----------

const stage = document.querySelector<HTMLCanvasElement>('#stage')!;
stage.width = W;
stage.height = H;
const ctx = stage.getContext('2d')!;
ctx.imageSmoothingEnabled = false;

const PIXEL = '"Press Start 2P", monospace';
const SPORT = '"Barlow Condensed", "Arial Narrow", sans-serif';

function fireGradient(c: CanvasRenderingContext2D, size: number) {
  const g = c.createLinearGradient(0, -size / 2, 0, size / 2);
  g.addColorStop(0, '#fff7a8');
  g.addColorStop(0.35, '#ffcb05');
  g.addColorStop(0.75, '#ff7a00');
  g.addColorStop(1, '#e3350d');
  return g;
}

/** Chunky italic arcade text with a thick outline and drop shadow. */
function jamText(text: string, x: number, y: number, size: number, opts: { fill?: string | CanvasGradient; scale?: number; alpha?: number; maxW?: number } = {}) {
  ctx.save();
  ctx.font = `${size}px ${PIXEL}`;
  const w = ctx.measureText(text).width;
  const fit = Math.min(1, (opts.maxW ?? W - 160) / w);
  ctx.translate(x, y);
  ctx.scale((opts.scale ?? 1) * fit, (opts.scale ?? 1) * fit);
  ctx.transform(1, 0, -0.16, 1, 0, 0);
  ctx.globalAlpha = opts.alpha ?? 1;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  ctx.fillStyle = '#000';
  ctx.fillText(text, size * 0.14, size * 0.16);
  ctx.lineWidth = size * 0.3;
  ctx.strokeStyle = '#000';
  ctx.strokeText(text, 0, 0);
  ctx.lineWidth = size * 0.12;
  ctx.strokeStyle = '#e3350d';
  ctx.strokeText(text, 0, 0);
  ctx.fillStyle = opts.fill ?? fireGradient(ctx, size);
  ctx.fillText(text, 0, 0);
  ctx.restore();
}

function plainText(text: string, x: number, y: number, size: number, color = '#f2f0e6', font = SPORT, weight = 800, align: CanvasTextAlign = 'center') {
  ctx.save();
  ctx.font = `${weight} ${size}px ${font}`;
  ctx.textAlign = align;
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#000';
  ctx.fillText(text, x + 4, y + 4);
  ctx.fillStyle = color;
  ctx.fillText(text, x, y);
  ctx.restore();
}

/** Pokémon battle text box, typed out over `typeDur` seconds. */
function battleBox(lines: string[], age: number, typeDur = 0.9) {
  const bx = 260;
  const by = H - 250;
  const bw = W - 520;
  const bh = 170;
  ctx.save();
  ctx.fillStyle = '#f8f8f0';
  ctx.fillRect(bx - 10, by - 10, bw + 20, bh + 20);
  ctx.strokeStyle = '#2a3170';
  ctx.lineWidth = 6;
  ctx.strokeRect(bx, by, bw, bh);
  ctx.strokeRect(bx + 12, by + 12, bw - 24, bh - 24);
  ctx.font = `34px ${PIXEL}`;
  ctx.fillStyle = '#1c1c28';
  ctx.textBaseline = 'middle';
  let remaining = Math.floor((age / typeDur) * lines.reduce((a, l) => a + l.length, 0));
  lines.forEach((l, i) => {
    const shown = l.slice(0, Math.max(0, remaining));
    remaining -= l.length;
    ctx.fillText(shown, bx + 50, by + 60 + i * 56);
  });
  ctx.restore();
}

function sprite(dex: number, x: number, y: number, h: number, opts: { flip?: boolean; alpha?: number; white?: number } = {}) {
  const s = getSprite(dex, false);
  if (!s) return;
  const k = h / Math.max(s.w, s.h);
  const w = s.w * k;
  const hh = s.h * k;
  ctx.save();
  ctx.globalAlpha = opts.alpha ?? 1;
  ctx.translate(x, y);
  if (opts.flip) ctx.scale(-1, 1);
  ctx.drawImage(s.img, -w / 2, -hh, w, hh);
  if (opts.white) {
    ctx.globalAlpha = (opts.alpha ?? 1) * opts.white;
    ctx.drawImage(silhouette(dex), -w / 2, -hh, w, hh);
  }
  ctx.restore();
}

const silhouettes = new Map<number, HTMLCanvasElement>();
function silhouette(dex: number): HTMLCanvasElement {
  let c = silhouettes.get(dex);
  if (c) return c;
  const s = getSprite(dex, false)!;
  c = document.createElement('canvas');
  c.width = s.w;
  c.height = s.h;
  const g = c.getContext('2d')!;
  g.drawImage(s.img, 0, 0);
  g.globalCompositeOperation = 'source-in';
  g.fillStyle = '#fff';
  g.fillRect(0, 0, s.w, s.h);
  silhouettes.set(dex, c);
  return c;
}

const TIER_COLORS: Record<string, [string, string]> = {
  dmd: ['#c084fc', '#f0abfc'], ame: ['#8b5cf6', '#a78bfa'], rby: ['#e3350d', '#ff7a59'],
  sap: ['#3b6fd8', '#7aa2ff'], emr: ['#21a366', '#5fe0a0'], gld: ['#d4a017', '#ffd866'], brz: ['#9a6a3a', '#c89a6a'],
};

function card(m: Mon, x: number, y: number, rot: number, scale: number) {
  const cw = 300;
  const ch = 420;
  const [c1, c2] = TIER_COLORS[tier(m.ovr)];
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.scale(scale, scale);
  const g = ctx.createLinearGradient(-cw / 2, -ch / 2, cw / 2, ch / 2);
  g.addColorStop(0, c1);
  g.addColorStop(0.55, '#121736');
  g.addColorStop(1, '#0a0d1f');
  ctx.fillStyle = '#000';
  ctx.fillRect(-cw / 2 + 10, -ch / 2 + 12, cw, ch);
  ctx.fillStyle = g;
  ctx.fillRect(-cw / 2, -ch / 2, cw, ch);
  ctx.strokeStyle = c2;
  ctx.lineWidth = 6;
  ctx.strokeRect(-cw / 2, -ch / 2, cw, ch);
  ctx.restore();
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.scale(scale, scale);
  ctx.font = `800 84px ${SPORT}`;
  ctx.fillStyle = c2;
  ctx.textBaseline = 'top';
  ctx.fillText(String(m.ovr), -cw / 2 + 20, -ch / 2 + 14);
  ctx.font = `800 40px ${SPORT}`;
  ctx.fillStyle = '#c9cdf0';
  ctx.textAlign = 'right';
  ctx.fillText(m.pos, cw / 2 - 20, -ch / 2 + 24);
  ctx.restore();
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(rot);
  ctx.scale(scale, scale);
  const s = getSprite(m.dex, false);
  if (s) {
    const k = 190 / Math.max(s.w, s.h);
    ctx.drawImage(s.img, -s.w * k / 2, 70 - s.h * k, s.w * k, s.h * k);
  }
  ctx.font = `800 48px ${SPORT}`;
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(m.name.toUpperCase(), 0, 120);
  const types = m.types;
  types.forEach((t, i) => {
    const tw = 110;
    const tx = (i - (types.length - 1) / 2) * (tw + 10);
    ctx.fillStyle = TYPE_COLORS[t];
    ctx.fillRect(tx - tw / 2, 158, tw, 34);
    ctx.font = `800 24px ${SPORT}`;
    ctx.fillStyle = '#111';
    ctx.fillText(t.toUpperCase(), tx, 176);
  });
  ctx.restore();
}

function scanlines() {
  ctx.save();
  ctx.globalAlpha = 0.07;
  ctx.fillStyle = '#000';
  for (let y = 0; y < H; y += 4) ctx.fillRect(0, y, W, 2);
  ctx.restore();
}

const easeOutBack = (t: number) => {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
};
const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

// ---------- callouts ----------

interface Callout {
  text: string;
  t0: number;
  dur: number;
  y: number;
  size: number;
  fill?: string;
}
let callouts: Callout[] = [];

function drawCallouts(t: number) {
  callouts = callouts.filter((c) => t < c.t0 + c.dur);
  for (const c of callouts) {
    const a = t - c.t0;
    if (a < 0) continue;
    const pop = a < 0.22 ? easeOutBack(a / 0.22) : 1;
    const shake = a < 0.45 ? (Math.random() - 0.5) * 18 : 0;
    const fade = clamp01((c.t0 + c.dur - t) / 0.2);
    jamText(c.text, W / 2 + shake, c.y + shake, c.size, { scale: 0.2 + 0.8 * pop, alpha: fade, fill: c.fill });
  }
}

// ---------- cue sheet for the audio pass ----------

export interface Cue { t: number; sound: string }
const cues: Cue[] = [];
const cue = (t: number, sound: string) => cues.push({ t: Math.round(t * 1000) / 1000, sound });

// ---------- live games ----------

const fps = FPS;
let segments: Segment[] = [];
let total = 0;
const bgCanvas = document.createElement('canvas');
const clipCanvas = document.createElement('canvas');
let bg: { sg: SeededGame; r: Renderer } | null = null;
let clip: { sg: SeededGame; r: Renderer; seg: Segment & { kind: 'clip' }; f: number } | null = null;

/** Crop window that follows the ball; zoom must divide 1920 evenly so pixels stay square. */
const crop = { x: VW / 2, y: VH / 2 };

function drawGame(r: Renderer, sg: SeededGame, canvas: HTMLCanvasElement, steps: number, t: number, onEvents?: (e: GameEvent[], t: number) => void, sfxOut = false, zoom = 4) {
  sg.advance(steps);
  const events = sg.g.events.splice(0);
  const sfx = sg.g.sfx.splice(0) as Sfx[];
  r.handle(events, sg.g);
  onEvents?.(events, t);
  if (sfxOut) for (const s of sfx) cue(t, s);
  r.draw(sg.g, steps * STEP);
  const cw = W / zoom;
  const ch = H / zoom;
  if (zoom === 4) {
    ctx.drawImage(canvas, 0, 0, VW, VH, 0, 0, W, H);
    return;
  }
  const b = sg.g.ball;
  const at = r.screenOf(b.x, b.y, Math.min(b.z, 6));
  crop.x += (at.x - crop.x) * 0.2;
  crop.y += (at.y - 10 - crop.y) * 0.2;
  const sx = Math.round(Math.max(0, Math.min(VW - cw, crop.x - cw / 2)));
  const sy = Math.round(Math.max(0, Math.min(VH - ch, crop.y - ch / 2)));
  ctx.drawImage(canvas, sx, sy, cw, ch, 0, 0, W, H);
}

function scorebug(g: Game) {
  ctx.save();
  const x = W / 2 - 330;
  const y = 28;
  ctx.fillStyle = '#05060f';
  ctx.fillRect(x, y, 660, 70);
  ctx.strokeStyle = '#2a3170';
  ctx.lineWidth = 4;
  ctx.strokeRect(x, y, 660, 70);
  const team = (i: 0 | 1, tx: number) => {
    ctx.fillStyle = g.teams[i].color;
    ctx.fillRect(tx, y + 4, 10, 62);
    ctx.font = `800 40px ${SPORT}`;
    ctx.fillStyle = '#f2f0e6';
    ctx.textBaseline = 'middle';
    ctx.fillText(g.teams[i].abbr, tx + 22, y + 36);
    ctx.font = `30px ${PIXEL}`;
    ctx.textAlign = 'right';
    ctx.fillText(String(g.score[i]), tx + 190, y + 38);
    ctx.textAlign = 'left';
  };
  team(0, x + 8);
  team(1, x + 218);
  ctx.fillStyle = '#1a2050';
  ctx.fillRect(x + 430, y + 4, 226, 62);
  ctx.font = `800 36px ${SPORT}`;
  ctx.fillStyle = '#f2f0e6';
  const q = ['1ST', '2ND', '3RD', '4TH'][Math.min(3, g.quarter - 1)];
  const c = Math.max(0, g.clock);
  ctx.fillText(`${q}  ${Math.floor(c / 60)}:${String(Math.floor(c % 60)).padStart(2, '0')}`, x + 448, y + 36);
  ctx.restore();
}

function replayTag(t: number) {
  if (Math.floor(t * 3) % 2) return;
  ctx.save();
  ctx.fillStyle = '#e3350d';
  ctx.beginPath();
  ctx.arc(80, 70, 14, 0, Math.PI * 2);
  ctx.fill();
  ctx.font = `30px ${PIXEL}`;
  ctx.fillStyle = '#fff';
  ctx.textBaseline = 'middle';
  ctx.fillText('REPLAY', 106, 72);
  ctx.restore();
}

// ---------- segment renderers ----------

const nameOf = (g: Game, id: number) => g.players.find((p) => p.id === id)!.mon;
const MONTAGE_WORDS = ['SLAM!', 'BOOM!', 'JAM!', 'POSTERIZED!'];
const montageIndex = (seg: Segment) => segments.filter((s) => s.kind === 'clip' && s.style === 'montage').indexOf(seg);

function renderClip(seg: Segment & { kind: 'clip' }, t: number, first: boolean) {
  if (first || !clip || clip.seg !== seg) {
    const sg = new SeededGame(seg.plan.h.seed);
    sg.advance(seg.plan.start);
    sg.g.events.length = 0;
    sg.g.sfx.length = 0;
    const r = new Renderer(clipCanvas);
    r.snap(sg.g);
    // Let the camera and particles settle for a few frames before filming.
    for (let i = 0; i < 4; i++) r.draw(sg.g, STEP);
    const b = sg.g.ball;
    const at = r.screenOf(b.x, b.y, Math.min(b.z, 6));
    crop.x = at.x;
    crop.y = at.y - 10;
    clip = { sg, r, seg, f: 0 };
    cue(t, 'whoosh');
  }
  const c = clip;
  const p = seg.plan;
  const steps = p.per[c.f] ?? 2;
  const slow = steps === 1;
  const h = p.h;
  drawGame(c.r, c.sg, clipCanvas, steps, t, (events, tt) => {
    for (const e of events) {
      if (seg.style === 'montage') {
        if ((e.kind === 'score' || e.kind === 'block') && e.player.id === h.player && Math.abs(c.f - p.eventFrame) < 6) {
          const word = e.kind === 'block' ? 'DENIED!' : e.kind === 'score' && e.points === 3 ? 'SPLASH!' : MONTAGE_WORDS[montageIndex(seg) % MONTAGE_WORDS.length];
          callouts.push({ text: word, t0: tt, dur: 0.8, y: 220, size: 150 });
          cue(tt, 'crowd');
        }
        continue;
      }
      if (e.kind === 'oop' && e.player.id === h.player) {
        callouts.push({ text: 'ALLEY-OOP!', t0: tt, dur: 1.1, y: 200, size: 96, fill: '#7aa2ff' });
      } else if (e.kind === 'score' && e.player.id === h.player && h.kind === 'dunk') {
        const m = nameOf(c.sg.g, h.player);
        callouts.push({ text: `${DUNK_MOVES[m.types[0]]}!`, t0: tt, dur: 1.5, y: 200, size: 130 });
        callouts.push({ text: "IT'S SUPER EFFECTIVE!", t0: tt + 0.65, dur: 1.4, y: H - 130, size: 72, fill: '#f8f8f0' });
        cue(tt, 'crowd');
      } else if (e.kind === 'block' && h.kind === 'block' && e.player.id === h.player) {
        callouts.push({ text: 'REJECTED!', t0: tt, dur: 1.5, y: 210, size: 150 });
        callouts.push({ text: `${e.player.mon.name.toUpperCase()} USED PROTECT!`, t0: tt + 0.5, dur: 1.3, y: H - 130, size: 56, fill: '#f8f8f0' });
        cue(tt, 'crowd');
      } else if (e.kind === 'fire' && e.on && h.kind === 'fire' && e.player.id === h.player) {
        callouts.push({ text: e.player.mon.name.toUpperCase(), t0: tt, dur: 2.2, y: 190, size: 110 });
        callouts.push({ text: 'IS ON FIRE!', t0: tt + 0.3, dur: 1.9, y: H - 150, size: 130 });
        cue(tt, 'crowd');
      }
    }
  }, true, slow ? 6 : 5);
  if (seg.style === 'hero') scorebug(c.sg.g);
  if (slow) replayTag(t);
  c.f++;
}

function renderBackground(t: number, dim = 0.6) {
  if (!bg) {
    const sg = new SeededGame(4242);
    sg.advance(900);
    const r = new Renderer(bgCanvas);
    r.snap(sg.g);
    bg = { sg, r };
  }
  drawGame(bg.r, bg.sg, bgCanvas, 2, t);
  ctx.fillStyle = `rgba(5, 6, 15, ${dim})`;
  ctx.fillRect(0, 0, W, H);
}

function logo(x: number, y: number, size: number, scale = 1) {
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(scale, scale);
  ctx.font = `${size}px ${PIXEL}`;
  ctx.textBaseline = 'middle';
  const poke = 'POKé';
  const jam = 'JAM';
  const gap = size * 0.35;
  const w1 = ctx.measureText(poke).width;
  const w2 = ctx.measureText(jam).width;
  const x0 = -(w1 + gap + w2) / 2;
  const layer = (txt: string, tx: number, front: string, mid: string, back: string) => {
    ctx.fillStyle = back;
    ctx.fillText(txt, tx + size * 0.12, size * 0.12);
    ctx.fillStyle = mid;
    ctx.fillText(txt, tx + size * 0.06, size * 0.06);
    ctx.fillStyle = front;
    ctx.fillText(txt, tx, 0);
  };
  layer(poke, x0, '#ffcb05', '#3b6fd8', '#0b1a46');
  layer(jam, x0 + w1 + gap, '#f2f0e6', '#e3350d', '#4a0d04');
  ctx.restore();
}

let flash = 0;
const fired = new Set<string>();
/** Fires a one-time effect when the timeline passes `at`. */
function once(key: string, t: number, at: number, fn: () => void) {
  if (t >= at && !fired.has(key)) {
    fired.add(key);
    fn();
  }
}

const DRAFT_CARDS = [25, 94, 6, 150, 143];

function renderSegment(seg: Segment, t: number, first: boolean) {
  const a = t - seg.t0;
  switch (seg.kind) {
    case 'intro': {
      ctx.fillStyle = '#000';
      ctx.fillRect(0, 0, W, H);
      once('intro', t, 0, () => { cue(0, 'crowd_low'); cue(0.15, 'whistle'); });
      if (a > 0.25) battleBox(['Wild TEAM ROCKET', 'wants to ball!'], a - 0.25, 1.1);
      break;
    }
    case 'logo': {
      renderBackground(t, 0.55);
      const k = clamp01(a / 0.22);
      const scale = a < 0.22 ? 3.2 - 2.2 * k * k : 1 + Math.max(0, 0.05 - (a - 0.22) * 0.2);
      once('logo-hit', t, seg.t0 + 0.22, () => { flash = 0.25; cue(t, 'slam'); cue(t, 'crowd'); });
      const shake = a > 0.22 && a < 0.6 ? (Math.random() - 0.5) * 24 : 0;
      logo(W / 2 + shake, H / 2 - 60 + shake, 170, scale);
      if (a > 0.6) plainText('FULL-COURT 5-ON-5 ARCADE HOOPS', W / 2, H / 2 + 140, 62, '#f2f0e6');
      break;
    }
    case 'draft': {
      renderBackground(t, 0.72);
      jamText('DRAFT YOUR SQUAD', W / 2, 130, 92, { scale: a < 0.2 ? easeOutBack(a / 0.2) : 1 });
      DRAFT_CARDS.forEach((dex, i) => {
        const land = 0.3 + i * 0.5;
        const ca = a - land;
        if (ca < -0.25) return;
        const k = clamp01((ca + 0.25) / 0.25);
        const x = W / 2 + (i - 2) * 340;
        const y = 600 + (1 - k) * 700;
        once(`card${i}`, t, seg.t0 + land, () => cue(t, 'card'));
        card(monByDex(dex), x, y, (1 - k) * (i % 2 ? 0.5 : -0.5) + (i - 2) * 0.03, 1 + (ca > 0 && ca < 0.12 ? 0.08 : 0));
      });
      if (a > 3) plainText('48 POKÉMON · 2K-STYLE RATINGS · SNAKE DRAFT', W / 2, H - 70, 52, '#ffcb05');
      break;
    }
    case 'types': {
      renderBackground(t, 0.8);
      jamText('TYPE MATCHUPS MATTER', W / 2, 140, 84);
      const lunge = clamp01((a - 0.5) / 0.25);
      const back = clamp01((a - 1.0) / 0.3);
      const sx = 560 + lunge * 600 - back * 600;
      sprite(143, sx, 720, 380, { flip: true });
      sprite(94, 1360, 720, 360, { alpha: a > 0.6 && a < 1.2 ? 0.35 : 1 });
      once('tackle', t, seg.t0 + 0.6, () => cue(t, 'whoosh'));
      battleBox(a < 1.0 ? ['SNORLAX used TACKLE!'] : ['SNORLAX used TACKLE!', "It doesn't affect GENGAR..."], a < 1.0 ? a : 0.9 + (a - 1.0), a < 1.0 ? 0.6 : 1.4);
      break;
    }
    case 'evolve': {
      ctx.fillStyle = '#05060f';
      ctx.fillRect(0, 0, W, H);
      const glow = ctx.createRadialGradient(W / 2, 520, 50, W / 2, 520, 700);
      glow.addColorStop(0, 'rgba(255,203,5,0.35)');
      glow.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = glow;
      ctx.fillRect(0, 0, W, H);
      jamText('LEVEL UP. EVOLVE.', W / 2, 120, 92);
      const evolved = a > 1.25;
      // Flash faster and faster, then the reveal.
      const flick = !evolved && a > 0.2 && Math.floor(Math.pow(a, 2.2) * 14) % 2 === 1;
      sprite(evolved ? 130 : 129, W / 2, 760, evolved ? 520 : 360, { white: flick ? 1 : 0 });
      once('evo-start', t, seg.t0 + 0.2, () => cue(t, 'evolve'));
      once('evo-done', t, seg.t0 + 1.25, () => { flash = 0.3; cue(t, 'slam'); cue(t, 'crowd'); });
      battleBox(evolved ? ['MAGIKARP evolved', 'into GYARADOS!'] : ['What? MAGIKARP', 'is evolving!'], evolved ? a - 1.25 : a, 0.6);
      break;
    }
    case 'franchise': {
      renderBackground(t, 0.8);
      jamText('RUN A FRANCHISE', W / 2, 150, 100);
      const steps = ['DRAFT', 'SEASON', 'PLAYOFFS', 'TITLE'];
      steps.forEach((s, i) => {
        const at = 0.2 + i * 0.4;
        if (a < at) return;
        once(`fr${i}`, t, seg.t0 + at, () => cue(t, 'card'));
        const k = easeOutBack(clamp01((a - at) / 0.2));
        ctx.save();
        ctx.translate(W / 2 + (i - 1.5) * 430, 540);
        ctx.scale(k, k);
        ctx.fillStyle = i === 3 ? '#ffcb05' : '#1a2050';
        ctx.fillRect(-190, -90, 380, 180);
        ctx.strokeStyle = i === 3 ? '#fff7a8' : '#3b6fd8';
        ctx.lineWidth = 6;
        ctx.strokeRect(-190, -90, 380, 180);
        ctx.font = `44px ${PIXEL}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = i === 3 ? '#1a1400' : '#f2f0e6';
        ctx.fillText(s, 0, 0);
        ctx.restore();
      });
      if (a > 1.1) plainText('LEVEL UP · EVOLVE · DEFEND YOUR CROWN', W / 2, 820, 58, '#ffcb05');
      break;
    }
    case 'outro': {
      renderBackground(t, 0.6);
      const k = clamp01(a / 0.25);
      once('outro-hit', t, seg.t0 + 0.25, () => { flash = 0.3; cue(t, 'slam'); cue(t, 'crowd_big'); });
      logo(W / 2, H / 2 - 110, 190, a < 0.25 ? 3 - 2 * k * k : 1);
      if (a > 0.6) jamText('PLAY FREE IN YOUR BROWSER', W / 2, H / 2 + 120, 64, { fill: '#f8f8f0' });
      if (a > 1.2 && Math.floor(a * 4) % 2 === 0) plainText('DRAFT · DUNK · SHOVE · EVOLVE', W / 2, H / 2 + 250, 60, '#ffcb05');
      if (seg.t1 - t < 0.6) {
        ctx.fillStyle = `rgba(0,0,0,${clamp01(1 - (seg.t1 - t) / 0.6)})`;
        ctx.fillRect(0, 0, W, H);
      }
      break;
    }
    case 'clip':
      renderClip(seg, t, first);
      break;
  }
}

// ---------- public API ----------

let lastSeg: Segment | null = null;

export function renderFrame(i: number) {
  const t = i / fps;
  const seg = segments.find((s) => t >= s.t0 && t < s.t1) ?? segments[segments.length - 1];
  const first = seg !== lastSeg;
  if (first && seg.kind !== 'clip') cue(t, 'whoosh');
  lastSeg = seg;
  ctx.save();
  renderSegment(seg, t, first);
  drawCallouts(t);
  if (flash > 0) {
    ctx.fillStyle = `rgba(255,255,255,${Math.min(1, flash * 3)})`;
    ctx.fillRect(0, 0, W, H);
    flash -= 1 / fps;
  }
  scanlines();
  ctx.restore();
}

export async function prepare(): Promise<{ frames: number; fps: number }> {
  await preload([...HOME.roster, ...AWAY.roster, ...[129, 130, 143, 94, ...DRAFT_CARDS].map(monByDex)]);
  await document.fonts.load(`40px ${PIXEL}`);
  await document.fonts.load(`800 40px ${SPORT}`);

  const scans: Scan[] = [];
  for (let seed = 1; seed <= 14; seed++) scans.push(scanGame(seed));
  const used = new Set<string>();
  const key = (h: Highlight) => `${h.seed}:${h.step}`;
  const pick = (kinds: Highlight['kind'][], seconds: number, eventAt: number, slow: boolean): ClipPlan => {
    const all = scans.flatMap((s) => s.highlights.filter((h) => kinds.includes(h.kind) && !used.has(key(h))).map((h) => ({ h, s })));
    all.sort((x, y) => y.h.score - x.h.score);
    for (const { h, s } of all) {
      const p = plan(h, s, seconds, eventAt, slow);
      if (p) {
        used.add(key(h));
        return p;
      }
    }
    throw new Error(`No usable ${kinds.join('/')} highlight`);
  };

  const s: Segment[] = [];
  let t = 0;
  const add = (seg: Segment) => { s.push(seg); t = seg.t1; };
  add({ kind: 'intro', t0: t, t1: t + 2 });
  add({ kind: 'logo', t0: t, t1: t + 2 });
  add({ kind: 'draft', t0: t, t1: t + 4 });
  add({ kind: 'clip', t0: t, t1: t + 6, plan: pick(['dunk'], 6, 3.6, true), style: 'hero' });
  add({ kind: 'types', t0: t, t1: t + 2.5 });
  add({ kind: 'clip', t0: t, t1: t + 4, plan: pick(['block'], 4, 2.2, true), style: 'hero' });
  add({ kind: 'clip', t0: t, t1: t + 4.5, plan: pick(['fire'], 4.5, 1.8, true), style: 'hero' });
  add({ kind: 'evolve', t0: t, t1: t + 2.5 });
  add({ kind: 'franchise', t0: t, t1: t + 2.5 });
  for (let i = 0; i < 4; i++) add({ kind: 'clip', t0: t, t1: t + 1, plan: pick(i === 2 ? ['three', 'dunk'] : ['dunk'], 1, 0.7, false), style: 'montage' });
  add({ kind: 'outro', t0: t, t1: t + 4 });
  segments = s;
  total = t;
  cue(segments.find((x) => x.kind === 'logo')!.t0 + 0.22, 'music_start');
  cue(segments.find((x) => x.kind === 'outro')!.t0 + 0.25, 'music_end');
  return { frames: Math.round(total * fps), fps };
}

export function getCues(): Cue[] {
  return [...cues].sort((a, b) => a.t - b.t);
}

declare global {
  interface Window {
    trailer?: { prepare: typeof prepare; renderFrame: typeof renderFrame; getCues: typeof getCues };
  }
}
window.trailer = { prepare, renderFrame, getCues };

// Real-time preview: /trailer.html?play
if (new URLSearchParams(location.search).has('play')) {
  void prepare().then(({ frames }) => {
    let i = 0;
    const t0 = performance.now();
    const tick = () => {
      const target = Math.floor(((performance.now() - t0) / 1000) * fps);
      while (i <= target && i < frames) renderFrame(i++);
      if (i < frames) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
}
