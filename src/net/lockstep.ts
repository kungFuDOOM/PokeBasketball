// Client side of an online match: builds the same game as the server, applies the server's ticks in
// order, checks the server's state hashes and resyncs from a snapshot if this copy ever drifts.
// Used by the online screen (with the renderer) and by the server's tests (headless).

import { Game } from '../game/game';
import { restore, stateHash, stepGame, type WireInput } from '../game/sync';
import { configFromStart } from './match';
import type { ClientMsg, MatchStart, ServerMsg } from './protocol';

export class LockstepClient {
  game: Game | null = null;
  start: MatchStart | null = null;
  /** Ticks applied to the local copy. */
  tick = 0;
  /** Inputs received but not applied yet; buffer[0] is tick + 1. */
  private buffer: [WireInput, WireInput][] = [];
  private serverHashes = new Map<number, number>();
  private ownHashes = new Map<number, number>();
  private waitingForSnap = false;
  desyncs = 0;

  /** With autoReady off, call ready() once the screen has loaded (sprites) to let the game start. */
  constructor(private side: 0 | 1, private send: (m: ClientMsg) => void, private onStart?: (g: Game) => void, private autoReady = true) {}

  ready() {
    this.send({ t: 'ready' });
  }

  get backlog() {
    return this.buffer.length;
  }

  handle(m: ServerMsg) {
    if (m.t === 'start') {
      this.start = m.start;
      this.game = new Game(configFromStart(m.start));
      this.game.viewTeam = this.side;
      if (m.snap) restore(this.game, m.snap);
      this.tick = m.tick;
      this.buffer = [];
      this.serverHashes.clear();
      this.ownHashes.clear();
      this.waitingForSnap = false;
      this.onStart?.(this.game);
      if (this.autoReady) this.ready();
    } else if (m.t === 'ticks' && this.game && !this.waitingForSnap) {
      const next = this.tick + this.buffer.length + 1;
      if (m.from > next) return this.resync(); // missed some: ask for the state instead
      this.buffer.push(...m.inputs.slice(next - m.from));
    } else if (m.t === 'hash') {
      this.serverHashes.set(m.tick, m.h);
      this.compare(m.tick);
    } else if (m.t === 'snap' && this.game) {
      restore(this.game, m.snap);
      this.tick = m.tick;
      this.buffer = [];
      this.waitingForSnap = false;
    }
  }

  /** Apply up to `max` buffered ticks. Returns how many were applied. */
  advance(max = Infinity): number {
    let n = 0;
    const g = this.game;
    if (!g) return 0;
    while (n < max && this.buffer.length && !this.waitingForSnap) {
      stepGame(g, this.buffer.shift()!);
      this.tick++;
      n++;
      if (this.tick % 120 === 0) {
        this.ownHashes.set(this.tick, stateHash(g));
        this.compare(this.tick);
      }
    }
    return n;
  }

  private compare(tick: number) {
    const a = this.ownHashes.get(tick);
    const b = this.serverHashes.get(tick);
    if (a === undefined || b === undefined) return;
    this.ownHashes.delete(tick);
    this.serverHashes.delete(tick);
    if (a !== b) {
      this.desyncs++;
      this.resync();
    }
  }

  private resync() {
    if (this.waitingForSnap) return;
    this.waitingForSnap = true;
    this.buffer = [];
    this.send({ t: 'resync' });
  }
}
