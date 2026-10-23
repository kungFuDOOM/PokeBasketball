import type { NoteEv } from './songs';

/** Shared voices for the music: the live player and the offline preview renderer both use these. */
export interface Kit {
  ctx: BaseAudioContext;
  /** Where the notes go (the song's own gain). */
  out: AudioNode;
  /** Echo send for the lead. */
  echo: AudioNode;
  /** Drum bus (its own level, so the beat sits under the melody). */
  drums: AudioNode;
  /** Bass bus (its own level, kept moderate for phone speakers). */
  bass: AudioNode;
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
export function makeKit(ctx: BaseAudioContext, dest: AudioNode, echoTime: number, cutoff = 3400, opts: { lowCut?: number; drumLevel?: number; bassLevel?: number; crispDrums?: boolean } = {}): Kit {
  const out = ctx.createGain();
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = cutoff;
  lp.Q.value = 0.5;
  const drums = ctx.createGain();
  drums.gain.value = opts.drumLevel ?? 1;
  const bass = ctx.createGain();
  bass.gain.value = opts.bassLevel ?? 1;
  bass.connect(out);
  const lowCut = (from: AudioNode) => {
    if (!opts.lowCut) return from;
    // Roll off the sub lows phone speakers can't play (they only distort).
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass';
    hp.frequency.value = opts.lowCut;
    hp.Q.value = 0.7;
    return from.connect(hp);
  };
  lowCut(out).connect(lp).connect(dest);
  if (opts.crispDrums) {
    // Drums skip the mellow low-pass so the hats stay crisp (they're on their own, lower bus), but not the low cut.
    const dlp = ctx.createBiquadFilter();
    dlp.type = 'lowpass';
    dlp.frequency.value = 9500;
    // Lift the snare and hats rather than the kick: the groove reads on a phone without more low end.
    const shelf = ctx.createBiquadFilter();
    shelf.type = 'highshelf';
    shelf.frequency.value = 1500;
    shelf.gain.value = 8;
    lowCut(drums).connect(shelf).connect(dlp).connect(dest);
  } else drums.connect(out);
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
  return { ctx, out, echo, drums, bass, pulse25: pulse(ctx, 0.25), pulse12: pulse(ctx, 0.125), noise };
}

const DRUMS = new Set<NoteEv['voice']>(['kick', 'punch', 'snare', 'snap', 'ghost', 'hat', 'ohat']);

/** Schedules one note at time `t`. */
export function playNote(k: Kit, ev: NoteEv, t: number, stepDur: number) {
  const { ctx } = k;
  const dur = ev.len * stepDur;
  const g = ctx.createGain();
  // Silent until the envelope starts: a sub-sample start time could otherwise let one full-level sample through (a click).
  g.gain.value = 0;
  g.connect(DRUMS.has(ev.voice) ? k.drums : ev.voice === 'bass' || ev.voice === 'slap' ? k.bass : k.out);
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
    case 'wobble': {
      // Wobbly G-funk lead: a filtered saw that scoops into the note and wavers the whole time.
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.frequency.setValueAtTime(ev.freq * 0.977, t);
      o.frequency.exponentialRampToValueAtTime(ev.freq, t + 0.06);
      const lfo = ctx.createOscillator();
      const depth = ctx.createGain();
      lfo.frequency.value = 5.5;
      depth.gain.value = ev.freq * 0.011;
      lfo.connect(depth).connect(o.frequency);
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.frequency.value = 1700;
      f.Q.value = 2;
      env.setValueAtTime(0.0001, t);
      env.linearRampToValueAtTime(0.06, t + 0.02);
      env.setValueAtTime(0.06, t + Math.max(0.03, dur - 0.06));
      env.exponentialRampToValueAtTime(0.0001, t + dur + 0.08);
      o.connect(f).connect(g);
      g.connect(k.echo);
      lfo.start(t); o.start(t);
      lfo.stop(t + dur + 0.12); o.stop(t + dur + 0.12);
      break;
    }
    case 'brass': {
      // Arcade synth brass: two detuned saws with a filter that swells open on each note.
      const f = ctx.createBiquadFilter();
      f.type = 'lowpass';
      f.Q.value = 1;
      f.frequency.setValueAtTime(700, t);
      f.frequency.linearRampToValueAtTime(2600, t + 0.05);
      f.frequency.exponentialRampToValueAtTime(1400, t + 0.3);
      for (const cents of [-8, 8]) {
        const o = ctx.createOscillator();
        o.type = 'sawtooth';
        o.frequency.value = ev.freq;
        o.detune.value = cents;
        o.connect(f);
        o.start(t);
        o.stop(t + dur + 0.1);
      }
      env.setValueAtTime(0.0001, t);
      env.linearRampToValueAtTime(0.035, t + 0.018);
      env.setValueAtTime(0.035, t + Math.max(0.03, dur - 0.05));
      env.exponentialRampToValueAtTime(0.0001, t + dur + 0.07);
      f.connect(g);
      break;
    }
    case 'ep': {
      // Electric piano: a sine with a short FM "tine" at the start, ringing out.
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.value = ev.freq;
      const m = ctx.createOscillator();
      m.frequency.value = ev.freq;
      const mg = ctx.createGain();
      mg.gain.setValueAtTime(ev.freq * 1.4, t);
      mg.gain.exponentialRampToValueAtTime(ev.freq * 0.05, t + 0.35);
      m.connect(mg).connect(o.frequency);
      env.setValueAtTime(0.0001, t);
      env.linearRampToValueAtTime(0.022, t + 0.006);
      env.exponentialRampToValueAtTime(0.0001, t + 1.1);
      o.connect(g);
      m.start(t); o.start(t);
      m.stop(t + 1.15); o.stop(t + 1.15);
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
      sg.gain.value = 0.55;
      const end = t + Math.min(dur, 0.6);
      env.setValueAtTime(0.0001, t);
      env.linearRampToValueAtTime(0.11, t + 0.005);
      env.exponentialRampToValueAtTime(0.07, t + 0.1);
      env.setValueAtTime(0.07, Math.max(t + 0.11, end - 0.03));
      env.exponentialRampToValueAtTime(0.0001, end + 0.02);
      o.connect(f).connect(g);
      sub.connect(sg).connect(g);
      o.start(t); sub.start(t);
      o.stop(end + 0.05); sub.stop(end + 0.05);
      break;
    }
    case 'punch': {
      // Breakbeat kick, kept moderate for phone speakers: a soft pitch drop and a light click.
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(120, t);
      o.frequency.exponentialRampToValueAtTime(60, t + 0.08);
      env.setValueAtTime(0.0001, t);
      env.linearRampToValueAtTime(0.12, t + 0.004);
      env.exponentialRampToValueAtTime(0.0001, t + 0.16);
      o.connect(g);
      o.start(t);
      o.stop(t + 0.24);
      noiseHit(k, g, t, 0.01, 0.02, 'lowpass', 2500);
      break;
    }
    case 'snare':
    case 'ghost': {
      const ghost = ev.voice === 'ghost';
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(220, t);
      o.frequency.exponentialRampToValueAtTime(150, t + 0.06);
      env.setValueAtTime(0.0001, t);
      env.linearRampToValueAtTime(ghost ? 0.012 : 0.04, t + 0.003);
      env.exponentialRampToValueAtTime(0.0001, t + 0.08);
      o.connect(g);
      o.start(t);
      o.stop(t + 0.1);
      noiseHit(k, g, t, ghost ? 0.05 : 0.12, ghost ? 0.015 : 0.05, 'bandpass', 1600);
      break;
    }
    case 'snap': {
      // Rounder, more present snare for the newer tracks: a soft body and a wider noise band, eased in.
      const o = ctx.createOscillator();
      o.type = 'triangle';
      o.frequency.setValueAtTime(200, t);
      o.frequency.exponentialRampToValueAtTime(140, t + 0.07);
      env.setValueAtTime(0.0001, t);
      env.linearRampToValueAtTime(0.035, t + 0.004);
      env.exponentialRampToValueAtTime(0.0001, t + 0.09);
      o.connect(g);
      o.start(t);
      o.stop(t + 0.11);
      noiseHit(k, g, t, 0.14, 0.13, 'bandpass', 1900);
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
  g.gain.value = 0;
  // A 2 ms ramp in takes the edge off the transient.
  g.gain.setValueAtTime(0.0001, t);
  g.gain.linearRampToValueAtTime(vol, t + 0.002);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(out);
  src.start(t);
  src.stop(t + dur + 0.02);
}
