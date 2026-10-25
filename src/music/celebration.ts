/**
 * Sound for the championship celebration, all synthesized with WebAudio (no files) and written for PokéJam:
 * a bright C-major victory fanfare (brass + marimba, a quick run up, a big last chord with a drum roll and cymbal),
 * a crowd cheer swell, a referee whistle and air-horn stingers, confetti pops and camera-flash sparkles, and a short
 * happy loop under the title card. The announcer line comes from the shared Voice.
 *
 * The note data and the building blocks only need a BaseAudioContext, so they also render offline.
 * `CelebrationSound` is the live controller: it owns every node it makes and stops them all in `stop()`.
 */

export const mtof = (m: number) => 440 * 2 ** ((m - 69) / 12);

export type NoteVoice = 'brass' | 'marimba';
/** A note: starts `at` beats in, lasts `len` beats. */
export interface Note { at: number; midi: number; len: number; voice: NoteVoice; vel?: number }

export const FANFARE_BPM = 140;
const BEAT = 60 / FANFARE_BPM;
/** Beat where the big final chord lands. */
export const CHORD_AT = 6;
/** Beats the final chord rings before it fades. */
const CHORD_LEN = 2.2;

const run = (from: number, midis: number[], step: number, voice: NoteVoice, len = step): Note[] =>
  midis.map((midi, i) => ({ at: from + i * step, midi, len, voice }));

/** The fanfare: melody on brass with the tune an octave down on marimba, then the last chord. */
export const FANFARE: Note[] = [
  // quick ascending run, C major arpeggio up two octaves
  ...run(0, [60, 64, 67, 72, 76, 79], 0.25, 'brass'),
  { at: 1.5, midi: 84, len: 0.5, voice: 'brass' },
  // bouncy hook
  { at: 2, midi: 81, len: 0.5, voice: 'brass' },
  { at: 2.5, midi: 79, len: 0.25, voice: 'brass' },
  { at: 2.75, midi: 81, len: 0.25, voice: 'brass' },
  { at: 3, midi: 84, len: 0.5, voice: 'brass' },
  { at: 3.5, midi: 86, len: 0.5, voice: 'brass' },
  // pickup run into the chord
  ...run(4, [79, 83, 86, 91], 0.25, 'brass'),
  { at: 5, midi: 89, len: 0.5, voice: 'brass', vel: 0.8 },
  { at: 5.5, midi: 91, len: 0.5, voice: 'brass', vel: 0.9 },
  // marimba underneath: the run an octave down, the hook, and a bouncing bass
  ...run(0, [48, 52, 55, 60, 64, 67], 0.25, 'marimba'),
  { at: 1.5, midi: 72, len: 0.5, voice: 'marimba' },
  { at: 2, midi: 69, len: 0.5, voice: 'marimba' },
  { at: 2.5, midi: 67, len: 0.25, voice: 'marimba' },
  { at: 2.75, midi: 69, len: 0.25, voice: 'marimba' },
  { at: 3, midi: 72, len: 0.5, voice: 'marimba' },
  { at: 3.5, midi: 74, len: 0.5, voice: 'marimba' },
  { at: 2, midi: 41, len: 0.5, voice: 'marimba' },
  { at: 3, midi: 43, len: 0.5, voice: 'marimba' },
  { at: 4, midi: 43, len: 0.5, voice: 'marimba' },
  { at: 5, midi: 41, len: 0.5, voice: 'marimba' },
  { at: 5.5, midi: 43, len: 0.5, voice: 'marimba' },
  // the big last chord: C major block chord on brass, marimba glitter running up it
  ...[48, 60, 64, 67, 72, 76, 79].map((midi): Note => ({ at: CHORD_AT, midi, len: CHORD_LEN, voice: 'brass', vel: 1.1 })),
  ...run(CHORD_AT + 0.5, [72, 76, 79, 84, 88, 91, 96], 0.125, 'marimba', 0.5),
];

/** Seconds from the start of the fanfare for a beat of it. */
export const fanfareTime = (beat: number) => beat * BEAT;
/** When the last chord lands, in seconds. */
export const CHORD_TIME = fanfareTime(CHORD_AT);
/** Length of the whole fanfare, tail included. */
export const FANFARE_SECONDS = fanfareTime(CHORD_AT + CHORD_LEN) + 0.6;
/** The announcer starts once the last chord has settled. */
export const ANNOUNCE_AT = CHORD_TIME + 0.7;
/** The fanfare starts this long after the whistle. */
const FANFARE_DELAY = 0.5;

// ---- title-card loop: C | Am | F | G, 4 beats a bar ----
export const LOOP_BPM = 118;
export const LOOP_PASSES = 2;
/** `tune` entries are [beat, midi, beats]. */
export interface LoopBar { bass: number; chord: number[]; tune: [number, number, number][] }
export const LOOP: LoopBar[] = [
  { bass: 48, chord: [64, 67, 72], tune: [[0, 76, 0.5], [0.5, 79, 0.5], [1, 84, 0.5], [1.5, 79, 0.5], [2, 76, 0.5], [2.5, 79, 0.5], [3, 81, 1]] },
  { bass: 45, chord: [64, 69, 72], tune: [[0, 76, 0.5], [0.5, 81, 0.5], [1, 84, 0.5], [1.5, 81, 0.5], [2, 76, 0.5], [2.5, 81, 0.5], [3, 79, 0.5], [3.5, 76, 0.5]] },
  { bass: 41, chord: [65, 69, 72], tune: [[0, 77, 0.5], [0.5, 81, 0.5], [1, 84, 0.5], [1.5, 81, 0.5], [2, 77, 0.5], [2.5, 84, 0.5], [3, 86, 0.5], [3.5, 84, 0.5]] },
  { bass: 43, chord: [62, 67, 71], tune: [[0, 74, 0.5], [0.5, 79, 0.5], [1, 83, 0.5], [1.5, 79, 0.5], [2, 86, 0.5], [2.5, 83, 0.5], [3, 79, 1]] },
];
export const LOOP_BAR_SECONDS = (60 / LOOP_BPM) * 4;

// ---- building blocks (any BaseAudioContext) ----

/** Short fixed-seed noise, so every hit sounds the same and renders reproducibly. */
export function noiseBuffer(ctx: BaseAudioContext, seconds = 1): AudioBuffer {
  const len = Math.floor(ctx.sampleRate * seconds);
  const buf = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = buf.getChannelData(0);
  let s = 987654;
  for (let i = 0; i < len; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    d[i] = (s / 0x7fffffff) * 2 - 1;
  }
  return buf;
}

/** Everything a scheduler needs: where sound goes, noise to shape, and who to tell about each source it starts. */
export interface Rig { ctx: BaseAudioContext; out: AudioNode; noise: AudioBuffer; track: (n: AudioScheduledSourceNode) => void }

function osc(r: Rig, type: OscillatorType, t: number, dur: number): OscillatorNode {
  const o = r.ctx.createOscillator();
  o.type = type;
  o.start(t);
  o.stop(t + dur);
  r.track(o);
  return o;
}

function hiss(r: Rig, t: number, dur: number, loop = false, offset = 0): AudioBufferSourceNode {
  const s = r.ctx.createBufferSource();
  s.buffer = r.noise;
  s.loop = loop;
  s.start(t, offset);
  s.stop(t + dur);
  r.track(s);
  return s;
}

function env(r: Rig, peak: number, t: number, attack: number, hold: number, release: number): GainNode {
  const g = r.ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(peak, t + attack);
  g.gain.setValueAtTime(peak, t + attack + hold);
  g.gain.exponentialRampToValueAtTime(0.0001, t + attack + hold + release);
  g.connect(r.out);
  return g;
}

/** Brass: two slightly detuned saws through a low-pass that opens on the attack. */
export function brass(r: Rig, t: number, midi: number, dur: number, vol: number) {
  const f = mtof(midi);
  const lp = r.ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.Q.value = 1.2;
  lp.frequency.setValueAtTime(f * 1.5, t);
  lp.frequency.linearRampToValueAtTime(Math.min(7000, f * 5), t + 0.07);
  lp.frequency.linearRampToValueAtTime(f * 3, t + Math.max(0.12, dur));
  lp.connect(env(r, vol, t, 0.025, Math.max(0, dur - 0.08), 0.1));
  for (const cents of [-7, 7]) {
    const o = osc(r, 'sawtooth', t, dur + 0.15);
    o.frequency.value = f;
    o.detune.value = cents;
    o.connect(lp);
  }
}

/** Marimba: a wooden "bonk" (fundamental plus a bar overtone at four times the pitch) that dies away fast. */
export function marimba(r: Rig, t: number, midi: number, dur: number, vol: number) {
  const f = mtof(midi);
  const ring = Math.min(0.55, Math.max(0.16, dur * 0.9));
  for (const [mult, mix] of [[1, 1], [4, 0.28]] as const) {
    const o = osc(r, 'sine', t, ring + 0.05);
    o.frequency.value = f * mult;
    const g = r.ctx.createGain();
    g.gain.setValueAtTime(vol * mix, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + ring / (mult === 1 ? 1 : 3));
    o.connect(g).connect(r.out);
  }
}

function snare(r: Rig, t: number, vol: number) {
  const f = r.ctx.createBiquadFilter();
  f.type = 'bandpass';
  f.frequency.value = 1900;
  f.Q.value = 0.8;
  const g = r.ctx.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.1);
  hiss(r, t, 0.12, false, (t * 7.3) % 0.5).connect(f).connect(g).connect(r.out);
}

function kick(r: Rig, t: number, vol: number) {
  const o = osc(r, 'sine', t, 0.3);
  o.frequency.setValueAtTime(130, t);
  o.frequency.exponentialRampToValueAtTime(45, t + 0.18);
  const g = r.ctx.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.26);
  o.connect(g).connect(r.out);
}

/** A snare roll that speeds up and swells. */
export function drumRoll(r: Rig, t: number, dur: number, vol = 0.3) {
  for (let at = 0; at < dur;) {
    const k = at / dur;
    snare(r, t + at, vol * (0.25 + 0.75 * k));
    at += 0.11 - 0.06 * k;
  }
}

export function cymbal(r: Rig, t: number, vol = 0.22, dur = 1.8) {
  for (const hz of [6200, 9500]) {
    const f = r.ctx.createBiquadFilter();
    f.type = 'highpass';
    f.frequency.value = hz;
    const g = r.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    hiss(r, t, dur + 0.05, true, 0.1).connect(f).connect(g).connect(r.out);
  }
}

/** Referee-style pea whistle: a high tone with a fast flutter, two tweets. */
export function whistle(r: Rig, t: number, vol = 0.1) {
  for (const [at, len] of [[0, 0.16], [0.22, 0.34]] as const) {
    const s = t + at;
    const o = osc(r, 'sine', s, len + 0.05);
    o.frequency.setValueAtTime(2750, s);
    o.frequency.linearRampToValueAtTime(3050, s + len);
    const lfo = osc(r, 'sine', s, len + 0.05);
    lfo.frequency.value = 36;
    const depth = r.ctx.createGain();
    depth.gain.value = 140;
    lfo.connect(depth).connect(o.frequency);
    o.connect(env(r, vol, s, 0.01, len - 0.03, 0.04));
    // a puff of breath
    const hp = r.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 3500;
    hiss(r, s, len + 0.05).connect(hp).connect(env(r, vol * 0.35, s, 0.01, len - 0.03, 0.04));
  }
}

/** Party air horn: a stack of buzzy tones with a scoop up to pitch; toot, toot, TOOOT. */
export function airHorn(r: Rig, t: number, vol = 0.07) {
  const lp = r.ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 2600;
  lp.Q.value = 0.8;
  lp.connect(r.out);
  for (const [at, len] of [[0, 0.16], [0.2, 0.16], [0.4, 0.75]] as const) {
    const s = t + at;
    const g = r.ctx.createGain();
    g.gain.setValueAtTime(0.0001, s);
    g.gain.linearRampToValueAtTime(vol, s + 0.02);
    g.gain.setValueAtTime(vol, s + len);
    g.gain.exponentialRampToValueAtTime(0.0001, s + len + 0.08);
    g.connect(lp);
    for (const hz of [349, 440, 523]) {
      const o = osc(r, 'sawtooth', s, len + 0.12);
      o.frequency.setValueAtTime(hz * 0.9, s);
      o.frequency.exponentialRampToValueAtTime(hz, s + 0.07);
      o.connect(g);
    }
  }
}

/** Crowd roar: noise through a moving band-pass with a clapping flutter, swelling up to `peak` and dying away. */
export function crowdSwell(r: Rig, t: number, dur: number, peak = 0.22, riseAt = 1.6) {
  const bp = r.ctx.createBiquadFilter();
  bp.type = 'bandpass';
  bp.Q.value = 0.55;
  bp.frequency.setValueAtTime(550, t);
  bp.frequency.linearRampToValueAtTime(1250, t + riseAt);
  bp.frequency.linearRampToValueAtTime(800, t + dur);
  const g = r.ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + riseAt);
  g.gain.setValueAtTime(peak, t + riseAt + 0.2);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  g.connect(r.out);
  // flutter: the level wobbles like a lot of people clapping and whooping
  const flutter = r.ctx.createGain();
  flutter.gain.value = 0.8;
  const lfo = osc(r, 'sine', t, dur + 0.05);
  lfo.frequency.value = 7.5;
  const depth = r.ctx.createGain();
  depth.gain.value = 0.2;
  lfo.connect(depth).connect(flutter.gain);
  hiss(r, t, dur + 0.05, true).connect(bp).connect(flutter).connect(g);
}

/** A little "bloop": a confetti-popper pop with a puff of air. */
export function pop(r: Rig, t: number, vol = 0.16, pitch = 520) {
  const o = osc(r, 'sine', t, 0.12);
  o.frequency.setValueAtTime(pitch, t);
  o.frequency.exponentialRampToValueAtTime(pitch * 2.1, t + 0.06);
  const g = r.ctx.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
  o.connect(g).connect(r.out);
  const hp = r.ctx.createBiquadFilter();
  hp.type = 'highpass';
  hp.frequency.value = 2500;
  const ng = r.ctx.createGain();
  ng.gain.setValueAtTime(vol * 0.7, t);
  ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.07);
  hiss(r, t, 0.09, false, (t * 3.1) % 0.5).connect(hp).connect(ng).connect(r.out);
}

/** Pentatonic sparkle notes (C major pentatonic, high). */
export const SPARKLE = [84, 86, 88, 91, 93, 96];

/** A few quick glittering blips, rising: `n` of them starting at pentatonic degree `from`. */
export function sparkle(r: Rig, t: number, vol = 0.05, n = 3, from = 0) {
  for (let i = 0; i < n; i++) {
    const s = t + i * 0.045;
    const o = osc(r, 'triangle', s, 0.2);
    o.frequency.value = mtof(SPARKLE[(from + i) % SPARKLE.length]);
    const g = r.ctx.createGain();
    g.gain.setValueAtTime(vol, s);
    g.gain.exponentialRampToValueAtTime(0.0001, s + 0.16);
    o.connect(g).connect(r.out);
  }
}

/** Schedules the whole fanfare (notes, drum roll, cymbal, kick) starting at audio time `t`. */
export function scheduleFanfare(r: Rig, t: number) {
  for (const n of FANFARE) {
    const at = t + fanfareTime(n.at);
    const dur = n.len * BEAT;
    const v = n.vel ?? 1;
    if (n.voice === 'brass') brass(r, at, n.midi, dur, 0.032 * v);
    else marimba(r, at, n.midi, dur, 0.1 * v);
  }
  drumRoll(r, t + fanfareTime(3.4), fanfareTime(CHORD_AT - 3.4), 0.28);
  kick(r, t + CHORD_TIME, 0.5);
  cymbal(r, t + CHORD_TIME, 0.2);
}

/** Schedules the scene's own sounds from `t`: whistle, drum roll and fanfare, air horn, crowd, and the cannon pop on the chord. */
export function scheduleScene(r: Rig, t: number) {
  const chord = t + FANFARE_DELAY + CHORD_TIME;
  whistle(r, t);
  scheduleFanfare(r, t + FANFARE_DELAY);
  crowdSwell(r, t + 0.3, 6.2, 0.2, 2.4);
  airHorn(r, chord);
  pop(r, chord, 0.2, 420);
  sparkle(r, chord + 0.05, 0.06, 6, 0);
}

/** Schedules one bar (0-based, cycling) of the title-card loop at `t`. */
export function scheduleLoopBar(r: Rig, t: number, bar: number) {
  const b = LOOP[bar % LOOP.length];
  const beat = 60 / LOOP_BPM;
  for (const [at, midi, len] of b.tune) marimba(r, t + at * beat, midi, len * beat, 0.07);
  for (const at of [0, 2]) {
    marimba(r, t + at * beat, b.bass, beat, 0.13);
    kick(r, t + at * beat, 0.16);
  }
  for (const at of [1, 3]) marimba(r, t + at * beat, b.bass + 7, beat * 0.8, 0.09);
  // soft brass stabs on the off-beats
  for (const at of [1.5, 3.5]) for (const m of b.chord) brass(r, t + at * beat, m, beat * 0.3, 0.008);
  // shaker
  for (let i = 0; i < 8; i++) {
    const s = t + i * 0.5 * beat;
    const hp = r.ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = 7000;
    const g = r.ctx.createGain();
    g.gain.setValueAtTime(i % 2 ? 0.02 : 0.035, s);
    g.gain.exponentialRampToValueAtTime(0.0001, s + 0.05);
    hiss(r, s, 0.06, false, (i * 0.13) % 0.5).connect(hp).connect(g).connect(r.out);
  }
}

// ---- live controller ----

/** What the controller needs from the game's audio (so tests can stand in for it). */
export interface SoundDeps {
  audio: { context: AudioContext | null; output: AudioNode | null; muted: boolean };
  music: { hold(on: boolean): void; enabled: boolean };
  voice: { speak(text: string, delay?: number): void; stop(): void };
}

/** Bus levels (before the master): the scene is the loudest thing in the game's audio, the card loop sits under the text. */
const SCENE_LEVEL = 1.4;
const CARD_LEVEL = 1.3;
/** Flash sparkles are rate-limited: the camera flashes come ~9 a second, which as sound would be a rattle. */
const FLASH_GAP = 0.16;
/** The scene lasts about this long on screen; a title card before then means the scene was skipped. */
const SCENE_END = 6;

export class CelebrationSound {
  private ctx: AudioContext | null = null;
  private rig: Rig | null = null;
  private sceneBus: GainNode | null = null;
  private cardBus: GainNode | null = null;
  private buses: GainNode[] = [];
  private live = new Set<AudioScheduledSourceNode>();
  private t0 = 0;
  private lastFlash = -1;
  private flashes = 0;
  private loopTimer = 0;
  private stopped = false;

  constructor(private deps: SoundDeps, private champion: string) {}

  /** Audible right now: audio unlocked, sound not muted. */
  private get ok() {
    return !this.stopped && !!this.ctx && !this.deps.audio.muted;
  }

  private bus(level = 1): GainNode {
    const g = this.ctx!.createGain();
    g.gain.value = level;
    g.connect(this.deps.audio.output!);
    this.buses.push(g);
    return g;
  }

  private rigFor(bus: GainNode): Rig {
    return {
      ctx: this.ctx!, out: bus, noise: this.rig?.noise ?? noiseBuffer(this.ctx!),
      track: (n) => {
        this.live.add(n);
        n.addEventListener('ended', () => this.live.delete(n));
      },
    };
  }

  /** Scene start: take over from the menu music, then the whistle, drum roll, fanfare, horn, cheer and announcer. */
  start() {
    this.deps.music.hold(true);
    const ctx = this.deps.audio.context;
    if (!ctx || !this.deps.audio.output) return;
    try {
      void ctx.resume().catch(() => {});
    } catch { /* resume unsupported */ }
    this.ctx = ctx;
    if (this.deps.audio.muted) return;
    this.sceneBus = this.bus(SCENE_LEVEL);
    this.rig = this.rigFor(this.sceneBus);
    const t = (this.t0 = ctx.currentTime + 0.06);
    scheduleScene(this.rig, t);
    this.deps.voice.speak(`${this.champion} are your champions!`, FANFARE_DELAY + ANNOUNCE_AT);
  }

  /** A pair of players chest-bumps: a pop and a sparkle. */
  bump() {
    if (!this.ok || !this.rig || !this.sceneBus) return;
    const t = this.ctx!.currentTime + 0.01;
    pop(this.rig, t, 0.13, 480 + Math.random() * 160);
    sparkle(this.rig, t + 0.02, 0.035, 3, Math.floor(Math.random() * 3));
  }

  /** A camera flash in the stands: a tiny glint (rate-limited). */
  flash() {
    if (!this.ok || !this.rig || !this.sceneBus) return;
    const now = this.ctx!.currentTime;
    if (now - this.lastFlash < FLASH_GAP) return;
    this.lastFlash = now;
    sparkle(this.rig, now + 0.005, 0.022, 2, ++this.flashes % 4);
  }

  /** The title card slides in: the scene fades away (the announcer too if the scene was skipped) and the short loop starts. */
  card() {
    if (this.stopped || this.cardBus) return;
    const ctx = this.ctx;
    const skipped = !!ctx && ctx.currentTime - this.t0 < SCENE_END;
    if (skipped) this.deps.voice.stop();
    this.fadeScene(skipped ? 0.2 : 0.6);
    if (!this.ok || !ctx) return;
    const bus = (this.cardBus = this.bus(CARD_LEVEL));
    const r = this.rigFor(bus);
    if (!this.deps.music.enabled) {
      // Music is off: just a short sparkle of welcome, no loop.
      sparkle(r, ctx.currentTime + 0.05, 0.05, 5, 0);
      return;
    }
    let bar = 0;
    let next = ctx.currentTime + 0.12;
    const total = LOOP.length * LOOP_PASSES;
    const pump = () => {
      while (next < ctx.currentTime + 0.6 && bar < total) {
        scheduleLoopBar(r, next, bar++);
        next += LOOP_BAR_SECONDS;
      }
      if (bar < total) return;
      clearInterval(this.loopTimer);
      this.loopTimer = 0;
      // after the last pass the loop rings out and fades, so it never drones on under a card someone is reading
      bus.gain.setValueAtTime(CARD_LEVEL, next - 0.8);
      bus.gain.linearRampToValueAtTime(0.0001, next);
    };
    pump();
    if (bar < total) this.loopTimer = window.setInterval(pump, 100);
  }

  private fadeScene(fade: number) {
    const bus = this.sceneBus;
    const ctx = this.ctx;
    if (!bus || !ctx) return;
    this.sceneBus = null;
    const t = ctx.currentTime;
    bus.gain.cancelScheduledValues(t);
    bus.gain.setValueAtTime(Math.max(0.0001, bus.gain.value), t);
    bus.gain.exponentialRampToValueAtTime(0.0001, t + fade);
    // Only the scene's nodes so far (the card's loop is scheduled after this call).
    const own = [...this.live];
    this.fadeTimer = window.setTimeout(() => {
      for (const n of own) this.halt(n);
      bus.disconnect();
    }, fade * 1000 + 30);
  }

  private fadeTimer = 0;

  private halt(n: AudioScheduledSourceNode) {
    try {
      n.stop();
    } catch { /* never started or already ended */ }
    try {
      n.disconnect();
    } catch { /* already disconnected */ }
    this.live.delete(n);
  }

  /** Scene closed (or leaving the screen): silence everything now and give the music back. */
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.loopTimer);
    clearTimeout(this.fadeTimer);
    this.loopTimer = this.fadeTimer = 0;
    this.deps.voice.stop();
    for (const n of [...this.live]) this.halt(n);
    this.buses.forEach((b) => b.disconnect());
    this.buses = [];
    this.sceneBus = this.cardBus = null;
    this.deps.music.hold(false);
  }
}
