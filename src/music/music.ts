import { menuPlaylist } from './menuSongs';
import { SONGS, loopNotes, type NoteEv, type Song, type TrackId } from './songs';
import { makeKit, playNote, type Kit } from './synth';

const KEY = 'pokejam.music';
const VOLUME = 0.6;
const LOOKAHEAD = 0.25;
/** Each menu track plays this many loops (about 65-80 s) before crossfading to the next. */
export const LOOPS_PER_TRACK = 2;
const CROSSFADE = 2;

/**
 * Shuffled rotation: starts on a random track and never plays the same one twice in a row. Pure, so it's tested.
 */
export class Playlist {
  private i: number;
  constructor(readonly songs: Song[], private rand: () => number = Math.random) {
    this.i = Math.floor(rand() * songs.length) % songs.length;
  }
  get current(): Song {
    return this.songs[this.i];
  }
  advance(): Song {
    if (this.songs.length > 1) this.i = (this.i + 1 + (Math.floor(this.rand() * (this.songs.length - 1)) % (this.songs.length - 1))) % this.songs.length;
    return this.current;
  }
}

/** Seconds per step (an eighth or a sixteenth note) and the swing offset for a step. */
export const stepDur = (s: Song) => 240 / (s.bpm * (s.steps ?? 8));
export const swingAt = (s: Song, step: number) => (step % 2 ? s.swing * stepDur(s) : 0);

/** The synth kit for a song, with its own low-pass and echo time. */
export const kitFor = (ctx: BaseAudioContext, dest: AudioNode, s: Song) => makeKit(ctx, dest, (60 / s.bpm) * (s.echoBeats ?? 1.5), s.cutoff, { lowCut: s.lowCut, drumLevel: s.drumLevel, bassLevel: s.bassLevel, crispDrums: s.crispDrums });

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

  /** Full loops scheduled so far. */
  loops = 0;

  constructor(
    private ctx: AudioContext,
    dest: AudioNode,
    readonly song: Song,
    /** Called when a loop ends, with the audio time it ends at. */
    private onLoop: (loops: number, endsAt: number) => void = () => {},
    fadeIn = 1.2,
  ) {
    this.gain = ctx.createGain();
    this.gain.connect(dest);
    const t = ctx.currentTime;
    this.gain.gain.setValueAtTime(0.0001, t);
    this.gain.gain.exponentialRampToValueAtTime(1, t + fadeIn);
    this.kit = kitFor(ctx, this.gain, song);
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
      if (this.step === 0) this.onLoop(++this.loops, this.next);
    }
  }

  /** Fades out (still playing underneath, so a crossfade overlaps), then stops and frees the nodes. */
  stop(fade = 0.6) {
    this.onLoop = () => {};
    const t = this.ctx.currentTime;
    this.gain.gain.cancelScheduledValues(t);
    this.gain.gain.setValueAtTime(Math.max(0.0001, this.gain.gain.value), t);
    this.gain.gain.exponentialRampToValueAtTime(0.0001, t + fade);
    const g = this.gain;
    window.setTimeout(() => {
      clearInterval(this.timer);
      window.setTimeout(() => g.disconnect(), 600);
    }, fade * 1000);
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
  /** Menu and franchise screens: a shuffled rotation. */
  private playlist = new Playlist(menuPlaylist(typeof location === 'undefined' ? null : new URLSearchParams(location.search).get('menu')));
  /** Loops the current menu track has played, so coming back from a draft or game moves on to a fresh track. */
  private menuLoops = 0;
  private rotateTimer = 0;
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
    // Moving between screens in the same group keeps the song going.
    if (target === this.playing) return;
    clearTimeout(this.rotateTimer);
    this.player?.stop();
    this.player = null;
    if (!target || !ctx || !this.bus) return;
    if (target === 'menu') {
      if (this.menuLoops >= 1) this.playlist.advance();
      this.playMenu(ctx, this.bus, this.playlist.current, 1.2);
    } else this.player = new Player(ctx, this.bus, SONGS[target]);
  }

  private playMenu(ctx: AudioContext, bus: AudioNode, song: Song, fadeIn: number) {
    this.menuLoops = 0;
    const p = new Player(ctx, bus, song, (loops, endsAt) => {
      this.menuLoops = loops;
      if (loops < LOOPS_PER_TRACK || this.playlist.songs.length < 2) return;
      // Crossfade into the next track right as this loop ends.
      clearTimeout(this.rotateTimer);
      this.rotateTimer = window.setTimeout(() => {
        if (this.player !== p) return;
        p.stop(CROSSFADE);
        this.playMenu(ctx, bus, this.playlist.advance(), CROSSFADE);
      }, Math.max(0, (endsAt - ctx.currentTime - CROSSFADE / 2) * 1000));
    }, fadeIn);
    this.player = p;
  }
}

/** Which track goes with which screen (the #app class). */
export function trackFor(screenClass: string): TrackId | null {
  if (screenClass.includes('screen-game')) return null;
  if (screenClass.includes('screen-draft')) return 'draft';
  // Title menu, opponent picker, roster, franchise hub, season results and box scores share the playlist.
  return 'menu';
}
