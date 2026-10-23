import type { NoteEv } from './songs';

/** Shared voices for the music: the live player and the offline preview renderer both use these. */
export interface Kit {
  ctx: BaseAudioContext;
  /** Where the notes go (the song's own gain). */
  out: AudioNode;
  /** Echo send for the lead. */
  echo: AudioNode;
  pulse25: PeriodicWave;
  pulse12: PeriodicWave;
  noise: AudioBuffer;
}

/** Game Boy-style pulse wave with the given duty cycle. */
function pulse(ctx: BaseAudioContext, duty: number): PeriodicWave {
  const n = 40;
  const real = new Float32Array(n);
  const imag = new Float32Array(n);
  for (let k = 1; k < n; k++) real[k] = (2 / (k * Math.PI)) * Math.sin(k * Math.PI * duty);
  return ctx.createPeriodicWave(real, imag);
}

/**
 * Builds the music bus: song gain -> soft low-pass (keeps the square waves mellow) -> `dest`,
 * plus an echo on the lead.
 */
export function makeKit(ctx: BaseAudioContext, dest: AudioNode, echoTime: number, cutoff = 3400): Kit {
  const out = ctx.createGain();
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = cutoff;
  lp.Q.value = 0.5;
  out.connect(lp).connect(dest);
  const echo = ctx.createGain();
  echo.gain.value = 0.22;
  const delay = ctx.createDelay(2);
  delay.delayTime.value = echoTime;
  const fb = ctx.createGain();
  fb.gain.value = 0.32;
  const dlp = ctx.createBiquadFilter();
  dlp.type = 'lowpass';
  dlp.frequency.value = 1800;
  echo.connect(delay).connect(dlp).connect(fb).connect(delay);
  dlp.connect(lp);
  const len = Math.floor(ctx.sampleRate * 0.5);
  const noise = ctx.createBuffer(1, len, ctx.sampleRate);
  const d = noise.getChannelData(0);
  // Fixed-seed noise so every hat sounds the same (and previews are reproducible).
  let s = 1234567;
  for (let i = 0; i < len; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    d[i] = (s / 0x7fffffff) * 2 - 1;
  }
  return { ctx, out, echo, pulse25: pulse(ctx, 0.25), pulse12: pulse(ctx, 0.125), noise };
}

/** Schedules one note at time `t`. */
export function playNote(k: Kit, ev: NoteEv, t: number, stepDur: number) {
  const { ctx } = k;
  const dur = ev.len * stepDur;
  const g = ctx.createGain();
  g.connect(k.out);
  const env = g.gain;
  switch (ev.voice) {
    case 'lead': {
      const o = ctx.createOscillator();
      o.setPeriodicWave(k.pulse25);
      o.frequency.value = ev.freq;
      if (dur > stepDur * 1.5) {
        // Gentle delayed vibrato on held notes.
        const lfo = ctx.createOscillator();
        const depth = ctx.createGain();
        lfo.frequency.value = 5.2;
        depth.gain.setValueAtTime(0, t);
        depth.gain.linearRampToValueAtTime(ev.freq * 0.006, t + Math.min(0.35, dur));
        lfo.connect(depth).connect(o.frequency);
        lfo.start(t);
        lfo.stop(t + dur + 0.1);
      }
      env.setValueAtTime(0.0001, t);
      env.linearRampToValueAtTime(0.085, t + 0.012);
      env.exponentialRampToValueAtTime(0.055, t + 0.18);
      env.setValueAtTime(0.055, t + Math.max(0.19, dur - 0.05));
      env.exponentialRampToValueAtTime(0.0001, t + dur + 0.04);
      o.connect(g);
      g.connect(k.echo);
      o.start(t);
      o.stop(t + dur + 0.08);
      break;
    }
    case 'arp': {
      const o = ctx.createOscillator();
      o.setPeriodicWave(k.pulse12);
      o.frequency.value = ev.freq;
      env.setValueAtTime(0.0001, t);
      env.linearRampToValueAtTime(0.028, t + 0.006);
      env.exponentialRampToValueAtTime(0.0001, t + Math.min(0.22, dur));
      o.connect(g);
      o.start(t);
      o.stop(t + 0.25);
      break;
    }
    case 'bass': {
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.value = ev.freq;
      env.setValueAtTime(0.0001, t);
      env.linearRampToValueAtTime(0.2, t + 0.01);
      env.exponentialRampToValueAtTime(0.14, t + 0.15);
      env.setValueAtTime(0.14, t + Math.max(0.16, dur - 0.04));
      env.exponentialRampToValueAtTime(0.0001, t + dur + 0.02);
      o.connect(g);
      o.start(t);
      o.stop(t + dur + 0.05);
      break;
    }
    case 'kick': {
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(ev.freq, t);
      o.frequency.exponentialRampToValueAtTime(42, t + 0.12);
      env.setValueAtTime(0.11, t);
      env.exponentialRampToValueAtTime(0.0001, t + 0.14);
      o.connect(g);
      o.start(t);
      o.stop(t + 0.16);
      break;
    }
    case 'slap': {
      // Funky slap: a bright pulse snapped shut by a fast filter sweep, over a clean sub.
      const o = ctx.createOscillator();
      o.setPeriodicWave(k.pulse25);
      o.frequency.value = ev.freq;
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.Q.value = 6;
      f.frequency.setValueAtTime(2400, t);
      f.frequency.exponentialRampToValueAtTime(260, t + 0.12);
      const sub = ctx.createOscillator();
      sub.type = 'triangle';
      sub.frequency.value = ev.freq;
      const sg = ctx.createGain();
      sg.gain.value = 0.9;
      const end = t + Math.min(dur, 0.6);
      env.setValueAtTime(0.0001, t);
      env.linearRampToValueAtTime(0.13, t + 0.005);
      env.exponentialRampToValueAtTime(0.08, t + 0.1);
      env.setValueAtTime(0.08, Math.max(t + 0.11, end - 0.03));
      env.exponentialRampToValueAtTime(0.0001, end + 0.02);
      o.connect(f).connect(g);
      sub.connect(sg).connect(g);
      o.start(t); sub.start(t);
      o.stop(end + 0.05); sub.stop(end + 0.05);
      break;
    }
    case 'punch': {
      // Punchy breakbeat kick: pitch drop plus a short click.
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(160, t);
      o.frequency.exponentialRampToValueAtTime(48, t + 0.09);
      env.setValueAtTime(0.2, t);
      env.exponentialRampToValueAtTime(0.0001, t + 0.22);
      o.connect(g);
      o.start(t);
      o.stop(t + 0.24);
      noiseHit(k, g, t, 0.012, 0.06, 'lowpass', 3000);
      break;
    }
    case 'snare':
    case 'ghost': {
      const ghost = ev.voice === 'ghost';
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(220, t);
      o.frequency.exponentialRampToValueAtTime(150, t + 0.06);
      env.setValueAtTime(ghost ? 0.02 : 0.07, t);
      env.exponentialRampToValueAtTime(0.0001, t + 0.08);
      o.connect(g);
      o.start(t);
      o.stop(t + 0.1);
      noiseHit(k, g, t, ghost ? 0.05 : 0.14, ghost ? 0.025 : 0.09, 'bandpass', 2200);
      break;
    }
    case 'ohat':
      noiseHit(k, g, t, 0.16, 0.025, 'highpass', 6500);
      break;
    case 'stab': {
      // Short brassy chord hit (one call per chord tone).
      const o = ctx.createOscillator();
      o.setPeriodicWave(k.pulse25);
      o.frequency.value = ev.freq;
      env.setValueAtTime(0.0001, t);
      env.linearRampToValueAtTime(0.03, t + 0.005);
      env.exponentialRampToValueAtTime(0.0001, t + 0.13);
      o.connect(g);
      o.start(t);
      o.stop(t + 0.15);
      break;
    }
    case 'hat': {
      const src = ctx.createBufferSource();
      src.buffer = k.noise;
      const f = ctx.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = 7000;
      env.setValueAtTime(0.03, t);
      env.exponentialRampToValueAtTime(0.0001, t + 0.035);
      src.connect(f).connect(g);
      src.start(t);
      src.stop(t + 0.05);
      break;
    }
  }
}

/** A filtered burst of noise (snare body, hats, kick click). */
function noiseHit(k: Kit, out: AudioNode, t: number, dur: number, vol: number, type: BiquadFilterType, freq: number) {
  const src = k.ctx.createBufferSource();
  src.buffer = k.noise;
  const f = k.ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  const g = k.ctx.createGain();
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(out);
  src.start(t);
  src.stop(t + dur + 0.02);
}
