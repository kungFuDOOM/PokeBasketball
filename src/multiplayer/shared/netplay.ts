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
import { rosterDigest } from '../ranked/presets';
import { rostersFor } from './roster';
import { RtcLink } from './rtc';
import type { OnlineMatch, SupabaseMatchService } from './onlineMatchService';
import { planRtt, startDelay, type RttStats } from './netDelay';
import { Pinger } from './ping';
import { parsePre, type Pre } from './pre';
import { backoffMs } from './throttle';
import { gameConfigFor, matchKey, type MatchKeys, type MatchSetup, type MatchTeam } from './winnerCheck';

/**
 * `ack` marks an answer to the other side's hi, which is never answered (so two finished sides don't echo).
 * `d` (Ranked only) is rosterDigest of both rosters; older clients leave it out and ignore it, so it needs no version bump.
 * `i: 1` says this client shows the pre-game intro (the 'pre' event); an older peer leaves it out and skips it.
 * `s: 1` says this client plays the starting five on the court; it's shown only when both sides send it.
 */
export type Hs = { k: 'hi'; v: number; n: number; side: 0 | 1; ack?: true; d?: number; i?: 1; s?: 1 };

export class NetError extends Error {}

/** The match is no longer on (the other player left, or the server called it off): there is nobody to connect to. */
export class MatchOverError extends Error {
  name = 'MatchOverError';
}

/** Realtime refused the channel because this player may not use it (RLS: the match isn't active), not for capacity. */
export const isRefusal = (why: string) => /unauthori[sz]ed|permission|not allowed|forbidden|denied/i.test(why);

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
  // The server's rosters (Social's draft, Ranked's preset picks) when present. Social falls back to the seed; Ranked
  // never does, so a Ranked match can't start on random teams.
  const drafted = match.game.rosters;
  if (!drafted && match.queue === 'ranked') throw new Error('ranked match has no preset rosters');
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

/**
 * Netcode protocol version: both players must match (an old tab and a new one can't play each other). The handshake
 * ("hi") carries it and a mismatch ends the connect with "different game versions" on both sides, before any input
 * is exchanged, so an old and a new client can never be in one game. 3 = per-tick sends, ping/pong, faster delay
 * adaptation (a 2 client would read the new lead reports and 60 Hz traffic as junk or flood).
 */
export const NET_VERSION = 3;

/** Ms between input batches: every tick (60 Hz) on the direct link, slower on Realtime, where every message is billed twice. */
export const PACE_DIRECT_MS = 16;
export const PACE_REALTIME_MS = 100;
/** Give up on the direct link after this long and stay on Realtime. */
const RTC_TIMEOUT_MS = 8000;
/** The direct link is treated as dead (traffic goes over Realtime) after this long without hearing anything over it. */
export const DIRECT_SILENT_MS = 2500;
/** Unacknowledged inputs this long (ms) are also sent over Realtime. */
const ACK_STALE_MS = 1000;

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
  /** Round-trip probes over whichever transport is live. */
  readonly pinger = new Pinger((m) => this.transmit(m));
  /** Input batches that went over Realtime instead of the direct link (the "used the fallback" stat). */
  realtimeInputs = 0;
  /** How the relay carried the direct link, once known. */
  relayProtocol: 'udp' | 'tcp' | 'tls' | 'unknown' = 'unknown';
  private meter: ReturnType<typeof setInterval> | undefined;
  constructor(private ch: RealtimeChannel, private sb: SupabaseClient) {}

  /** Wait (up to `ms`) for the direct link to open; resolves whether it did or not. */
  waitDirect(ms: number): Promise<boolean> {
    return new Promise((resolve) => {
      const until = Date.now() + ms;
      const check = () => {
        if (this.direct) resolve(true);
        else if (Date.now() >= until || this.gaveUp) resolve(false);
        else setTimeout(check, 50);
      };
      check();
    });
  }

  /** The direct link was never tried (no TURN credentials, no WebRTC) or has failed: nothing to wait for. */
  gaveUp = false;

  /** Ping the peer `count` times, `gapMs` apart, and give the figures (stats cover just this run). */
  async probe(count = 10, gapMs = this.direct ? 60 : 200): Promise<RttStats> {
    const from = this.pinger.samples.length;
    for (let i = 0; i < count; i++) {
      this.pinger.ping();
      await new Promise((r) => setTimeout(r, gapMs));
    }
    // Stragglers: wait for the last pongs, but not long.
    for (let i = 0; i < 20 && this.pinger.samples.length - from < count; i++) await new Promise((r) => setTimeout(r, 50));
    return this.pinger.stats(from);
  }

  /** The delay to start with, from a probe of the live transport. */
  startDelayFor(st: RttStats): number {
    const { rtt, jitter } = planRtt(st, this.direct);
    return startDelay(rtt, this.pace(), jitter);
  }

  /** Keep pinging for the in-game meter (slower on Realtime, where every message is billed) and learn the relay protocol. */
  startMeter() {
    if (this.meter) return;
    let n = 0;
    this.meter = setInterval(() => {
      if (this.direct || n % 2 === 0) this.pinger.ping();
      if (this.rtc?.open && this.relayProtocol === 'unknown' && n % 4 === 0) void this.rtc.relayProtocol().then((p) => { if (p !== 'unknown') this.relayProtocol = p; });
      n++;
    }, 1500);
  }

  /** Swaps in a fresh channel after a failed join (the old one is removed by the caller). */
  useChannel(ch: RealtimeChannel) { this.ch = ch; }

  get direct(): boolean {
    return !!this.rtc?.open;
  }

  /** Receive times (performance.now) per transport, and when the direct link opened. */
  private rx = { direct: -Infinity, realtime: -Infinity };
  private openedAt = -Infinity;

  /**
   * Is the direct link carrying traffic both ways? It can read "open" on our side after the other side has dropped it
   * (the browser takes ~30 s to notice a dead relay path); then the peer sends over Realtime only, and our inputs
   * sent into the dead link would never arrive. So the link counts as good only while we have heard from it lately.
   * Pings keep going over it, and a pong coming back brings it back into use.
   */
  private directGood(): boolean {
    if (!this.direct) return false;
    return performance.now() - Math.max(this.rx.direct, this.openedAt) < DIRECT_SILENT_MS;
  }

  pace(): number {
    return this.directGood() ? PACE_DIRECT_MS : PACE_REALTIME_MS;
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
    // Probes always try the direct link when it is open (that is how a silent link is found to be alive again).
    const probe = m.k === 'ping' || m.k === 'pong';
    let viaDirect = probe ? this.direct : this.directGood();
    if (viaDirect) {
      try {
        this.rtc!.send(m);
        this.sent.direct++;
      } catch {
        viaDirect = false; // the channel is closing or its queue is full: Realtime carries this one
      }
    }
    // Inputs the peer has not acknowledged for a second: the direct path may be broken one way (we hear them, they
    // don't hear us). Repeat them on Realtime too, at Realtime's own pace.
    const now = performance.now();
    const hedge = viaDirect && m.k === 'in' && (this.ls?.ackStale() ?? 0) > ACK_STALE_MS && now - this.lastHedge >= PACE_REALTIME_MS;
    if (hedge) this.lastHedge = now;
    if (!viaDirect || hedge) {
      void this.ch.send({ type: 'broadcast', event: 'ls', payload: m });
      this.sent.realtime++;
      if (m.k === 'in' && !hedge) this.realtimeInputs++;
    }
  }
  private lastHedge = 0;
  /** Lockstep messages that arrive before the game is built are held until then. */
  deliver(m: unknown, via: 'direct' | 'realtime' = 'realtime') {
    this.rx[via] = performance.now();
    if (this.pinger.handle(m)) return;
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
    // The peer's direct link failed: stop sending into ours (it can read "open" for ~30 s after the other end is gone).
    if ((raw as { k?: unknown } | null)?.k === 'down') { this.rtc?.close(); return; }
    if (this.rtc) void this.rtc.handle(raw);
    else if (this.rtcEarly.length < 60) this.rtcEarly.push(raw);
  }

  /** Try the direct link with these ICE servers (relay-only unless `policy` says otherwise). */
  upgrade(side: 0 | 1, iceServers: RTCIceServer[], policy: RTCIceTransportPolicy = 'relay') {
    if (this.rtc || typeof RTCPeerConnection === 'undefined') return;
    const rtc = new RtcLink(side, iceServers, (s) => void this.ch.send({ type: 'broadcast', event: 'rtc', payload: s }), policy);
    this.rtc = rtc;
    rtc.onMessage = (m) => this.deliver(m, 'direct');
    rtc.onClose = () => {
      if (this.rtc !== rtc) return;
      this.rtc = null;
      this.gaveUp = true;
      if (this.openedAt > -Infinity) void this.ch.send({ type: 'broadcast', event: 'rtc', payload: { k: 'down' } });
    };
    const giveUp = setTimeout(() => { if (!rtc.open) rtc.close(); }, RTC_TIMEOUT_MS);
    rtc.onOpen = () => { clearTimeout(giveUp); this.openedAt = performance.now(); };
    for (const s of this.rtcEarly.splice(0)) void rtc.handle(s);
    void rtc.start().catch(() => rtc.close());
  }

  private preCb: ((p: Pre) => void) | null = null;
  /** Intro messages ('pre'): skip votes and the start barrier, over Realtime only. */
  sendPre(k: Pre['k'], at?: number) {
    void this.ch.send({ type: 'broadcast', event: 'pre', payload: at === undefined ? { k } : { k, at } });
    this.sent.realtime++;
  }
  onPre(cb: ((p: Pre) => void) | null) { this.preCb = cb; }
  /** A peer's 'pre' payload; junk is dropped. */
  deliverPre(raw: unknown) {
    const p = parsePre(raw);
    if (p) this.preCb?.(p);
  }

  close() {
    this.preCb = null;
    clearInterval(this.meter);
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
  // One try per match (plus one retry after a timeout, e.g. the function's cold start), and none for a minute after a
  // failure (TURN not set up, or the function is down): quiet. Every game that misses the direct link runs on Realtime,
  // which is billed per message, so a short pause matters.
  if (iceTried.has(matchId) || now() < iceDownUntil) return null;
  iceTried.add(matchId);
  if (iceTried.size > 50) iceTried.delete(iceTried.values().next().value!);
  const down = () => { iceDownUntil = now() + ICE_PAUSE_MS; return null; };
  for (let attempt = 1; ; attempt++) {
    // The server hands out credentials ICE_MAX times per ICE_WINDOW_MS per player (pokejam_ice_ok); past that it
    // would only refuse, so don't ask.
    if (!iceBudget(now())) return null;
    try {
      const call = sb.functions.invoke('pokejam-ice', { body: { match: matchId } });
      const { data, error } = await Promise.race([call, new Promise<never>((_, rej) => setTimeout(() => rej(new IceTimeout()), ICE_TIMEOUT_MS))]);
      const servers = (data as { iceServers?: unknown } | null)?.iceServers;
      if (error || !Array.isArray(servers) || !servers.length) return down();
      return { iceServers: servers as RTCIceServer[], policy: 'relay' };
    } catch (e) {
      if (!(e instanceof IceTimeout) || attempt >= ICE_TRIES) return down();
    }
  }
}

class IceTimeout extends Error {}
const ICE_PAUSE_MS = 60_000;
const ICE_TIMEOUT_MS = 6000;
const ICE_TRIES = 2;
/** pokejam_ice_ok (migration 20261026): 6 credential requests per player per 10 minutes. */
export const ICE_MAX = 6;
export const ICE_WINDOW_MS = 10 * 60_000;
const iceTried = new Set<string>();
let iceDownUntil = 0;
let iceAsked: number[] = [];
/** Records a request to pokejam-ice at `t`; false (nothing recorded) if the server's limit is used up. */
function iceBudget(t: number): boolean {
  iceAsked = iceAsked.filter((h) => t - h < ICE_WINDOW_MS);
  if (iceAsked.length >= ICE_MAX) return false;
  iceAsked.push(t);
  return true;
}
/** Forget what iceFor has learned (tests). */
export function resetIce() {
  iceTried.clear();
  iceDownUntil = 0;
  iceAsked = [];
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
  /** The peer shows the pre-game intro (its hi carried `i: 1`); false for an older client, which goes straight in. */
  intro: boolean;
  /** The peer also plays the starting five (its hi carried `s: 1`); false for an older client. */
  startingFive: boolean;
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
    let peerIntro = false;
    let peerFive = false;
    if (signed) void prepareEvidence(service!, match).then((e) => { evidence = e; ready(); });
    let done = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    // Nothing is sent until the channel is joined: a send on an unjoined channel goes out as an HTTP request instead.
    let subscribed = false;
    // Ranked: both sides must be about to play the same two teams.
    const teams = match.queue === 'ranked' ? setupFor(match, quarterLen) : null;
    const digest = teams ? rosterDigest([teams.home.roster, teams.away.roster]) : undefined;
    const hi = (ack?: true) => subscribed && void ch.send({ type: 'broadcast', event: 'hs', payload: { k: 'hi', v: ENGINE_VERSION, n: NET_VERSION, side: match.side, ack, d: digest, i: 1, s: 1 } satisfies Hs });
    const finish = (err: Error | null) => {
      if (done) return;
      done = true;
      clearInterval(timer);
      clearTimeout(timeout);
      clearTimeout(retry);
      if (err) { link.close(); reject(err); return; }
      link.evidence = evidence?.log ?? null;
      resolve({ cfg: buildConfig(match, quarterLen), link, setup: setupFor(match, quarterLen), keys: evidence?.keys ?? null, intro: peerIntro, startingFive: peerFive });
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
        if (m.v !== ENGINE_VERSION || m.n !== NET_VERSION || (digest !== undefined && m.d !== undefined && m.d !== digest)) return finish(new NetError('You and your opponent are on different game versions. Refresh to update.'));
        // Answer their hi, even after starting (ours may have been lost), but never an answer.
        if (!m.ack) hi(true);
        peerIntro = m.i === 1;
        peerFive = m.s === 1;
        peer = true;
        ready();
      });
      c.on('broadcast', { event: 'ls' }, ({ payload }) => link.deliver(payload, 'realtime'));
      c.on('broadcast', { event: 'rtc' }, ({ payload }) => link.signal(payload));
      c.on('broadcast', { event: 'pre' }, ({ payload }) => link.deliverPre(payload));
    };
    bind(ch);
    // A cold Realtime tenant can refuse the first join (MissingPartition), and a full one refuses with rate-limit or
    // too-many-channels errors: retry on a fresh channel after an exponential, jittered backoff (capped), then
    // report "online is busy" rather than a vague connection error.
    const attempt = (n: number) => {
      const joining = ch;
      const fail = async (why = '') => {
        if (done || joining !== ch) return;
        // Refused rather than full: if the match is over (the other player left), say so instead of retrying. Only
        // capacity problems are "online is busy"; a refusal that persists is a connection problem.
        if (isRefusal(why) && service) {
          const status = await service.matchStatus(match.id).catch(() => null);
          if (done || joining !== ch) return;
          if (status && status !== 'active') return finish(new MatchOverError(`match ${status}`));
        }
        if (n >= JOIN_ATTEMPTS) return finish(isRefusal(why) ? new NetError('Could not join the match.') : new BusyError(why || 'channel join failed'));
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
        else if (isChannelFailure(status)) void fail(err?.message ?? status);
      }), () => void fail('auth'));
    };
    attempt(1);
  });
}
