// The Pack Battles judge: who won a paid match, from both players' signed evidence and the server's match row.
//
// Shared by the pokejam-pack-judge Edge Function (bundled for Deno by scripts/build-pack-judge.mjs) and the tests.
// Nothing an upload says about the game is trusted: the setup (seed, quarter length, both teams) and both keys come
// from the match row, exactly as both players built them (setupFor), and only the uploads' signed inputs are used.
// judge() then replays the match from those inputs (winnerCheck.ts).

import { unpack } from './evidence';
import { MIN_DELAY } from './lockstep';
import { setupFor } from './netplay';
import type { OnlineMatch } from './onlineMatchService';
import { judge, MAX_TICKS, type SignedInputs, type SignedResign, type Verdict } from './winnerCheck';

/** A battle ready to judge, as pokejam_pack_due_battles returns it. */
export interface DueBattle {
  match_id: string;
  tier: string;
  seed: number | string;
  quarter_len: number;
  host: string;
  guest: string;
  host_key: string | null;
  guest_key: string | null;
  host_name: string;
  guest_name: string;
  /** Each player's upload (evidence.ts pack()), as stored. */
  uploads: string[];
  /** Which players uploaded (from the server's rows, so an upload can't claim to be the other player's). */
  host_uploaded: boolean;
  guest_uploaded: boolean;
}

/** What pokejam_pack_settle does with it. */
export interface Settlement {
  /** 'host' or 'guest' won the pack; 'void' refunds both; 'review' holds it for a person (a disconnect, or bad evidence). */
  result: 'host' | 'guest' | 'void' | 'review';
  /** The judge's status, or why there was nothing to judge. */
  outcome: string;
  note: string;
  verdict?: Verdict;
}

/** The match as the host saw it: setupFor gives both players (and so the judge) the same game. */
function hostView(b: DueBattle): OnlineMatch {
  return {
    id: b.match_id, queue: 'pack', side: 0,
    me: { id: b.host, name: b.host_name },
    opponent: { id: b.guest, name: b.guest_name, mmr: 1000, simulated: false },
    game: { seed: Number(b.seed) >>> 0, quarterLen: b.quarter_len, rosters: null },
    keys: [b.host_key, b.guest_key],
  };
}

const side = (s: 0 | 1) => (s === 0 ? 'host' : 'guest');

const NAMES = ['host', 'guest'] as const;

/**
 * Decide a battle. kungFuDOOM's rule for a game that stops early: the player who quit forfeits, and a player who
 * says it was a real disconnect contacts support, who look at both uploads (each carries its connection log). In
 * order:
 *   - No keys on the match, no uploads at all, or not one tick played with both players' inputs: the game never got
 *     going. Void, both refunded (nobody can know they're losing before tip-off).
 *   - Uploads that can't be read: held for a person.
 *   - 'final': the winner at the buzzer wins. A tie: void.
 *   - 'forfeit': a player signed two versions of the same input. The other player wins.
 *   - 'incomplete' (the inputs stop before the buzzer):
 *       - one player signed a resignation (the Leave button, or closing the page): they forfeit;
 *       - otherwise, one player never uploaded: they left without a word (closed the app, or lost their connection
 *         for good), and forfeit;
 *       - otherwise both stayed to the end and uploaded, each saying the other went quiet: a real disconnect, or one
 *         player cutting the link to dodge a loss. Their signed inputs can't tell those apart, so a person decides
 *         from the connection logs. Nothing moves, and nobody wins by cutting the link.
 *     The 45-minute hard stop is held for a person too.
 *   - 'invalid': the evidence can't be judged. Held for a person: nothing moves.
 */
export async function judgeBattle(b: DueBattle): Promise<Settlement> {
  if (!b.host_key || !b.guest_key) return { result: 'void', outcome: 'no-game', note: 'The game never started (no keys registered).' };
  if (!b.uploads.length) return { result: 'void', outcome: 'no-game', note: 'Neither player uploaded anything: the game never got going.' };
  const inputs: SignedInputs[] = [];
  const resigns: SignedResign[] = [];
  const notes: string[] = [];
  for (const u of b.uploads) {
    try {
      const e = await unpack(u);
      inputs.push(...(e.inputs ?? []));
      resigns.push(...(Array.isArray(e.resigns) ? e.resigns : []));
    } catch (e) {
      notes.push(`an upload could not be read (${(e as Error).message})`);
    }
  }
  if (!inputs.length) {
    return notes.length
      ? { result: 'review', outcome: 'no-evidence', note: ['Nothing signed to judge.', ...notes].join(' ') }
      : { result: 'void', outcome: 'no-game', note: 'Nobody signed a single input: the game never got going.' };
  }
  const v = await judge({ setup: setupFor(hostView(b)), keys: [b.host_key, b.guest_key], inputs, applied: [], lockstep: { emptyTicks: MIN_DELAY }, resigns });
  const note = (...extra: string[]) => [...extra, `${v.score[0]}-${v.score[1]} after ${v.ticks} ticks.`, ...notes, ...v.notes].join(' ');
  if (v.status === 'final') {
    return v.winner === null ? { result: 'void', outcome: 'tie', note: note(), verdict: v } : { result: side(v.winner), outcome: 'final', note: note(), verdict: v };
  }
  if (v.status === 'forfeit' && v.winner !== null) return { result: side(v.winner), outcome: 'forfeit', note: note(), verdict: v };
  if (v.status === 'incomplete') {
    if (v.ticks <= MIN_DELAY) return { result: 'void', outcome: 'no-game', note: note('Not one tick was played with both players\' inputs.'), verdict: v };
    if (v.ticks >= MAX_TICKS) return { result: 'review', outcome: 'hard-stop', note: note(), verdict: v };
    if (v.resigned !== undefined) {
      const q = v.resigned;
      return { result: side((1 - q) as 0 | 1), outcome: 'resigned', note: note(`${NAMES[q]} (${q ? b.guest_name : b.host_name}) left the game and forfeits.`), verdict: v };
    }
    if (b.host_uploaded !== b.guest_uploaded) {
      const q = b.host_uploaded ? 1 : 0;
      return { result: side((1 - q) as 0 | 1), outcome: 'abandoned', note: note(`${NAMES[q]} (${q ? b.guest_name : b.host_name}) went quiet and never uploaded, so forfeits.`), verdict: v };
    }
    return { result: 'review', outcome: 'disconnect', note: note('Both players stayed and uploaded: a person checks both connection logs.'), verdict: v };
  }
  return { result: 'review', outcome: v.status, note: note(), verdict: v };
}
