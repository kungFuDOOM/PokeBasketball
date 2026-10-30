// The pre-game intro over the match channel (event 'pre'): skip votes and the start barrier. Never touches lockstep
// or the evidence log; the game's inputs only start after both sides have passed the barrier.

export type PreKind = 'ready' | 'skip' | 'unskip' | 'go';
export type Pre = { k: PreKind; at?: number };

const KINDS: readonly PreKind[] = ['ready', 'skip', 'unskip', 'go'];

/** A peer's 'pre' payload, or null for anything else (junk is ignored, never thrown on). */
export function parsePre(payload: unknown): Pre | null {
  if (!payload || typeof payload !== 'object') return null;
  const { k, at } = payload as { k?: unknown; at?: unknown };
  if (typeof k !== 'string' || !(KINDS as readonly string[]).includes(k)) return null;
  if (at !== undefined && (typeof at !== 'number' || !Number.isFinite(at))) return null;
  return at === undefined ? { k: k as PreKind } : { k: k as PreKind, at };
}

/**
 * Who has finished the intro. The host (side 0) says `go` once both are ready; the guest starts on `go`.
 */
export class PreBarrier {
  mine = false;
  theirs = false;
  goSent = false;
  goReceived = false;
  constructor(readonly side: 0 | 1) {}

  get host(): boolean {
    return this.side === 0;
  }

  /** Our intro ended. */
  ready() {
    this.mine = true;
  }

  /** A message from the peer. Only the host's `go` counts (a guest can't start the host). */
  receive(p: Pre) {
    if (p.k === 'ready') this.theirs = true;
    else if (p.k === 'go' && !this.host) this.goReceived = true;
  }

  /** Host only: true once, when it should send `go` (both ready, or `force` after the cap). */
  takeGo(force = false): boolean {
    if (!this.host || this.goSent || !this.mine || (!this.theirs && !force)) return false;
    this.goSent = true;
    return true;
  }

  /** May this side start the game now? */
  canStart(): boolean {
    return this.host ? this.goSent : this.goReceived;
  }
}

/** A guest that never hears `go` starts this long after the cap anyway. */
export const GUEST_FALLBACK_MS = 2000;

/**
 * Drives the barrier with timers: `localEnd()` when our intro ends, `peer()` for each 'pre' message. The host sends
 * `go` once both are ready (or at the cap) and starts; the guest starts on `go`, or at the cap + GUEST_FALLBACK_MS.
 * `start` is called at most once; `destroy` clears the timers (abort, opponent left).
 */
export class PreGate {
  readonly barrier: PreBarrier;
  private started = false;
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(side: 0 | 1, capMs: number, private send: (k: PreKind) => void, private start: () => void) {
    this.barrier = new PreBarrier(side);
    this.timer = setTimeout(() => this.atCap(), this.barrier.host ? capMs : capMs + GUEST_FALLBACK_MS);
  }

  localEnd() {
    if (this.started || this.barrier.mine) return;
    this.barrier.ready();
    this.send('ready');
    this.check();
  }

  peer(p: Pre) {
    if (this.started) return;
    this.barrier.receive(p);
    this.check();
  }

  destroy() {
    this.started = true;
    clearTimeout(this.timer);
  }

  private atCap() {
    if (this.started) return;
    if (!this.barrier.mine) {
      this.barrier.ready();
      this.send('ready');
    }
    if (this.barrier.takeGo(true)) this.send('go');
    this.go();
  }

  private check() {
    if (this.barrier.takeGo()) this.send('go');
    if (this.barrier.canStart()) this.go();
  }

  private go() {
    if (this.started) return;
    this.destroy();
    this.start();
  }
}
