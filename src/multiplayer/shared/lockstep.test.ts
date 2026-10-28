import { describe, expect, it } from 'vitest';
import { COURTS } from '../../data/courts';
import { monByDex } from '../../data/pokemon';
import { Game } from '../../game/game';
import { snapshot } from '../../game/sync';
import { emptyIntent, seededRng, type GameConfig, type Intent, type TeamDef } from '../../game/types';
import { Lockstep, type NetMsg } from './lockstep';

const team = (name: string, dexes: number[]): TeamDef => ({
  name, abbr: name.slice(0, 3).toUpperCase(), color: '#3b6fd8', color2: '#16224a', human: true, roster: dexes.map(monByDex),
});
const config = (seed: number): GameConfig => ({
  home: team('Pallet Town', [25, 381, 6, 445, 382]),
  away: team('Indigo Elite', [94, 130, 149, 248, 150]),
  quarterLen: 12, difficulty: 'pro', court: COURTS['Indigo Elite'], seed,
});

/** A player that changes what they're doing now and then (deterministic per seed). */
function player(seed: number) {
  const rng = seededRng(seed);
  let held = emptyIntent();
  return (): Intent => {
    if (rng() < 0.08) { held = emptyIntent(); held.mx = rng() * 2 - 1; held.my = rng() * 2 - 1; held.turbo = rng() < 0.3; }
    const shoot = rng() < 0.03;
    return { ...held, shoot, shootHeld: shoot, pass: rng() < 0.01, steal: rng() < 0.01 };
  };
}

interface NetOpts { latency: [number, number]; drop: number; seed: number }

/** Two clients on one fake clock, connected by a lossy, jittery, reordering link. */
function match(net: NetOpts, onFrame?: (t: number, guest: Game) => void) {
  const rng = seededRng(net.seed);
  let now = 0;
  const queue: { at: number; to: 0 | 1; m: NetMsg }[] = [];
  const games = [new Game(config(42)), new Game(config(42))];
  const link = (from: 0 | 1) => ({
    send(m: NetMsg) {
      if (m.k === 'in' && rng() < net.drop) return; // inputs are resent until acked; hashes/snapshots ride a reliable socket
      const [lo, hi] = net.latency;
      queue.push({ at: now + lo + rng() * (hi - lo), to: (1 - from) as 0 | 1, m: JSON.parse(JSON.stringify(m)) });
    },
  });
  const ls = [0, 1].map((s) => new Lockstep(games[s], link(s as 0 | 1), { side: s as 0 | 1, now: () => now }));
  const players = [player(1), player(2)];
  const held: Intent[] = [players[0](), players[1]()];
  let frames = 0;
  while ((games[0].phase !== 'final' || games[1].phase !== 'final') && frames < 200_000) {
    frames++;
    now += 1000 / 60 + (rng() - 0.5) * 6; // uneven frame times
    queue.sort((a, b) => a.at - b.at);
    while (queue.length && queue[0].at <= now) { const q = queue.shift()!; ls[q.to].receive(q.m); }
    for (const s of [0, 1]) {
      if (ls[s].advance(held[s], 1 / 60) > 0) held[s] = players[s]();
      games[s].events.length = 0;
      games[s].sfx.length = 0;
    }
    onFrame?.(frames, games[1]);
  }
  return { games, ls };
}

describe('lockstep', () => {
  it('two clients over a jittery, lossy link finish the same game in the same state', () => {
    const { games, ls } = match({ latency: [30, 140], drop: 0.15, seed: 7 });
    expect(games[0].phase).toBe('final');
    expect(games[1].phase).toBe('final');
    expect(JSON.stringify(snapshot(games[1]))).toBe(JSON.stringify(snapshot(games[0])));
    expect(games[0].score[0] + games[0].score[1]).toBeGreaterThan(0);
    expect(ls[0].stats.desyncs + ls[1].stats.desyncs).toBe(0);
    // Delay adapts to the link but stays in range.
    for (const l of ls) expect(l.delay).toBeGreaterThanOrEqual(4);
  });

  it('on a typical connection the input delay settles low and the game rarely waits', () => {
    const { games, ls } = match({ latency: [20, 60], drop: 0, seed: 11 });
    expect(JSON.stringify(snapshot(games[1]))).toBe(JSON.stringify(snapshot(games[0])));
    for (const l of ls) {
      expect(l.delay).toBeLessThanOrEqual(11); // ≈180 ms at most
      expect(l.stats.stalls).toBeLessThan(10);
    }
  });

  it('a guest that drifts is put back on the host state and both still finish identically', () => {
    let nudged = false;
    const { games, ls } = match({ latency: [20, 60], drop: 0, seed: 3 }, (f, guest) => {
      if (!nudged && f > 900 && guest.phase === 'live') { guest.players[3].x += 0.75; nudged = true; }
    });
    expect(nudged).toBe(true);
    expect(ls[0].stats.desyncs).toBeGreaterThan(0);
    expect(ls[1].stats.resyncs).toBeGreaterThan(0);
    expect(JSON.stringify(snapshot(games[1]))).toBe(JSON.stringify(snapshot(games[0])));
  });

  it('notices when the peer quits', () => {
    const g = new Game(config(1));
    const l = new Lockstep(g, { send() {} }, { side: 1, now: () => 0 });
    l.receive({ k: 'bye' });
    expect(l.peerLeft).toBe(true);
  });
});

describe('a malicious peer', () => {
  const fresh = (side: 0 | 1 = 1) => {
    let now = 0;
    const sent: NetMsg[] = [];
    const g = new Game(config(42));
    const ls = new Lockstep(g, { send: (m) => sent.push(m) }, { side, now: () => now });
    return { g, ls, sent, tick: (ms: number) => { now += ms; } };
  };

  it('a run claiming a billion ticks is dropped at once instead of freezing the game', () => {
    const { ls } = fresh();
    const t0 = performance.now();
    ls.receive({ k: 'in', s: 4, r: [[1e9, 0, 0, 0]], a: 0 });
    ls.receive({ k: 'in', s: 4, r: [[Infinity, 0, 0, 0]], a: 0 });
    expect(performance.now() - t0).toBeLessThan(50);
    expect(ls.stats.dropped).toBe(2);
  });

  it('inputs far in the future or past, bad sticks, bad buttons and junk are all dropped', () => {
    const { ls } = fresh();
    for (const m of [
      { k: 'in', s: 1e7, r: [[1, 0, 0, 0]], a: 0 },
      { k: 'in', s: -5000, r: [[1, 0, 0, 0]], a: 0 },
      { k: 'in', s: 4, r: [[1, NaN, 0, 0]], a: 0 },
      { k: 'in', s: 4, r: [[1, 5, 0, 0]], a: 0 },
      { k: 'in', s: 4, r: [[1, 0, 0, 1.5]], a: 0 },
      { k: 'in', s: 4, r: 'lots', a: 0 },
      { k: 'h', t: 59, h: 'x' },
      { k: 'h', t: 1e9, h: 1 },
      { k: 'nope' }, null, 42, 'in',
    ]) ls.receive(m);
    expect(ls.stats.dropped).toBe(12);
    expect(ls.problem).toBeNull();
  });

  it('a flood is cut off after 80 messages a second', () => {
    const { ls, tick } = fresh();
    for (let i = 0; i < 1000; i++) ls.receive({ k: 'h', t: 59, h: 1 });
    expect(ls.stats.received).toBe(80);
    tick(1000);
    ls.receive({ k: 'h', t: 59, h: 1 });
    expect(ls.stats.received).toBe(81);
  });

  it('an acknowledgement for inputs we never sent does not skip any', () => {
    const { ls, sent } = fresh();
    ls.receive({ k: 'in', s: 4, r: [[1, 0, 0, 0]], a: 1e6 });
    ls.maybeSend(true);
    const last = sent[sent.length - 1] as Extract<NetMsg, { k: 'in' }>;
    expect(last.s).toBeLessThanOrEqual(8); // still sending from the start of our schedule
  });

  it('a snapshot that does not fit this game (extra keys, __proto__, other players) stops the game', () => {
    // As the bytes would arrive: a "__proto__" key in JSON becomes an own property when parsed.
    const wire = (edit: (json: string) => string) => edit(JSON.stringify({ k: 'snap', t: 10, s: snapshot(new Game(config(42))) }));
    for (const json of [
      wire((j) => j.replace('"game":{', '"game":{"__proto__":{"phase":"final"},')),
      wire((j) => j.replace('"game":{', '"game":{"evil":1,')),
      wire((j) => j.replace(/"players":\[\{"id":\d+/, '"players":[{"id":999')),
      wire((j) => j.replace(/"rng":\d+/, '"rng":"x"')),
    ]) {
      const { ls, g } = fresh(1);
      ls.receive(JSON.parse(json));
      expect(ls.problem).toMatch(/does not fit/);
      expect(Object.getPrototypeOf(g)).toBe(Game.prototype);
    }
  });

  it('resync spam: at most one every 1.5 s, and a dozen per game before the game stops', () => {
    const { ls, tick } = fresh(1);
    const snap = snapshot(new Game(config(42)));
    for (let i = 0; i < 5; i++) ls.receive({ k: 'snap', t: 10, s: snap });
    expect(ls.stats.resyncs).toBe(1);
    for (let i = 0; i < 20; i++) { tick(1600); ls.receive({ k: 'snap', t: 10, s: snap }); }
    expect(ls.stats.resyncs).toBe(12);
    expect(ls.problem).toMatch(/out of sync/);
  });

  it('the host never takes a snapshot from the guest', () => {
    const { ls } = fresh(0);
    ls.receive({ k: 'snap', t: 10, s: snapshot(new Game(config(42))) });
    expect(ls.stats.resyncs).toBe(0);
    expect(ls.stats.dropped).toBe(1);
  });
});
