import { describe, expect, it } from 'vitest';
import { FALLBACK_RTT, MAX_DELAY, MIN_DELAY, SLACK_LEAD, STEADY_REPORTS, TARGET_LEAD, adapt, clampDelay, planRtt, rttStats, startDelay, type AdaptState } from './netDelay';
import { Pinger } from './ping';

describe('start delay from the measured RTT', () => {
  it('ceil((RTT/2 + send interval + 2 x jitter) / 16.67) + 1', () => {
    // 200 ms RTT, 60 Hz sends (16 ms), 10 ms jitter: (100 + 16 + 20) / 16.67 = 8.2 -> 9, +1 = 10
    expect(startDelay(200, 16, 10)).toBe(10);
    // The same link at the old 66 ms pace needs more: (100 + 66 + 20) / 16.67 = 11.2 -> 12, +1 = 13
    expect(startDelay(200, 66, 10)).toBe(13);
    expect(startDelay(250, 16, 20)).toBe(12);
  });

  it('is clamped between the minimum and the 30-tick cap', () => {
    expect(startDelay(1, 16, 0)).toBe(MIN_DELAY);
    expect(startDelay(2000, 100, 200)).toBe(MAX_DELAY);
    expect(MAX_DELAY).toBe(30);
    expect(clampDelay(99)).toBe(30);
    expect(clampDelay(-3)).toBe(MIN_DELAY);
  });

  it('grows with RTT and with jitter', () => {
    expect(startDelay(300, 16, 10)).toBeGreaterThan(startDelay(100, 16, 10));
    expect(startDelay(200, 16, 40)).toBeGreaterThan(startDelay(200, 16, 0));
  });
});

describe('RTT statistics', () => {
  it('median, p95 and jitter of the samples; junk is ignored', () => {
    const st = rttStats([100, 110, 90, 105, 95, 100, 300, NaN, -4]);
    expect(st.samples).toBe(7);
    expect(st.median).toBe(100);
    expect(st.p95).toBe(300);
    expect(st.jitter).toBeGreaterThan(0);
    expect(rttStats([]).samples).toBe(0);
  });

  it('too few pings: plan with a fallback estimate (a wider one on the Realtime path)', () => {
    expect(planRtt(rttStats([50, 60]), true).rtt).toBe(FALLBACK_RTT.direct);
    expect(planRtt(rttStats([]), false).rtt).toBe(FALLBACK_RTT.realtime);
    expect(planRtt(rttStats([80, 90, 100, 110]), true).rtt).toBe(95);
  });
});

describe('adaptation', () => {
  const at = (delay: number, steady = 0): AdaptState => ({ delay, steady });

  it('late inputs: jumps straight to the shortfall instead of one tick per report', () => {
    expect(adapt(at(8), 0)).toEqual(at(8 + TARGET_LEAD));
    expect(adapt(at(8), -6)).toEqual(at(8 + TARGET_LEAD + 6));
  });

  it('never goes past the cap', () => {
    expect(adapt(at(28), -20).delay).toBe(MAX_DELAY);
    expect(adapt(at(MAX_DELAY), 0).delay).toBe(MAX_DELAY);
  });

  it('eases down one tick only after several steady reports, and never below the minimum', () => {
    let s = at(12);
    for (let i = 0; i < STEADY_REPORTS - 1; i++) s = adapt(s, SLACK_LEAD + 3);
    expect(s.delay).toBe(12);
    s = adapt(s, SLACK_LEAD + 3);
    expect(s).toEqual(at(11));
    expect(adapt(at(MIN_DELAY, STEADY_REPORTS - 1), 20).delay).toBe(MIN_DELAY);
  });

  it('a report with less slack resets the steady count; a late one resets it and goes up', () => {
    expect(adapt(at(12, 5), SLACK_LEAD).steady).toBe(0);
    expect(adapt(at(12, 5), 0)).toEqual(at(12 + TARGET_LEAD));
  });

  it('two peers fed the same reports land on the same delay (deterministic)', () => {
    const reports = [3, 0, -2, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 8, 1, 9, 9];
    const run = () => reports.reduce(adapt, at(8) as AdaptState);
    expect(run()).toEqual(run());
  });
});

describe('ping / pong', () => {
  it('measures the round trip with its own clock and answers the peer\'s pings', () => {
    let now = 0;
    const a: unknown[] = [];
    const b: unknown[] = [];
    const pa = new Pinger((m) => a.push(m), () => now);
    const pb = new Pinger((m) => b.push(m), () => now);
    pa.ping();
    now += 120;
    expect(pb.handle(a.shift())).toBe(true);
    now += 130;
    expect(pa.handle(b.shift())).toBe(true);
    expect(pa.last).toBe(250);
    expect(pa.stats().median).toBe(250);
  });

  it('ignores pongs it never asked for, junk, and ping floods; passes other messages on', () => {
    let now = 0;
    const out: unknown[] = [];
    const p = new Pinger((m) => out.push(m), () => now);
    expect(p.handle({ k: 'pong', n: 99, t: 0 })).toBe(true);
    expect(p.last).toBeNull();
    expect(p.handle({ k: 'ping', n: 'x', t: 0 })).toBe(true);
    expect(out).toHaveLength(0);
    for (let i = 0; i < 500; i++) p.handle({ k: 'ping', n: i, t: 0 });
    expect(out.length).toBe(40);
    expect(p.handle({ k: 'in', s: 0, r: [], a: 0 })).toBe(false);
    expect(p.handle(null)).toBe(false);
  });
});
