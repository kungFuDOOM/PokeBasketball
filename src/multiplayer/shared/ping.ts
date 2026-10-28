// Round-trip probes between the two players' links (not part of lockstep): ping out, pong back, RTT = our own clock
// difference. Used to size the starting input delay and to drive the in-game ping meter and the per-match stats.
import type { NetMsg } from './lockstep';
import { rttStats, type RttStats } from './netDelay';

/** RTT samples kept for the end-of-match median / p95. */
const MAX_SAMPLES = 1000;
/** Pongs answered per second (a ping flood from the peer gets no more). */
const MAX_PONGS_PER_SEC = 40;

export class Pinger {
  /** Every RTT measured (ms), oldest first. */
  readonly samples: number[] = [];
  /** Latest RTT (ms), or null before the first pong. */
  last: number | null = null;
  /** Smoothed RTT for the meter (ms), or null before the first pong. */
  smooth: number | null = null;
  private n = 0;
  private pending = new Map<number, number>();
  private win = -Infinity;
  private winCount = 0;

  constructor(private send: (m: NetMsg) => void, private now: () => number = () => performance.now()) {}

  ping() {
    const n = this.n++;
    this.pending.set(n, this.now());
    if (this.pending.size > 64) this.pending.delete(this.pending.keys().next().value!);
    this.send({ k: 'ping', n, t: this.pending.get(n)! });
  }

  /** Handles a ping or pong from the peer. False when `m` is something else (the caller passes it on). */
  handle(m: unknown): boolean {
    const x = m as Partial<Record<string, unknown>> | null;
    if (!x || typeof x !== 'object' || (x.k !== 'ping' && x.k !== 'pong')) return false;
    if (!Number.isInteger(x.n) || !Number.isFinite(x.t)) return true;
    const now = this.now();
    if (x.k === 'ping') {
      if (now - this.win >= 1000) { this.win = now; this.winCount = 0; }
      if (++this.winCount <= MAX_PONGS_PER_SEC) this.send({ k: 'pong', n: x.n as number, t: x.t as number });
    } else {
      const sentAt = this.pending.get(x.n as number);
      if (sentAt === undefined) return true;
      this.pending.delete(x.n as number);
      const rtt = Math.max(0, now - sentAt);
      this.last = rtt;
      this.smooth = this.smooth === null ? rtt : this.smooth * 0.7 + rtt * 0.3;
      this.samples.push(rtt);
      if (this.samples.length > MAX_SAMPLES) this.samples.shift();
    }
    return true;
  }

  stats(from = 0): RttStats {
    return rttStats(this.samples.slice(from));
  }
}
