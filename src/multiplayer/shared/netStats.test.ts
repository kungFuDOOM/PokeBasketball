import { describe, expect, it, vi } from 'vitest';
import type { Lockstep } from './lockstep';
import type { RttStats } from './netDelay';
import { browserEngine, netStatsRow, submitNetStats } from './netStats';
import type { MatchLink } from './netplay';

const rtt: RttStats = { samples: 0, median: 0, p95: 0, jitter: 0 };
const fakeLink = (sent = { realtime: 120, direct: 3400 }, realtimeInputs = 4) =>
  ({ sent, realtimeInputs, relayProtocol: 'udp' }) as unknown as MatchLink;
const fakeLs = (stats: Partial<Lockstep['stats']> = {}) =>
  ({ delay: 6, stats: { stalls: 2, stallMs: 0, desyncs: 1, resyncs: 1, sent: 0, received: 3300, dropped: 7, startDelay: 5, maxDelay: 9, ...stats } }) as unknown as Lockstep;

const UA = {
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36',
  edge: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0',
  firefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.0; rv:131.0) Gecko/20100101 Firefox/131.0',
  safariMac: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
  safariIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
  chromeIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/130.0.0.0 Mobile/15E148 Safari/604.1',
  firefoxIos: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/131.0 Mobile/15E148 Safari/605.1.15',
  androidChrome: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36',
};

describe('netStatsRow', () => {
  it('copies the link and lockstep counters into the new fields', () => {
    const r = netStatsRow('m', 'u', fakeLink(), fakeLs(), rtt, 240);
    expect(r).toMatchObject({ sent_realtime: 120, sent_direct: 3400, realtime_inputs: 4, received: 3300, dropped: 7, resyncs: 1, desyncs: 1 });
    expect(['blink', 'gecko', 'webkit', 'other']).toContain(r.browser_engine);
  });

  it('gives zeros without a lockstep', () => {
    const r = netStatsRow('m', 'u', fakeLink(), null, rtt, 3);
    expect(r).toMatchObject({ received: 0, dropped: 0, resyncs: 0, desyncs: 0, stalls: 0 });
  });

  it('clamps a runaway counter to the column limit instead of losing the row', () => {
    const r = netStatsRow('m', 'u', fakeLink({ realtime: 5e9, direct: -3 }, Infinity), fakeLs({ received: 2e8, resyncs: 1e9 }), rtt, 60);
    expect(r).toMatchObject({ sent_realtime: 10_000_000, sent_direct: 0, realtime_inputs: 0, received: 10_000_000, resyncs: 100_000 });
  });

  it('keeps the Realtime-fallback threshold at 10 batches', () => {
    expect(netStatsRow('m', 'u', fakeLink(undefined, 10), null, rtt, 60).used_realtime_fallback).toBe(false);
    expect(netStatsRow('m', 'u', fakeLink(undefined, 11), null, rtt, 60).used_realtime_fallback).toBe(true);
  });

  it('still reports protocol version 3', () => {
    expect(netStatsRow('m', 'u', fakeLink(), null, rtt, 60).proto_version).toBe(3);
  });
});

describe('browserEngine', () => {
  it.each([
    ['chrome', 'blink'], ['edge', 'blink'], ['androidChrome', 'blink'], ['firefox', 'gecko'],
    ['safariMac', 'webkit'], ['safariIos', 'webkit'], ['chromeIos', 'webkit'], ['firefoxIos', 'webkit'],
  ] as const)('%s → %s', (k, want) => expect(browserEngine(UA[k])).toBe(want));

  it('is "other" for an empty or unrecognised agent', () => {
    expect(browserEngine('')).toBe('other');
    expect(browserEngine('curl/8.0')).toBe('other');
  });

  it('is "other" when there is no navigator', () => {
    vi.stubGlobal('navigator', undefined);
    try { expect(browserEngine()).toBe('other'); } finally { vi.unstubAllGlobals(); }
  });
});

describe('submitNetStats', () => {
  const row = netStatsRow('m', 'u', fakeLink(), fakeLs(), rtt, 60);
  const fakeSb = (errors: ({ code?: string; message: string } | null)[]) => {
    const inserted: Record<string, unknown>[] = [];
    const sb = { from: () => ({ insert: async (r: Record<string, unknown>) => { inserted.push(r); return { error: errors.shift() ?? null }; } }) };
    return { sb: sb as never, inserted };
  };

  it('inserts the full row once when the server accepts it', async () => {
    const { sb, inserted } = fakeSb([null]);
    await submitNetStats(sb, row);
    expect(inserted).toEqual([row]);
  });

  it('retries once without the new columns when the server does not have them yet', async () => {
    const { sb, inserted } = fakeSb([{ code: 'PGRST204', message: "Could not find the 'browser_engine' column of 'pokejam_match_net_stats' in the schema cache" }]);
    await submitNetStats(sb, row);
    expect(inserted).toHaveLength(2);
    expect(inserted[1]).not.toHaveProperty('browser_engine');
    expect(inserted[1]).not.toHaveProperty('sent_realtime');
    expect(inserted[1]).toMatchObject({ match_id: 'm', user_id: 'u', stalls: 2, desyncs: 1, proto_version: 3 });
  });

  it('does not retry other errors (a duplicate row), and never throws', async () => {
    const { sb, inserted } = fakeSb([{ code: '23505', message: 'duplicate key value violates unique constraint' }]);
    await submitNetStats(sb, row);
    expect(inserted).toHaveLength(1);
    await expect(submitNetStats({ from: () => { throw new Error('offline'); } } as never, row)).resolves.toBeUndefined();
  });
});
