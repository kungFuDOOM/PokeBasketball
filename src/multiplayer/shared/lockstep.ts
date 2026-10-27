// Lockstep netcode for online games (see docs/multiplayer.md, "Netcode").
//
// Both players run the same deterministic Game (seeded RNG, fixed 60 Hz tick, src/game/sync.ts). Nothing but
// inputs crosses the wire: each side schedules its own input `delay` ticks into the future and sends it to the
// peer; tick t is simulated only once both players' inputs for t are known, so both copies step through exactly
// the same inputs. Input delay hides the network round trip; if the peer's input is late, the game waits.
//
// - Inputs travel in small batches (about 15 a second) and every batch repeats everything the peer has not
//   acknowledged yet, so a lost or reordered message never loses an input.
// - Each side adapts its own input delay: the peer reports how early our inputs arrive ("lead"), and we add
//   delay when they arrive late and shave it when there is plenty of slack.
// - Every HASH_EVERY ticks both sides exchange a state hash. On a mismatch (floating point can differ in the last
//   bit between browser engines) the host sends a full snapshot; the guest restores it and replays its stored
//   inputs to catch up. The host is the authority for that.
//
// This class is transport-agnostic: hand it anything with send(), feed it received messages with receive().
//
// The peer is not trusted: receive() takes anything. Malformed messages, inputs far outside the window the game
// can be in, oversized runs and floods are dropped; a snapshot that doesn't fit this game, or resync spam, sets
// `problem` and the match screen ends the game without a result.

import type { Game } from '../../game/game';
import { TICK, packInput, restore, snapshot, stateHash, stepGame, type Snapshot, type WireInput } from '../../game/sync';
import type { Intent } from '../../game/types';

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
  | { k: 'bye' };

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
}

export const MIN_DELAY = 4;
export const MAX_DELAY = 18;
export const SEND_MS = 66;
export const HASH_EVERY = 60;
/** The peer can't be further ahead than both input delays plus a stall; anything beyond this is junk. */
const MAX_AHEAD = 4 * MAX_DELAY + 60;
/** At most this many messages a second are read from the peer (about 16 in normal play); the rest are dropped. */
const MAX_MSGS_PER_SEC = 80;
/** Resyncs the guest accepts per game, and how often: a host sending more is broken or cheating. */
const MAX_RESYNCS = 12;
const MIN_RESYNC_MS = 1500;
/** Ticks of input history kept for replays after a resync. */
const HISTORY = 900;
const EMPTY: WireInput = { mx: 0, my: 0, b: 0 };
/** The game can only run up to this far behind real time before it stops trying to catch up. */
const MAX_ACC = 0.25;

const same = (a: WireInput, b: WireInput) => a.mx === b.mx && a.my === b.my && a.b === b.b;

export class Lockstep {
  /** Next tick to simulate. */
  tick = 0;
  delay: number;
  readonly side: Side;
  /** Seconds the game has been waiting for the peer's input right now (0 when running). */
  waiting = 0;
  lastHeard: number;
  peerLeft = false;
  readonly stats = { stalls: 0, desyncs: 0, resyncs: 0, sent: 0, received: 0, dropped: 0 };
  /** Why this game can't go on safely (a broken or malicious peer), or null. */
  problem: string | null = null;

  private local = new Map<number, WireInput>();
  private remote = new Map<number, WireInput>();
  /** Next tick to schedule our own input for. */
  private nextLocal: number;
  /** Highest tick of ours the peer has confirmed. */
  private peerAck: number;
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
  private now: () => number;
  /** Our latest hash, sent with the next input batch. */
  private hashOut: [number, number] | null = null;
  private rateWindow = 0;
  private rateCount = 0;
  private lastResync = -Infinity;

  constructor(private g: Game, private net: Transport, o: LockstepOptions) {
    this.side = o.side;
    this.delay = Math.max(MIN_DELAY, Math.min(MAX_DELAY, o.delay ?? 8));
    this.now = o.now ?? (() => performance.now());
    this.lastHeard = this.now();
    this.leadWindowStart = this.lastHeard;
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
      this.hashOut = [t, h];
      this.check(t);
    }
    const old = t - HISTORY;
    this.local.delete(old);
    this.remote.delete(old);
    this.myHashes.delete(old);
    this.peerHashes.delete(old);
  }

  private check(t: number) {
    const a = this.myHashes.get(t);
    const b = this.peerHashes.get(t);
    if (a === undefined || b === undefined) return;
    if (a === b) {
      this.resyncPending = false;
      return;
    }
    this.stats.desyncs++;
    // The host is the authority: it sends its state and the guest adopts it.
    if (this.side === 0 && !this.resyncPending) {
      this.resyncPending = true;
      this.net.send({ k: 'snap', t: this.tick - 1, s: snapshot(this.g) });
    }
  }

  /** A tick the peer could honestly be talking about right now. */
  private plausible(t: unknown): t is number {
    return Number.isInteger(t) && (t as number) >= this.tick - HISTORY && (t as number) <= this.tick + MAX_AHEAD;
  }

  /** Feed a message from the peer: anything at all (it's checked here). */
  receive(raw: unknown) {
    const now = this.now();
    if (now - this.rateWindow >= 1000) { this.rateWindow = now; this.rateCount = 0; }
    if (++this.rateCount > MAX_MSGS_PER_SEC || !raw || typeof raw !== 'object') { this.stats.dropped++; return; }
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
      if (this.plausible(m.t) && m.s && typeof m.s === 'object') this.resync(m.t, m.s as Snapshot);
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
        this.minLead = Math.min(this.minLead, t - this.tick);
      }
    }
    while (this.remote.has(this.remoteTop + 1)) this.remoteTop++;
    // The peer can only acknowledge inputs we've actually scheduled.
    if (Number.isInteger(m.a) && (m.a as number) > this.peerAck) this.peerAck = Math.min(m.a as number, this.nextLocal - 1);
    if (Number.isFinite(m.l) && Number.isInteger(m.lw) && m.lw !== this.lastPeerLw) {
      this.lastPeerLw = m.lw as number;
      this.adaptDelay(Math.max(-MAX_DELAY, Math.min(MAX_DELAY, m.l as number)));
    }
    if (Array.isArray(m.h) && m.h.length === 2) this.receiveHash(m.h[0], m.h[1]);
  }

  /** The peer says our inputs reached it `lead` ticks before it needed them (negative: it had to wait). */
  private adaptDelay(lead: number) {
    if (lead < 1 && this.delay < MAX_DELAY) this.delay += lead < -3 ? 2 : 1;
    else if (lead > 3 && this.delay > MIN_DELAY) this.delay--;
    this.delay = Math.min(MAX_DELAY, this.delay);
  }

  /** Guest: adopt the host's state after tick t, then replay our stored inputs to where we were. */
  private resync(t: number, s: Snapshot) {
    const now = this.now();
    if (this.stats.resyncs >= MAX_RESYNCS) { this.problem = 'The games kept going out of sync.'; return; }
    if (now - this.lastResync < MIN_RESYNC_MS) { this.stats.dropped++; return; }
    if (!fitsGame(this.g, s)) { this.problem = 'The other player sent a game state that does not fit this game.'; return; }
    this.lastResync = now;
    const target = Math.max(this.tick, t + 1);
    try {
      restore(this.g, s);
    } catch {
      this.problem = 'The other player sent a game state that does not fit this game.';
      return;
    }
    this.tick = t + 1;
    for (const k of [...this.myHashes.keys()]) if (k > t) this.myHashes.delete(k);
    while (this.tick < target && this.remote.has(this.tick) && this.local.has(this.tick)) {
      stepGame(this.g, this.inputsFor(this.tick));
      this.tick++;
    }
    // A replay must not repeat sounds and announcements.
    this.g.events.length = 0;
    this.g.sfx.length = 0;
    this.stats.resyncs++;
  }

  /** Send unacknowledged inputs (paced to SEND_MS unless forced). */
  maybeSend(force: boolean) {
    const now = this.now();
    if (!force && now - this.lastSend < (this.net.pace?.() ?? SEND_MS)) return;
    this.lastSend = now;
    if (now - this.leadWindowStart >= 1000) {
      // Report the smallest lead seen this second (−delay if nothing arrived at all, which reads as "late").
      this.leadReport = { l: Number.isFinite(this.minLead) ? this.minLead : -1, lw: this.leadSeq++ };
      this.minLead = Infinity;
      this.leadWindowStart = now;
    }
    const from = this.peerAck + 1;
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
