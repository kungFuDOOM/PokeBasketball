import { describe, expect, it } from 'vitest';
import { RateLimit, backoffMs, jitter, singleFlight, tapGuard } from './throttle';

describe('backoff with jitter', () => {
  it('grows exponentially, is capped, and jitters between half and full', () => {
    expect([1, 2, 3, 4].map((n) => backoffMs(n, 1000, 8000, () => 1))).toEqual([1000, 2000, 4000, 8000]);
    expect(backoffMs(10, 1000, 8000, () => 1)).toBe(8000);
    expect(backoffMs(3, 1000, 8000, () => 0)).toBe(2000);
    for (let i = 0; i < 50; i++) {
      const v = backoffMs(2);
      expect(v).toBeGreaterThanOrEqual(1000);
      expect(v).toBeLessThanOrEqual(2000);
    }
  });
  it('jitter stays within the spread', () => {
    expect(jitter(2000, 0.2, () => 0)).toBe(1600);
    expect(jitter(2000, 0.2, () => 1)).toBe(2400);
  });
});

describe('single flight and tap guard', () => {
  it('callers at once share one request; a later call runs again', async () => {
    let n = 0;
    const f = singleFlight(async (_k: string) => ++n, (k) => k);
    const [a, b] = await Promise.all([f('x'), f('x')]);
    expect([a, b, n]).toEqual([1, 1, 1]);
    expect(await f('x')).toBe(2);
    const [c, d] = await Promise.all([f('x'), f('y')]);
    expect([c, d]).toEqual([3, 4]);
  });
  it('a double-tap fires once, even after the handler finishes within the cooldown', async () => {
    let t = 0;
    let calls = 0;
    const tap = tapGuard(async () => { calls++; }, 800, () => t);
    expect(tap()).toBe(true);
    expect(tap()).toBe(false);
    await new Promise((r) => setTimeout(r, 0));
    t = 300;
    expect(tap()).toBe(false);
    t = 900;
    expect(tap()).toBe(true);
    expect(calls).toBe(2);
  });
});

describe('sliding-window rate limit', () => {
  it('allows max tries per window, then says how long to wait', () => {
    let t = 0;
    const r = new RateLimit(3, 10_000, () => t);
    expect([r.take(), r.take(), r.take(), r.take()]).toEqual([true, true, true, false]);
    t = 4000;
    expect(r.waitSeconds()).toBe(6);
    t = 10_001;
    expect(r.take()).toBe(true);
  });
});
