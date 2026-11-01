// Per-match network stats (table pokejam_match_net_stats, migrations 20261108 and 20261126): what the link was like, so the next
// lag report can be explained. No IP addresses, nothing about who the opponent is. Best effort: never throws.
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Lockstep } from './lockstep';
import type { RttStats } from './netDelay';
import { NET_VERSION, type MatchLink } from './netplay';


/** The build has no version stamp of its own; the protocol version tells builds apart well enough for lag questions. */
export const CLIENT_VERSION = `web-n${NET_VERSION}`;

export interface NetStatsRow {
  match_id: string;
  user_id: string;
  rtt_median_ms: number | null;
  rtt_p95_ms: number | null;
  relay_protocol: string;
  used_realtime_fallback: boolean;
  stalls_per_min: number;
  stalls: number;
  duration_s: number;
  start_delay: number;
  final_delay: number;
  max_delay: number;
  desyncs: number;
  proto_version: number;
  client_version: string;
  // Cost and resync counters (migration 20261126). Self-reported: for cost estimates, never to judge anyone.
  /** Messages this client sent over Supabase Realtime / the direct WebRTC link. */
  sent_realtime: number;
  sent_direct: number;
  /** Input batches that went over Realtime as the only path (not a hedge copy). */
  realtime_inputs: number;
  /** Lockstep messages received, and the ones dropped as invalid, rate-limited or too soon. */
  received: number;
  dropped: number;
  /** Snapshots this client accepted (guest side) after a desync. */
  resyncs: number;
  browser_engine: BrowserEngine;
}

export type BrowserEngine = 'blink' | 'gecko' | 'webkit' | 'other';

/** The new columns, left out when a server without migration 20261126 rejects the row (so the old fields still land). */
const NEW_FIELDS = ['sent_realtime', 'sent_direct', 'realtime_inputs', 'received', 'dropped', 'resyncs', 'browser_engine'] as const;

/** Upper bound of the counter columns' check constraint: a runaway counter must not cost the whole row. */
const MAX_COUNT = 10_000_000;
const MAX_RESYNCS = 100_000;
const count = (n: number, max = MAX_COUNT) => (Number.isFinite(n) ? Math.min(Math.max(0, Math.round(n)), max) : 0);

/**
 * The browser's rendering engine from its user agent. Every iOS browser runs on WebKit, so Chrome (CriOS),
 * Firefox (FxiOS), Edge and Opera on iOS count as webkit. Never throws.
 */
export function browserEngine(ua?: string): BrowserEngine {
  try {
    const s = ua ?? (typeof navigator !== 'undefined' ? navigator.userAgent : '');
    if (!s) return 'other';
    if (/CriOS|FxiOS|EdgiOS|OPiOS/.test(s)) return 'webkit';
    if (/Firefox\//.test(s)) return 'gecko';
    if (/Chrome\/|Chromium\/|Edg\/|OPR\//.test(s)) return 'blink';
    if (/AppleWebKit|Safari\//.test(s)) return 'webkit';
    return 'other';
  } catch {
    return 'other';
  }
}

/** Input batches over Realtime (100 ms apart) that still count as "no fallback": about a second, e.g. the hand-over at tip-off. */
const REALTIME_BATCHES = 10;

const r1 = (x: number) => Math.round(x * 10) / 10;

export function netStatsRow(matchId: string, userId: string, link: MatchLink, ls: Lockstep | null, rtt: RttStats, durationS: number): NetStatsRow {
  const stalls = ls?.stats.stalls ?? 0;
  return {
    match_id: matchId,
    user_id: userId,
    rtt_median_ms: rtt.samples ? r1(rtt.median) : null,
    rtt_p95_ms: rtt.samples ? r1(rtt.p95) : null,
    relay_protocol: link.relayProtocol,
    used_realtime_fallback: link.realtimeInputs > REALTIME_BATCHES,
    stalls_per_min: durationS >= 5 ? r1((stalls * 60) / durationS) : 0,
    stalls,
    duration_s: Math.round(durationS),
    start_delay: ls?.stats.startDelay ?? 0,
    final_delay: ls?.delay ?? 0,
    max_delay: ls?.stats.maxDelay ?? 0,
    desyncs: ls?.stats.desyncs ?? 0,
    proto_version: NET_VERSION,
    client_version: CLIENT_VERSION,
    sent_realtime: count(link.sent.realtime),
    sent_direct: count(link.sent.direct),
    realtime_inputs: count(link.realtimeInputs),
    received: count(ls?.stats.received ?? 0),
    dropped: count(ls?.stats.dropped ?? 0),
    resyncs: count(ls?.stats.resyncs ?? 0, MAX_RESYNCS),
    browser_engine: browserEngine(),
  };
}

/**
 * Insert the row (once per match; the table's unique key drops a repeat). Swallows every error. supabase-js returns
 * errors rather than throwing, so if the server doesn't know the new columns yet (PostgREST PGRST204 "Could not find
 * the 'x' column", or Postgres 42703 undefined column) it retries once with only the original fields.
 */
export async function submitNetStats(sb: Pick<SupabaseClient, 'from'>, row: NetStatsRow): Promise<void> {
  try {
    const { error } = await sb.from('pokejam_match_net_stats').insert(row);
    if (error && (error.code === 'PGRST204' || error.code === '42703' || /column/i.test(error.message ?? ''))) {
      const old: Record<string, unknown> = { ...row };
      for (const k of NEW_FIELDS) delete old[k];
      await sb.from('pokejam_match_net_stats').insert(old);
    }
  } catch { /* telemetry must never reach the game */ }
}
