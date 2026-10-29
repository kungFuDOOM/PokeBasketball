// Server-backed MatchService (Supabase). Every write goes through the pokejam_* SECURITY DEFINER RPCs;
// clients can only read their own rows. See supabase/migrations/.
import { MODE_RANKED } from '../../config/features';
import type { DraftView } from './draft';
import { cooldownSeconds, counted, outcomeBetween, parseMatchRanks, parseMe, parseProfile, parseRankResult, type RankedMe, type RankedResult, type ServerRank } from '../ranked/serverRank';
import { displayName, serverNameError } from '../ranked/username';
import type { BadgeRank } from '../../ranked/badge';
import { isBusy } from './capacity';
import { RateLimit, backoffMs, jitter, singleFlight, sleep } from './throttle';
import type { MatchResult, MatchService, Opponent, Queue, ReportOutcome } from './matchService';

/** The slice of the Supabase client this service uses (lets tests pass a fake). */
export interface RpcClient {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string; code?: string } | null; status?: number }>;
}

export interface OnlineMatch {
  id: string;
  queue: Queue;
  /** 0 = host (home team), 1 = guest (away team). */
  side: 0 | 1;
  me: { id: string; name: string };
  opponent: Opponent;
  /**
   * The game the server picked: its seed and quarter length in seconds, and for a drafted match (Social) the two
   * rosters the players drafted (host, guest; Pokédex numbers by position). Otherwise both come from the seed.
   */
  game: { seed: number; quarterLen: number; rosters?: [number[], number[]] | null };
  /** Each side's registered evidence key (host, guest), or null while not registered yet. */
  keys: [string | null, string | null];
  /** 'active' while it's on; 'void' once a player left (or the server called it off), 'done' once it has a result. */
  status?: string;
}

/** Why a player reports an opponent (the server's list). */
export type ReportReason = 'name' | 'cheating' | 'quitting' | 'other';

export interface OnlineOpponent extends Opponent {
  matchId: string;
  /** The side I (not the opponent) play: 0 = host, 1 = guest. */
  mySide: 0 | 1;
}

/** The room the host was waiting in is over: the friend left, it was closed, or nobody joined in time. */
export class RoomGoneError extends Error {
  name = 'RoomGoneError';
}

const aborted = () => new DOMException('aborted', 'AbortError');
const stopIfAborted = (signal?: AbortSignal) => { if (signal?.aborted) throw aborted(); };

/** A refusal from the server. `code` and `status` (HTTP) are kept so capacity limits can be told from real errors (capacity.ts). */
export class OnlineError extends Error {
  constructor(message: string, public code?: string, public status?: number) {
    super(message);
  }
}

/** Ranked search refused: this player is on a leaver cooldown (migration 20261112). `seconds` is what is left of it. */
export class RankedCooldownError extends OnlineError {
  name = 'RankedCooldownError';
  constructor(public seconds: number, code?: string, status?: number) {
    super(`You can search for Ranked again in ${Math.ceil(seconds / 60)} min.`, code, status);
  }
}

const POLL_MS = 2000;
/** After reporting a Ranked result, wait this long for the other player's report before giving up on showing the rating change. */
const SETTLE_MS = 30_000;
/** A poll that hits a capacity limit is retried this many times (backoff with jitter) before it is reported. */
const POLL_RETRIES = 2;
/** Room-code tries allowed per minute, so a code can't be guessed by hammering the join button. */
const JOIN_TRIES = 6;
const JOIN_WINDOW_MS = 60_000;
/**
 * A page-exit request is warmed up again after this long (the browser keeps the preflight answer for an hour; a match
 * started within 20 minutes of a warm-up still has 40 minutes of it).
 */
const WARM_MS = 20 * 60_000;
/** No match has this id and no room has this code: the warm-up calls change nothing on the server. */
const NO_MATCH = '00000000-0000-0000-0000-000000000000';
const NO_ROOM = '';
/** A server without the RPC (an older migration set): the client stops asking. */
const missingRpc = (e: unknown) => e instanceof OnlineError && /PGRST202|42883/.test(e.code ?? '');

export class SupabaseMatchService implements MatchService {
  /**
   * @param queues the queues this service may play. Social builds pass ['social'] only, so this code path can
   * never submit a rated result (the server enforces the same: Social matches never reach the rating RPC).
   */
  constructor(private db: RpcClient, readonly userId: string, private queues: readonly Queue[] = ['social'],
    /** Runs the human check when the server asks for one (human.ts); `force` after a "human check needed" refusal. */
    private human: (force: boolean) => Promise<void> = async () => {},
    /** Sends an RPC that outlives the page (fetch keepalive, supabase.ts keepaliveRpc); best effort, no answer. */
    private beacon: (fn: string, args?: Record<string, unknown>) => void | Promise<void> = () => {}) {}

  private warmedAt = new Map<string, number>();
  /**
   * Sends a page-exit request once now, while the page is alive, so the browser has its CORS preflight cached: a
   * closing page gets the preflight out but not the request behind it (supabase.ts rpcBeacon; measured in Chrome).
   * `args` must make the call a no-op. At most once per WARM_MS per RPC.
   */
  private warm(fn: string, args?: Record<string, unknown>): Promise<void> {
    const at = this.warmedAt.get(fn);
    if (at !== undefined && Date.now() - at < WARM_MS) return Promise.resolve();
    this.warmedAt.set(fn, Date.now());
    return Promise.resolve(this.beacon(fn, args));
  }

  /** My rating as of just before the current Ranked match, so the result screen can show what the match changed. */
  private rankBefore: ServerRank | null = null;

  /** A matchmaking call, behind the human check: checked first if needed, and once more if the server still refuses. */
  private async gated<T>(run: () => Promise<T>, checkFirst = true): Promise<T> {
    if (checkFirst) await this.human(false);
    try {
      return await run();
    } catch (e) {
      if (!/human check needed/i.test((e as Error).message)) throw e;
      await this.human(true);
      return run();
    }
  }

  /** One RPC. With `retries`, a capacity refusal (429/503, too many connections) is retried after a growing, jittered pause. */
  private async call<T>(fn: string, args?: Record<string, unknown>, o: { retries?: number; signal?: AbortSignal } = {}): Promise<T> {
    for (let n = 1; ; n++) {
      const { data, error, status } = await this.db.rpc(fn, args);
      if (!error) return data as T;
      const err = new OnlineError(error.message, error.code, status);
      if (n > (o.retries ?? 0) || !isBusy(err)) throw err;
      await sleep(backoffMs(n, 1000, 6000), o.signal);
    }
  }

  private lastName: { want: string; kept: string } | null = null;
  private naming = singleFlight(async (want: string) => {
    const p = await this.call<{ trainer_name?: string } | null>('pokejam_ensure_profile', { p_name: want });
    const kept = p?.trainer_name ?? 'Trainer';
    this.lastName = { want, kept };
    return kept;
  }, (want) => want);
  private reporting = singleFlight((matchId: string, reason: ReportReason, note?: string) =>
    this.call<boolean>('pokejam_report_player', { p_match: matchId, p_reason: reason, p_note: note?.slice(0, 200) ?? null }), (matchId) => matchId);
  private blocking = singleFlight((matchId: string) => this.call('pokejam_block_player', { p_match: matchId }), (matchId) => matchId);
  private roomMaking = singleFlight((quarterLen: number) =>
    this.gated(() => this.call<string>('pokejam_create_room', { p_quarter_len: quarterLen <= 60 ? 60 : 120 })));
  private codeTries = new RateLimit(JOIN_TRIES, JOIN_WINDOW_MS);
  private joining = singleFlight(async (clean: string) => {
    if (!this.codeTries.take()) throw new OnlineError(`Too many tries. Wait ${this.codeTries.waitSeconds()} seconds and try again.`);
    const id = await this.gated(() => this.call<string | null>('pokejam_join_room', { p_code: clean }));
    if (!id) throw new OnlineError('room not found');
    return this.matchInfo(id);
  }, (clean) => clean);

  private allow(queue: Queue) {
    if (!this.queues.includes(queue)) throw new OnlineError(`${queue} online play is not enabled`);
  }

  /** Sets my trainer name; returns the name the server kept (a name it doesn't allow becomes "Trainer"). */
  async setName(name: string): Promise<string> {
    const want = name.trim().slice(0, 40) || 'Trainer';
    // Already set to this name on this account: no request (every Social action used to repeat it).
    return this.lastName?.want === want ? this.lastName.kept : this.naming(want);
  }

  /** My rating as the server holds it (my profile row; nothing here is computed on the client). */
  async myRank(): Promise<ServerRank> {
    if (!MODE_RANKED) throw new OnlineError('Ranked is not available');
    return parseProfile(await this.call('pokejam_ensure_profile', { p_name: null }));
  }

  /** My Season 1 rank (pokejam_ranked_me): season, placements, points, shield. Null if the server answers with nothing usable. */
  async rankedMe(): Promise<RankedMe | null> {
    if (!MODE_RANKED) throw new OnlineError('Ranked is not available');
    return parseMe(await this.call('pokejam_ranked_me'));
  }

  /** Both players' public rank for a Ranked match's name cards. Fails soft: any error (e.g. the server lacks the function) gives {}. */
  async matchRanks(matchId: string, side: 0 | 1): Promise<{ me?: BadgeRank; opp?: BadgeRank }> {
    if (!MODE_RANKED) return {};
    try {
      return parseMatchRanks(await this.call('pokejam_match_ranks', { p_match: matchId }), side);
    } catch {
      return {};
    }
  }

  /** My username and when I may change it (null = now). A guest, or a player who hasn't picked, has none. */
  async myUsername(): Promise<{ username: string | null; nextChangeAt: string | null }> {
    const r = await this.call<{ username?: string | null; next_change_at?: string | null } | null>('pokejam_my_username');
    return { username: typeof r?.username === 'string' ? r.username : null, nextChangeAt: typeof r?.next_change_at === 'string' ? r.next_change_at : null };
  }

  /** Pick or change my username. Throws an OnlineError with player-facing text if the server refuses it. */
  async setUsername(name: string): Promise<string> {
    try {
      const r = await this.call<{ username: string }>('pokejam_set_username', { p_name: name });
      return r.username;
    } catch (e) {
      const text = serverNameError((e as Error).message);
      if (text) throw new OnlineError(text);
      throw e;
    }
  }

  /** Who is in a match, from my side. */
  async matchInfo(id: string): Promise<OnlineMatch> {
    const m = await this.call<{
      id: string; queue: Queue; host: string; guest: string | null; host_name: string; guest_name: string | null; seed: number | null; quarter_len: number | null;
      host_key?: string | null; guest_key?: string | null; host_roster?: number[] | null; guest_roster?: number[] | null; status?: string;
    } | null>('pokejam_match_info', { p_match: id }, { retries: POLL_RETRIES });
    if (!m || !m.guest) throw new OnlineError('match not found');
    if (m.seed === null || m.seed === undefined) throw new OnlineError('This match was made by an older server. Refresh to update.');
    const side: 0 | 1 = m.host === this.userId ? 0 : 1;
    let opp = side === 0 ? { id: m.guest, name: m.guest_name ?? 'Trainer' } : { id: m.host, name: m.host_name };
    let me = side === 0 ? m.host_name : m.guest_name ?? 'Trainer';
    if (m.queue === 'ranked') {
      // Ranked shows usernames, not team names or ids; a player without one reads as "Player".
      const u = await this.call<{ host?: string | null; guest?: string | null } | null>('pokejam_match_usernames', { p_match: id }).catch(() => null);
      me = displayName(side === 0 ? u?.host : u?.guest);
      opp = { ...opp, name: displayName(side === 0 ? u?.guest : u?.host) };
    }
    return {
      id: m.id, queue: m.queue, side, me: { id: this.userId, name: me }, opponent: { ...opp, mmr: 1000, simulated: false },
      game: {
        seed: Number(m.seed) >>> 0, quarterLen: m.quarter_len === 60 ? 60 : 120,
        rosters: m.host_roster?.length === 5 && m.guest_roster?.length === 5 ? [m.host_roster, m.guest_roster] : null,
      },
      keys: [m.host_key ?? null, m.guest_key ?? null],
      status: m.status,
    };
  }

  /** The match's status as the server has it ('active', 'void', 'done'), or null if it isn't mine. */
  async matchStatus(id: string): Promise<string | null> {
    const s = await this.call<{ status?: string } | null>('pokejam_match_status', { p_match: id }, { retries: POLL_RETRIES });
    return s?.status ?? null;
  }

  /**
   * The server handed me a match. If the search (or room) was cancelled meanwhile, the match is left on the server, so
   * the other player isn't kept waiting, and this throws an AbortError: a cancelled search never starts a match.
   */
  private async claim(id: string, signal?: AbortSignal): Promise<OnlineMatch> {
    if (!signal?.aborted) {
      const m = await this.matchInfo(id);
      if (!signal?.aborted) return this.inMatch(m);
    }
    await this.call('pokejam_leave_match', { p_match: id }).catch(() => {});
    throw aborted();
  }

  /** The Social draft as I see it (the server starts it on the first look, and settles any picks whose time ran out). */
  draftState(matchId: string): Promise<DraftView> {
    return this.call<DraftView>('pokejam_draft_state', { p_match: matchId }, { retries: POLL_RETRIES });
  }

  /** Make my draft pick; the server checks it's my turn, it's free, and I still need its position. */
  draftPick(matchId: string, dex: number): Promise<DraftView> {
    return this.call<DraftView>('pokejam_draft_pick', { p_match: matchId, p_dex: dex });
  }

  /** Register my evidence key on the match row (once). False if a different key is already there. */
  registerKey(matchId: string, publicKey: string): Promise<boolean> {
    return this.call<boolean>('pokejam_register_key', { p_match: matchId, p_key: publicKey });
  }

  /** Upload my evidence after the game (evidence.ts pack()). False if it was already uploaded. */
  submitEvidence(matchId: string, packed: string): Promise<boolean> {
    return this.call<boolean>('pokejam_submit_evidence', { p_match: matchId, p_evidence: packed });
  }

  /**
   * Quick match: polls the queue until paired or `signal` aborts (then leaves the queue). Every poll is the server's
   * heartbeat for my queue row. Cancelled at any point, even with a request in flight, it never returns a match.
   */
  async quickMatch(queue: Queue, signal?: AbortSignal): Promise<OnlineMatch> {
    this.allow(queue);
    if (MODE_RANKED && queue === 'ranked') this.rankBefore = await this.myRank();
    // Gets leaving on page exit ready (warm). Before searching, leaving the queue is a no-op apart from calling off a
    // match made for me that I never opened, which is stale by now; awaited, so it can't land after a new pairing.
    await this.warm('pokejam_leave_queue');
    try {
      // The pass is checked before the first search; later polls only re-check if the server refuses.
      for (let first = true; ; first = false) {
        stopIfAborted(signal);
        const id = await this.gated(() => {
          stopIfAborted(signal); // the human check can take a while
          return this.call<string | null>('pokejam_find_match', { p_queue: queue }, { retries: POLL_RETRIES, signal });
        }, first);
        if (id) return await this.claim(id, signal);
        await sleep(jitter(POLL_MS), signal);
      }
    } catch (e) {
      if (signal?.aborted) await this.call('pokejam_leave_queue').catch(() => {});
      const wait = queue === 'ranked' ? cooldownSeconds((e as Error).message ?? '') : null;
      if (wait !== null) throw new RankedCooldownError(wait, (e as OnlineError).code, (e as OnlineError).status);
      throw e;
    }
  }

  /** Play a friend: make a room (1- or 2-minute quarters) and get its 6-character code. */
  async createRoom(quarterLen = 120): Promise<string> {
    const code = await this.roomMaking(quarterLen <= 60 ? 60 : 120);
    void this.warm('pokejam_close_room', { p_code: NO_ROOM }); // for closeRoomOnExit
    return code;
  }

  /** Host: give up on a room nobody has joined yet. */
  async closeRoom(code: string) {
    await this.call('pokejam_close_room', { p_code: code }).catch(() => {});
  }

  /** Host: the page is going away; close the room with a request that outlives it. */
  closeRoomOnExit(code: string) {
    this.beacon('pokejam_close_room', { p_code: code });
  }

  /** Host: has my friend joined (the match id), is the room still open (null), or is it over (RoomGoneError)? */
  private async roomState(code: string, signal?: AbortSignal): Promise<string | null> {
    if (!this.oldRoomPoll) {
      try {
        const r = await this.call<{ match?: string | null; status?: string } | null>('pokejam_room_state', { p_code: code }, { retries: POLL_RETRIES, signal });
        if (r?.match) return r.match;
        if (r?.status === 'waiting') return null;
        throw new RoomGoneError(r?.status === 'expired' ? 'Nobody joined this room in 30 minutes, so it closed. Make a new room to play.'
          : 'This room is closed: your friend left before the game started. Make a new room to play.');
      } catch (e) {
        // A server without pokejam_room_state (migration 20261104 not applied yet): poll the old way.
        if (!missingRpc(e)) throw e;
        this.oldRoomPoll = true;
      }
    }
    return this.call<string | null>('pokejam_room_match', { p_code: code }, { retries: POLL_RETRIES, signal });
  }
  private oldRoomPoll = false;

  /** Host: wait for a friend to join the room. Cancelled at any point, it never returns a match. */
  async waitForFriend(code: string, signal?: AbortSignal): Promise<OnlineMatch> {
    for (;;) {
      stopIfAborted(signal);
      const id = await this.roomState(code, signal);
      if (id) return this.claim(id, signal);
      await sleep(jitter(POLL_MS), signal);
    }
  }

  /** Join a friend's room. If `signal` aborts before the join comes back, the match is left and this throws AbortError. */
  async joinRoom(code: string, signal?: AbortSignal): Promise<OnlineMatch> {
    const clean = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (clean.length !== 6) throw new OnlineError('Room codes are 6 letters and numbers.');
    stopIfAborted(signal);
    const m = await this.joining(clean);
    if (signal?.aborted) {
      await this.call('pokejam_leave_match', { p_match: m.id }).catch(() => {});
      throw aborted();
    }
    return this.inMatch(m);
  }

  /** A match is starting (draft, then game): get its page-exit leave ready to be delivered. */
  private inMatch(m: OnlineMatch): OnlineMatch {
    void this.warm('pokejam_leave_match', { p_match: NO_MATCH });
    return m;
  }

  /** Report the other player in a match. False if this match was already reported. A double-tap sends one request. */
  report(matchId: string, reason: ReportReason, note?: string): Promise<boolean> {
    return this.reporting(matchId, reason, note);
  }

  /** Block the other player in a match: you won't be matched with them again. */
  async block(matchId: string) {
    await this.blocking(matchId);
  }

  /** Leave a match or room without a result. */
  async leave(matchId: string | null) {
    await this.call('pokejam_leave_queue').catch(() => {});
    if (matchId) await this.call('pokejam_leave_match', { p_match: matchId }).catch(() => {});
  }

  /**
   * The page is going away (closed, or hidden mid-search): leave the queue, or this match, with a request that
   * outlives the page. Best effort; the server's heartbeats and cleanup cover what doesn't arrive. In a match I'm no
   * longer queued (pairing took me out), so only the match is left: one request, already warmed up when it started.
   */
  leaveOnExit(matchId: string | null) {
    if (matchId) void this.beacon('pokejam_leave_match', { p_match: matchId });
    else void this.beacon('pokejam_leave_queue');
  }

  private noHeartbeat = false;
  /**
   * In-game heartbeat (migration 20261106): tells the server I'm still playing. A finished-draft match where both
   * players have sent one and then both stopped is called off by the cleanup. A server without it: stop asking.
   */
  async alive(matchId: string): Promise<void> {
    if (this.noHeartbeat) return;
    try {
      await this.call('pokejam_match_alive', { p_match: matchId });
    } catch (e) {
      if (missingRpc(e)) this.noHeartbeat = true;
    }
  }

  /** MatchService: a quick match with no way to cancel (the Social screen uses quickMatch directly). */
  async findMatch(queue: Queue): Promise<Opponent> {
    const m = await this.quickMatch(queue);
    return { ...m.opponent, matchId: m.id, mySide: m.side } as OnlineOpponent;
  }

  /**
   * Both players report who won. Social results are recorded but never rated: no rank comes back, whatever the
   * server sends, and the server itself never rates a Social match. Ranked ratings come from the server only.
   */
  async reportResult(queue: Queue, opp: Opponent, result: MatchResult): Promise<ReportOutcome> {
    this.allow(queue);
    const o = opp as Partial<OnlineOpponent>;
    if (!o.matchId || (o.mySide !== 0 && o.mySide !== 1)) throw new OnlineError('not an online match');
    const hostWon = o.mySide === 0 ? result.won : !result.won;
    // Ranked: the final score goes first. The server only uses it once both players sent the same one (else a photo finish).
    if (MODE_RANKED && queue === 'ranked') await this.reportScore(o.matchId, o.mySide, result.score);
    const res = await this.call<{ status?: string; rank?: unknown } | null>('pokejam_report_result', { p_match: o.matchId, p_host_won: hostWon });
    if (!MODE_RANKED || queue !== 'ranked') return { queue };
    // Ranked: Season 1 sends my rank change with the result; an older server doesn't, then the rating is read back from my profile.
    if (res?.status === 'done') return this.rated(parseRankResult(res.rank));
    if (res?.status === 'void') return { queue, status: 'void' };
    return { queue, status: 'pending', later: this.settle(o.matchId).catch((): ReportOutcome => ({ queue, status: 'pending' })) };
  }

  /** The other player hasn't reported yet: poll the match until the server has rated it, or give up. */
  private async settle(matchId: string): Promise<ReportOutcome> {
    const until = Date.now() + SETTLE_MS;
    for (;;) {
      await sleep(jitter(POLL_MS));
      const s = await this.call<{ status?: string } | null>('pokejam_match_status', { p_match: matchId }, { retries: POLL_RETRIES });
      if (s?.status === 'done') return this.rated(); // (the result screen reads the numbers in PR 3: pokejam_ranked_match_result)
      if (!s || s.status === 'void') return { queue: 'ranked', status: 'void' };
      if (Date.now() >= until) return { queue: 'ranked', status: 'pending' };
    }
  }

  /** My final score for a Ranked match (host score first), before the result. Best effort: a refusal or an older server just means no margin. */
  private async reportScore(matchId: string, side: 0 | 1, score: [number, number]) {
    const [mine, theirs] = score;
    try {
      await this.call('pokejam_ranked_report_score', { p_match: matchId, p_host_score: side === 0 ? mine : theirs, p_guest_score: side === 0 ? theirs : mine });
    } catch { /* the result still counts, as a photo finish */ }
  }

  /**
   * I'm the stayer: the other player's heartbeat went quiet. Asks the server to settle the match (it forfeits them once
   * they've been silent for 45 s) every few seconds for up to `forMs`, keeping my own heartbeat going meanwhile. Resolves
   * with the outcome once settled, or null if it never was (a lag spike: nothing is penalised, the sweep decides later).
   */
  async claimForfeit(matchId: string, forMs = 70_000): Promise<ReportOutcome | null> {
    if (!MODE_RANKED) return null;
    const until = Date.now() + forMs;
    while (Date.now() < until) {
      void this.alive(matchId);
      const r = await this.call<{ status?: string; rank?: unknown } | null>('pokejam_ranked_forfeit', { p_match: matchId }).catch(() => null);
      if (r?.status === 'done') return this.rated(parseRankResult(r.rank));
      if (r && r.status !== 'active') return { queue: 'ranked', status: 'void' };
      await sleep(jitter(5000));
    }
    return null;
  }

  /** The server has rated the match: read my new rating (Season 1: the answer I was given; older server: my profile). */
  private async rated(result: RankedResult | null = null): Promise<ReportOutcome> {
    if (!MODE_RANKED) return { queue: 'ranked', status: 'void' };
    if (result) {
      const me = await this.rankedMe().catch(() => null); // the shield state after the match; the screen copes without it
      return { queue: 'ranked', status: 'done', result, me: me ?? undefined };
    }
    const before = this.rankBefore;
    const after = await this.myRank();
    this.rankBefore = after;
    return { queue: 'ranked', status: 'done', rank: before && counted(before, after) ? outcomeBetween(before, after) : undefined };
  }
}
