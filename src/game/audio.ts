import type { Sfx } from './game';

/** Tiny WebAudio synth for arcade sound effects; no audio files needed. */
export class Audio {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private crowd: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  muted = false;

  constructor() {
    try {
      this.muted = localStorage.getItem('pokejam.muted') === '1';
    } catch { /* storage unavailable */ }
  }

  /** The audio context, once a tap has unlocked it (the background music shares it). */
  get context(): AudioContext | null {
    return this.ctx;
  }

  /** Where sound effects go (its gain is 0 while muted), for sounds that build their own nodes. */
  get output(): AudioNode | null {
    return this.master;
  }

  /** Must be called from a user gesture. */
  unlock() {
    if (this.ctx) {
      void this.ctx.resume();
      return;
    }
    const AC = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return;
    try {
      this.ctx = new AC();
    } catch {
      return; // too many contexts or audio blocked: the game stays silent instead of throwing
    }
    this.master = this.ctx.createGain();
    this.master.gain.value = this.muted ? 0 : 0.5;
    this.master.connect(this.ctx.destination);
    const len = this.ctx.sampleRate;
    this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
    const d = this.noiseBuf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
  }

  setMuted(m: boolean) {
    this.muted = m;
    try {
      localStorage.setItem('pokejam.muted', m ? '1' : '0');
    } catch { /* storage unavailable */ }
    if (this.master) this.master.gain.value = m ? 0 : 0.5;
  }

  startCrowd() {
    if (!this.ctx || !this.master || !this.noiseBuf || this.crowd) return;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = 700;
    f.Q.value = 0.6;
    this.crowd = this.ctx.createGain();
    this.crowd.gain.value = 0.04;
    src.connect(f).connect(this.crowd).connect(this.master);
    src.start();
  }

  stopCrowd() {
    this.crowd?.disconnect();
    this.crowd = null;
  }

  cheer(level = 1) {
    if (!this.ctx || !this.crowd) return;
    const t = this.ctx.currentTime;
    this.crowd.gain.cancelScheduledValues(t);
    this.crowd.gain.setValueAtTime(0.04 + 0.16 * level, t);
    this.crowd.gain.exponentialRampToValueAtTime(0.04, t + 2.2);
  }

  private tone(type: OscillatorType, f0: number, f1: number, dur: number, vol: number, delay = 0) {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f0, t);
    o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + dur);
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + dur + 0.02);
  }

  private noise(dur: number, vol: number, freq: number, type: BiquadFilterType = 'highpass', delay = 0) {
    if (!this.ctx || !this.master || !this.noiseBuf) return;
    const t = this.ctx.currentTime + delay;
    const src = this.ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(vol, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start(t, Math.random() * 0.5);
    src.stop(t + dur + 0.02);
  }

  play(s: Sfx) {
    if (!this.ctx || this.muted) return;
    switch (s) {
      case 'dribble': this.tone('sine', 140, 60, 0.07, 0.25); break;
      case 'bounce': this.tone('sine', 120, 50, 0.08, 0.2); break;
      case 'swish': this.noise(0.28, 0.35, 3000); this.cheer(0.8); break;
      case 'rim': this.tone('square', 330, 300, 0.12, 0.12); this.tone('square', 495, 440, 0.1, 0.08); break;
      case 'dunk':
        this.tone('sine', 110, 40, 0.35, 0.6);
        this.noise(0.3, 0.4, 400, 'lowpass');
        this.tone('square', 260, 240, 0.15, 0.1, 0.02);
        this.cheer(1.4);
        break;
      case 'buzzer': this.horn(0.85, 0.16); break;
      case 'shotclock': this.horn(0.45, 0.09); break;
      case 'whistle': this.tone('sine', 2600, 2500, 0.22, 0.12); this.tone('sine', 2650, 2550, 0.22, 0.08, 0.25); break;
      case 'block': this.tone('square', 180, 70, 0.18, 0.2); this.noise(0.12, 0.2, 800, 'lowpass'); this.cheer(1); break;
      case 'steal': this.tone('square', 600, 1200, 0.1, 0.12); this.tone('square', 900, 1800, 0.1, 0.1, 0.08); this.cheer(0.6); break;
      case 'shove': this.noise(0.15, 0.35, 300, 'lowpass'); this.tone('triangle', 200, 60, 0.18, 0.3); break;
      case 'pass': this.noise(0.08, 0.12, 1500, 'bandpass'); break;
      case 'catch': this.tone('sine', 220, 120, 0.05, 0.15); break;
      case 'shot': this.noise(0.1, 0.1, 2000, 'bandpass'); break;
      case 'fire':
        [523, 659, 784, 1047].forEach((f, i) => this.tone('square', f, f, 0.12, 0.1, i * 0.08));
        this.noise(0.8, 0.2, 600, 'lowpass');
        this.cheer(1.5);
        break;
      case 'special':
        [392, 523, 659, 784, 1047].forEach((f, i) => this.tone('square', f, f * 1.01, 0.09, 0.09, i * 0.05));
        break;
    }
  }

  /**
   * Arena horn for time running out: two slightly detuned square waves through a low-pass so it buzzes
   * without screeching, a quick fade-in, a short hold and a soft fade-out. Goes through the master gain, so mute applies.
   */
  private horn(dur: number, vol: number) {
    if (!this.ctx || !this.master) return;
    const t = this.ctx.currentTime;
    const f = this.ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 1400;
    f.Q.value = 0.7;
    const g = this.ctx.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(vol, t + 0.04);
    g.gain.setValueAtTime(vol, t + dur * 0.55);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    f.connect(g).connect(this.master);
    for (const [hz, mix] of [[196, 1], [233, 0.7]] as const) {
      const o = this.ctx.createOscillator();
      const m = this.ctx.createGain();
      o.type = 'square';
      o.frequency.value = hz;
      m.gain.value = mix * 0.5;
      o.connect(m).connect(f);
      o.start(t);
      o.stop(t + dur + 0.05);
    }
  }

  /** Short blip for menus. */
  blip(high = false) {
    this.tone('square', high ? 880 : 660, high ? 880 : 660, 0.06, 0.08);
  }
}
