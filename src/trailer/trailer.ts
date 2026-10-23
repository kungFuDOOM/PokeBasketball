// Poké Jam trailer #2, rendered from the real game engine.
// Seeded CPU-vs-CPU games on the Indigo Plateau court are scanned for highlights, then replayed frame by
// frame (slow motion on the big moments) between title scenes: the opening jump ball, the 287-Pokémon
// wall, the draft clock, Kyogre vs Groudon, the badge case, evolution and a $PJAM end card.
// scripts/render-trailer.mjs captures the frames and scores the result; open /trailer.html?play in the
// dev server to preview it in real time.
import '../fonts.css';
import { COURTS, type CourtStyle } from '../data/courts';
import { LEAGUE } from '../franchise/league';
import { POKEMON, monByDex, TYPE_COLORS, type Mon } from '../data/pokemon';
import { Game, type Sfx } from '../game/game';
import { DUNK_MOVES } from '../game/hud';
import { Renderer, VH, VW } from '../game/render';
import { getSprite, preload } from '../game/sprites';
import type { GameEvent, TeamDef } from '../game/types';
import { badgeSvg } from '../ui/badges';
import { tier } from '../util';

export const FPS = 30;
/**
 * Which cut to render (?cut=…): 'main' (the launch trailer), 'vertical' (9:16 for TikTok / Reels / Shorts),
 * 'franchise' (the season story) or 'top5' (a countdown of the best plays).
 */
type Cut = 'main' | 'vertical' | 'franchise' | 'top5';
const CUT: Cut = (['vertical', 'franchise', 'top5'] as const).find((c) => c === new URLSearchParams(location.search).get('cut')) ?? 'main';
const VERTICAL = CUT === 'vertical';
const W = VERTICAL ? 1080 : 1920;
const H = VERTICAL ? 1920 : 1080;
/** Game-canvas zoom: 4 shows the whole 480x270 court at 1080p; vertical crops a 135x240 window around the ball. */
const BG_ZOOM = VERTICAL ? 8 : 4;
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
    this.g = this.seeded(() => new Game({ home: HOME, away: AWAY, quarterLen: 120, difficulty: 'pro', court: COURT }));
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
const gym = (name: string, dexes: number[]): TeamDef => {
  const t = LEAGUE.find((x) => x.name === name)!;
  return { name: t.name, abbr: t.abbr, color: t.color, color2: t.color2, human: false, roster: mons(dexes) };
};
const pallet = (dexes: number[]): TeamDef => ({ name: 'Pallet Town', abbr: 'PAL', color: '#3b6fd8', color2: '#16224a', human: false, roster: mons(dexes) });
/** Each cut has its own matchup and floor. */
const MATCHUPS: Record<Cut, { home: TeamDef; away: TeamDef; court: CourtStyle }> = {
  main: { home: pallet([25, 381, 6, 445, 382]), away: gym('Indigo Elite', [151, 94, 150, 383, 149]), court: COURTS['Indigo Elite'] },
  vertical: { home: pallet([25, 6, 448, 445, 143]), away: gym('Saffron Psychics', [65, 94, 150, 376, 248]), court: COURTS['Saffron Psychics'] },
  franchise: { home: pallet([25, 6, 9, 3, 143]), away: gym('Cerulean Cascades', [121, 134, 131, 130, 382]), court: COURTS['Cerulean Cascades'] },
  top5: { home: pallet([151, 381, 384, 149, 249]), away: gym('Cinnabar Volcanoes', [59, 157, 146, 244, 250]), court: COURTS['Cinnabar Volcanoes'] },
};
const { home: HOME, away: AWAY, court: COURT } = MATCHUPS[CUT];

// ---------- highlight scan ----------

interface Highlight {
  seed: number;
  step: number;
  kind: 'dunk' | 'three' | 'block' | 'fire' | 'buzzer';
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
      } else if (e.kind === 'buzzerbeater') {
        highlights.push({ seed, step: k, kind: 'buzzer', player: e.player.id, oop: false, spin: false, dist: 0, score: 3 + e.points });
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

type Scene = 'tipoff' | 'logo' | 'wall' | 'clock' | 'legends' | 'badges' | 'evolve' | 'outro'
  | 'v-hook' | 'v-cards' | 'v-outro'
  | 'f-intro' | 'f-draft' | 'f-subs' | 'f-evolve' | 'f-champs'
  | 't-title' | 't-num';
type Segment =
  | { kind: Scene; t0: number; t1: number }
  | { kind: 'clip'; t0: number; t1: number; plan: ClipPlan; style: 'hero' | 'montage'; rank?: number; lower?: string };

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
  // A buzzer beater ends its quarter: the horn may come after the shot, never before the clip starts.
  const stop = h.kind === 'buzzer' ? h.step : end;
  if (scan.quarterSteps.some((q) => q > start - 200 && q < stop)) return null;
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
  const bx = VERTICAL ? 60 : 260;
  const by = H - (VERTICAL ? 330 : 250);
  const bw = W - 2 * bx;
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
  if (zoom === 4 && !VERTICAL) {
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
const MONTAGE_WORDS = ['KABOOM!', 'SLAM!', 'FACIALIZED!', 'JAM!'];
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
        if (!seg.lower) callouts.push({ text: "IT'S SUPER EFFECTIVE!", t0: tt + 0.65, dur: 1.4, y: H - 130, size: 72, fill: '#f8f8f0' });
        cue(tt, 'crowd');
      } else if (e.kind === 'block' && h.kind === 'block' && e.player.id === h.player) {
        callouts.push({ text: 'REJECTED!', t0: tt, dur: 1.5, y: 210, size: 150 });
        if (!seg.lower) callouts.push({ text: `${e.player.mon.name.toUpperCase()} USED PROTECT!`, t0: tt + 0.5, dur: 1.3, y: H - 130, size: 56, fill: '#f8f8f0' });
        cue(tt, 'crowd');
      } else if (e.kind === 'buzzerbeater' && h.kind === 'buzzer' && e.player.id === h.player) {
        callouts.push({ text: 'BUZZER BEATER!', t0: tt, dur: 1.8, y: VERTICAL ? 300 : 200, size: 130 });
        if (!seg.lower) callouts.push({ text: `${e.player.mon.name.toUpperCase()} AT THE HORN!`, t0: tt + 0.45, dur: 1.5, y: H - (VERTICAL ? 420 : 140), size: 64, fill: '#f8f8f0' });
        cue(tt, 'buzzer');
        cue(tt + 0.1, 'crowd_big');
      } else if (e.kind === 'fire' && e.on && h.kind === 'fire' && e.player.id === h.player) {
        callouts.push({ text: e.player.mon.name.toUpperCase(), t0: tt, dur: 2.2, y: 190, size: 110 });
        callouts.push({ text: 'IS ON FIRE!', t0: tt + 0.3, dur: 1.9, y: seg.lower ? 330 : H - 150, size: 130 });
        cue(tt, 'crowd');
      }
    }
  }, true, VERTICAL ? (slow ? 9 : 8) : slow ? 6 : 5);
  if (seg.style === 'hero') scorebug(c.sg.g);
  if (slow) replayTag(t);
  if (seg.lower) lowerThird(seg, c.f);
  c.f++;
}

function renderBackground(t: number, dim = 0.6) {
  if (!bg) {
    const sg = new SeededGame(5151);
    sg.advance(900);
    const r = new Renderer(bgCanvas);
    r.snap(sg.g);
    bg = { sg, r };
  }
  drawGame(bg.r, bg.sg, bgCanvas, 2, t, undefined, false, BG_ZOOM);
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


// ---------- new scenes ----------

const images = new Map<string, HTMLImageElement>();
function loadImage(key: string, src: string): Promise<void> {
  const img = new Image();
  images.set(key, img);
  img.src = src;
  return img.decode().catch(() => undefined);
}
const BADGES = ['Boulder', 'Cascade', 'Thunder', 'Rainbow', 'Soul', 'Marsh', 'Volcano', 'Earth'];

let tip: { sg: SeededGame; r: Renderer } | null = null;
const tipCanvas = document.createElement('canvas');

/** Cold open: the real opening jump ball, close up. */
function renderTipoff(seg: Segment, t: number, a: number) {
  if (!tip) {
    const sg = new SeededGame(77);
    const r = new Renderer(tipCanvas);
    r.snap(sg.g);
    crop.x = VW / 2;
    crop.y = VH / 2;
    tip = { sg, r };
  }
  drawGame(tip.r, tip.sg, tipCanvas, 2, t, (events, tt) => {
    for (const e of events) {
      if (e.kind === 'jumpball') {
        callouts.push({ text: `${e.winner.mon.name.toUpperCase()} WINS THE TIP!`, t0: tt, dur: 1.2, y: H - 150, size: 70, fill: '#f8f8f0' });
        cue(tt, 'crowd');
      }
    }
  }, true, 6);
  once('tip-open', t, seg.t0, () => { cue(t, 'crowd_low'); });
  once('tip-call', t, seg.t0 + 0.5, () => callouts.push({ text: 'JUMP BALL!', t0: t, dur: 1.4, y: 190, size: 130 }));
  if (a < 0.4) {
    ctx.fillStyle = `rgba(0,0,0,${1 - a / 0.4})`;
    ctx.fillRect(0, 0, W, H);
  }
}

/** The icon spins in and slams, then the wordmark. */
function renderLogo(seg: Segment, t: number, a: number) {
  renderBackground(t, 0.62);
  const icon = images.get('icon');
  const k = clamp01(a / 0.3);
  once('logo-hit', t, seg.t0 + 0.3, () => { flash = 0.25; cue(t, 'slam'); cue(t, 'crowd'); });
  if (icon) {
    ctx.save();
    ctx.translate(W / 2, H / 2 - 230);
    ctx.rotate((1 - k) * Math.PI * 3);
    const s = (a < 0.3 ? 0.2 + 0.8 * k : 1 + Math.max(0, 0.08 - (a - 0.3) * 0.3)) * 240;
    ctx.drawImage(icon, -s / 2, -s / 2, s, s);
    ctx.restore();
  }
  const shake = a > 0.3 && a < 0.65 ? (Math.random() - 0.5) * 22 : 0;
  if (a > 0.3) logo(W / 2 + shake, H / 2 + 40 + shake, 150, 1 + Math.max(0, 0.25 - (a - 0.3)) );
  if (a > 0.75) plainText('DRAFT POKéMON. PLAY ARCADE HOOPS.', W / 2, H / 2 + 200, 64, '#f2f0e6');
}

/** Every Pokémon in the game scrolling past, a counter running to 287, then the number one. */
function renderWall(seg: Segment, t: number, a: number) {
  ctx.fillStyle = '#070a1c';
  ctx.fillRect(0, 0, W, H);
  const cell = 150;
  const cols = Math.ceil(W / cell) + 2;
  const rows = Math.ceil(H / cell) + 1;
  const speed = 900 * (1 - clamp01((a - 2.0) / 0.6) * 0.9);
  const off = (a * speed) % cell;
  const dim = clamp01((a - 2.0) / 0.5);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = (r * 17 + c * 5 + Math.floor((a * speed) / cell) * 3) % POKEMON.length;
      const m = POKEMON[idx];
      const x = c * cell - off + (r % 2 ? cell / 2 : 0) - cell;
      const y = r * cell + 30;
      ctx.globalAlpha = 0.85 - dim * 0.6;
      ctx.fillStyle = TIER_COLORS[tier(m.ovr)][0] + '33';
      ctx.fillRect(x + 6, y + 6, cell - 12, cell - 12);
      ctx.globalAlpha = 1 - dim * 0.7;
      sprite(m.dex, x + cell / 2, y + cell - 18, 120);
    }
  }
  ctx.globalAlpha = 1;
  ctx.fillStyle = 'rgba(5,6,15,0.45)';
  ctx.fillRect(0, 0, W, H);
  const n = Math.min(POKEMON.length, Math.round(POKEMON.length * clamp01(a / 1.6) ** 0.7));
  if (a < 2.1) {
    jamText(`${n} POKéMON`, W / 2, H / 2 - 40, 150, { scale: a < 0.2 ? easeOutBack(a / 0.2) : 1 });
    if (a > 0.6) plainText('EVERY ONE OF GEN 1 & 2 · FAN FAVORITES FROM GEN 3-5', W / 2, H / 2 + 110, 56, '#ffcb05');
  } else {
    const ca = a - 2.1;
    once('wall-card', t, seg.t0 + 2.1, () => { flash = 0.2; cue(t, 'slam'); cue(t, 'crowd'); });
    card(monByDex(150), W / 2, H / 2 + 40, 0, ca < 0.15 ? 1.6 - ca * 4 : 1);
    jamText('#1 OVERALL', W / 2, 140, 96, { scale: ca < 0.2 ? easeOutBack(ca / 0.2) : 1 });
  }
}

/** The draft clock runs down, then the pick is in. */
function renderClock(seg: Segment, t: number, a: number) {
  renderBackground(t, 0.8);
  jamText('60 SECONDS ON THE CLOCK', W / 2, 130, 84, { scale: a < 0.2 ? easeOutBack(a / 0.2) : 1 });
  const left = Math.max(0, 5 - Math.floor(a / 0.38));
  const picked = a > 0.38 * 5 + 0.1;
  for (let s = 1; s <= 5; s++) once(`tick${s}`, t, seg.t0 + 0.38 * (5 - s), () => cue(t, 'tick'));
  ctx.save();
  ctx.translate(W / 2 - 430, 560);
  const r = 170;
  ctx.fillStyle = picked ? '#21a366' : left <= 3 ? '#c0281b' : '#1a2050';
  ctx.beginPath();
  ctx.arc(0, 0, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 12;
  ctx.strokeStyle = '#f8f8f0';
  ctx.stroke();
  ctx.font = `110px ${PIXEL}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#fff';
  ctx.fillText(picked ? '✓' : `:0${left}`, 0, 8);
  ctx.restore();
  const m = monByDex(6);
  if (picked) {
    const pa = a - (0.38 * 5 + 0.1);
    once('pick-in', t, seg.t0 + 0.38 * 5 + 0.1, () => { flash = 0.15; cue(t, 'card'); cue(t, 'crowd'); });
    card(m, W / 2 + 330, 600, 0, pa < 0.15 ? 1.4 - pa * 2.6 : 1);
    plainText('THE PICK IS IN', W / 2 + 330, 140 + 110, 60, '#ffcb05');
  } else {
    // The board flips through candidates while the clock runs.
    const pool = [9, 3, 149, 248, 143, 25, 6];
    const cand = monByDex(pool[Math.floor(a * 7) % pool.length]);
    card(cand, W / 2 + 330, 600, Math.sin(a * 20) * 0.02, 1);
  }
}

/** Kyogre vs Groudon, with a real type matchup. */
function renderLegends(seg: Segment, t: number, a: number) {
  ctx.fillStyle = '#05060f';
  ctx.fillRect(0, 0, W, H);
  const split = W / 2 + Math.sin(a * 3) * 10;
  ctx.fillStyle = '#123b8c';
  ctx.beginPath();
  ctx.moveTo(0, 0); ctx.lineTo(split + 120, 0); ctx.lineTo(split - 120, H); ctx.lineTo(0, H);
  ctx.fill();
  ctx.fillStyle = '#7a1a0e';
  ctx.beginPath();
  ctx.moveTo(split + 120, 0); ctx.lineTo(W, 0); ctx.lineTo(W, H); ctx.lineTo(split - 120, H);
  ctx.fill();
  const inL = easeOutBack(clamp01(a / 0.35));
  const surf = a > 1.1;
  const hit = surf && a < 1.6;
  sprite(382, -300 + inL * 780, 760, 520);
  sprite(383, W + 300 - inL * 780, 760, 520, { flip: true, white: hit && Math.floor(a * 16) % 2 ? 0.9 : 0 });
  once('legends-in', t, seg.t0 + 0.3, () => { flash = 0.15; cue(t, 'slam'); });
  jamText('VS', W / 2, 330, 160, { scale: a < 0.45 ? easeOutBack(clamp01((a - 0.25) / 0.2)) : 1 });
  plainText('KYOGRE 92', 470, 150, 70, '#7aa2ff');
  plainText('GROUDON 92', W - 470, 150, 70, '#ff7a59');
  once('surf', t, seg.t0 + 1.1, () => { cue(t, 'block'); cue(t, 'crowd'); });
  battleBox(surf ? ['KYOGRE used SURF!', "It's super effective!"] : ['KYOGRE used SURF!'], surf ? 0.6 + (a - 1.1) : a - 0.5, surf ? 1.2 : 0.6);
}

/** The badge case fills, then the Elite Four crown. */
function renderBadges(seg: Segment, t: number, a: number) {
  renderBackground(t, 0.82);
  jamText('WIN ALL 8 BADGES', W / 2, 140, 96, { scale: a < 0.2 ? easeOutBack(a / 0.2) : 1 });
  const size = 150;
  BADGES.forEach((name, i) => {
    const at = 0.25 + i * 0.16;
    const x = W / 2 + (i - 3.5) * 200;
    const y = 470;
    ctx.fillStyle = 'rgba(255,255,255,0.08)';
    ctx.fillRect(x - 85, y - 85, 170, 170);
    if (a < at) return;
    once(`badge${i}`, t, seg.t0 + at, () => cue(t, 'badge'));
    const k = easeOutBack(clamp01((a - at) / 0.18));
    const img = images.get(`badge-${name}`);
    if (img) ctx.drawImage(img, x - (size / 2) * k, y - (size / 2) * k, size * k, size * k);
  });
  const crownAt = 0.25 + 8 * 0.16 + 0.15;
  if (a > crownAt) {
    once('crown', t, seg.t0 + crownAt, () => { flash = 0.2; cue(t, 'slam'); cue(t, 'crowd_big'); });
    const k = easeOutBack(clamp01((a - crownAt) / 0.25));
    const img = images.get('badge-Elite');
    if (img) ctx.drawImage(img, W / 2 - 110 * k, 640 - 110 * k, 220 * k, 220 * k);
    jamText('THEN BEAT THE ELITE FOUR', W / 2, 930, 72, { fill: '#f8f8f0' });
  }
}

/** Dragonair evolving into Dragonite. */
function renderEvolve(seg: Segment, t: number, a: number) {
  ctx.fillStyle = '#05060f';
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W / 2, 520, 50, W / 2, 520, 700);
  glow.addColorStop(0, 'rgba(122,162,255,0.35)');
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  jamText('LEVEL UP. EVOLVE.', W / 2, 120, 92);
  const evolved = a > 1.3;
  const flick = !evolved && a > 0.2 && Math.floor(Math.pow(a, 2.2) * 14) % 2 === 1;
  sprite(evolved ? 149 : 148, W / 2, 760, evolved ? 500 : 420, { white: flick ? 1 : 0 });
  once('evo-start', t, seg.t0 + 0.2, () => cue(t, 'evolve'));
  once('evo-done', t, seg.t0 + 1.3, () => { flash = 0.3; cue(t, 'slam'); cue(t, 'crowd'); });
  battleBox(evolved ? ['DRAGONAIR evolved', 'into DRAGONITE!'] : ['What? DRAGONAIR', 'is evolving!'], evolved ? a - 1.3 : a, 0.6);
}

/** Logo, where to play, then $PJAM. */
function renderOutro(seg: Segment, t: number, a: number) {
  renderBackground(t, 0.66);
  const k = clamp01(a / 0.25);
  once('outro-hit', t, seg.t0 + 0.25, () => { flash = 0.3; cue(t, 'slam'); cue(t, 'crowd_big'); });
  const pj = a - 2.2;
  if (pj < 0) {
    logo(W / 2, H / 2 - 150, 170, a < 0.25 ? 3 - 2 * k * k : 1);
    if (a > 0.6) jamText('PLAY FREE IN YOUR BROWSER', W / 2, H / 2 + 40, 64, { fill: '#f8f8f0' });
    if (a > 1.0) plainText('kungfudoom.github.io/PokeBasketball', W / 2, H / 2 + 170, 64, '#ffcb05');
  } else {
    // $PJAM: gold, glinting, center stage.
    once('pjam', t, seg.t0 + 2.2, () => { flash = 0.35; cue(t, 'slam'); cue(t, 'coin'); cue(t, 'crowd_big'); });
    const s = pj < 0.25 ? 3.2 - 2.2 * easeOutBack(pj / 0.25) : 1 + 0.03 * Math.sin(pj * 6);
    const gold = ctx.createLinearGradient(0, -110, 0, 110);
    gold.addColorStop(0, '#fff7c2');
    gold.addColorStop(0.45, '#ffcb05');
    gold.addColorStop(1, '#b37400');
    const shake = pj > 0.25 && pj < 0.55 ? (Math.random() - 0.5) * 26 : 0;
    jamText('$PJAM', W / 2 + shake, H / 2 - 20 + shake, 230, { scale: s, fill: gold });
    // A glint sweeping across.
    const gx = ((pj * 900) % 2600) - 400;
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    const g = ctx.createLinearGradient(gx - 120, 0, gx + 120, 0);
    g.addColorStop(0, 'rgba(255,255,255,0)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.35)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(gx - 120, H / 2 - 200, 240, 360);
    ctx.restore();
    if (pj > 0.5) logo(W / 2, H - 170, 70);
  }
  if (seg.t1 - t < 0.5) {
    ctx.fillStyle = `rgba(0,0,0,${clamp01(1 - (seg.t1 - t) / 0.5)})`;
    ctx.fillRect(0, 0, W, H);
  }
}

// ---------- cut: vertical (9:16) ----------

/** "POKéMON. BUT IT'S NBA JAM." stacked over close-up gameplay. */
function renderVHook(seg: Segment, t: number, a: number) {
  renderBackground(t, 0.5);
  once('vhook', t, seg.t0, () => { cue(t, 'crowd_low'); cue(t + 0.05, 'whistle'); });
  const line = (txt: string, at: number, y: number, size: number, fill?: string) => {
    if (a < at) return;
    once(`vh-${txt}`, t, seg.t0 + at, () => { cue(t, 'slam'); flash = 0.12; });
    const k = easeOutBack(clamp01((a - at) / 0.2));
    jamText(txt, W / 2, y, size, { scale: 0.3 + 0.7 * k, fill, maxW: W - 100 });
  };
  line('POKéMON.', 0.15, H / 2 - 300, 120);
  line("BUT IT'S", 0.6, H / 2 - 110, 90, '#f8f8f0');
  line('NBA JAM.', 1.05, H / 2 + 80, 140);
  if (a > 1.6) plainText('DRAFT · DUNK · EVOLVE', W / 2, H / 2 + 300, 64, '#ffcb05');
}

/** Cards flipping past, slowing down, landing on Mewtwo. */
function renderVCards(seg: Segment, t: number, a: number) {
  renderBackground(t, 0.8);
  jamText(`${POKEMON.length} POKéMON`, W / 2, 280, 120, { scale: a < 0.2 ? easeOutBack(a / 0.2) : 1, maxW: W - 100 });
  plainText('TO DRAFT', W / 2, 420, 80, '#f8f8f0');
  const land = 2.0;
  if (a < land) {
    // Flip rate slows from ~14/s to ~3/s.
    const n = Math.floor(14 * a - 2.75 * a * a);
    const pool = [...POKEMON].sort((x, y) => y.ovr - x.ovr).slice(0, 60);
    const m = pool[(n * 7) % pool.length];
    once(`vc${n}`, t, t, () => cue(t, 'tick'));
    card(m, W / 2, H / 2 + 120, Math.sin(n) * 0.04, 1.7);
  } else {
    once('vc-land', t, seg.t0 + land, () => { flash = 0.2; cue(t, 'slam'); cue(t, 'crowd'); });
    const k = a - land;
    card(monByDex(150), W / 2, H / 2 + 120, 0, k < 0.15 ? 2.2 - k * 3.4 : 1.7);
    jamText('#1 OVERALL', W / 2, H - 320, 100, { maxW: W - 100 });
  }
}

/** Logo, where to play, then $PJAM: stacked for a tall screen. */
function renderVOutro(seg: Segment, t: number, a: number) {
  renderBackground(t, 0.68);
  once('vout-hit', t, seg.t0 + 0.2, () => { flash = 0.3; cue(t, 'slam'); cue(t, 'crowd_big'); });
  const icon = images.get('icon');
  if (icon) {
    const k = easeOutBack(clamp01(a / 0.3));
    ctx.drawImage(icon, W / 2 - 130 * k, 260 - 130 * k, 260 * k, 260 * k);
  }
  logo(W / 2, 560, 104);
  if (a > 0.5) jamText('PLAY FREE', W / 2, 760, 96, { fill: '#f8f8f0', maxW: W - 100 });
  if (a > 0.8) plainText('IN YOUR BROWSER', W / 2, 870, 64, '#f8f8f0');
  if (a > 1.1) plainText('kungfudoom.github.io/PokeBasketball', W / 2, 980, 50, '#ffcb05');
  const pj = a - 2.0;
  if (pj >= 0) {
    once('vpjam', t, seg.t0 + 2.0, () => { flash = 0.35; cue(t, 'slam'); cue(t, 'coin'); cue(t, 'crowd_big'); });
    pjam(W / 2, 1320, 200, pj);
  }
  fadeOut(seg, t, 0.5);
}

// ---------- cut: franchise ----------

function renderFIntro(seg: Segment, t: number, a: number) {
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, W, H);
  once('fintro', t, seg.t0, () => { cue(t, 'crowd_low'); cue(t + 0.1, 'whistle'); });
  const img = images.get('badge-Boulder');
  if (img && a > 0.2) {
    const k = easeOutBack(clamp01((a - 0.2) / 0.3));
    ctx.drawImage(img, W / 2 - 150 * k, 330 - 150 * k, 300 * k, 300 * k);
  }
  if (a > 0.3) battleBox(['GYM LEADER BROCK', 'wants to ball!'], a - 0.3, 1.0);
}

/** Ten teams snake-drafting ten Pokémon each, picks landing fast. */
const DRAFT_TEAMS = [{ abbr: 'PAL', color: '#3b6fd8' }, ...LEAGUE.map((t) => ({ abbr: t.abbr, color: t.color }))];
let draftPicks: number[][] | null = null;
function renderFDraft(t: number, a: number) {
  renderBackground(t, 0.86);
  jamText('DRAFT 10. BUILD A DYNASTY.', W / 2, 110, 76);
  if (!draftPicks) {
    const pool = [...POKEMON].sort((x, y) => y.ovr - x.ovr);
    draftPicks = DRAFT_TEAMS.map(() => []);
    let i = 0;
    for (let r = 0; r < 10; r++) {
      const order = r % 2 ? [...DRAFT_TEAMS.keys()].reverse() : [...DRAFT_TEAMS.keys()];
      for (const ti of order) draftPicks[ti].push(pool[i++].dex);
    }
  }
  const made = Math.floor(clamp01((a - 0.2) / 2.6) * 100);
  const rowH = 76;
  const top = 200;
  DRAFT_TEAMS.forEach((tm, ti) => {
    const y = top + ti * rowH;
    ctx.fillStyle = 'rgba(18,22,58,0.85)';
    ctx.fillRect(220, y, W - 440, rowH - 8);
    ctx.fillStyle = tm.color;
    ctx.fillRect(220, y, 12, rowH - 8);
    ctx.font = `800 40px ${SPORT}`;
    ctx.fillStyle = ti === 0 ? '#ffcb05' : '#f2f0e6';
    ctx.textBaseline = 'middle';
    ctx.fillText(ti === 0 ? 'YOU' : tm.abbr, 250, y + rowH / 2 - 4);
    for (let r = 0; r < 10; r++) {
      // Pick number of team ti in round r (snake order).
      const idx = r * 10 + (r % 2 ? 9 - ti : ti);
      const x = 380 + r * 128;
      if (idx < made) sprite(draftPicks![ti][r], x + 50, y + rowH - 6, 72);
      else {
        ctx.strokeStyle = 'rgba(255,255,255,0.15)';
        ctx.strokeRect(x + 20, y + 10, 60, 48);
      }
    }
  });
  if (made > 0 && made < 100) once(`fd${Math.floor(made / 4)}`, t, t, () => cue(t, 'card'));
}

/** A tired starter heads to the bench and the 6th man checks in. */
function renderFSubs(seg: Segment, t: number, a: number) {
  renderBackground(t, 0.82);
  jamText('STARTERS TIRE.', W / 2, 110, 84);
  if (a > 0.5) jamText('THE BENCH STEPS IN.', W / 2, 220, 84, { fill: '#f8f8f0' });
  const swap = 1.5;
  const energy = a < swap ? 1 - 0.85 * clamp01(a / 1.3) : 1;
  const out = clamp01((a - swap) / 0.35);
  const inn = easeOutBack(clamp01((a - swap - 0.15) / 0.35));
  if (out < 1) sprite(25, W / 2 - out * 900, 760, 330, { alpha: 1 - out });
  if (a > swap) sprite(26, W / 2 + (1 - inn) * 900, 760, 360);
  // Energy bar
  const bw = 520;
  const bx = W / 2 - bw / 2;
  ctx.fillStyle = '#05060f';
  ctx.fillRect(bx - 6, 330, bw + 12, 44);
  ctx.fillStyle = energy < 0.3 ? '#e3350d' : '#21d07a';
  ctx.fillRect(bx, 336, bw * energy, 32);
  plainText('ENERGY', bx - 20, 352, 40, '#f2f0e6', SPORT, 800, 'right');
  once('fsub', t, seg.t0 + swap, () => { cue(t, 'whistle'); cue(t + 0.2, 'card'); });
  battleBox(a < swap ? ['Come back, PIKACHU!'] : ['Come back, PIKACHU!', 'Go! RAICHU!'], a < swap ? a : 0.6 + (a - swap), a < swap ? 0.5 : 1.0);
}

/** Charmander to Charmeleon to Charizard. */
function renderFEvolve(seg: Segment, t: number, a: number) {
  ctx.fillStyle = '#05060f';
  ctx.fillRect(0, 0, W, H);
  const glow = ctx.createRadialGradient(W / 2, 520, 50, W / 2, 520, 700);
  glow.addColorStop(0, 'rgba(238,129,48,0.35)');
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, W, H);
  jamText('LEVEL UP. EVOLVE. AGAIN.', W / 2, 120, 84);
  const stage = a < 1.2 ? 0 : a < 2.4 ? 1 : 2;
  const local = stage === 0 ? a : stage === 1 ? a - 1.2 : a - 2.4;
  const flick = stage < 2 && local > 0.25 && Math.floor(Math.pow(local, 2.2) * 16) % 2 === 1;
  const dex = [4, 5, 6][stage];
  sprite(dex, W / 2, 770, [300, 400, 520][stage], { white: flick ? 1 : 0 });
  once('fe0', t, seg.t0 + 0.2, () => cue(t, 'evolve'));
  once('fe1', t, seg.t0 + 1.2, () => { flash = 0.25; cue(t, 'slam'); cue(t + 0.15, 'evolve'); });
  once('fe2', t, seg.t0 + 2.4, () => { flash = 0.3; cue(t, 'slam'); cue(t, 'crowd'); });
  const lines = stage === 0 ? ['What? CHARMANDER', 'is evolving!'] : stage === 1 ? ['CHARMANDER evolved into', 'CHARMELEON! ...and again?!'] : ['CHARMELEON evolved', 'into CHARIZARD!'];
  battleBox(lines, local, 0.6);
}

/** Title night: confetti, the trophy, and the season's awards. */
function renderFChamps(seg: Segment, t: number, a: number) {
  renderBackground(t, 0.7);
  once('champs', t, seg.t0 + 0.2, () => { flash = 0.3; cue(t, 'slam'); cue(t, 'crowd_big'); });
  // Confetti
  const colors = ['#ffcb05', '#3b6fd8', '#e3350d', '#21d07a', '#f8f8f0'];
  for (let i = 0; i < 140; i++) {
    const x = ((i * 137.5) % W) + Math.sin(a * 2 + i) * 30;
    const y = ((i * 71) % 400) - 400 + a * (380 + (i % 7) * 40);
    ctx.fillStyle = colors[i % colors.length];
    ctx.save();
    ctx.translate(x, y % (H + 60));
    ctx.rotate(a * 4 + i);
    ctx.fillRect(-7, -4, 14, 8);
    ctx.restore();
  }
  const k = easeOutBack(clamp01((a - 0.2) / 0.3));
  jamText('CHAMPIONS!', W / 2, 240, 150, { scale: 0.3 + 0.7 * k });
  const crown = images.get('badge-Elite');
  if (crown) ctx.drawImage(crown, W / 2 - 120 * k, 520 - 120 * k, 240 * k, 240 * k);
  if (a > 1.0) plainText('MVP · DEFENSIVE PLAYER · SIXTH MAN · MOST IMPROVED', W / 2, 760, 54, '#ffcb05');
  if (a > 1.6) plainText('THEN THE ROOKIE DRAFT. AND RUN IT BACK.', W / 2, 860, 54, '#f2f0e6');
}

// ---------- cut: top 5 ----------

function renderTTitle(seg: Segment, t: number, a: number) {
  ctx.fillStyle = '#12020a';
  ctx.fillRect(0, 0, W, H);
  // Diagonal stripes sliding by
  ctx.save();
  ctx.fillStyle = '#e3350d';
  for (let i = -4; i < 16; i++) {
    const x = i * 220 + ((a * 600) % 220);
    ctx.beginPath();
    ctx.moveTo(x, 0); ctx.lineTo(x + 90, 0); ctx.lineTo(x - 210, H); ctx.lineTo(x - 300, H);
    ctx.globalAlpha = 0.18;
    ctx.fill();
  }
  ctx.restore();
  once('ttitle', t, seg.t0 + 0.25, () => { flash = 0.2; cue(t, 'slam'); cue(t, 'crowd'); });
  const k = easeOutBack(clamp01((a - 0.25) / 0.25));
  if (a > 0.25) jamText('TOP 5 PLAYS', W / 2, H / 2 - 60, 170, { scale: 0.3 + 0.7 * k });
  if (a > 0.8) logo(W / 2, H / 2 + 130, 64);
  if (a > 1.2) plainText(`${HOME.name.toUpperCase()} vs ${AWAY.name.toUpperCase()}`, W / 2, H / 2 + 250, 54, '#ffcb05');
}

function renderTNum(seg: Segment & { rank?: number }, t: number, a: number) {
  ctx.fillStyle = '#05060f';
  ctx.fillRect(0, 0, W, H);
  const rank = seg.rank ?? 1;
  once(`tnum${rank}`, t, seg.t0, () => { cue(t, 'slam'); if (rank === 1) cue(t, 'crowd'); });
  const k = a < 0.18 ? 3 - 2 * easeOutBack(a / 0.18) : 1 + (a - 0.18) * 0.06;
  jamText(`#${rank}`, W / 2, H / 2, 360, { scale: k, fill: rank === 1 ? undefined : '#f8f8f0' });
}

/** Lower-third caption for countdown clips: rank chip, then the play. */
function lowerThird(seg: Segment & { kind: 'clip' }, f: number) {
  const k = clamp01((f - 6) / 8);
  if (k <= 0) return;
  const x = 80 - (1 - k) * 900;
  const y = H - 190;
  ctx.save();
  ctx.fillStyle = '#e3350d';
  ctx.fillRect(x, y, 130, 110);
  ctx.font = `70px ${PIXEL}`;
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(`${seg.rank ?? ''}`, x + 68, y + 60);
  ctx.fillStyle = 'rgba(5,6,15,0.9)';
  ctx.fillRect(x + 130, y, 900, 110);
  ctx.fillStyle = '#ffcb05';
  ctx.fillRect(x + 130, y + 104, 900, 6);
  ctx.font = `800 64px ${SPORT}`;
  ctx.fillStyle = '#f8f8f0';
  ctx.textAlign = 'left';
  ctx.fillText(seg.lower ?? '', x + 170, y + 58);
  ctx.restore();
}

// ---------- shared ----------

function pjam(x: number, y: number, size: number, pj: number) {
  const s = pj < 0.25 ? 3.2 - 2.2 * easeOutBack(pj / 0.25) : 1 + 0.03 * Math.sin(pj * 6);
  const gold = ctx.createLinearGradient(0, -size / 2, 0, size / 2);
  gold.addColorStop(0, '#fff7c2');
  gold.addColorStop(0.45, '#ffcb05');
  gold.addColorStop(1, '#b37400');
  const shake = pj > 0.25 && pj < 0.55 ? (Math.random() - 0.5) * 26 : 0;
  jamText('$PJAM', x + shake, y + shake, size, { scale: s, fill: gold, maxW: W - 100 });
  const gx = ((pj * 900) % (W + 700)) - 400;
  ctx.save();
  ctx.globalCompositeOperation = 'lighter';
  const g = ctx.createLinearGradient(gx - 120, 0, gx + 120, 0);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.5, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(gx - 120, y - size * 0.9, 240, size * 1.6);
  ctx.restore();
}

function fadeOut(seg: Segment, t: number, dur: number) {
  if (seg.t1 - t < dur) {
    ctx.fillStyle = `rgba(0,0,0,${clamp01(1 - (seg.t1 - t) / dur)})`;
    ctx.fillRect(0, 0, W, H);
  }
}

function renderSegment(seg: Segment, t: number, first: boolean) {
  const a = t - seg.t0;
  switch (seg.kind) {
    case 'tipoff': renderTipoff(seg, t, a); break;
    case 'logo': renderLogo(seg, t, a); break;
    case 'wall': renderWall(seg, t, a); break;
    case 'clock': renderClock(seg, t, a); break;
    case 'legends': renderLegends(seg, t, a); break;
    case 'badges': renderBadges(seg, t, a); break;
    case 'evolve': renderEvolve(seg, t, a); break;
    case 'outro': renderOutro(seg, t, a); break;
    case 'v-hook': renderVHook(seg, t, a); break;
    case 'v-cards': renderVCards(seg, t, a); break;
    case 'v-outro': renderVOutro(seg, t, a); break;
    case 'f-intro': renderFIntro(seg, t, a); break;
    case 'f-draft': renderFDraft(t, a); break;
    case 'f-subs': renderFSubs(seg, t, a); break;
    case 'f-evolve': renderFEvolve(seg, t, a); break;
    case 'f-champs': renderFChamps(seg, t, a); break;
    case 't-title': renderTTitle(seg, t, a); break;
    case 't-num': renderTNum(seg as Segment & { rank?: number }, t, a); break;
    case 'clip': renderClip(seg, t, first); break;
  }
}

// ---------- public API ----------

let lastSeg: Segment | null = null;

export function renderFrame(i: number) {
  const t = i / fps;
  const seg = segments.find((s) => t >= s.t0 && t < s.t1) ?? segments[segments.length - 1];
  const first = seg !== lastSeg;
  // A clip's callouts end with the clip; scenes add their own.
  if (first) callouts = callouts.filter((c) => c.t0 >= seg.t0);
  if (first && seg.kind !== 'clip' && seg.kind !== 'tipoff') cue(t, 'whoosh');
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
  await preload(POKEMON);
  await Promise.all([
    loadImage('icon', `${import.meta.env.BASE_URL}icon.svg`),
    ...[...BADGES, 'Elite'].map((b) => loadImage(`badge-${b}`, `data:image/svg+xml;charset=utf-8,${encodeURIComponent(badgeSvg(b, true, 200))}`)),
  ]);
  await document.fonts.load(`40px ${PIXEL}`);
  await document.fonts.load(`800 40px ${SPORT}`);

  const scans: Scan[] = [];
  for (let seed = 1; seed <= 22; seed++) scans.push(scanGame(seed));
  const used = new Set<string>();
  const key = (h: Highlight) => `${h.seed}:${h.step}`;
  const pick = (kinds: Highlight['kind'][], seconds: number, eventAt: number, slow: boolean, ok: (h: Highlight) => boolean = () => true): ClipPlan => {
    const all = scans.flatMap((s) => s.highlights.filter((h) => kinds.includes(h.kind) && !used.has(key(h)) && ok(h)).map((h) => ({ h, s })));
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

  /** First choice that has a usable highlight, so a cut never fails for want of one kind of play. */
  const pickAny = (choices: Highlight['kind'][][], seconds: number, eventAt: number, slow: boolean, ok?: (h: Highlight) => boolean): ClipPlan => {
    for (const kinds of choices) {
      try { return pick(kinds, seconds, eventAt, slow, ok); } catch { /* try the next kind */ }
    }
    if (ok) return pickAny(choices, seconds, eventAt, slow);
    throw new Error(`No usable ${choices.flat().join('/')} highlight`);
  };
  const LABELS: Record<Highlight['kind'], string> = { dunk: 'POSTER DUNK', three: 'FROM DOWNTOWN', block: 'GET THAT OUTTA HERE', fire: 'HEATING UP', buzzer: 'AT THE BUZZER' };
  const label = (p: ClipPlan) => {
    const g = new SeededGame(p.h.seed);
    const m = g.g.players.concat(g.g.bench).find((x) => x.id === p.h.player)?.mon;
    const what = p.h.kind === 'dunk' ? (p.h.oop ? 'ALLEY-OOP' : DUNK_MOVES[m?.types[0] ?? 'Normal']) : LABELS[p.h.kind];
    return `${m?.name.toUpperCase() ?? ''} · ${what}`;
  };

  const s: Segment[] = [];
  let t = 0;
  const add = (seg: Segment) => { s.push(seg); t = seg.t1; };
  const clip = (kinds: Highlight['kind'][][], seconds: number, eventAt: number, slow = true, style: 'hero' | 'montage' = 'hero') =>
    add({ kind: 'clip', t0: t, t1: t + seconds, plan: pickAny(kinds, seconds, eventAt, slow), style });
  let musicStart = 0;
  let musicEnd = 0;
  if (CUT === 'vertical') {
    add({ kind: 'v-hook', t0: t, t1: t + 2.6 });
    clip([['dunk']], 4.2, 2.6);
    add({ kind: 'v-cards', t0: t, t1: t + 3.4 });
    clip([['fire'], ['three']], 3.6, 1.4);
    clip([['buzzer'], ['three'], ['dunk']], 4.2, 2.0);
    clip([['block']], 3.2, 1.8);
    for (let i = 0; i < 3; i++) clip([['dunk']], 0.9, 0.6, false, 'montage');
    add({ kind: 'v-outro', t0: t, t1: t + 4.8 });
    musicStart = 0.15;
    musicEnd = s[s.length - 1].t0 + 2.0;
  } else if (CUT === 'franchise') {
    add({ kind: 'f-intro', t0: t, t1: t + 2.8 });
    add({ kind: 'logo', t0: t, t1: t + 2.2 });
    musicStart = s[1].t0 + 0.3;
    add({ kind: 'f-draft', t0: t, t1: t + 3.4 });
    clip([['dunk']], 4.5, 2.8);
    add({ kind: 'f-subs', t0: t, t1: t + 3.0 });
    clip([['block']], 3.8, 2.1);
    add({ kind: 'f-evolve', t0: t, t1: t + 3.6 });
    add({ kind: 'badges', t0: t, t1: t + 3.2 });
    clip([['fire'], ['buzzer']], 4.2, 1.7);
    add({ kind: 'f-champs', t0: t, t1: t + 3.0 });
    add({ kind: 'outro', t0: t, t1: t + 5.4 });
    musicEnd = s[s.length - 1].t0 + 2.2;
  } else if (CUT === 'top5') {
    add({ kind: 't-title', t0: t, t1: t + 2.4 });
    musicStart = 0.25;
    // Pick #1 first so it gets the best dunk, then fill the countdown.
    const one = pickAny([['dunk']], 4.6, 2.8, true);
    const plays: [number, ClipPlan, number][] = [
      [5, pickAny([['three'], ['fire']], 3.6, 2.0, true), 3.6],
      [4, pickAny([['block']], 3.6, 2.0, true), 3.6],
      [3, pickAny([['dunk']], 3.8, 2.2, true, (h) => h.player !== one.h.player), 3.8],
      [2, pickAny([['buzzer'], ['fire'], ['three']], 4.2, 2.0, true), 4.2],
      [1, one, 4.6],
    ];
    for (const [rank, p, sec] of plays) {
      add({ kind: 't-num', t0: t, t1: t + 0.8, rank } as Segment);
      add({ kind: 'clip', t0: t, t1: t + sec, plan: p, style: 'hero', rank, lower: label(p) });
    }
    add({ kind: 'outro', t0: t, t1: t + 5.4 });
    musicEnd = s[s.length - 1].t0 + 2.2;
  } else {
    add({ kind: 'tipoff', t0: t, t1: t + 3.6 });
    add({ kind: 'logo', t0: t, t1: t + 2.2 });
    musicStart = s[1].t0 + 0.3;
    clip([['dunk']], 5.5, 3.3);
    add({ kind: 'wall', t0: t, t1: t + 3.6 });
    add({ kind: 'clock', t0: t, t1: t + 3.0 });
    clip([['block']], 4, 2.2);
    add({ kind: 'legends', t0: t, t1: t + 2.8 });
    clip([['fire']], 4.5, 1.8);
    add({ kind: 'badges', t0: t, t1: t + 3.2 });
    add({ kind: 'evolve', t0: t, t1: t + 2.6 });
    for (let i = 0; i < 4; i++) clip(i === 1 ? [['three', 'dunk']] : [['dunk']], 1, 0.7, false, 'montage');
    add({ kind: 'outro', t0: t, t1: t + 5.4 });
    musicEnd = s[s.length - 1].t0 + 2.2;
  }
  segments = s;
  total = t;
  cue(musicStart, 'music_start');
  cue(musicEnd, 'music_end');
  return { frames: Math.round(total * fps), fps };
}

export function getCues(): Cue[] {
  return [...cues].sort((a, b) => a.t - b.t);
}

declare global {
  interface Window {
    trailer?: { prepare: typeof prepare; renderFrame: typeof renderFrame; getCues: typeof getCues; cut: Cut; size: [number, number] };
  }
}
window.trailer = { prepare, renderFrame, getCues, cut: CUT, size: [W, H] };

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
