// Lockstep netcode for online games (see docs/multiplayer.md, "Netcode").
//
// Both players run the same deterministic Game (seeded RNG, fixed 60 Hz tick, src/game/sync.ts). Nothing but
// inputs crosses the wire: each side schedules its own input `delay` ticks into the future and sends it to the
// peer; tick t is simulated only once both players' inputs for t are known, so both copies step through exactly
// the same inputs. Input delay hides the network round trip; if the peer's input is late, the game waits.
//
// - Inputs travel in small batches (every tick on a direct link, about 10 a second on Realtime) and every batch
//   repeats everything the peer has not acknowledged yet, so a lost or reordered message never loses an input.
// - Each side adapts its own input delay (netDelay.ts): the peer reports how early our inputs arrive ("lead"), and
//   we jump to the shortfall when they arrive late and ease down slowly when there is plenty of slack. The two
//   delays need not match: inputs are tagged with their tick, so the sim is the same whatever they are.
// - Every HASH_EVERY ticks both sides exchange a state hash. On a mismatch (floating point can differ in the last
//   bit between browser engines) the host sends a full snapshot; the guest restores it and replays its stored
//   inputs to catch up. The host is the authority for that, but only when the guest has seen the mismatch itself and
//   the snapshot's score, quarter and clock are close to the guest's own.
//
// This class is transport-agnostic: hand it anything with send(), feed it received messages with receive().
//
// The peer is not trusted: receive() takes anything. Malformed messages, inputs far outside the window the game
// can be in, oversized runs and floods are dropped. A snapshot the guest did not ask for is ignored, and one whose
// values jump too far is dropped and counted. After a detected desync, a snapshot that doesn't fit this game, or too
// many resyncs, sets `problem` and the match screen ends the game without a result.

import type { Game, Phase } from '../../game/game';
import { TICK, packInput, restore, snapshot, stateHash, stepGame, type Snapshot, type WireInput } from '../../game/sync';
import { quarterClock, type Intent } from '../../game/types';
import { LEAD_WINDOW_MS, MAX_DELAY, MIN_DELAY, adapt } from './netDelay';

export { MAX_DELAY, MIN_DELAY };

export type Side = 0 | 1;

/** [run length, mx, my, button bits] */
export type InputRun = [number, number, number, number];

export type NetMsg =
  /**
   * Inputs for ticks s, s+1, … (run-length encoded); a = highest contiguous tick of the receiver's inputs we hold;
   * l = lead report; h = the sender's latest state hash [tick, hash], riding along instead of a message of its own;
   * g = the sender's signature over these inputs (evidence.ts), for the winner check.
   */
  | { k: 'in'; s: number; r: InputRun[]; a: number; l?: number; lw?: number; h?: [number, number]; g?: string }
  /** State hash after tick t. */
  | { k: 'h'; t: number; h: number }
  /** Host → guest: the authoritative state after tick t. */
  | { k: 'snap'; t: number; s: Snapshot }
  /** The sender quit. */
  | { k: 'bye' }
  /** Round-trip probe (answered by the link, never seen by Lockstep): n = probe number, t = the sender's clock. */
  | { k: 'ping'; n: number; t: number }
  | { k: 'pong'; n: number; t: number };

export interface Transport {
  send(m: NetMsg): void;
  /** Milliseconds between input batches on this transport right now (default SEND_MS). */
  pace?(): number;
}

export interface LockstepOptions {
  side: Side;
  /** Starting input delay in ticks (default 8, about 133 ms). Adapts between MIN_DELAY and MAX_DELAY. */
  delay?: number;
  /** Clock for timeouts and send pacing (ms). */
  now?: () => number;
  /** Replace the delay tuning (the latency simulator in the tests compares it with the old tuning). */
  tune?: { adapt?: typeof adapt; windowMs?: number; stallLead?: boolean };
  /** Resyncs the guest takes per game before the game stops (default 12). */
  resyncLimit?: number;
}

export const SEND_MS = 66;
/** Most ticks of unacknowledged input one batch repeats (5 s: past that the link is dead anyway). */
const MAX_RESEND = 300;
/** A stall only counts as the peer's lateness after this many ticks of play (the sides start at slightly different moments). */
const START_GRACE = 60;
/** Most ticks a single stall can say we are short by. */
const MAX_STALL_LEAD = 12;
export const HASH_EVERY = 60;
/** The peer can't be further ahead than both input delays plus a stall; anything beyond this is junk. */
const MAX_AHEAD = 4 * MAX_DELAY + 60;
/** At most this many messages a second are read from the peer (about 65 in normal play, more in a burst after a hiccup); the rest are dropped. */
const MAX_MSGS_PER_SEC = 200;
/** Resyncs the guest accepts per game, and how often: a host sending more is broken or cheating. */
const DEFAULT_RESYNC_LIMIT = 12;
/** Resyncs allowed before the game stops. Ranked is low: past this the judge decides, and each one could be a forged state. */
export const resyncLimitFor = (queue: 'social' | 'ranked') => (queue === 'ranked' ? 3 : DEFAULT_RESYNC_LIMIT);
const MIN_RESYNC_MS = 1500;
/** How long after its last mismatching hash the guest will take a snapshot. */
const DESYNC_WINDOW_MS = 5000;
/** How long a snapshot that beat the guest's own hash check is held (the two transports can reorder messages). */
const PENDING_MS = 2000;
/** Ticks of input history kept for replays after a resync. */
const HISTORY = 900;
const EMPTY: WireInput = { mx: 0, my: 0, b: 0 };
/** The game can only run up to this far behind real time before it stops trying to catch up. */
const MAX_ACC = 0.25;

const same = (a: WireInput, b: WireInput) => a.mx === b.mx && a.my === b.my && a.b === b.b;

/** The values a snapshot may not move far: what decides the result. */
export interface Vitals {
  score: [number, number];
  quarter: number;
  clock: number;
  phase: Phase;
}

const PHASES: readonly unknown[] = ['tip', 'live', 'dead', 'break', 'final'] satisfies Phase[];

function snapshotVitals(s: Snapshot): Vitals | null {
  const { score, quarter, clock, phase } = s.game;
  if (!Array.isArray(score) || score.length !== 2 || !score.every(Number.isFinite)) return null;
  if (!Number.isFinite(quarter) || !Number.isFinite(clock) || !PHASES.includes(phase)) return null;
  return { score: score as [number, number], quarter: quarter as number, clock: clock as number, phase: phase as Phase };
}

/**
 * Could an honest host be at `b`, given that this copy was at `a` about `dt` seconds away? A desync is a tiny drift,
 * but the two ticks can differ by a round trip and a hash interval, so a basket or a buzzer can fall between them.
 */
export function plausibleVitals(a: Vitals, b: Vitals, dt: number, quarterLen: number): boolean {
  const scoreRoom = 3 + Math.ceil(dt) * 3;
  if (Math.abs(a.score[0] - b.score[0]) > scoreRoom || Math.abs(a.score[1] - b.score[1]) > scoreRoom) return false;
  const dq = b.quarter - a.quarter;
  if (Math.abs(dq) > 1) return false;
  const clockRoom = 1 + dt;
  // The game ended on one side only: the other must be at the same buzzer, or just past it into overtime after a tie.
  if ((a.phase === 'final') !== (b.phase === 'final')) {
    const [done, other] = a.phase === 'final' ? [a, b] : [b, a];
    if (done.quarter < 4 || done.clock > clockRoom) return false;
    return other.quarter === done.quarter ? other.clock <= clockRoom : other.quarter > done.quarter;
  }
  // A new quarter: the earlier side must be at the buzzer, and the later side's clock can't be over a full quarter.
  if (dq !== 0) {
    const [early, late] = dq > 0 ? [a, b] : [b, a];
    return early.clock <= clockRoom && late.clock <= quarterClock(late.quarter, quarterLen) + clockRoom;
  }
  // The quarter number moves at the buzzer, but the clock stays at 0 until the break ends, then jumps to a full quarter.
  if ((a.phase === 'break') !== (b.phase === 'break')) {
    const [inBreak, other] = a.phase === 'break' ? [a, b] : [b, a];
    const full = quarterClock(other.quarter, quarterLen);
    return inBreak.clock <= clockRoom && other.clock >= full - clockRoom && other.clock <= full + clockRoom;
  }
  return Math.abs(a.clock - b.clock) <= clockRoom;
}

export class Lockstep {
  /** Next tick to simulate. */
  tick = 0;
  delay: number;
  readonly side: Side;
  /** Seconds the game has been waiting for the peer's input right now (0 when running). */
  waiting = 0;
  lastHeard: number;
  peerLeft = false;
  readonly stats = {
    stalls: 0, stallMs: 0, desyncs: 0, resyncs: 0, sent: 0, received: 0, dropped: 0, startDelay: 0, maxDelay: 0,
    /** Snapshots dropped because their values jumped too far. */
    rejected: 0,
    /** Snapshots dropped because this guest never saw a mismatch that called for them. */
    unrequested: 0,
    /** Snapshots taken with no stored values to compare them with. */
    unchecked: 0,
  };
  /** Why this game can't go on safely (a broken or malicious peer), or null. */
  problem: string | null = null;

  private local = new Map<number, WireInput>();
  private remote = new Map<number, WireInput>();
  /** Next tick to schedule our own input for. */
  private nextLocal: number;
  /** Highest tick of ours the peer has confirmed. */
  private peerAck: number;
  /** When peerAck last moved. */
  private peerAckAt: number;
  /** Highest tick up to which we hold every remote input. */
  private remoteTop: number;
  private myHashes = new Map<number, number>();
  private peerHashes = new Map<number, number>();
  private acc = 0;
  private lastSend = -Infinity;
  private resyncPending = false;
  // Lead tracking: how many ticks early the peer's inputs reach us, reported back once a second.
  private minLead = Infinity;
  private leadWindowStart: number;
  private leadReport: { l: number; lw: number } | null = null;
  private leadSeq = 0;
  private lastPeerLw = -1;
  private steady = 0;
  private hold = 0;
  private tune: Required<NonNullable<LockstepOptions['tune']>>;
  private now: () => number;
  /** Our latest hash, sent with the next input batch. */
  private hashOut: [number, number] | null = null;
  private rateWindow = 0;
  private rateCount = 0;
  private lastResync = -Infinity;
  private resyncLimit: number;
  /** Guest: the earliest mismatching hash tick not yet settled by a snapshot or a matching hash (-1: none). */
  private desyncAt = -1;
  /** When the latest mismatching hash tick was first seen. */
  private desyncSeenAt = 0;
  /** The latest mismatching hash tick already handled (a hash repeats on every batch until the next one). */
  private lastMismatch = -1;
  /** A snapshot that arrived before the guest's own check called for it. */
  private pending: { t: number; s: Snapshot; at: number } | null = null;
  /** This copy's own values at each hash tick, to compare snapshots with. */
  private mine = new Map<number, Vitals>();

  constructor(private g: Game, private net: Transport, o: LockstepOptions) {
    this.side = o.side;
    this.delay = Math.max(MIN_DELAY, Math.min(MAX_DELAY, o.delay ?? 8));
    this.stats.startDelay = this.stats.maxDelay = this.delay;
    this.now = o.now ?? (() => performance.now());
    this.tune = { adapt, windowMs: LEAD_WINDOW_MS, stallLead: true, ...o.tune };
    this.resyncLimit = o.resyncLimit ?? DEFAULT_RESYNC_LIMIT;
    this.lastHeard = this.now();
    this.leadWindowStart = this.peerAckAt = this.lastHeard;
    // The first ticks have no input from anyone; both sides agree they are empty.
    for (let t = 0; t < MIN_DELAY; t++) {
      this.local.set(t, EMPTY);
      this.remote.set(t, EMPTY);
    }
    this.nextLocal = MIN_DELAY;
    this.peerAck = MIN_DELAY - 1;
    this.remoteTop = MIN_DELAY - 1;
  }

  /**
   * Advance by real time `dt` seconds with the local player's current input. Steps as many ticks as the clock
   * and the peer's inputs allow. Returns how many times `intent` was sampled (edge buttons are consumed then).
   */
  advance(intent: Intent, dt: number): number {
    let sampled = 0;
    this.expireSnapshotState(this.now());
    this.acc = Math.min(MAX_ACC, this.acc + dt);
    // Fell behind the peer (e.g. a slow frame): run a little faster until we catch up.
    if (this.remoteTop - this.tick > this.delay + 3) this.acc = Math.min(MAX_ACC, this.acc + TICK);
    while (this.acc >= TICK && this.g.phase !== 'final') {
      // Keep our own input scheduled `delay` ticks ahead.
      if (this.nextLocal <= this.tick + this.delay) {
        const w = packInput(intent);
        while (this.nextLocal <= this.tick + this.delay) this.local.set(this.nextLocal++, w);
        sampled++;
      }
      if (!this.remote.has(this.tick)) {
        if (this.waiting === 0) this.stats.stalls++;
        this.waiting += dt;
        this.stats.stallMs += dt * 1000;
        break;
      }
      this.waiting = 0;
      this.stepOnce();
      this.acc -= TICK;
    }
    if (this.acc < TICK) this.waiting = 0;
    this.maybeSend(false);
    return sampled;
  }

  private inputsFor(t: number): [WireInput, WireInput] {
    const mine = this.local.get(t) ?? EMPTY;
    const theirs = this.remote.get(t) ?? EMPTY;
    return this.side === 0 ? [mine, theirs] : [theirs, mine];
  }

  private stepOnce() {
    const t = this.tick;
    stepGame(this.g, this.inputsFor(t));
    this.tick++;
    if ((t + 1) % HASH_EVERY === 0) {
      const h = stateHash(this.g);
      this.myHashes.set(t, h);
      this.remember(t);
      this.hashOut = [t, h];
      this.check(t);
    }
    const old = t - HISTORY;
    this.local.delete(old);
    this.remote.delete(old);
    this.myHashes.delete(old);
    this.peerHashes.delete(old);
    this.mine.delete(old);
  }

  private check(t: number) {
    const a = this.myHashes.get(t);
    const b = this.peerHashes.get(t);
    if (a === undefined || b === undefined) return;
    if (a === b) {
      this.resyncPending = false;
      if (t >= this.desyncAt) this.desyncAt = -1;
      return;
    }
    this.stats.desyncs++;
    if (this.side === 1 && t > this.lastMismatch) {
      this.lastMismatch = t;
      // Keep the earliest tick: the host's answer to it may still be on its way when the next hash also mismatches.
      if (this.desyncAt < 0) this.desyncAt = t;
      this.desyncSeenAt = this.now();
      this.takePending();
    }
    // The host is the authority: it sends its state and the guest adopts it.
    if (this.side === 0 && !this.resyncPending) {
      this.resyncPending = true;
      this.net.send({ k: 'snap', t: this.tick - 1, s: snapshot(this.g) });
    }
  }

  private remember(t: number) {
    const g = this.g;
    this.mine.set(t, { score: [g.score[0], g.score[1]], quarter: g.quarter, clock: g.clock, phase: g.phase });
  }

  private canTakeSnapshot(t: number): boolean {
    return this.desyncAt >= 0 && t >= this.desyncAt && this.now() - this.desyncSeenAt <= DESYNC_WINDOW_MS;
  }

  /** Guest: take a snapshot if our own check called for it, otherwise hold it in case that check is about to. */
  private offerSnapshot(t: number, s: Snapshot) {
    this.expireSnapshotState(this.now());
    if (this.canTakeSnapshot(t)) {
      this.adopt(t, s);
      return;
    }
    if (this.pending) this.stats.unrequested++;
    this.pending = { t, s, at: this.now() };
  }

  private takePending() {
    const p = this.pending;
    if (!p || !this.canTakeSnapshot(p.t)) return;
    this.pending = null;
    this.adopt(p.t, p.s);
  }

  private adopt(t: number, s: Snapshot) {
    if (this.resync(t, s)) {
      this.desyncAt = -1;
      this.lastMismatch = -1;
    }
  }

  private expireSnapshotState(now: number) {
    if (this.pending && now - this.pending.at > PENDING_MS) {
      this.pending = null;
      this.stats.unrequested++;
    }
    if (this.desyncAt >= 0 && now - this.desyncSeenAt > DESYNC_WINDOW_MS) this.desyncAt = -1;
  }

  /** Are a snapshot's values close to what this copy had near tick t? Nothing stored to compare with counts as yes. */
  private plausibleValues(t: number, s: Snapshot): boolean {
    const theirs = snapshotVitals(s);
    if (!theirs) return false;
    // The gate means this normally finds the hash tick that opened it, or a later one.
    let at = -1;
    for (const k of this.mine.keys()) if (k <= t && k > at) at = k;
    const ours = this.mine.get(at);
    if (!ours) {
      this.stats.unchecked++;
      return true;
    }
    return plausibleVitals(ours, theirs, (t - at) / 60, this.g.cfg.quarterLen);
  }

  /** A tick the peer could honestly be talking about right now. */
  private plausible(t: unknown): t is number {
    return Number.isInteger(t) && (t as number) >= this.tick - HISTORY && (t as number) <= this.tick + MAX_AHEAD;
  }

  /** Feed a message from the peer: anything at all (it's checked here). */
  receive(raw: unknown) {
    const now = this.now();
    this.expireSnapshotState(now);
    if (now - this.rateWindow >= 1000) { this.rateWindow = now; this.rateCount = 0; }
    // Snapshots and goodbyes are rare and each is guarded elsewhere (resync limits); a burst of inputs must not shut them out.
    const rare = !!raw && typeof raw === 'object' && ((raw as { k?: unknown }).k === 'snap' || (raw as { k?: unknown }).k === 'bye');
    if ((!rare && ++this.rateCount > MAX_MSGS_PER_SEC) || !raw || typeof raw !== 'object') { this.stats.dropped++; return; }
    const m = raw as Partial<Record<string, unknown>> & { k?: unknown };
    this.lastHeard = now;
    this.stats.received++;
    if (m.k === 'bye') {
      this.peerLeft = true;
    } else if (m.k === 'in') {
      this.receiveInputs(m);
    } else if (m.k === 'h') {
      this.receiveHash(m.t, m.h);
    } else if (m.k === 'snap' && this.side === 1) {
      if (this.plausible(m.t) && m.s && typeof m.s === 'object') this.offerSnapshot(m.t, m.s as Snapshot);
      else this.stats.dropped++;
    } else {
      this.stats.dropped++;
    }
  }

  private receiveHash(t: unknown, h: unknown) {
    if (!this.plausible(t) || !Number.isFinite(h) || (t + 1) % HASH_EVERY !== 0) { this.stats.dropped++; return; }
    this.peerHashes.set(t, h as number);
    this.check(t);
  }

  private receiveInputs(m: Partial<Record<string, unknown>>) {
    const r = m.r;
    if (!this.plausible(m.s) || !Array.isArray(r) || r.length > HISTORY) { this.stats.dropped++; return; }
    // Check every run before taking any: whole numbers, a sane total, stick in -1..1, buttons a byte.
    let total = 0;
    for (const run of r) {
      if (!Array.isArray(run) || run.length !== 4) { this.stats.dropped++; return; }
      const [n, mx, my, b] = run as unknown[];
      if (!Number.isInteger(n) || (n as number) < 1 || !Number.isFinite(mx) || !Number.isFinite(my) || Math.abs(mx as number) > 1
        || Math.abs(my as number) > 1 || !Number.isInteger(b) || (b as number) < 0 || (b as number) > 255) { this.stats.dropped++; return; }
      total += n as number;
    }
    if (total > HISTORY || !this.plausible(m.s + total)) { this.stats.dropped++; return; }
    let t = m.s;
    for (const [n, mx, my, b] of r as InputRun[]) {
      for (let i = 0; i < n; i++, t++) {
        if (t < this.tick || this.remote.has(t)) continue;
        this.remote.set(t, { mx, my, b });
        // Arriving while we are stuck waiting: the lead is minus how long we have waited, in ticks. Not at tip-off (the
        // two sides start a moment apart, which is no fault of the link) and capped (a hitch of our own looks the same).
        const stalled = this.tune.stallLead && this.waiting > 0 && this.tick > START_GRACE;
        this.minLead = Math.min(this.minLead, stalled ? -Math.min(MAX_STALL_LEAD, Math.ceil(this.waiting / TICK)) : t - this.tick);
      }
    }
    while (this.remote.has(this.remoteTop + 1)) this.remoteTop++;
    // The peer can only acknowledge inputs we've actually scheduled.
    if (Number.isInteger(m.a) && (m.a as number) > this.peerAck) {
      this.peerAck = Math.min(m.a as number, this.nextLocal - 1);
      this.peerAckAt = this.now();
    }
    if (Number.isFinite(m.l) && Number.isInteger(m.lw) && m.lw !== this.lastPeerLw) {
      this.lastPeerLw = m.lw as number;
      this.adaptDelay(Math.max(-MAX_DELAY, Math.min(MAX_DELAY, m.l as number)));
    }
    if (Array.isArray(m.h) && m.h.length === 2) this.receiveHash(m.h[0], m.h[1]);
  }

  /** The peer says our inputs reached it `lead` ticks before it needed them (negative: it had to wait). */
  private adaptDelay(lead: number) {
    const next = this.tune.adapt({ delay: this.delay, steady: this.steady, hold: this.hold }, lead);
    this.delay = next.delay;
    this.steady = next.steady;
    this.hold = next.hold ?? 0;
    this.stats.maxDelay = Math.max(this.stats.maxDelay, this.delay);
  }

  /** Guest: adopt the host's state after tick t, then replay our stored inputs to where we were. Returns whether it did. */
  private resync(t: number, s: Snapshot): boolean {
    const now = this.now();
    if (this.stats.resyncs >= this.resyncLimit) { this.problem = 'The games kept going out of sync.'; return false; }
    if (now - this.lastResync < MIN_RESYNC_MS) { this.stats.dropped++; return false; }
    if (!fitsGame(this.g, s)) { this.problem = 'The other player sent a game state that does not fit this game.'; return false; }
    // Dropped, not fatal: a problem ends the game as this player's forfeit, which would hand a cheating host the win.
    if (!this.plausibleValues(t, s)) {
      this.stats.rejected++;
      this.pending = null;
      return false;
    }
    this.lastResync = now;
    const target = Math.max(this.tick, t + 1);
    try {
      restore(this.g, s);
    } catch {
      this.problem = 'The other player sent a game state that does not fit this game.';
      return false;
    }
    this.tick = t + 1;
    // Every hash so far describes the state we just left. The host repeats its latest hash on each batch, so keeping
    // ours would raise the same mismatch again straight after this resync.
    this.myHashes.clear();
    this.mine.clear();
    while (this.tick < target && this.remote.has(this.tick) && this.local.has(this.tick)) {
      stepGame(this.g, this.inputsFor(this.tick));
      this.tick++;
    }
    // A replay must not repeat sounds and announcements.
    this.g.events.length = 0;
    this.g.sfx.length = 0;
    this.stats.resyncs++;
    return true;
  }

  /** Send unacknowledged inputs (paced to SEND_MS unless forced). */
  maybeSend(force: boolean) {
    const now = this.now();
    if (!force && now - this.lastSend < (this.net.pace?.() ?? SEND_MS)) return;
    this.lastSend = now;
    if (now - this.leadWindowStart >= this.tune.windowMs) {
      // Report the smallest lead seen in this window. A window with no input from the peer says nothing about our delay
      // (a dead link, or a peer that is itself stalled): no report, rather than a "late" one that would push the peer's delay up.
      if (Number.isFinite(this.minLead)) {
        this.leadReport = { l: this.minLead, lw: this.leadSeq++ };
        this.minLead = Infinity;
      }
      this.leadWindowStart = now;
    }
    const from = Math.max(this.peerAck + 1, this.nextLocal - MAX_RESEND);
    const runs: InputRun[] = [];
    for (let t = from; t < this.nextLocal; t++) {
      const w = this.local.get(t) ?? EMPTY;
      const last = runs[runs.length - 1];
      if (last && same({ mx: last[1], my: last[2], b: last[3] }, w)) last[0]++;
      else runs.push([1, w.mx, w.my, w.b]);
    }
    const m: NetMsg = { k: 'in', s: from, r: runs, a: this.remoteTop };
    if (this.leadReport) Object.assign(m, this.leadReport);
    if (this.hashOut) m.h = this.hashOut;
    this.net.send(m);
    this.stats.sent++;
  }

  /**
   * How long (ms) our inputs have gone unacknowledged while some are outstanding (0 when all are acked). Normally under
   * an RTT; far more means the path we send on is broken one way (the link layer then sends on both transports).
   */
  ackStale(): number {
    return this.peerAck < this.nextLocal - 1 ? Math.max(0, this.now() - this.peerAckAt) : 0;
  }

  /** Tell the peer we are leaving. */
  bye() {
    this.net.send({ k: 'bye' });
  }

  /** Hash of the current state (for end-of-game comparison). */
  hash(): number {
    return stateHash(this.g);
  }
}

/**
 * Does a snapshot have the shape of this game's own? Same engine, the same top-level fields (no extra or missing
 * ones, nothing like __proto__), the same players by id, and a numeric RNG state. restore() then fills it in.
 */
export function fitsGame(g: Game, s: Snapshot): boolean {
  if (!s || typeof s !== 'object' || !s.game || typeof s.game !== 'object' || !Array.isArray(s.players) || !Array.isArray(s.bench)) return false;
  if (!Number.isFinite(s.rng)) return false;
  const own = snapshot(g);
  if (s.engine !== own.engine) return false;
  const keys = (o: object) => Object.keys(o).sort().join(',');
  if (keys(s.game) !== keys(own.game)) return false;
  const ids = (list: Record<string, unknown>[]) => list.map((p) => (p && typeof p === 'object' ? p.id : null)).sort().join(',');
  if (ids([...s.players, ...s.bench]) !== ids([...own.players, ...own.bench])) return false;
  return [...s.players, ...s.bench].every((p) => keys(p) === keys([...own.players, ...own.bench].find((q) => q.id === p.id) ?? {}));
}
