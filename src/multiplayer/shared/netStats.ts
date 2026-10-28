// Per-match network stats (table pokejam_match_net_stats, migration 20261108): what the link was like, so the next
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
  };
}

/** Insert the row (once per match; the table's unique key drops a repeat). Swallows every error. */
export async function submitNetStats(sb: Pick<SupabaseClient, 'from'>, row: NetStatsRow): Promise<void> {
  try {
    await sb.from('pokejam_match_net_stats').insert(row);
  } catch { /* telemetry must never reach the game */ }
}
