// Client-side throttling for online requests: backoff with jitter, single-flight, tap guards and a sliding-window
// limiter. Keeps double-taps and retry loops from turning into request storms on the free Supabase plan.

/** Exponential backoff with jitter: the pause before retry `attempt` (1 = the first retry), between half and all of base·2^(n-1), capped. */
export function backoffMs(attempt: number, base = 1000, cap = 8000, rand: () => number = Math.random): number {
  const full = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  return Math.round(full / 2 + (full / 2) * rand());
}

/** A poll interval spread ±`spread` around `ms`, so many clients don't poll in step. */
export function jitter(ms: number, spread = 0.2, rand: () => number = Math.random): number {
  return Math.round(ms * (1 - spread + 2 * spread * rand()));
}

export const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((res, rej) => {
  if (signal?.aborted) return rej(new DOMException('aborted', 'AbortError'));
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('aborted', 'AbortError')); }, { once: true });
});

/** Calls made while one is running share its promise (one request, however many callers). */
export function singleFlight<A extends unknown[], T>(fn: (...a: A) => Promise<T>, key: (...a: A) => string = () => ''): (...a: A) => Promise<T> {
  const running = new Map<string, Promise<T>>();
  return (...a) => {
    const k = key(...a);
    let p = running.get(k);
    if (!p) {
      p = fn(...a).finally(() => running.delete(k));
      running.set(k, p);
    }
    return p;
  };
}

/**
 * Wraps a tap handler: ignored while the last call is still running and for `cooldownMs` after it started, so a
 * double-tap fires once. Returns whether the call went ahead.
 */
export function tapGuard(fn: () => unknown, cooldownMs = 800, now: () => number = () => Date.now()): () => boolean {
  let busy = false;
  let last = -Infinity;
  return () => {
    if (busy || now() - last < cooldownMs) return false;
    last = now();
    busy = true;
    let r: unknown;
    try { r = fn(); } catch (e) { busy = false; throw e; }
    Promise.resolve(r).catch(() => {}).finally(() => { busy = false; });
    return true;
  };
}

/** At most `max` events per `windowMs`: tries(), then ask wait() for how long until another is allowed. */
export class RateLimit {
  private hits: number[] = [];
  constructor(private max: number, private windowMs: number, private now: () => number = () => Date.now()) {}

  /** Records an attempt; false (and nothing recorded) if the limit is used up. */
  take(): boolean {
    const t = this.now();
    this.hits = this.hits.filter((h) => t - h < this.windowMs);
    if (this.hits.length >= this.max) return false;
    this.hits.push(t);
    return true;
  }

  /** Seconds until an attempt is allowed again (0 if one is allowed now). */
  waitSeconds(): number {
    const t = this.now();
    const live = this.hits.filter((h) => t - h < this.windowMs);
    return live.length < this.max ? 0 : Math.ceil((live[0] + this.windowMs - t) / 1000);
  }
}
