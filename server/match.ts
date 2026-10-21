// Live match rooms: snake draft, then a lockstep game the server referees.
//
// The server owns the clock. Each tick it takes both players' latest stick and held buttons, plus any
// button presses since the last tick, steps its own copy of the game, and streams that tick's inputs to
// both clients, which step their copies with the same inputs. The server's copy decides the winner.
// Every 120 ticks it sends a state hash; a client whose copy drifted asks for a snapshot and resyncs.

import { POKEMON, monByDex } from '../src/data/pokemon';
import { USER_STYLE, contrastAway } from '../src/franchise/league';
import { Game } from '../src/game/game';
import { TICK, snapshot, stateHash, stepGame, unpackInput, type WireInput } from '../src/game/sync';
import { configFromStart, snakeOrder } from '../src/net/match';
import type { ClientMsg, DraftView, MatchStart, Proof, ServerMsg, TeamSpec } from '../src/net/protocol';
import { cpuPick } from '../src/screens/draft';
import { abbr } from '../src/util';
import { finishBattle, getBattle, setState, view, voidBattle, type BattleRow } from './battles';
import type { Config } from './config';
import type { Db } from './db';

/** What a room needs from a socket. Bun's ServerWebSocket fits; tests can pass anything with send/close. */
export interface Peer {
  send(data: string): unknown;
  close(code?: number, reason?: string): unknown;
}

const EDGE = 2 | 8 | 16 | 32 | 64; // shoot, pass, steal, special, swap: presses, not holds
const HASH_EVERY = 120;
const BATCH = 2;
const MAX_TICKS = 60 * 60 * 45; // a 45-minute hard stop, whatever happens in overtime
const READY_WAIT_MS = 10_000;

type Phase = 'waiting' | 'draft' | 'starting' | 'game' | 'over';

class Room {
  phase: Phase = 'waiting';
  peers: [Peer | null, Peer | null] = [null, null];
  // draft
  private order: (0 | 1)[] = [];
  private picks: number[] = [];
  private deadline = 0;
  private draftTimer: ReturnType<typeof setTimeout> | null = null;
  // game
  start: MatchStart | null = null;
  game: Game | null = null;
  tick = 0;
  private held: [WireInput, WireInput] = [{ mx: 0, my: 0, b: 0 }, { mx: 0, my: 0, b: 0 }];
  private edges: [number, number] = [0, 0];
  private log: [WireInput, WireInput][] = [];
  private batch: [WireInput, WireInput][] = [];
  private batchFrom = 1;
  private loop: ReturnType<typeof setInterval> | null = null;
  private lastStep = 0;
  private acc = 0;
  private ready: [boolean, boolean] = [false, false];
  private readyTimer: ReturnType<typeof setTimeout> | null = null;
  private forfeitTimer: ReturnType<typeof setTimeout> | null = null;
  private forfeitAt: number | null = null;
  private acceptTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly id: string, private mgr: MatchManager) {
    const b = this.battle();
    const age = Date.now() - (b.accepted_at ?? Date.now());
    this.acceptTimer = setTimeout(() => {
      if (this.phase === 'waiting') this.void('both players did not show up in time');
    }, Math.max(1000, mgr.cfg.acceptTimeoutSeconds * 1000 - age));
  }

  private battle(): BattleRow {
    return getBattle(this.mgr.db, this.id)!;
  }

  private send(side: 0 | 1, msg: ServerMsg) {
    this.peers[side]?.send(JSON.stringify(msg));
  }

  private both(msg: ServerMsg) {
    const s = JSON.stringify(msg);
    for (const p of this.peers) p?.send(s);
  }

  private connected(): [boolean, boolean] {
    return [!!this.peers[0], !!this.peers[1]];
  }

  join(side: 0 | 1, peer: Peer) {
    this.peers[side]?.close(4000, 'Opened in another tab');
    this.peers[side] = peer;
    this.send(side, { t: 'hello', side, battle: view(this.battle()) });
    if (this.phase === 'waiting') {
      if (this.peers[0] && this.peers[1]) this.startDraft();
      else this.both({ t: 'wait', who: ([0, 1] as const).filter((s) => !this.peers[s]) });
    } else if (this.phase === 'draft') {
      this.send(side, { t: 'draft', draft: this.draftView() });
    } else if (this.phase === 'starting' || this.phase === 'game') {
      this.flush();
      this.send(side, { t: 'start', start: this.start!, tick: this.tick, snap: this.tick ? snapshot(this.game!) : null });
    }
    this.presence();
  }

  leave(side: 0 | 1, peer: Peer) {
    if (this.peers[side] !== peer) return;
    this.peers[side] = null;
    if (this.phase === 'over') return;
    this.ready[side] = false;
    this.presence();
  }

  /** Pause the game and start the forfeit clock while anyone is missing; clear it when both are back. */
  private presence() {
    const [a, b] = this.connected();
    const missing = !a || !b;
    if (this.phase === 'game' || this.phase === 'starting' || this.phase === 'draft') {
      if (missing && !this.forfeitTimer) {
        this.forfeitAt = Date.now() + this.mgr.cfg.forfeitSeconds * 1000;
        this.forfeitTimer = setTimeout(() => this.forfeitCheck(), this.mgr.cfg.forfeitSeconds * 1000);
      } else if (!missing && this.forfeitTimer) {
        clearTimeout(this.forfeitTimer);
        this.forfeitTimer = null;
        this.forfeitAt = null;
      }
    }
    this.both({ t: 'presence', connected: [a, b], forfeitAt: this.forfeitAt });
  }

  private forfeitCheck() {
    this.forfeitTimer = null;
    const [a, b] = this.connected();
    if (a && b) return;
    if (!a && !b) return this.void('both players left');
    this.finish(a ? 0 : 1, true);
  }

  message(side: 0 | 1, raw: string) {
    let m: ClientMsg;
    try { m = JSON.parse(raw) as ClientMsg; } catch { return; }
    if (m.t === 'pick' && this.phase === 'draft') this.pick(side, Number(m.dex), false);
    else if (m.t === 'in') {
      const w = { mx: Number(m.mx) || 0, my: Number(m.my) || 0, b: (Number(m.b) | 0) & 127 };
      const clean = unpackInput(w); // clamps and rounds the stick
      this.held[side] = { mx: clean.mx, my: clean.my, b: w.b & ~EDGE };
      this.edges[side] |= w.b & EDGE;
    } else if (m.t === 'ready' && (this.phase === 'starting' || this.phase === 'game')) {
      this.ready[side] = true;
      if (this.phase === 'starting' && this.ready[0] && this.ready[1]) this.beginTicking();
    } else if (m.t === 'resync' && this.phase === 'game' && this.game) {
      this.flush();
      this.send(side, { t: 'snap', tick: this.tick, snap: snapshot(this.game) });
    }
  }

  // ------------------------------------------------------------ draft

  private startDraft() {
    clearTimeout(this.acceptTimer!);
    const b = this.battle();
    setState(this.mgr.db, this.id, 'drafting');
    this.phase = 'draft';
    this.order = snakeOrder((b.seed! & 1) as 0 | 1);
    this.picks = [];
    this.nextPick();
  }

  private draftView(): DraftView {
    const b = this.battle();
    return { order: this.order, picks: this.picks, deadline: this.deadline, teamNames: [b.host_name, b.guest_name ?? 'Challenger'] };
  }

  private nextPick() {
    if (this.draftTimer) clearTimeout(this.draftTimer);
    if (this.picks.length >= this.order.length) return this.startGame();
    this.deadline = Date.now() + this.mgr.cfg.pickSeconds * 1000;
    const turn = this.picks.length;
    this.draftTimer = setTimeout(() => {
      if (this.phase === 'draft' && this.picks.length === turn) this.pick(this.order[turn], 0, true);
    }, this.mgr.cfg.pickSeconds * 1000);
    this.both({ t: 'draft', draft: this.draftView() });
  }

  private rosterOf(side: 0 | 1): number[] {
    return this.picks.filter((_, i) => this.order[i] === side);
  }

  private pick(side: 0 | 1, dex: number, auto: boolean) {
    if (this.order[this.picks.length] !== side) return;
    const pool = POKEMON.filter((m) => !this.picks.includes(m.dex));
    let mon = auto ? null : pool.find((m) => m.dex === dex) ?? null;
    if (!mon && !auto) return this.send(side, { t: 'error', message: "That Pokémon isn't available." });
    mon ??= cpuPick(pool, this.rosterOf(side).map(monByDex));
    this.picks.push(mon.dex);
    this.nextPick();
  }

  // ------------------------------------------------------------ game

  private startGame() {
    const b = this.battle();
    const home: TeamSpec = { name: b.host_name, abbr: abbr(b.host_name), ...USER_STYLE, roster: this.rosterOf(0) };
    const awayColors = contrastAway(
      { ...home, roster: [], human: true },
      { name: b.guest_name ?? 'Challenger', abbr: '', color: '#e3350d', color2: '#3d0a03', roster: [], human: true },
    );
    const away: TeamSpec = { name: b.guest_name ?? 'Challenger', abbr: abbr(b.guest_name ?? 'Challenger'), color: awayColors.color, color2: awayColors.color2, roster: this.rosterOf(1) };
    this.start = { seed: b.seed!, quarterLen: b.quarter_len, home, away };
    this.game = new Game(configFromStart(this.start));
    this.tick = 0;
    this.log = [];
    this.phase = 'starting';
    setState(this.mgr.db, this.id, 'playing');
    this.both({ t: 'start', start: this.start, tick: 0, snap: null });
    // Start even if a client never says it's ready (slow sprite load), so nobody can stall the game.
    this.readyTimer = setTimeout(() => this.beginTicking(), READY_WAIT_MS);
  }

  private beginTicking() {
    if (this.phase !== 'starting') return;
    if (this.readyTimer) clearTimeout(this.readyTimer);
    this.phase = 'game';
    this.lastStep = performance.now();
    this.acc = 0;
    this.batchFrom = this.tick + 1;
    this.loop = setInterval(() => this.run(), 8);
    this.run();
  }

  private run() {
    const t = performance.now();
    const dt = Math.min(0.25, (t - this.lastStep) / 1000) * this.mgr.cfg.simSpeed;
    this.lastStep = t;
    // Lockstep pauses while a player is missing; the forfeit clock is running meanwhile.
    if (!this.peers[0] || !this.peers[1]) return;
    this.acc += dt;
    while (this.acc >= TICK && this.phase === 'game') {
      this.acc -= TICK;
      this.step();
    }
  }

  private step() {
    const g = this.game!;
    const ins: [WireInput, WireInput] = [0, 1].map((s) => ({ ...this.held[s], b: this.held[s].b | this.edges[s] })) as [WireInput, WireInput];
    this.edges = [0, 0];
    stepGame(g, ins);
    g.events.length = 0;
    g.sfx.length = 0;
    this.tick++;
    this.log.push(ins);
    this.batch.push(ins);
    if (this.batch.length >= BATCH) this.flush();
    if (this.tick % HASH_EVERY === 0) this.both({ t: 'hash', tick: this.tick, h: stateHash(g) });
    if (g.phase === 'final') {
      this.flush();
      const [h, a] = g.score;
      this.finish(h > a ? 0 : 1, false);
    } else if (this.tick >= MAX_TICKS) {
      this.flush();
      const [h, a] = g.score;
      if (h === a) this.void('game hit the time limit tied');
      else this.finish(h > a ? 0 : 1, false);
    }
  }

  private flush() {
    if (!this.batch.length) return;
    this.both({ t: 'ticks', from: this.batchFrom, inputs: this.batch });
    this.batchFrom += this.batch.length;
    this.batch = [];
  }

  // ------------------------------------------------------------ endings

  private stopTimers() {
    for (const t of [this.draftTimer, this.readyTimer, this.forfeitTimer, this.acceptTimer]) if (t) clearTimeout(t);
    if (this.loop) clearInterval(this.loop);
    this.loop = null;
  }

  private finish(winner: 0 | 1, forfeit: boolean) {
    if (this.phase === 'over') return;
    this.phase = 'over';
    this.stopTimers();
    const b = this.battle();
    const score: [number, number] = this.game ? [this.game.score[0], this.game.score[1]] : [0, 0];
    const proof: Proof | null = this.start ? {
      battleId: b.id, commit: b.commit_hash, serverSeed: b.server_seed, hostSeed: b.host_seed, guestSeed: b.guest_seed!,
      seed: b.seed!, start: this.start, inputs: this.log, score, winner, forfeit,
    } : null;
    finishBattle(this.mgr.db, this.id, winner, score, forfeit, proof);
    this.both({ t: 'final', battle: view(this.battle()) });
    this.mgr.done(this.id);
    this.mgr.onFinish?.(this.id);
  }

  void(reason: string) {
    if (this.phase === 'over') return;
    this.phase = 'over';
    this.stopTimers();
    voidBattle(this.mgr.db, this.id, reason);
    this.both({ t: 'final', battle: view(this.battle()) });
    this.mgr.done(this.id);
  }
}

export class MatchManager {
  private rooms = new Map<string, Room>();
  onFinish?: (battleId: string) => void;

  constructor(readonly db: Db, readonly cfg: Config) {}

  /** The room for a battle that's been accepted, created on first use. */
  room(id: string): Room | null {
    let r = this.rooms.get(id);
    if (r) return r;
    const b = getBattle(this.db, id);
    if (!b || !['ready', 'drafting', 'playing'].includes(b.state)) return null;
    r = new Room(id, this);
    this.rooms.set(id, r);
    return r;
  }

  done(id: string) {
    // Keep the room briefly so late messages land somewhere harmless, then drop it.
    setTimeout(() => this.rooms.delete(id), 30_000);
  }

  /** Open rooms for accepted battles so their no-show timers run even if nobody connects. */
  resume() {
    const rows = this.db.query("select id from battles where state = 'ready'").all() as { id: string }[];
    for (const r of rows) this.room(r.id);
  }

  get size() {
    return this.rooms.size;
  }

  stopAll() {
    for (const r of this.rooms.values()) r.void('server shutting down');
  }
}

export type { Room };
