/**
 * Sound for the PokeJam Master cutscene, built from the championship celebration's synth blocks. It runs about
 * twelve seconds: a drum roll under nine rising marimba pings (one per badge as it lights), a huge G major chord
 * when the title slams in, the announcer, then an original brass theme that climbs to a last, bigger chord.
 * The ping scale, the theme and the chords are written for PokeJam; the key (G major) is deliberately not the
 * C major of the championship fanfare, so it lands as the next step up.
 *
 * `MasterSound` owns every node it makes and silences them all in `stop()`.
 */
import {
  LOOP, LOOP_BAR_SECONDS, LOOP_PASSES, airHorn, brass, crowdSwell, cymbal, drumRoll, kick, marimba, noiseBuffer, pop, scheduleLoopBar,
  sparkle, whistle, type Note, type NoteVoice, type Rig, type SoundDeps,
} from './celebration';

export const BADGE_COUNT = 9;
/** Seconds until the first badge lights, and between badges. */
export const LIGHT_START = 0.5;
export const LIGHT_GAP = 0.34;
export const lightAt = (i: number) => LIGHT_START + i * LIGHT_GAP;
/** The title slams in with the big chord. */
export const SLAM_AT = lightAt(BADGE_COUNT - 1) + 0.9;
/** The announcer starts once the slam chord has bloomed. */
export const ANNOUNCE_AT = SLAM_AT + 0.9;
export const THEME_BPM = 144;
const BEAT = 60 / THEME_BPM;
/** Seconds into the scene where the theme starts, and the beat inside it where the last chord lands. */
export const THEME_AT = SLAM_AT + 4.2;
export const THEME_CHORD = 6;
const THEME_CHORD_LEN = 3;
/** The whole sting, tail included. */
export const MASTER_SECONDS = THEME_AT + (THEME_CHORD + THEME_CHORD_LEN) * BEAT + 0.5;

/** One ping per badge, rising: G major pentatonic from G4 to D6. */
export const PING_SCALE = [67, 69, 71, 74, 76, 79, 81, 83, 86];

const G_MAJOR = [43, 55, 59, 62, 67, 71, 74, 79, 83, 86];
const stack = (at: number, len: number, vel: number): Note[] => G_MAJOR.map((midi) => ({ at, midi, len, voice: 'brass' as NoteVoice, vel }));

/** The theme: a bold rising line on brass, the same line an octave down with a bouncing bass on marimba, then the big chord. */
export const THEME: Note[] = [
  { at: 0, midi: 74, len: 0.5, voice: 'brass' },
  { at: 0.5, midi: 79, len: 0.5, voice: 'brass' },
  { at: 1, midi: 83, len: 0.75, voice: 'brass' },
  { at: 1.75, midi: 81, len: 0.25, voice: 'brass' },
  { at: 2, midi: 79, len: 0.5, voice: 'brass' },
  { at: 2.5, midi: 76, len: 0.5, voice: 'brass' },
  { at: 3, midi: 81, len: 0.5, voice: 'brass' },
  { at: 3.5, midi: 86, len: 0.5, voice: 'brass' },
  { at: 4, midi: 83, len: 0.5, voice: 'brass' },
  { at: 4.5, midi: 84, len: 0.25, voice: 'brass' },
  { at: 4.75, midi: 86, len: 0.25, voice: 'brass' },
  { at: 5, midi: 88, len: 0.5, voice: 'brass', vel: 0.9 },
  { at: 5.5, midi: 91, len: 0.5, voice: 'brass', vel: 1 },
  { at: 0, midi: 62, len: 0.5, voice: 'marimba' },
  { at: 0.5, midi: 67, len: 0.5, voice: 'marimba' },
  { at: 1, midi: 71, len: 0.75, voice: 'marimba' },
  { at: 2, midi: 67, len: 0.5, voice: 'marimba' },
  { at: 3, midi: 69, len: 0.5, voice: 'marimba' },
  { at: 3.5, midi: 74, len: 0.5, voice: 'marimba' },
  { at: 4, midi: 71, len: 0.5, voice: 'marimba' },
  { at: 5, midi: 76, len: 0.5, voice: 'marimba' },
  // bass: G, G, E, D, C, D
  { at: 0, midi: 43, len: 0.5, voice: 'marimba' },
  { at: 1, midi: 43, len: 0.5, voice: 'marimba' },
  { at: 2, midi: 40, len: 0.5, voice: 'marimba' },
  { at: 3, midi: 38, len: 0.5, voice: 'marimba' },
  { at: 4, midi: 36, len: 0.5, voice: 'marimba' },
  { at: 5, midi: 38, len: 0.5, voice: 'marimba' },
  ...stack(THEME_CHORD, THEME_CHORD_LEN, 1.25),
  ...[79, 83, 86, 91, 95, 98].map((midi, i): Note => ({ at: THEME_CHORD + 0.4 + i * 0.125, midi, len: 0.5, voice: 'marimba' })),
];

/** Time of the last chord, in seconds into the scene. */
export const FINAL_CHORD_TIME = THEME_AT + THEME_CHORD * BEAT;

/** A badge lights: a marimba ping up the scale with a sparkle; the ninth (the Elite Four emblem) rings with a brass chord. */
export function lightPing(r: Rig, t: number, i: number) {
  marimba(r, t, PING_SCALE[i], 0.45, 0.13);
  sparkle(r, t + 0.02, 0.04, 2, i % 6);
  if (i === BADGE_COUNT - 1) for (const m of [67, 71, 74]) brass(r, t, m, 0.5, 0.02);
}

function scheduleTheme(r: Rig, t: number) {
  for (const n of THEME) {
    const at = t + n.at * BEAT;
    const v = n.vel ?? 1;
    if (n.voice === 'brass') brass(r, at, n.midi, n.len * BEAT, 0.03 * v);
    else marimba(r, at, n.midi, n.len * BEAT, 0.1 * v);
  }
  drumRoll(r, t + 4 * BEAT, 2 * BEAT, 0.28);
  kick(r, t + THEME_CHORD * BEAT, 0.5);
  cymbal(r, t + THEME_CHORD * BEAT, 0.24, 2.4);
  sparkle(r, t + THEME_CHORD * BEAT + 0.05, 0.06, 6, 0);
}

/** Everything from the first ping to the last chord, as it plays on the clock. */
export function scheduleMaster(r: Rig, t: number) {
  for (let i = 0; i < BADGE_COUNT; i++) lightPing(r, t + lightAt(i), i);
  drumRoll(r, t + LIGHT_START, SLAM_AT - LIGHT_START - 0.05, 0.22);
  crowdSwell(r, t + SLAM_AT - 0.3, 8.6, 0.22, 1.6);
  // the slam: a full chord, kick, cymbal, horn and pop
  for (const n of stack(0, 1.8, 1.2)) brass(r, t + SLAM_AT, n.midi, n.len * BEAT * 2.2, 0.03 * (n.vel ?? 1));
  [79, 83, 86, 91, 95, 98].forEach((m, i) => marimba(r, t + SLAM_AT + 0.35 + i * 0.07, m, 0.5, 0.09));
  kick(r, t + SLAM_AT, 0.55);
  cymbal(r, t + SLAM_AT, 0.24, 2.4);
  airHorn(r, t + SLAM_AT);
  pop(r, t + SLAM_AT, 0.2, 440);
  pop(r, t + SLAM_AT + 0.12, 0.15, 560);
  sparkle(r, t + SLAM_AT + 0.05, 0.06, 6, 0);
  whistle(r, t + SLAM_AT - 0.35, 0.07);
  scheduleTheme(r, t + THEME_AT);
}

const LEVEL = 1.4;
const LOOP_LEVEL = 1.2;

export class MasterSound {
  private ctx: AudioContext | null = null;
  private buses: GainNode[] = [];
  private live = new Set<AudioScheduledSourceNode>();
  private loopTimer = 0;
  private stopped = false;

  constructor(private deps: SoundDeps, private name: string) {}

  private bus(level: number): GainNode {
    const g = this.ctx!.createGain();
    g.gain.value = level;
    g.connect(this.deps.audio.output!);
    this.buses.push(g);
    return g;
  }

  private rigFor(bus: GainNode): Rig {
    return {
      ctx: this.ctx!, out: bus, noise: noiseBuffer(this.ctx!),
      track: (n) => {
        this.live.add(n);
        n.addEventListener('ended', () => this.live.delete(n));
      },
    };
  }

  /** Scene start: takes over from the menu music, schedules the sting, and queues the announcer (the Announcer setting and mute apply to him). */
  start() {
    this.deps.music.hold(true);
    const ctx = this.deps.audio.context;
    if (!ctx || !this.deps.audio.output || this.deps.audio.muted) return;
    try {
      void ctx.resume().catch(() => {});
    } catch { /* resume unsupported */ }
    this.ctx = ctx;
    const t0 = ctx.currentTime + 0.06;
    scheduleMaster(this.rigFor(this.bus(LEVEL)), t0);
    this.deps.voice.speak(`${this.name} is a PokeJam Master!`, 0.06 + ANNOUNCE_AT);
    // With Music on, the happy title-card loop carries on under the finished scene, then fades out by itself.
    if (this.deps.music.enabled) this.loop(t0 + MASTER_SECONDS - 0.4);
  }

  private loop(startAt: number) {
    const ctx = this.ctx!;
    const bus = this.bus(LOOP_LEVEL);
    const r = this.rigFor(bus);
    const total = LOOP.length * LOOP_PASSES;
    let bar = 0;
    let next = startAt;
    const pump = () => {
      while (next < ctx.currentTime + 0.6 && bar < total) {
        scheduleLoopBar(r, next, bar++);
        next += LOOP_BAR_SECONDS;
      }
      if (bar < total) return;
      clearInterval(this.loopTimer);
      this.loopTimer = 0;
      bus.gain.setValueAtTime(LOOP_LEVEL, next - 0.8);
      bus.gain.linearRampToValueAtTime(0.0001, next);
    };
    pump();
    if (bar < total) this.loopTimer = window.setInterval(pump, 100);
  }

  /** Scene closed (or leaving the screen): silence everything now, cancel the voice, give the music back. */
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.loopTimer);
    this.loopTimer = 0;
    this.deps.voice.stop();
    for (const n of [...this.live]) {
      try { n.stop(); } catch { /* never started or already ended */ }
      try { n.disconnect(); } catch { /* already disconnected */ }
    }
    this.live.clear();
    this.buses.forEach((b) => b.disconnect());
    this.buses = [];
    this.deps.music.hold(false);
  }
}
