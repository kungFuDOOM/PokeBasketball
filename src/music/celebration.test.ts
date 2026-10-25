import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ANNOUNCE_AT, CHORD_AT, CHORD_TIME, CelebrationSound, FANFARE, FANFARE_SECONDS, LOOP, LOOP_BAR_SECONDS, mtof, type SoundDeps,
} from './celebration';

const C_MAJOR = new Set([0, 2, 4, 5, 7, 9, 11]);

describe('fanfare data', () => {
  it('is valid, in C major, and about 3-5 seconds', () => {
    for (const n of FANFARE) {
      expect(n.at).toBeGreaterThanOrEqual(0);
      expect(n.len).toBeGreaterThan(0);
      expect(Number.isInteger(n.midi)).toBe(true);
      expect(mtof(n.midi)).toBeGreaterThan(40);
      expect(mtof(n.midi)).toBeLessThan(4500);
      expect(C_MAJOR.has(n.midi % 12)).toBe(true);
    }
    expect(FANFARE_SECONDS).toBeGreaterThanOrEqual(3);
    expect(FANFARE_SECONDS).toBeLessThanOrEqual(5);
  });

  it('runs up to the chord and ends on a full C major chord', () => {
    const run = FANFARE.filter((n) => n.voice === 'brass' && n.at < 1.5).map((n) => n.midi);
    expect(run.length).toBeGreaterThanOrEqual(5);
    expect([...run].sort((a, b) => a - b)).toEqual(run);
    const chord = FANFARE.filter((n) => n.voice === 'brass' && n.at === CHORD_AT);
    expect(chord.length).toBeGreaterThanOrEqual(5);
    expect(new Set(chord.map((n) => n.midi % 12))).toEqual(new Set([0, 4, 7]));
    expect(FANFARE.some((n) => n.voice === 'marimba')).toBe(true);
    expect(Math.max(...FANFARE.map((n) => n.at))).toBeLessThan(CHORD_AT + 3);
  });

  it('lets the announcer in after the chord and before the fanfare is over', () => {
    expect(ANNOUNCE_AT).toBeGreaterThan(CHORD_TIME);
    expect(ANNOUNCE_AT).toBeLessThan(FANFARE_SECONDS);
  });
});

describe('title-card loop', () => {
  it('has four well-formed bars that fit in the bar', () => {
    expect(LOOP.length).toBe(4);
    expect(LOOP_BAR_SECONDS).toBeGreaterThan(1.5);
    for (const b of LOOP) {
      for (const [at, midi, len] of b.tune) {
        expect(at).toBeGreaterThanOrEqual(0);
        expect(at + len).toBeLessThanOrEqual(4);
        expect(C_MAJOR.has(midi % 12)).toBe(true);
      }
      b.chord.forEach((m) => expect(C_MAJOR.has(m % 12)).toBe(true));
    }
  });
});

/** A just-enough fake AudioContext that counts what is started, stopped and left connected. */
function fakeAudio(out: object) {
  const stats = { started: 0, stopped: 0, buses: [] as { connected: boolean }[] };
  const param = () => ({
    value: 0, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn(), cancelScheduledValues: vi.fn(),
  });
  const node = (extra: object = {}) => {
    const listeners: (() => void)[] = [];
    const n: Record<string, unknown> = {
      frequency: param(), gain: param(), Q: param(), detune: param(), playbackRate: param(), type: '', loop: false, buffer: null,
      connect: vi.fn((d: unknown) => d), disconnect: vi.fn(),
      start: vi.fn(() => { stats.started++; }), stop: vi.fn(() => { stats.stopped++; }),
      addEventListener: (_: string, f: () => void) => listeners.push(f),
      ...extra,
    };
    return n;
  };
  const ctx = {
    currentTime: 1, sampleRate: 8000, state: 'running',
    resume: vi.fn(() => Promise.resolve()),
    createGain: vi.fn(() => {
      // only gains wired straight to the game's output count as buses
      const bus = { connected: true };
      return node({
        connect: vi.fn((d: unknown) => { if (d === out) stats.buses.push(bus); return d; }),
        disconnect: vi.fn(() => { bus.connected = false; }),
      });
    }),
    createOscillator: vi.fn(() => node()),
    createBufferSource: vi.fn(() => node()),
    createBiquadFilter: vi.fn(() => node()),
    createBuffer: vi.fn((_c: number, len: number) => ({ getChannelData: () => new Float32Array(len) })),
  };
  return { ctx, stats };
}

describe('CelebrationSound', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('window', { setTimeout, setInterval, clearTimeout, clearInterval });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function setup(over: { muted?: boolean; musicOn?: boolean; ctx?: boolean } = {}) {
    const out = { connect: vi.fn() } as unknown as AudioNode;
    const { ctx, stats } = fakeAudio(out);
    const deps = {
      audio: { context: over.ctx === false ? null : (ctx as unknown as AudioContext), output: out, muted: !!over.muted },
      music: { hold: vi.fn(), enabled: over.musicOn ?? true },
      voice: { speak: vi.fn(), stop: vi.fn() },
    } satisfies SoundDeps;
    return { ctx, stats, deps, sound: new CelebrationSound(deps, 'Pallet Town') };
  }

  it('starts the scene, announces the champion by name, and holds the menu music', () => {
    const { sound, deps, stats, ctx } = setup();
    sound.start();
    expect(deps.music.hold).toHaveBeenCalledWith(true);
    expect(deps.voice.speak).toHaveBeenCalledWith('Pallet Town are your champions!', expect.any(Number));
    expect(ctx.resume).toHaveBeenCalled();
    expect(stats.started).toBeGreaterThan(50);
  });

  it('stop() silences every source, disconnects its buses, cancels the voice and releases the music', () => {
    const { sound, deps, stats } = setup();
    sound.start();
    sound.bump();
    sound.flash();
    sound.card();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    sound.stop();
    expect(stats.buses.length).toBeGreaterThanOrEqual(2);
    expect(stats.buses.every((b) => !b.connected)).toBe(true);
    expect(stats.stopped).toBeGreaterThanOrEqual(stats.started);
    expect(vi.getTimerCount()).toBe(0);
    expect(deps.voice.stop).toHaveBeenCalled();
    expect(deps.music.hold).toHaveBeenLastCalledWith(false);
    // nothing plays after stop
    const before = stats.started;
    sound.bump();
    sound.flash();
    sound.card();
    expect(stats.started).toBe(before);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('a skip to the title card cuts the announcer, a card after the scene ran its course does not', () => {
    const skipped = setup();
    skipped.sound.start();
    skipped.sound.card();
    expect(skipped.deps.voice.stop).toHaveBeenCalled();
    skipped.sound.stop();

    const natural = setup();
    natural.sound.start();
    natural.ctx.currentTime += 7;
    natural.deps.voice.stop.mockClear();
    natural.sound.card();
    expect(natural.deps.voice.stop).not.toHaveBeenCalled();
    natural.sound.stop();
  });

  it('plays nothing while muted, or before audio is unlocked, but still gives the music back', () => {
    for (const s of [setup({ muted: true }), setup({ ctx: false })]) {
      s.sound.start();
      s.sound.bump();
      s.sound.flash();
      s.sound.card();
      expect(s.stats.started).toBe(0);
      expect(s.deps.voice.speak).not.toHaveBeenCalled();
      s.sound.stop();
      expect(s.deps.music.hold).toHaveBeenLastCalledWith(false);
    }
  });

  it('rate-limits the camera-flash glints', () => {
    const { sound, stats, ctx } = setup();
    sound.start();
    const base = stats.started;
    sound.flash();
    const one = stats.started - base;
    sound.flash();
    expect(stats.started - base).toBe(one);
    ctx.currentTime += 0.5;
    sound.flash();
    expect(stats.started - base).toBe(one * 2);
    sound.stop();
  });

  it('the title-card loop ends by itself after its passes', () => {
    const { sound, ctx } = setup();
    sound.start();
    sound.card();
    for (let i = 0; i < 400; i++) {
      ctx.currentTime += 0.1;
      vi.advanceTimersByTime(100);
    }
    expect(vi.getTimerCount()).toBe(0);
    sound.stop();
  });

  it('with music off the card gets a sparkle but no loop', () => {
    const { sound } = setup({ musicOn: false });
    sound.start();
    sound.card();
    expect(vi.getTimerCount()).toBeLessThanOrEqual(1); // only the scene fade timer
    sound.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
