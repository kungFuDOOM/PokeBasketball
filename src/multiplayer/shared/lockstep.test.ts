import { describe, expect, it } from 'vitest';
import { COURTS } from '../../data/courts';
import { monByDex } from '../../data/pokemon';
import { Game } from '../../game/game';
import { snapshot, stateHash, stepGame, type Snapshot } from '../../game/sync';
import { emptyIntent, seededRng, type GameConfig, type Intent, type TeamDef } from '../../game/types';
import { HASH_EVERY, Lockstep, SEND_MS, plausibleVitals, resyncLimitFor, type LockstepOptions, type NetMsg, type Vitals } from './lockstep';
import { rttStats, startDelay } from './netDelay';
import { PACE_DIRECT_MS } from './netplay';

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

interface NetOpts {
  latency: [number, number]; drop: number; seed: number;
  /** Ms between input batches (default: the engine's SEND_MS). */
  pace?: number;
  /** Starting input delay for both sides, and the tuning (default: the engine's own). */
  delay?: number;
  tune?: LockstepOptions['tune'];
  /** Stop after this many frames even if the game isn't over. */
  maxFrames?: number;
  /** Per-side send pace (overrides `pace`). */
  paceBy?: [number, number];
  /** Everything sent to `to` between `at` and `at + ms` (sim ms) is lost: a blackout on a link or a dead transport. */
  outages?: { at: number; ms: number; to: 0 | 1 }[];
  resyncLimit?: number;
}

/** Two clients on one fake clock, connected by a lossy, jittery, reordering link. */
function match(net: NetOpts, onFrame?: (t: number, guest: Game, ls: Lockstep[]) => void) {
  const rng = seededRng(net.seed);
  let now = 0;
  const queue: { at: number; to: 0 | 1; m: NetMsg }[] = [];
  const games = [new Game(config(42)), new Game(config(42))];
  const link = (from: 0 | 1) => ({
    pace: () => net.paceBy?.[from] ?? net.pace ?? SEND_MS,
    send(m: NetMsg) {
      const to = (1 - from) as 0 | 1;
      if (net.outages?.some((o) => o.to === to && now >= o.at && now < o.at + o.ms)) return;
      if (m.k === 'in' && rng() < net.drop) return; // inputs are resent until acked; hashes/snapshots ride a reliable socket
      const [lo, hi] = net.latency;
      queue.push({ at: now + lo + rng() * (hi - lo), to: (1 - from) as 0 | 1, m: JSON.parse(JSON.stringify(m)) });
    },
  });
  const ls = [0, 1].map((s) => new Lockstep(games[s], link(s as 0 | 1), { side: s as 0 | 1, now: () => now, delay: net.delay, tune: net.tune, resyncLimit: net.resyncLimit }));
  const players = [player(1), player(2)];
  const held: Intent[] = [players[0](), players[1]()];
  let frames = 0;
  while ((games[0].phase !== 'final' || games[1].phase !== 'final') && frames < (net.maxFrames ?? 200_000)) {
    frames++;
    now += 1000 / 60 + (rng() - 0.5) * 6; // uneven frame times
    queue.sort((a, b) => a.at - b.at);
    while (queue.length && queue[0].at <= now) { const q = queue.shift()!; ls[q.to].receive(q.m); }
    for (const s of [0, 1]) {
      if (ls[s].advance(held[s], 1 / 60) > 0) held[s] = players[s]();
      games[s].events.length = 0;
      games[s].sfx.length = 0;
    }
    onFrame?.(frames, games[1], ls);
  }
  return { games, ls, frames, seconds: now / 1000 };
}

/**
 * A guest alone on a fake clock, with `host` a second copy stepped through the same (empty) inputs: what an honest host
 * would hold. The tests play the host's side by hand: forged hashes and snapshots go straight into receive().
 */
function gated(o: Partial<LockstepOptions> = {}) {
  let now = 0;
  const g = new Game(config(42));
  const host = new Game(config(42));
  const ls = new Lockstep(g, { send() {} }, { side: 1, now: () => now, ...o });
  const hashes = new Map<number, number>();
  let hostTick = 0;
  let nextInput = 4;
  const take = (): Snapshot => JSON.parse(JSON.stringify(snapshot(host)));
  const stepHost = () => {
    while (hostTick < ls.tick) {
      stepGame(host, [null, null]);
      if ((hostTick + 1) % HASH_EVERY === 0) hashes.set(hostTick, stateHash(host));
      hostTick++;
    }
    host.events.length = 0;
    host.sfx.length = 0;
  };
  return {
    g, host, ls, take,
    tick: (ms: number) => { now += ms; },
    /** Play on until the guest reaches this tick. */
    playTo(t: number) {
      while (ls.tick < t) {
        ls.receive({ k: 'in', s: nextInput++, r: [[1, 0, 0, 0]], a: 0 });
        now += 1000 / 60;
        ls.advance(emptyIntent(), 1 / 60);
        g.events.length = 0;
        g.sfx.length = 0;
      }
      stepHost();
    },
    hashAt: (t: number) => hashes.get(t)!,
    /** A host hash for tick t that can't match the guest's. */
    mismatch(t: number) { ls.receive({ k: 'h', t, h: 0 }); },
    /** The host's snapshot right now, unless given another. */
    offer(s: Snapshot = take(), t = hostTick - 1) { ls.receive({ k: 'snap', t, s }); },
  };
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

  it('honest drift all game long is never rejected, across quarter breaks and on a slow link', () => {
    for (const [seed, latency] of [[3, [20, 60]], [5, [20, 60]], [8, [105, 145]]] as [number, [number, number]][]) {
      let nudges = 0;
      const { games, ls } = match({ latency, drop: 0.02, seed, resyncLimit: 1000 }, (f, guest) => {
        if (f % 300 === 0 && guest.phase === 'live' && (guest.quarter < 4 || guest.clock > 4)) { guest.players[3].x += 0.75; nudges++; }
      });
      expect(nudges).toBeGreaterThan(3);
      expect(ls[1].stats.resyncs).toBeGreaterThan(3);
      expect(ls[1].stats.rejected).toBe(0);
      expect(ls[1].stats.unrequested).toBe(0);
      expect(ls[1].problem).toBeNull();
      expect(JSON.stringify(snapshot(games[1]))).toBe(JSON.stringify(snapshot(games[0])));
    }
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

  it('a flood is cut off after 200 messages a second', () => {
    const { ls, tick } = fresh();
    for (let i = 0; i < 1000; i++) ls.receive({ k: 'h', t: 59, h: 1 });
    expect(ls.stats.received).toBe(200);
    tick(1000);
    ls.receive({ k: 'h', t: 59, h: 1 });
    expect(ls.stats.received).toBe(201);
  });

  it('an acknowledgement for inputs we never sent does not skip any', () => {
    const { ls, sent } = fresh();
    ls.receive({ k: 'in', s: 4, r: [[1, 0, 0, 0]], a: 1e6 });
    ls.maybeSend(true);
    const last = sent[sent.length - 1] as Extract<NetMsg, { k: 'in' }>;
    expect(last.s).toBeLessThanOrEqual(8); // still sending from the start of our schedule
  });

  it('after a detected desync, a snapshot that does not fit this game (extra keys, __proto__, other players) stops the game', () => {
    // As the bytes would arrive: a "__proto__" key in JSON becomes an own property when parsed.
    const wire = (edit: (json: string) => string) => edit(JSON.stringify({ k: 'snap', t: 59, s: snapshot(new Game(config(42))) }));
    for (const json of [
      wire((j) => j.replace('"game":{', '"game":{"__proto__":{"phase":"final"},')),
      wire((j) => j.replace('"game":{', '"game":{"evil":1,')),
      wire((j) => j.replace(/"players":\[\{"id":\d+/, '"players":[{"id":999')),
      wire((j) => j.replace(/"rng":\d+/, '"rng":"x"')),
    ]) {
      const { ls, g, playTo, mismatch } = gated();
      playTo(60);
      mismatch(59);
      ls.receive(JSON.parse(json));
      expect(ls.problem).toMatch(/does not fit/);
      expect(Object.getPrototypeOf(g)).toBe(Game.prototype);
    }
  });

  it('resync spam: at most one every 1.5 s, and a dozen per game before the game stops', () => {
    const { ls, playTo, mismatch, offer } = gated();
    playTo(60);
    mismatch(59);
    offer();
    expect(ls.stats.resyncs).toBe(1);
    // A second desync one hash later, inside the 1.5 s.
    playTo(120);
    mismatch(119);
    offer();
    expect(ls.stats.resyncs).toBe(1);
    expect(ls.stats.dropped).toBe(1);
    // Two more hash intervals: past the 1.5 s, and through real quarter breaks, so each honest snapshot passes the value check.
    for (let i = 2; i < 20 && !ls.problem; i++) {
      playTo((i + 1) * 2 * HASH_EVERY);
      mismatch(ls.tick - 1 - (ls.tick % HASH_EVERY));
      offer();
    }
    expect(ls.stats.resyncs).toBe(12);
    expect(ls.stats.rejected).toBe(0);
    expect(ls.problem).toMatch(/out of sync/);
  });

  it('the host never takes a snapshot from the guest', () => {
    const { ls } = fresh(0);
    ls.receive({ k: 'snap', t: 10, s: snapshot(new Game(config(42))) });
    expect(ls.stats.resyncs).toBe(0);
    expect(ls.stats.dropped).toBe(1);
  });
});

describe('the guest takes a snapshot only after its own detected desync', () => {
  const unchanged = (g: Game) => { const before = JSON.stringify(snapshot(g)); return () => expect(JSON.stringify(snapshot(g))).toBe(before); };

  it('an unrequested snapshot is ignored and counted once it expires', () => {
    const { ls, g, playTo, hashAt, offer, tick } = gated();
    playTo(60);
    ls.receive({ k: 'h', t: 59, h: hashAt(59) });
    g.players[3].x += 0.75;
    const same = unchanged(g);
    offer();
    tick(2001);
    ls.receive({ k: 'bye' });
    same();
    expect(ls.stats.resyncs).toBe(0);
    expect(ls.stats.unrequested).toBe(1);
    expect(ls.problem).toBeNull();
  });

  it('a malformed snapshot nobody asked for does not stop the game', () => {
    const { ls, playTo, tick } = gated();
    playTo(60);
    ls.receive({ k: 'snap', t: 59, s: { junk: true } });
    tick(2001);
    ls.receive({ k: 'bye' });
    expect(ls.problem).toBeNull();
    expect(ls.stats.unrequested).toBe(1);
  });

  it('a snapshot that beats the guest\'s own check is held, and taken when the mismatch arrives', () => {
    const { ls, g, host, playTo, mismatch, offer } = gated();
    playTo(60);
    g.players[3].x += 0.75;
    offer();
    expect(ls.stats.resyncs).toBe(0);
    mismatch(59);
    expect(ls.stats.resyncs).toBe(1);
    expect(ls.stats.unrequested).toBe(0);
    expect(JSON.stringify(snapshot(g))).toBe(JSON.stringify(snapshot(host)));
  });

  it('a held snapshot is gone after 2 s', () => {
    const { ls, g, playTo, mismatch, offer, tick } = gated();
    playTo(60);
    g.players[3].x += 0.75;
    offer();
    tick(2001);
    const same = unchanged(g);
    mismatch(59);
    same();
    expect(ls.stats.resyncs).toBe(0);
    expect(ls.stats.unrequested).toBe(1);
  });

  it('a snapshot from before the desync is not taken', () => {
    const { ls, g, playTo, take, mismatch, offer } = gated();
    playTo(30);
    const old = take();
    playTo(60);
    mismatch(59);
    const same = unchanged(g);
    offer(old, 29);
    same();
    expect(ls.stats.resyncs).toBe(0);
  });

  it('the answer to the first mismatch still counts when the next hash mismatches too, and the guest replays forward', () => {
    const { ls, g, host, playTo, take, mismatch, offer } = gated();
    playTo(60);
    g.players[3].x += 0.75;
    mismatch(59);
    playTo(70);
    const answer = take();
    playTo(120);
    mismatch(119);
    offer(answer, 69);
    expect(ls.stats.resyncs).toBe(1);
    expect(ls.tick).toBe(120);
    expect(JSON.stringify(snapshot(g))).toBe(JSON.stringify(snapshot(host)));
  });

  it('the host repeating the mismatching hash after a resync does not open the gate again', () => {
    const { ls, playTo, mismatch, offer, tick } = gated();
    playTo(60);
    mismatch(59);
    offer();
    expect(ls.stats.resyncs).toBe(1);
    mismatch(59);
    tick(1600);
    offer();
    expect(ls.stats.resyncs).toBe(1);
  });

  it('the host repeating one hash does not hold the 5 s window open', () => {
    const { ls, playTo, mismatch, offer, tick } = gated();
    playTo(60);
    mismatch(59);
    tick(3000);
    mismatch(59);
    tick(2001);
    offer();
    expect(ls.stats.resyncs).toBe(0);
  });

  it('the gate closes 5 s after the mismatch', () => {
    for (const [wait, resyncs] of [[5000, 1], [5001, 0]]) {
      const { ls, playTo, mismatch, offer, tick } = gated();
      playTo(60);
      mismatch(59);
      tick(wait);
      offer();
      expect(ls.stats.resyncs).toBe(resyncs);
    }
  });

  it('a later matching hash closes the gate', () => {
    const { ls, playTo, hashAt, mismatch, offer } = gated();
    playTo(60);
    mismatch(59);
    playTo(120);
    ls.receive({ k: 'h', t: 119, h: hashAt(119) });
    offer();
    expect(ls.stats.resyncs).toBe(0);
  });

  it('a score jump is dropped and counted, the game goes on, and an honest snapshot in the window still works', () => {
    const { ls, g, host, playTo, mismatch, offer, take } = gated();
    playTo(60);
    g.players[3].x += 0.75;
    mismatch(59);
    const same = unchanged(g);
    const forged = take();
    forged.game.score = [20, 0];
    offer(forged);
    same();
    expect(ls.stats.rejected).toBe(1);
    expect(ls.stats.resyncs).toBe(0);
    expect(ls.problem).toBeNull();
    offer();
    expect(ls.stats.resyncs).toBe(1);
    expect(JSON.stringify(snapshot(g))).toBe(JSON.stringify(snapshot(host)));
  });

  it('values that are not values at all are dropped too', () => {
    for (const edit of [
      (s: Snapshot) => { s.game.score = 'lots'; },
      (s: Snapshot) => { s.game.score = [1]; },
      (s: Snapshot) => { s.game.quarter = null; },
      (s: Snapshot) => { s.game.clock = { $f: 'Infinity' }; },
      (s: Snapshot) => { s.game.phase = 'over'; },
    ]) {
      const { ls, playTo, mismatch, offer, take } = gated();
      playTo(60);
      mismatch(59);
      const bad = take();
      edit(bad);
      offer(bad);
      expect(ls.stats.rejected).toBe(1);
      expect(ls.problem).toBeNull();
    }
  });

  it('a quarter jump, a forced final and a rewound clock are dropped', () => {
    for (const edit of [
      (s: Snapshot) => { s.game.quarter = 3; },
      (s: Snapshot) => { s.game.quarter = 2; }, // one quarter on, but the clock is nowhere near the buzzer
      (s: Snapshot) => { s.game.phase = 'final'; },
      (s: Snapshot) => { s.game.clock = 1; },
    ]) {
      const { ls, playTo, mismatch, offer, take } = gated();
      playTo(60);
      mismatch(59);
      const bad = take();
      edit(bad);
      offer(bad);
      expect(ls.stats.rejected).toBe(1);
      expect(ls.stats.resyncs).toBe(0);
    }
  });

  it('a quarter rollover, the start of overtime and a final buzzer inside the gap are taken', () => {
    for (const [quarter, edit] of [
      [1, (s: Snapshot) => { s.game.quarter = 2; s.game.clock = 0; s.game.phase = 'break'; }],
      [1, (s: Snapshot) => { s.game.quarter = 2; s.game.clock = 12; s.game.phase = 'tip'; }],
      [4, (s: Snapshot) => { s.game.quarter = 5; s.game.clock = 0; s.game.phase = 'break'; }],
      [4, (s: Snapshot) => { s.game.quarter = 5; s.game.clock = 30; s.game.phase = 'tip'; }],
      [4, (s: Snapshot) => { s.game.quarter = 4; s.game.clock = 0; s.game.phase = 'final'; s.game.score = [2, 0]; }],
    ] as [number, (s: Snapshot) => void][]) {
      const { ls, g, playTo, mismatch, offer, take } = gated();
      playTo(50);
      g.quarter = quarter;
      g.clock = 0.5;
      playTo(60);
      mismatch(59);
      const late = take();
      edit(late);
      offer(late);
      expect(ls.stats.rejected).toBe(0);
      expect(ls.stats.resyncs).toBe(1);
    }
  });

  it('later snapshots compare with the state the last one left behind', () => {
    const { ls, playTo, mismatch, offer, take, tick } = gated();
    playTo(60);
    mismatch(59);
    const first = take();
    first.game.score = [3, 0];
    offer(first);
    expect(ls.stats.resyncs).toBe(1);
    tick(1600);
    playTo(120);
    mismatch(119);
    // +3 on what the first snapshot left is fine; measured from the 0-0 before it, this would be too far.
    const second = take();
    second.game.score = [6, 0];
    offer(second);
    expect(ls.stats.rejected).toBe(0);
    expect(ls.stats.resyncs).toBe(2);
  });

  it('Ranked allows 3 resyncs, Social keeps 12', () => {
    expect(resyncLimitFor('ranked')).toBe(3);
    expect(resyncLimitFor('social')).toBe(12);
  });

  it('resyncLimit: the snapshot past the limit stops the game, and only after a detected desync', () => {
    const { ls, playTo, mismatch, offer } = gated({ resyncLimit: 1 });
    playTo(60);
    mismatch(59);
    offer();
    expect(ls.stats.resyncs).toBe(1);
    expect(ls.problem).toBeNull();
    playTo(180);
    offer(); // no mismatch yet: held, not fatal
    expect(ls.problem).toBeNull();
    mismatch(179);
    expect(ls.stats.resyncs).toBe(1);
    expect(ls.problem).toMatch(/out of sync/);
  });
});

describe('plausibleVitals', () => {
  const at = (o: Partial<Vitals> = {}): Vitals => ({ score: [10, 10], quarter: 2, clock: 60, phase: 'live', ...o });
  const ok = (a: Vitals, b: Vitals, dt = 0) => plausibleVitals(a, b, dt, 120);

  it('score: 3 points, plus 3 for each started second of gap', () => {
    expect(ok(at(), at({ score: [13, 10] }))).toBe(true);
    expect(ok(at(), at({ score: [14, 10] }))).toBe(false);
    expect(ok(at(), at({ score: [10, 7] }))).toBe(true);
    expect(ok(at(), at({ score: [10, 6] }))).toBe(false);
    expect(ok(at(), at({ score: [19, 10], clock: 59 }), 1.5)).toBe(true);
    expect(ok(at(), at({ score: [20, 10], clock: 59 }), 1.5)).toBe(false);
  });

  it('clock: 1 s, plus the gap', () => {
    expect(ok(at(), at({ clock: 59 }))).toBe(true);
    expect(ok(at(), at({ clock: 58.9 }))).toBe(false);
    expect(ok(at(), at({ clock: 58 }), 1)).toBe(true);
    expect(ok(at(), at({ clock: 57.9 }), 1)).toBe(false);
  });

  it('a new quarter only at the buzzer, and never two', () => {
    const buzzer = at({ clock: 0.5 });
    expect(ok(buzzer, at({ quarter: 3, clock: 0, phase: 'break' }))).toBe(true);
    expect(ok(buzzer, at({ quarter: 3, clock: 120, phase: 'tip' }))).toBe(true);
    expect(ok(buzzer, at({ quarter: 3, clock: 121.1, phase: 'tip' }))).toBe(false);
    expect(ok(buzzer, at({ quarter: 4, clock: 0, phase: 'break' }))).toBe(false);
    expect(ok(at(), at({ quarter: 3, clock: 120, phase: 'tip' }))).toBe(false);
    expect(ok(at({ quarter: 3, clock: 120, phase: 'tip' }), buzzer)).toBe(true);
  });

  it('the clock jumping back up when a break ends is not a clock jump', () => {
    const inBreak = at({ quarter: 3, clock: 0, phase: 'break' });
    expect(ok(inBreak, at({ quarter: 3, clock: 120, phase: 'tip' }))).toBe(true);
    expect(ok(inBreak, at({ quarter: 3, clock: 119.5, phase: 'live' }))).toBe(true);
    expect(ok(at({ quarter: 3, clock: 120, phase: 'tip' }), inBreak)).toBe(true);
    expect(ok(inBreak, at({ quarter: 3, clock: 50, phase: 'live' }))).toBe(false);
    // Overtime clocks are shorter.
    expect(ok(at({ quarter: 5, clock: 0, phase: 'break' }), at({ quarter: 5, clock: 60, phase: 'tip' }))).toBe(true);
    expect(ok(at({ quarter: 5, clock: 0, phase: 'break' }), at({ quarter: 5, clock: 120, phase: 'tip' }))).toBe(false);
  });

  it('the game ending on one side only: at the buzzer of the 4th or later, or that side tied into overtime', () => {
    const done = at({ quarter: 4, clock: 0, phase: 'final' });
    expect(ok(at({ quarter: 4, clock: 0.5 }), done)).toBe(true);
    expect(ok(done, at({ quarter: 4, clock: 0.5 }))).toBe(true);
    expect(ok(at({ quarter: 4, clock: 30 }), done)).toBe(false);
    expect(ok(at({ quarter: 3, clock: 0.5 }), at({ quarter: 3, clock: 0, phase: 'final' }))).toBe(false);
    expect(ok(done, at({ quarter: 5, clock: 0, phase: 'break' }))).toBe(true);
    expect(ok(done, at({ quarter: 5, clock: 60, phase: 'tip' }))).toBe(true);
    expect(ok(at({ quarter: 4, clock: 0.5 }), at({ quarter: 4, clock: 30, phase: 'final' }))).toBe(false);
    expect(ok(done, done)).toBe(true);
  });
});

describe('lag: 250 ms RTT, +/-40 ms jitter, 2% loss', () => {
  // The old live tuning: start 8, cap 18, +1 per 1 s report (+2 if badly late), -1 when lead > 3, 66 ms send pace.
  const oldAdapt: LockstepOptions['tune'] = {
    windowMs: 1000,
    stallLead: false,
    adapt: (s, lead) => {
      let d = s.delay;
      if (lead < 1 && d < 18) d += lead < -3 ? 2 : 1;
      else if (lead > 3 && d > 4) d--;
      return { delay: Math.min(18, d), steady: 0 };
    },
  };
  const latency: [number, number] = [105, 145]; // one way: RTT 210-290 ms
  const rtt = rttStats(Array.from({ length: 200 }, (_, i) => 2 * (latency[0] + ((latency[1] - latency[0]) * i) / 199)));
  const seeds = [1, 2, 3, 4, 5, 6];

  function run(kind: 'old' | 'new') {
    const fresh = kind === 'new';
    let stalls = 0;
    let seconds = 0;
    let final = 0;
    let max = 0;
    const games: Game[][] = [];
    for (const seed of seeds) {
      const r = match({
        latency, drop: 0.02, seed,
        pace: fresh ? PACE_DIRECT_MS : SEND_MS,
        delay: fresh ? startDelay(rtt.median, PACE_DIRECT_MS, rtt.jitter) : 8,
        tune: fresh ? undefined : oldAdapt,
      });
      stalls += r.ls[0].stats.stalls + r.ls[1].stats.stalls;
      seconds += 2 * r.seconds; // player-seconds
      final += r.ls[0].delay + r.ls[1].delay;
      max = Math.max(max, r.ls[0].stats.maxDelay, r.ls[1].stats.maxDelay);
      games.push(r.games);
    }
    return { stalls, perMin: (stalls * 60) / seconds, finalDelay: final / (2 * seeds.length), maxDelay: max, games };
  }

  it('the new delay start, 60 Hz sends and fast adaptation stall far less than the old tuning', async () => {
    const [before, after] = [run('old'), run('new')];
    const out = {
      scenario: '250 ms RTT (210-290), 2% input loss, 6 seeded matches',
      old: { start_delay: 8, cap: 18, pace_ms: 66, stalls: before.stalls, stalls_per_min: +before.perMin.toFixed(2), final_delay: +before.finalDelay.toFixed(1), max_delay: before.maxDelay },
      new: { start_delay: startDelay(rtt.median, PACE_DIRECT_MS, rtt.jitter), cap: 30, pace_ms: PACE_DIRECT_MS, stalls: after.stalls, stalls_per_min: +after.perMin.toFixed(2), final_delay: +after.finalDelay.toFixed(1), max_delay: after.maxDelay },
    };
    console.log(`stalls/min  OLD ${out.old.stalls_per_min}   NEW ${out.new.stalls_per_min}\n${JSON.stringify(out)}`);
    try {
      // (a computed specifier: the browser tsconfig has no Node types)
      const fs = await import(/* @vite-ignore */ ['node', 'fs'].join(':'));
      fs.writeFileSync('/workspace/social-launch/lag/sim-stalls.json', JSON.stringify(out, null, 2) + '\n');
    } catch { /* the output folder only exists on the dev machine */ }
    expect(after.perMin).toBeLessThan(before.perMin / 2);
    // And both still play the same game to the end, whatever the delays.
    for (const g of [...before.games, ...after.games]) {
      expect(g[0].phase).toBe('final');
      expect(JSON.stringify(snapshot(g[1]))).toBe(JSON.stringify(snapshot(g[0])));
    }
  });

  /** Plays a match to the end and checks both sides finished identical; `worst` = the longest single wait (s). */
  function recovers(net: NetOpts, label: string) {
    let worst = 0;
    const r = match({ ...net, maxFrames: 60 * 150 }, (_t, _g, ls) => { for (const l of ls) worst = Math.max(worst, l.waiting); });
    expect(r.games[0].phase, `${label}: game finished`).toBe('final');
    expect(JSON.stringify(snapshot(r.games[1])), `${label}: same state`).toBe(JSON.stringify(snapshot(r.games[0])));
    return { ...r, worst };
  }

  it('asymmetric send pace (16 ms against 100 ms) finishes identical with short waits', () => {
    const r = recovers({ latency, drop: 0.02, seed: 11, paceBy: [PACE_DIRECT_MS, 100], delay: 12 }, 'asymmetric');
    expect(r.worst).toBeLessThan(2);
    expect(r.ls[0].stats.stallMs + r.ls[1].stats.stallMs).toBeLessThan(20_000);
  });

  it('a 2 s one-way blackout and a 1.2 s burst loss: the game waits, then picks up where it was', () => {
    for (const to of [0, 1] as const) {
      const r = recovers({ latency, drop: 0.02, seed: 12 + to, pace: PACE_DIRECT_MS, delay: 12, outages: [{ at: 20_000, ms: 2000, to }, { at: 40_000, ms: 1200, to: (1 - to) as 0 | 1 }] }, `outage to ${to}`);
      expect(r.worst).toBeGreaterThan(1); // the blackout really bit
      expect(r.worst).toBeLessThan(4);
      expect(r.ls[0].delay).toBeLessThanOrEqual(30);
      expect(r.ls[0].peerLeft || r.ls[1].peerLeft).toBe(false);
    }
  });

  it('after a long blackout in both directions the delays do not run away to the cap and stay there', () => {
    const r = recovers({ latency, drop: 0.02, seed: 14, pace: PACE_DIRECT_MS, delay: 12, outages: [{ at: 20_000, ms: 3000, to: 0 }, { at: 20_000, ms: 3000, to: 1 }] }, 'blackout');
    expect(r.worst).toBeLessThan(5);
    // the late-report jump is capped (MAX_STALL_LEAD) and eases down again afterwards
    expect(Math.max(r.ls[0].delay, r.ls[1].delay)).toBeLessThan(30);
  });

  it('delays adapt on each side by itself and need not agree; the games still finish identical', () => {
    const { games, ls } = match({ latency, drop: 0.02, seed: 9, pace: PACE_DIRECT_MS, delay: 5 });
    expect(Math.max(ls[0].stats.maxDelay, ls[1].stats.maxDelay)).toBeGreaterThan(5); // it climbed from a too-small start
    expect(games[0].phase).toBe('final');
    expect(JSON.stringify(snapshot(games[1]))).toBe(JSON.stringify(snapshot(games[0])));
  });
});
