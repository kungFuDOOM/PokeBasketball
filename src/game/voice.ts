import type { Audio } from './audio';
import type { Sfx } from './game';

const KEY = 'pokejam.announcer';
/** Same level the sound effects use (their master gain is 0.5), a touch under it. */
const GAIN = 0.45;
/** How long the arena horns ring, so a call waits for the horn instead of shouting over it. */
const HORN: Partial<Record<Sfx, number>> = { buzzer: 0.7, shotclock: 0.4 };

/**
 * Plays the arena announcer's recorded lines (public/announcer/*.mp3). The clips aren't in the bundle: they're
 * fetched and decoded in the background the first time a game starts after audio is unlocked. Sound: off in the
 * pause menu silences him too; his own on/off is saved in localStorage.
 */
export class Voice {
  on = true;
  private buffers = new Map<string, AudioBuffer>();
  private loading = new Set<string>();
  private src: AudioBufferSourceNode | null = null;
  private out: GainNode | null = null;

  constructor(private audio: Audio) {
    try {
      this.on = localStorage.getItem(KEY) !== '0';
    } catch { /* storage unavailable */ }
  }

  /** Starts fetching the clips (once). Needs an unlocked audio context; safe to call again later. */
  load(clips: string[]) {
    const ctx = this.audio.context;
    if (!ctx) return;
    for (const c of clips) {
      if (this.buffers.has(c) || this.loading.has(c)) continue;
      this.loading.add(c);
      fetch(`${import.meta.env.BASE_URL}announcer/${c}.mp3`)
        .then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
        .then((b) => ctx.decodeAudioData(b))
        .then((buf) => this.buffers.set(c, buf))
        .catch(() => { /* no line for this one: the popup still shows */ })
        .finally(() => this.loading.delete(c));
    }
  }

  setOn(on: boolean) {
    this.on = on;
    try {
      localStorage.setItem(KEY, on ? '1' : '0');
    } catch { /* storage unavailable */ }
    if (!on) this.stop();
  }

  private get live() {
    return this.on && !this.audio.muted;
  }

  /** Seconds a clip lasts, or 0 if it isn't loaded (or he's off), so nothing waits on it. */
  length(clip: string): number {
    return this.live ? this.buffers.get(clip)?.duration ?? 0 : 0;
  }

  /** Extra wait before a line when a horn went off this frame. */
  static hornDelay(sfx: readonly Sfx[]): number {
    return sfx.reduce((d, s) => Math.max(d, HORN[s] ?? 0), 0);
  }

  /** Says a line `delay` seconds from now, cutting off whatever he was saying. */
  say(clip: string, delay = 0) {
    const ctx = this.audio.context;
    const buf = this.buffers.get(clip);
    if (!ctx || !buf || !this.live) return;
    if (!this.out || this.out.context !== ctx) {
      this.out = ctx.createGain();
      this.out.gain.value = GAIN;
      this.out.connect(ctx.destination);
    }
    this.stop();
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(this.out);
    src.start(ctx.currentTime + delay);
    src.onended = () => { if (this.src === src) this.src = null; };
    this.src = src;
  }

  stop() {
    try {
      this.src?.stop();
    } catch { /* not started */ }
    this.src = null;
  }
}
