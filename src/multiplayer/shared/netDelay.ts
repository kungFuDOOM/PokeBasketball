// Input-delay maths for lockstep (pure, unit-tested in netDelay.test.ts).
//
// Each side picks its OWN input delay (how many ticks ahead it schedules its local input). The sim stays identical
// on both sides whatever the two delays are: every input is tagged with the tick it applies to, and tick t only runs
// once both players' inputs for t are in. So the peers never need to agree on a delay, only on the protocol (NET_VERSION).

export const TICK_MS = 1000 / 60;
export const MIN_DELAY = 4;
export const MAX_DELAY = 30;
/** Ticks of slack we want inputs to arrive with; a lead below 1 means the peer had to wait. */
export const TARGET_LEAD = 2;
/** A lead above this, report after report, means the delay is more than needed. */
export const SLACK_LEAD = 4;
/** Lead reports in a row with slack before the delay eases down by one tick (reports are LEAD_WINDOW_MS apart). */
export const STEADY_REPORTS = 10;
export const LEAD_WINDOW_MS = 500;
/** Used when too few pings came back to measure. */
export const FALLBACK_RTT = { direct: 160, realtime: 320 };

export const clampDelay = (d: number) => Math.max(MIN_DELAY, Math.min(MAX_DELAY, Math.round(d)));

export interface RttStats {
  samples: number;
  median: number;
  p95: number;
  /** Mean absolute deviation from the median. */
  jitter: number;
}

export function rttStats(samples: number[]): RttStats {
  const s = samples.filter((x) => Number.isFinite(x) && x >= 0).sort((a, b) => a - b);
  if (!s.length) return { samples: 0, median: 0, p95: 0, jitter: 0 };
  const at = (q: number) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  const median = s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
  return { samples: s.length, median, p95: at(0.95), jitter: s.reduce((a, x) => a + Math.abs(x - median), 0) / s.length };
}

/** RTT figures to plan with: the measurement, or a guess when fewer than 3 pings came back. */
export function planRtt(st: RttStats, direct: boolean): { rtt: number; jitter: number } {
  if (st.samples < 3) return { rtt: direct ? FALLBACK_RTT.direct : FALLBACK_RTT.realtime, jitter: direct ? 20 : 50 };
  return { rtt: st.median, jitter: st.jitter };
}

/** Starting delay: ceil((RTT/2 + send interval + 2 × jitter) / 16.67 ms) + 1 ticks, clamped. */
export function startDelay(rttMs: number, sendMs: number, jitterMs: number): number {
  return clampDelay(Math.ceil((rttMs / 2 + sendMs + 2 * jitterMs) / TICK_MS) + 1);
}

export interface AdaptState {
  delay: number;
  /** Consecutive lead reports with plenty of slack. */
  steady: number;
}

/**
 * The peer reports the smallest lead (ticks) our inputs had in the last window; negative: it had to wait that long.
 * Late: jump straight to the shortfall (to TARGET_LEAD). Slack for STEADY_REPORTS reports in a row: ease down by 1.
 */
export function adapt(s: AdaptState, lead: number): AdaptState {
  if (lead < 1) return { delay: clampDelay(s.delay + (TARGET_LEAD - lead)), steady: 0 };
  if (lead > SLACK_LEAD) {
    if (s.steady + 1 >= STEADY_REPORTS) return { delay: clampDelay(s.delay - 1), steady: 0 };
    return { delay: s.delay, steady: s.steady + 1 };
  }
  return { delay: s.delay, steady: 0 };
}
