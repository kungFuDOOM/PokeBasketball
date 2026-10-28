// Matchmaking / network seam. Phase 1 ships LocalMockMatchService (CPU opponent, local storage).
// Phase 2 swaps in a server-backed implementation (see docs/multiplayer.md) without touching the UI.

export type Queue = 'social' | 'ranked';

export interface Opponent {
  id: string;
  name: string;
  mmr: number;
  /** True for the phase 1 CPU stand-in. */
  simulated: boolean;
}

export interface MatchResult {
  won: boolean;
  score: [number, number];
  /** ENGINE_VERSION the game ran on, so a replay or dispute is judged by the same rules. */
  engineVersion: number;
  /** The game's seed (absent for a simulated result, where no game was played). */
  seed?: number;
}

/** Where a mode keeps ratings. Ranked supplies one; Social has none, so it can never change rank. */
export interface RatingStore<O = unknown> {
  mmr(): number;
  apply(oppMmr: number, won: boolean): O;
}

export interface ReportOutcome<O = unknown> {
  queue: Queue;
  /** Ranked only: the rating store's outcome. */
  rank?: O;
  /** Online Ranked: where the match stands on the server. `pending` = waiting for the other player's report. */
  status?: 'done' | 'pending' | 'void';
  /** Online Ranked, when `pending`: resolves with the final outcome once the server has rated the match (or gives up). */
  later?: Promise<ReportOutcome<O>>;
}

export interface MatchService {
  findMatch(queue: Queue): Promise<Opponent>;
  reportResult(queue: Queue, opp: Opponent, result: MatchResult): Promise<ReportOutcome>;
}

const NAMES = ['Ace Trainer Rio', 'Hiker Bo', 'Youngster Jin', 'Lass Mei', 'Cool Trainer Ash', 'Swimmer Kai', 'Ranger Lu', 'Psychic Ida'];

/** Phase 1 stand-in: simulated opponents, results stay on this device. */
export class LocalMockMatchService implements MatchService {
  constructor(private ratings: RatingStore | null = null) {}

  async findMatch(queue: Queue): Promise<Opponent> {
    const base = queue === 'ranked' && this.ratings ? this.ratings.mmr() : 1000;
    const mmr = Math.round(base + (Math.random() * 2 - 1) * 75); // nearby MMR
    await new Promise((r) => setTimeout(r, 600 + Math.random() * 900)); // feel of a queue
    return { id: `cpu-${Date.now()}`, name: NAMES[Math.floor(Math.random() * NAMES.length)], mmr, simulated: true };
  }

  async reportResult(queue: Queue, opp: Opponent, result: MatchResult): Promise<ReportOutcome> {
    if (queue !== 'ranked' || !this.ratings) return { queue };
    return { queue, rank: this.ratings.apply(opp.mmr, result.won) };
  }
}
