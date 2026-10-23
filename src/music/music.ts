import { SONGS, loopNotes, type NoteEv, type Song, type TrackId } from './songs';
import { makeKit, playNote, type Kit } from './synth';

const KEY = 'pokejam.music';
const VOLUME = 0.6;
const LOOKAHEAD = 0.25;

/** Seconds per step (eighth note) and the swing offset for a step. */
export const stepDur = (s: Song) => 30 / s.bpm;
export const swingAt = (s: Song, step: number) => (step % 2 ? s.swing * stepDur(s) : 0);

/** Notes of a loop grouped by step. */
function byStep(s: Song): { steps: number; at: NoteEv[][] } {
  const { steps, notes } = loopNotes(s);
  const at: NoteEv[][] = Array.from({ length: steps }, () => []);
  for (const n of notes) at[n.step].push(n);
  return { steps, at };
}

/** One song playing: its own gain (for fades) and a look-ahead scheduler. */
class Player {
  private kit: Kit;
  private gain: GainNode;
  private timer = 0;
  private step = 0;
  private next: number;
  private loop: { steps: number; at: NoteEv[][] };

  constructor(private ctx: AudioContext, dest: AudioNode, readonly song: Song) {
    this.gain = ctx.createGain();
    this.gain.connect(dest);
    const t = ctx.currentTime;
    this.gain.gain.setValueAtTime(0.0001, t);
    this.gain.gain.exponentialRampToValueAtTime(1, t + 1.2);
    this.kit = makeKit(ctx, this.gain, stepDur(song));
    this.loop = byStep(song);
    this.next = t + 0.08;
    this.tick();
    this.timer = window.setInterval(() => this.tick(), 40);
  }

  private tick() {
    const now = this.ctx.currentTime;
    const sd = stepDur(this.song);
    // After a throttled timer, skip ahead rather than bunching notes up.
    if (this.next < now - 0.1) this.next = now + 0.05;
    while (this.next < now + LOOKAHEAD) {
      const t = this.next + swingAt(this.song, this.step);
      for (const n of this.loop.at[this.step]) playNote(this.kit, n, t, sd);
      this.step = (this.step + 1) % this.loop.steps;
      this.next += sd;
    }
  }

  /** Fades out, then frees the nodes. */
  stop() {
    clearInterval(this.timer);
    const t = this.ctx.currentTime;
    this.gain.gain.cancelScheduledValues(t);
    this.gain.gain.setValueAtTime(Math.max(0.0001, this.gain.gain.value), t);
    this.gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    const g = this.gain;
    window.setTimeout(() => g.disconnect(), 1200);
  }
}

/**
 * Background music, separate from the sound effects (its own on/off, saved in localStorage).
 * Plays the track for the current screen once audio is unlocked by a tap, and goes quiet while the tab is hidden.
 */
export class Music {
  enabled = true;
  private ctx: AudioContext | null = null;
  private bus: GainNode | null = null;
  private want: TrackId | null = null;
  private player: Player | null = null;
  private listeners: (() => void)[] = [];

  constructor() {
    try {
      this.enabled = localStorage.getItem(KEY) !== '0';
    } catch { /* storage unavailable */ }
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) void this.ctx?.resume().catch(() => {});
      this.sync();
    });
  }

  /** Hands over the (unlocked) audio context. Safe to call on every tap. */
  attach(ctx: AudioContext | null) {
    if (!ctx) return;
    if (ctx !== this.ctx) {
      this.ctx = ctx;
      this.bus = ctx.createGain();
      this.bus.gain.value = VOLUME;
      this.bus.connect(ctx.destination);
      ctx.addEventListener('statechange', () => this.sync());
    }
    this.sync();
  }

  /** The track this screen wants (null = silence, e.g. during a game). */
  setTrack(id: TrackId | null) {
    this.want = id;
    this.sync();
  }

  setEnabled(on: boolean) {
    this.enabled = on;
    try {
      localStorage.setItem(KEY, on ? '1' : '0');
    } catch { /* storage unavailable */ }
    this.sync();
    this.listeners.forEach((f) => f());
  }

  onChange(f: () => void) {
    this.listeners.push(f);
  }

  get playing(): TrackId | null {
    return this.player?.song.id ?? null;
  }

  private sync() {
    const ctx = this.ctx;
    const target = ctx && this.bus && this.enabled && !document.hidden && ctx.state !== 'closed' ? this.want : null;
    if (target === this.playing) return;
    this.player?.stop();
    this.player = target && ctx && this.bus ? new Player(ctx, this.bus, SONGS[target]) : null;
  }
}

/** Which track goes with which screen (the #app class). */
export function trackFor(screenClass: string): TrackId | null {
  if (screenClass.includes('screen-game')) return null;
  if (screenClass.includes('screen-draft')) return 'draft';
  if (/screen-(hub|season|results)/.test(screenClass)) return 'season';
  return 'menu';
}
