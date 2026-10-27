// Connecting two players over a private Supabase Realtime channel and starting the game the server picked.
//
// Channel `pokejam:match:<match id>`: private, so only the match's two players can join it (RLS on
// realtime.messages, migration 20261025). The game itself (seed, both rosters, quarter length, names) comes from
// the server's match row, never from the other player, so neither side can stack it. The handshake only checks
// that both are here on the same engine ("hi", with ENGINE_VERSION); then the channel carries lockstep messages.
import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { userCourt } from '../../data/courts';
import { monByDex } from '../../data/pokemon';
import { USER_STYLE, contrastAway } from '../../franchise/league';
import { ENGINE_VERSION, type GameConfig } from '../../game/types';
import { abbr } from '../../util';
import { BusyError, isChannelFailure } from './capacity';
import { EvidenceLog } from './evidence';
import type { Lockstep, NetMsg, Transport } from './lockstep';
import { rostersFor } from './roster';
import { RtcLink } from './rtc';
import type { OnlineMatch, SupabaseMatchService } from './onlineMatchService';
import { backoffMs } from './throttle';
import { gameConfigFor, matchKey, type MatchKeys, type MatchSetup, type MatchTeam } from './winnerCheck';

/** `ack` marks an answer to the other side's hi, which is never answered (so two finished sides don't echo). */
type Hs = { k: 'hi'; v: number; n: number; side: 0 | 1; ack?: true };

export class NetError extends Error {}

const HS_EVERY = 400;
/** Waiting for the other player once we're on the channel; a failed join is retried inside this (each try can take up to 10 s to time out). */
const CONNECT_TIMEOUT = 40_000;
/** Joining the match channel: tries, and the pause before retry n (backoffMs: exponential with jitter, capped). */
export const JOIN_ATTEMPTS = 4;
export const JOIN_BACKOFF = 1000;
export const JOIN_BACKOFF_CAP = 8000;

/**
 * The match as the winner check sees it (winnerCheck.ts): seed, quarter length and both teams, all from the server's
 * match row. Both players and the judge build the game from this, so the judge's replay is the game that was played.
 */
export function setupFor(match: OnlineMatch, quarterLen = match.game.quarterLen): MatchSetup {
  // A drafted match (Social) plays the rosters the players drafted on the server; otherwise both come from the seed
  // (balanced for Ranked).
  const drafted = match.game.rosters;
  const [homeMons, awayMons] = drafted ? [drafted[0].map(monByDex), drafted[1].map(monByDex)] : rostersFor(match.game.seed, match.queue);
  const names: [string, string] = match.side === 0 ? [match.me.name, match.opponent.name] : [match.opponent.name, match.me.name];
  const home = { name: names[0], abbr: abbr(names[0]), ...USER_STYLE, human: true, roster: homeMons };
  const away = contrastAway(home, { name: names[1], abbr: abbr(names[1]), ...USER_STYLE, color: '#7a3fd8', color2: '#24124a', human: true, roster: awayMons });
  const team = (t: typeof home): MatchTeam => ({ name: t.name, abbr: t.abbr, color: t.color, color2: t.color2, roster: t.roster.map((m) => m.dex) });
  return { matchId: match.id, engineVersion: ENGINE_VERSION, seed: match.game.seed, quarterLen, home: team(home), away: team(away) };
}

/** The game for a match, the same on both sides and for the judge: gameConfigFor(setupFor(match)), plus the court art. */
export function buildConfig(match: OnlineMatch, quarterLen = match.game.quarterLen): GameConfig {
  const setup = setupFor(match, quarterLen);
  return { ...gameConfigFor(setup), court: userCourt(setup.home.name) };
}

/** Netcode protocol version: both players must match (an old tab and a new one can't play each other). */
export const NET_VERSION = 2;

/** Ms between input batches: quick on the direct link, slower on Realtime, where every message is billed twice. */
export const PACE_DIRECT_MS = 66;
export const PACE_REALTIME_MS = 100;
/** Give up on the direct link after this long and stay on Realtime. */
const RTC_TIMEOUT_MS = 8000;

/**
 * The live link to the other player: lockstep transport plus teardown. Starts on the private Realtime channel;
 * when a relayed WebRTC link opens (rtc.ts), gameplay moves there, and falls back to Realtime if it drops.
 */
export class MatchLink implements Transport {
  private ls: Lockstep | null = null;
  private early: NetMsg[] = [];
  private rtc: RtcLink | null = null;
  private rtcEarly: unknown[] = [];
  /** Messages sent over each transport (for the end-of-game stats and the quota maths). */
  readonly sent = { realtime: 0, direct: 0 };
  /** Signs what we send and keeps what they sent, for the winner check (null when the match has no keys). */
  evidence: EvidenceLog | null = null;
  constructor(private ch: RealtimeChannel, private sb: SupabaseClient) {}

  /** Swaps in a fresh channel after a failed join (the old one is removed by the caller). */
  useChannel(ch: RealtimeChannel) { this.ch = ch; }

  get direct(): boolean {
    return !!this.rtc?.open;
  }

  pace(): number {
    return this.direct ? PACE_DIRECT_MS : PACE_REALTIME_MS;
  }

  send(m: NetMsg) {
    // Input batches go out signed (a moment later: signing is async), so the other player holds proof of them.
    if (this.evidence && m.k === 'in' && m.r.length) {
      void this.evidence.sign(m).then((signed) => this.transmit(signed), () => this.transmit(m));
      return;
    }
    this.transmit(m);
  }

  private transmit(m: NetMsg) {
    if (this.rtc?.open) {
      this.rtc.send(m);
      this.sent.direct++;
    } else {
      void this.ch.send({ type: 'broadcast', event: 'ls', payload: m });
      this.sent.realtime++;
    }
  }
  /** Lockstep messages that arrive before the game is built are held until then. */
  deliver(m: unknown) {
    this.evidence?.received(m);
    if (this.ls) this.ls.receive(m);
    else if (this.early.length < 200) this.early.push(m as NetMsg); // a flood before the game starts is dropped
  }
  attach(ls: Lockstep) {
    this.ls = ls;
    for (const m of this.early.splice(0)) ls.receive(m);
  }

  /** A signalling message for the direct link (it may arrive before we've set ours up). */
  signal(raw: unknown) {
    if (this.rtc) void this.rtc.handle(raw);
    else if (this.rtcEarly.length < 60) this.rtcEarly.push(raw);
  }

  /** Try the direct link with these ICE servers (relay-only unless `policy` says otherwise). */
  upgrade(side: 0 | 1, iceServers: RTCIceServer[], policy: RTCIceTransportPolicy = 'relay') {
    if (this.rtc || typeof RTCPeerConnection === 'undefined') return;
    const rtc = new RtcLink(side, iceServers, (s) => void this.ch.send({ type: 'broadcast', event: 'rtc', payload: s }), policy);
    this.rtc = rtc;
    rtc.onMessage = (m) => this.deliver(m);
    rtc.onClose = () => { if (this.rtc === rtc) this.rtc = null; };
    const giveUp = setTimeout(() => { if (!rtc.open) rtc.close(); }, RTC_TIMEOUT_MS);
    rtc.onOpen = () => clearTimeout(giveUp);
    for (const s of this.rtcEarly.splice(0)) void rtc.handle(s);
    void rtc.start().catch(() => rtc.close());
  }

  close() {
    this.rtc?.close();
    void this.sb.removeChannel(this.ch);
  }
}

/**
 * ICE servers for the direct link: short-lived TURN credentials from the pokejam-ice Edge Function, for this
 * match only. Null when it isn't set up (or refuses), and the match stays on Realtime. Dev builds can try a plain
 * local connection with ?p2p=local (two tabs on one machine).
 */
export async function iceFor(sb: SupabaseClient, matchId: string, now: () => number = Date.now): Promise<{ iceServers: RTCIceServer[]; policy: RTCIceTransportPolicy } | null> {
  if (import.meta.env.DEV && typeof location !== 'undefined' && new URLSearchParams(location.search).get('p2p') === 'local') return { iceServers: [], policy: 'all' };
  // One attempt per match, and none for a while after a failure (TURN not set up, or the function is down): quiet, no retries.
  if (iceTried.has(matchId) || now() < iceDownUntil) return null;
  iceTried.add(matchId);
  if (iceTried.size > 50) iceTried.delete(iceTried.values().next().value!);
  const down = () => { iceDownUntil = now() + ICE_PAUSE_MS; return null; };
  try {
    const call = sb.functions.invoke('pokejam-ice', { body: { match: matchId } });
    const { data, error } = await Promise.race([call, new Promise<never>((_, rej) => setTimeout(() => rej(new Error('pokejam-ice timed out')), ICE_TIMEOUT_MS))]);
    const servers = (data as { iceServers?: unknown } | null)?.iceServers;
    if (error || !Array.isArray(servers) || !servers.length) return down();
    return { iceServers: servers as RTCIceServer[], policy: 'relay' };
  } catch {
    return down();
  }
}

const ICE_PAUSE_MS = 10 * 60_000;
const ICE_TIMEOUT_MS = 6000;
const iceTried = new Set<string>();
let iceDownUntil = 0;
/** Forget what iceFor has learned (tests). */
export function resetIce() {
  iceTried.clear();
  iceDownUntil = 0;
}

/**
 * Joins the match's private channel and waits for the other player. Resolves with the game and the link.
 * `quarterLen` overrides the server's only in dev builds (the two-browser end-to-end test).
 */
export interface Connected {
  cfg: GameConfig;
  link: MatchLink;
  /** What the judge rebuilds the game from, and both registered keys (null if this match has no evidence). */
  setup: MatchSetup;
  keys: MatchKeys | null;
}

const KEYS_TIMEOUT = 15_000;

/**
 * Does this match need signed evidence? Only when a result is judged: Ranked now, Pack Battles when it moves here.
 * Social is neither rated nor paid (and its uploads would be about 1 GB per 1,000 games), so it plays without.
 */
export function wantsEvidence(match: Pick<OnlineMatch, 'queue'>): boolean {
  return match.queue !== 'social';
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Before tip-off: make this match's key, register it, and wait until both players' keys are on the match row.
 * Null when this browser can't sign (no Ed25519) or the server has no keys yet (an older database), and the match
 * goes on without evidence: fine for Social, which nothing is paid or rated on.
 */
async function prepareEvidence(service: SupabaseMatchService, match: OnlineMatch): Promise<{ log: EvidenceLog; keys: MatchKeys } | null> {
  let key: Awaited<ReturnType<typeof matchKey>>;
  try {
    key = await matchKey();
  } catch {
    return null;
  }
  try {
    if (!(await service.registerKey(match.id, key.publicKey))) return null;
  } catch {
    return null;
  }
  const until = Date.now() + KEYS_TIMEOUT;
  while (Date.now() < until) {
    const info = await service.matchInfo(match.id).catch(() => null);
    const [h, g] = info?.keys ?? [null, null];
    if (h && g) return info!.keys[match.side] === key.publicKey ? { log: new EvidenceLog(key.privateKey, match.id, match.side), keys: [h, g] } : null;
    await sleep(400);
  }
  return null;
}

export function connect(sb: SupabaseClient, match: OnlineMatch, quarterLen: number | undefined, signal?: AbortSignal,
  service?: SupabaseMatchService): Promise<Connected> {
  return new Promise((resolve, reject) => {
    const open = () => sb.channel(`pokejam:match:${match.id}`, { config: { private: true, broadcast: { self: false, ack: false } } });
    let ch = open();
    const link = new MatchLink(ch, sb);
    // Keys are registered while the players find each other; tip-off waits for both.
    // Only rated (and paid) matches are ever judged, so only they sign and upload; Social plays without.
    const signed = !!service && wantsEvidence(match);
    let evidence: { log: EvidenceLog; keys: MatchKeys } | null | undefined = signed ? undefined : null;
    let peer = false;
    if (signed) void prepareEvidence(service!, match).then((e) => { evidence = e; ready(); });
    let done = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    // Nothing is sent until the channel is joined: a send on an unjoined channel goes out as an HTTP request instead.
    let subscribed = false;
    const hi = (ack?: true) => subscribed && void ch.send({ type: 'broadcast', event: 'hs', payload: { k: 'hi', v: ENGINE_VERSION, n: NET_VERSION, side: match.side, ack } satisfies Hs });
    const finish = (err: Error | null) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      clearTimeout(timeout);
      clearTimeout(retry);
      if (err) { link.close(); reject(err); return; }
      link.evidence = evidence?.log ?? null;
      resolve({ cfg: buildConfig(match, quarterLen), link, setup: setupFor(match, quarterLen), keys: evidence?.keys ?? null });
    };
    const ready = () => { if (peer && evidence !== undefined) finish(null); };
    const timer = setInterval(() => hi(), HS_EVERY);
    // Never got onto the channel: the match server is the problem (full, rate-limited), not the other player.
    const timeout = setTimeout(() => finish(subscribed ? new NetError('Could not reach the other player.') : new BusyError('join timed out')), CONNECT_TIMEOUT);
    signal?.addEventListener('abort', () => finish(new DOMException('aborted', 'AbortError')), { once: true });

    const bind = (c: RealtimeChannel) => {
      c.on('broadcast', { event: 'hs' }, ({ payload }) => {
        const m = payload as Partial<Hs>;
        if (m?.k !== 'hi' || m.side === match.side || (m.side !== 0 && m.side !== 1)) return;
        if (m.v !== ENGINE_VERSION || m.n !== NET_VERSION) return finish(new NetError('You and your opponent are on different game versions. Refresh to update.'));
        // Answer their hi, even after starting (ours may have been lost), but never an answer.
        if (!m.ack) hi(true);
        peer = true;
        ready();
      });
      c.on('broadcast', { event: 'ls' }, ({ payload }) => link.deliver(payload));
      c.on('broadcast', { event: 'rtc' }, ({ payload }) => link.signal(payload));
    };
    bind(ch);
    // A cold Realtime tenant can refuse the first join (MissingPartition), and a full one refuses with rate-limit or
    // too-many-channels errors: retry on a fresh channel after an exponential, jittered backoff (capped), then
    // report "online is busy" rather than a vague connection error.
    const attempt = (n: number) => {
      const joining = ch;
      const fail = (why = '') => {
        if (done || joining !== ch) return;
        if (n >= JOIN_ATTEMPTS) return finish(new BusyError(why || 'channel join failed'));
        void sb.removeChannel(joining);
        retry = setTimeout(() => {
          if (done) return;
          subscribed = false;
          ch = open();
          link.useChannel(ch);
          bind(ch);
          attempt(n + 1);
        }, backoffMs(n, JOIN_BACKOFF, JOIN_BACKOFF_CAP));
      };
      // Private channels authorize with the player's own token.
      void sb.realtime.setAuth().then(() => joining.subscribe((status, err) => {
        if (joining !== ch || done) return;
        if (status === 'SUBSCRIBED') { subscribed = true; hi(); }
        else if (isChannelFailure(status)) fail(err?.message ?? status);
      }), () => fail('auth'));
    };
    attempt(1);
  });
}
