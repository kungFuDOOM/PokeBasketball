// The match setup, from the server's match row alone: the client (setupFor in netplay.ts) and the judge
// (supabase/functions/_shared/judge) both build it here. No DOM, no Vite env and nothing from the franchise code,
// because the Edge Function bundles this file under Deno.
import { ENGINE_VERSION } from '../../game/types';
import { displayName, safeName } from '../../nameFilter';
import { abbr } from '../../util';
import type { MatchSetup, MatchTeam } from './winnerCheck';

export const USER_STYLE = { color: '#3b6fd8', color2: '#16224a' };
const AWAY_STYLE = { color: '#7a3fd8', color2: '#24124a' };

export function colorDistance(a: string, b: string): number {
  const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
  const [x, y] = [rgb(a), rgb(b)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

/** Two blues (you vs Misty) are hard to tell apart on the floor: give the second team a contrasting color. */
export function contrastAway<T extends { color: string }>(home: { color: string }, away: T): T {
  if (colorDistance(home.color, away.color) >= 110) return away;
  return { ...away, color: colorDistance(home.color, '#e3350d') < 110 ? '#f4f1e8' : '#e3350d' };
}

/**
 * The names on a match, host first, from what the server returns. Ranked shows usernames (no username reads as
 * "Player"); Social shows trainer names, and a blocked one (a modified client, or an old name) shows as the default.
 */
export function namesFromRow(queue: string, hostName: string | null | undefined, guestName: string | null | undefined): [string, string] {
  const name = (n: string | null | undefined) => (queue === 'ranked' ? displayName(n) : safeName(n ?? 'Trainer', 'Trainer'));
  return [name(hostName), name(guestName)];
}

/** Seed, quarter length and rosters as both clients and the judge read them from the row. */
export function gameFromRow(r: { seed?: number | null; quarter_len?: number | null; host_roster?: number[] | null; guest_roster?: number[] | null }) {
  return {
    seed: Number(r.seed) >>> 0,
    quarterLen: r.quarter_len === 60 ? 60 : 120,
    rosters: r.host_roster?.length === 5 && r.guest_roster?.length === 5 ? [r.host_roster, r.guest_roster] as [number[], number[]] : null,
  };
}

export interface SetupRow {
  id: string;
  seed: number;
  quarterLen: number;
  hostName: string;
  guestName: string;
  /** Pokédex numbers, host first. */
  rosters: [number[], number[]];
  /** The engine the match was played on; this build's when left out. */
  engineVersion?: number;
}

/** Everything both copies of the game are built from. Host, guest and judge must all come through here. */
export function setupFromRow(r: SetupRow): MatchSetup {
  const home: MatchTeam = { name: r.hostName, abbr: abbr(r.hostName), ...USER_STYLE, roster: r.rosters[0] };
  const away = contrastAway(home, { name: r.guestName, abbr: abbr(r.guestName), ...AWAY_STYLE, roster: r.rosters[1] });
  return { matchId: r.id, engineVersion: r.engineVersion ?? ENGINE_VERSION, seed: r.seed, quarterLen: r.quarterLen, home, away };
}

/** What pokejam_match_setup returns (migration 20261128). */
export interface ServerMatchRow {
  id: string;
  queue: string;
  seed: number | null;
  quarter_len: number | null;
  host_name: string | null;
  guest_name: string | null;
  host_roster: number[] | null;
  guest_roster: number[] | null;
  host_key: string | null;
  guest_key: string | null;
}

/** The judge's reading of pokejam_match_setup. `setup` is null when the row can't build the game (no seed, or rosters not ready). */
export function judgeSetupFromRow(r: ServerMatchRow): { setup: MatchSetup | null; keys: { host_key: string | null; guest_key: string | null } } {
  const { seed, quarterLen, rosters } = gameFromRow(r);
  const [hostName, guestName] = namesFromRow(r.queue, r.host_name, r.guest_name);
  return {
    setup: r.seed === null || r.seed === undefined || !rosters ? null : setupFromRow({ id: r.id, seed, quarterLen, hostName, guestName, rosters }),
    keys: { host_key: r.host_key, guest_key: r.guest_key },
  };
}
