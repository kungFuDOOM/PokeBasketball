import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mtof, type SoundDeps } from './celebration';
import {
  ANNOUNCE_AT, BADGE_COUNT, FINAL_CHORD_TIME, MASTER_SECONDS, MasterSound, PING_SCALE, SLAM_AT, THEME, THEME_CHORD, lightAt,
} from './master';

const G_MAJOR = new Set([0, 2, 4, 6, 7, 9, 11]);

describe('master sting data', () => {
  it('has one ascending ping per badge, in G major', () => {
    expect(PING_SCALE.length).toBe(BADGE_COUNT);
    expect([...PING_SCALE].sort((a, b) => a - b)).toEqual(PING_SCALE);
    PING_SCALE.forEach((m) => expect(G_MAJOR.has(m % 12)).toBe(true));
    for (let i = 1; i < BADGE_COUNT; i++) expect(lightAt(i)).toBeGreaterThan(lightAt(i - 1));
  });

  it('has a valid in-key theme that ends on a full G chord', () => {
    for (const n of THEME) {
      expect(n.at).toBeGreaterThanOrEqual(0);
      expect(n.len).toBeGreaterThan(0);
      expect(G_MAJOR.has(n.midi % 12)).toBe(true);
      expect(mtof(n.midi)).toBeLessThan(4500);
    }
    const chord = THEME.filter((n) => n.voice === 'brass' && n.at === THEME_CHORD);
    expect(chord.length).toBeGreaterThanOrEqual(8);
    expect(new Set(chord.map((n) => n.midi % 12))).toEqual(new Set([7, 11, 2]));
  });

  it('is ordered: badges, slam, announcer, then the last chord, all inside the sting', () => {
    expect(SLAM_AT).toBeGreaterThan(lightAt(BADGE_COUNT - 1));
    expect(ANNOUNCE_AT).toBeGreaterThan(SLAM_AT);
    expect(FINAL_CHORD_TIME).toBeGreaterThan(ANNOUNCE_AT + 2);
    expect(MASTER_SECONDS).toBeGreaterThan(FINAL_CHORD_TIME);
    expect(MASTER_SECONDS).toBeLessThan(20);
  });
});

function fakeAudio(out: object) {
  const stats = { started: 0, stopped: 0, buses: [] as { connected: boolean }[] };
  const param = () => ({
    value: 0, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn(), cancelScheduledValues: vi.fn(),
  });
  const node = (extra: object = {}) => ({
    frequency: param(), gain: param(), Q: param(), detune: param(), playbackRate: param(), type: '', loop: false, buffer: null,
    connect: vi.fn((d: unknown) => d), disconnect: vi.fn(),
    start: vi.fn(() => { stats.started++; }), stop: vi.fn(() => { stats.stopped++; }),
    addEventListener: () => {},
    ...extra,
  });
  const ctx = {
    currentTime: 1, sampleRate: 8000, state: 'running',
    resume: vi.fn(() => Promise.resolve()),
    createGain: vi.fn(() => {
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

describe('MasterSound', () => {
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
    return { ctx, stats, deps, sound: new MasterSound(deps, 'Pallet Town') };
  }

  it('plays the sting and announces the team by name as a PokeJam Master', () => {
    const { sound, deps, stats } = setup();
    sound.start();
    expect(deps.music.hold).toHaveBeenCalledWith(true);
    expect(deps.voice.speak).toHaveBeenCalledWith('Pallet Town is a PokeJam Master!', expect.any(Number));
    expect(stats.started).toBeGreaterThan(100);
    sound.stop();
  });

  it('stop() silences every source, disconnects its buses, cancels voice and timers, and releases the music', () => {
    const { sound, deps, stats } = setup();
    sound.start();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    sound.stop();
    expect(stats.buses.length).toBeGreaterThanOrEqual(1);
    expect(stats.buses.every((b) => !b.connected)).toBe(true);
    expect(stats.stopped).toBeGreaterThanOrEqual(stats.started);
    expect(vi.getTimerCount()).toBe(0);
    expect(deps.voice.stop).toHaveBeenCalled();
    expect(deps.music.hold).toHaveBeenLastCalledWith(false);
  });

  it('plays nothing while muted or before audio is unlocked, but still gives the music back', () => {
    for (const s of [setup({ muted: true }), setup({ ctx: false })]) {
      s.sound.start();
      expect(s.stats.started).toBe(0);
      expect(s.deps.voice.speak).not.toHaveBeenCalled();
      s.sound.stop();
      expect(s.deps.music.hold).toHaveBeenLastCalledWith(false);
    }
  });

  it('with Music off there is no title loop (no timers)', () => {
    const { sound } = setup({ musicOn: false });
    sound.start();
    expect(vi.getTimerCount()).toBe(0);
    sound.stop();
  });
});
