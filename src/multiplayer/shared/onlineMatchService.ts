// Server-backed MatchService (Supabase). Every write goes through the pokejam_* SECURITY DEFINER RPCs;
// clients can only read their own rows. See supabase/migrations/.
import { MODE_RANKED } from '../../config/features';
import type { DraftView } from './draft';
import { counted, outcomeBetween, parseProfile, type ServerRank } from '../ranked/serverRank';
import type { MatchResult, MatchService, Opponent, Queue, ReportOutcome } from './matchService';

/** The slice of the Supabase client this service uses (lets tests pass a fake). */
export interface RpcClient {
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
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
}

/** Why a player reports an opponent (the server's list). */
export type ReportReason = 'name' | 'cheating' | 'quitting' | 'other';

export interface OnlineOpponent extends Opponent {
  matchId: string;
  /** The side I (not the opponent) play: 0 = host, 1 = guest. */
  mySide: 0 | 1;
}

export class OnlineError extends Error {}

const POLL_MS = 2000;
/** After reporting a Ranked result, wait this long for the other player's report before giving up on showing the rating change. */
const SETTLE_MS = 30_000;
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('aborted', 'AbortError')); }, { once: true });
});

export class SupabaseMatchService implements MatchService {
  /**
   * @param queues the queues this service may play. Social builds pass ['social'] only, so this code path can
   * never submit a rated result (the server enforces the same: Social matches never reach the rating RPC).
   */
  constructor(private db: RpcClient, private userId: string, private queues: readonly Queue[] = ['social'],
    /** Runs the human check when the server asks for one (human.ts); `force` after a "human check needed" refusal. */
    private human: (force: boolean) => Promise<void> = async () => {}) {}

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

  private async call<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.db.rpc(fn, args);
    if (error) throw new OnlineError(error.message);
    return data as T;
  }

  private allow(queue: Queue) {
    if (!this.queues.includes(queue)) throw new OnlineError(`${queue} online play is not enabled`);
  }

  /** Sets my trainer name; returns the name the server kept (a name it doesn't allow becomes "Trainer"). */
  async setName(name: string): Promise<string> {
    const p = await this.call<{ trainer_name?: string } | null>('pokejam_ensure_profile', { p_name: name.trim().slice(0, 40) || 'Trainer' });
    return p?.trainer_name ?? 'Trainer';
  }

  /** My rating as the server holds it (my profile row; nothing here is computed on the client). */
  async myRank(): Promise<ServerRank> {
    if (!MODE_RANKED) throw new OnlineError('Ranked is not available');
    return parseProfile(await this.call('pokejam_ensure_profile', { p_name: null }));
  }

  /** Who is in a match, from my side. */
  async matchInfo(id: string): Promise<OnlineMatch> {
    const m = await this.call<{
      id: string; queue: Queue; host: string; guest: string | null; host_name: string; guest_name: string | null; seed: number | null; quarter_len: number | null;
      host_key?: string | null; guest_key?: string | null; host_roster?: number[] | null; guest_roster?: number[] | null;
    } | null>('pokejam_match_info', { p_match: id });
    if (!m || !m.guest) throw new OnlineError('match not found');
    if (m.seed === null || m.seed === undefined) throw new OnlineError('This match was made by an older server. Refresh to update.');
    const side: 0 | 1 = m.host === this.userId ? 0 : 1;
    const opp = side === 0 ? { id: m.guest, name: m.guest_name ?? 'Trainer' } : { id: m.host, name: m.host_name };
    const me = side === 0 ? m.host_name : m.guest_name ?? 'Trainer';
    return {
      id: m.id, queue: m.queue, side, me: { id: this.userId, name: me }, opponent: { ...opp, mmr: 1000, simulated: false },
      game: {
        seed: Number(m.seed) >>> 0, quarterLen: m.quarter_len === 60 ? 60 : 120,
        rosters: m.host_roster?.length === 5 && m.guest_roster?.length === 5 ? [m.host_roster, m.guest_roster] : null,
      },
      keys: [m.host_key ?? null, m.guest_key ?? null],
    };
  }

  /** The Social draft as I see it (the server starts it on the first look, and settles any picks whose time ran out). */
  draftState(matchId: string): Promise<DraftView> {
    return this.call<DraftView>('pokejam_draft_state', { p_match: matchId });
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

  /** Quick match: polls the queue until paired or `signal` aborts (then leaves the queue). */
  async quickMatch(queue: Queue, signal?: AbortSignal): Promise<OnlineMatch> {
    this.allow(queue);
    if (MODE_RANKED && queue === 'ranked') this.rankBefore = await this.myRank();
    try {
      // The pass is checked before the first search; later polls only re-check if the server refuses.
      for (let first = true; ; first = false) {
        const id = await this.gated(() => this.call<string | null>('pokejam_find_match', { p_queue: queue }), first);
        if (id) return await this.matchInfo(id);
        await sleep(POLL_MS, signal);
      }
    } catch (e) {
      if (signal?.aborted) await this.call('pokejam_leave_queue').catch(() => {});
      throw e;
    }
  }

  /** Play a friend: make a room (1- or 2-minute quarters) and get its 6-character code. */
  createRoom(quarterLen = 120): Promise<string> {
    return this.gated(() => this.call<string>('pokejam_create_room', { p_quarter_len: quarterLen <= 60 ? 60 : 120 }));
  }

  /** Host: give up on a room nobody has joined yet. */
  async closeRoom(code: string) {
    await this.call('pokejam_close_room', { p_code: code }).catch(() => {});
  }

  /** Host: wait for a friend to join the room. */
  async waitForFriend(code: string, signal?: AbortSignal): Promise<OnlineMatch> {
    for (;;) {
      const id = await this.call<string | null>('pokejam_room_match', { p_code: code });
      if (id) return this.matchInfo(id);
      await sleep(POLL_MS, signal);
    }
  }

  async joinRoom(code: string): Promise<OnlineMatch> {
    const clean = code.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (clean.length !== 6) throw new OnlineError('Room codes are 6 letters and numbers.');
    const id = await this.gated(() => this.call<string | null>('pokejam_join_room', { p_code: clean }));
    if (!id) throw new OnlineError('room not found');
    return this.matchInfo(id);
  }

  /** Report the other player in a match. False if this match was already reported. */
  report(matchId: string, reason: ReportReason, note?: string): Promise<boolean> {
    return this.call<boolean>('pokejam_report_player', { p_match: matchId, p_reason: reason, p_note: note?.slice(0, 200) ?? null });
  }

  /** Block the other player in a match: you won't be matched with them again. */
  async block(matchId: string) {
    await this.call('pokejam_block_player', { p_match: matchId });
  }

  /** Leave a match or room without a result. */
  async leave(matchId: string | null) {
    await this.call('pokejam_leave_queue').catch(() => {});
    if (matchId) await this.call('pokejam_leave_match', { p_match: matchId }).catch(() => {});
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
    const res = await this.call<{ status?: string } | null>('pokejam_report_result', { p_match: o.matchId, p_host_won: hostWon });
    if (!MODE_RANKED || queue !== 'ranked') return { queue };
    // Ranked: the rating is only ever read back from my server profile, after the server has rated the match.
    if (res?.status === 'done') return this.rated();
    if (res?.status === 'void') return { queue, status: 'void' };
    return { queue, status: 'pending', later: this.settle(o.matchId).catch((): ReportOutcome => ({ queue, status: 'pending' })) };
  }

  /** The other player hasn't reported yet: poll the match until the server has rated it, or give up. */
  private async settle(matchId: string): Promise<ReportOutcome> {
    const until = Date.now() + SETTLE_MS;
    for (;;) {
      await sleep(POLL_MS);
      const s = await this.call<{ status?: string } | null>('pokejam_match_status', { p_match: matchId });
      if (s?.status === 'done') return this.rated();
      if (!s || s.status === 'void') return { queue: 'ranked', status: 'void' };
      if (Date.now() >= until) return { queue: 'ranked', status: 'pending' };
    }
  }

  /** The server has rated the match: read my new rating from my profile. */
  private async rated(): Promise<ReportOutcome> {
    if (!MODE_RANKED) return { queue: 'ranked', status: 'void' };
    const before = this.rankBefore;
    const after = await this.myRank();
    this.rankBefore = after;
    return { queue: 'ranked', status: 'done', rank: before && counted(before, after) ? outcomeBetween(before, after) : undefined };
  }
}
