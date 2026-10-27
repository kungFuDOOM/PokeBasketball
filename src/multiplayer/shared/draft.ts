// The Social quick draft (#28), the client's side. The server runs it (migration 20261101: pokejam_draft_state,
// pokejam_draft_pick), so this only reads what the server says and asks it to record a pick.
import { POSITIONS, type Pos } from '../../data/pokemon';

export interface DraftPick { side: 0 | 1; dex: number; pos: Pos; auto: boolean }

/** The draft as one player sees it (pokejam_draft_view). */
export interface DraftView {
  pool: { dex: number; pos: Pos }[];
  first: 0 | 1;
  picks: DraftPick[];
  done: boolean;
  /** My side: 0 = host, 1 = guest. */
  me: 0 | 1;
  turn: number;
  on_turn: 0 | 1 | null;
  seconds_left: number;
  /** Seconds since the other player last checked in (null before they ever have). */
  opponent_seen_ago: number | null;
}

/** Ten picks: five each. */
export const DRAFT_PICKS = 10;
/** Seconds the server gives each pick (a random legal pick when it runs out). */
export const PICK_SECONDS = 12;
/** After this long without word from the other player, the draft is called off. */
export const GONE_AFTER = 25;

/** Who makes the i-th pick: snake order A B B A A B B A A B, the same rule as pokejam_draft_side on the server. */
export function draftSide(first: 0 | 1, i: number): 0 | 1 {
  return (first ^ [0, 1, 1, 0][i % 4]) as 0 | 1;
}

/** A side's picks by position (missing positions are still to pick). */
export function teamOf(v: Pick<DraftView, 'picks'>, side: 0 | 1): Partial<Record<Pos, number>> {
  const t: Partial<Record<Pos, number>> = {};
  for (const p of v.picks) if (p.side === side) t[p.pos] = p.dex;
  return t;
}

/** Can I pick this Pokémon right now? It's my turn, nobody has it, and I still need its position. */
export function canPick(v: DraftView, dex: number): boolean {
  if (v.done || v.on_turn !== v.me) return false;
  const m = v.pool.find((x) => x.dex === dex);
  if (!m || v.picks.some((p) => p.dex === dex)) return false;
  return teamOf(v, v.me)[m.pos] === undefined;
}

/** Both finished rosters as Pokédex numbers in position order (host, guest), once the draft is done. */
export function draftedRosters(v: Pick<DraftView, 'picks'>): [number[], number[]] | null {
  const out = ([0, 1] as const).map((s) => { const t = teamOf(v, s); return POSITIONS.map((p) => t[p]); });
  return out.every((r) => r.every((d) => d !== undefined)) ? (out as [number[], number[]]) : null;
}
