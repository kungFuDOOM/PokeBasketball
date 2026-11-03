// Weekly challenge and raffle entry maths. Pure: no DOM, no network.
// The SQL in supabase/migrations/20261210_pokejam_weekly_raffle.sql (pokejam_raffle_cfg_value,
// pokejam_raffle_score, pokejam_raffle_ticket) mirrors these numbers. supabase/tests/weekly-raffle.test.ts
// checks the two against each other. NET_VERSION is not involved.

/** Whole PJAM tokens (not raw units) per holder bonus entry. */
export const PJAM_PER_ENTRY = 1_000_000;
export const PJAM_MINT = 'GQe9QiBBV4G6bRUCxx2JgKrzT7G7RD17FJquBWgVpump';
/** postgres int4 max. Holder entries above this are clamped the same way in SQL. */
export const HOLDER_ENTRY_CAP = 2_147_483_647;
/** How a stored draw seed becomes a ticket. Bump it if the pick changes. */
export const DRAW_ALGORITHM = 'uint64be-mod-v1';

export interface RaffleConfig {
  offlineGames: number;
  onlineGames: number;
  social: number;
  rankSteps: number;
  pjamPerEntry: number;
  pjamMint: string;
  grindOnlinePerEntry: number;
  grindWinsPerEntry: number;
  bonusCap: number;
}

export const RAFFLE_DEFAULTS: RaffleConfig = {
  offlineGames: 3,
  onlineGames: 3,
  social: 1,
  rankSteps: 1,
  pjamPerEntry: PJAM_PER_ENTRY,
  pjamMint: PJAM_MINT,
  grindOnlinePerEntry: 10,
  grindWinsPerEntry: 3,
  bonusCap: 5,
};

const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Out of range becomes the default, same as pokejam_raffle_cfg_value. A typo must not silently shrink the challenge. */
const clampInt = (n: number, lo: number, hi: number, fallback: number) => {
  if (!Number.isInteger(n) || n < lo || n > hi) return fallback;
  return n;
};

/** Same bounds as pokejam_raffle_cfg_value. A missing or wild value falls back to the default. */
export function clampConfig(raw: Partial<Record<keyof RaffleConfig, unknown>> | null | undefined): RaffleConfig {
  const n = (v: unknown) => (typeof v === 'number' ? v : typeof v === 'string' && /^-?\d+$/.test(v) ? Number(v) : Number.NaN);
  const mint = typeof raw?.pjamMint === 'string' && MINT.test(raw.pjamMint) ? raw.pjamMint : RAFFLE_DEFAULTS.pjamMint;
  return {
    offlineGames: clampInt(n(raw?.offlineGames), 1, 100, RAFFLE_DEFAULTS.offlineGames),
    onlineGames: clampInt(n(raw?.onlineGames), 1, 100, RAFFLE_DEFAULTS.onlineGames),
    social: clampInt(n(raw?.social), 1, 20, RAFFLE_DEFAULTS.social),
    rankSteps: clampInt(n(raw?.rankSteps), 1, 24, RAFFLE_DEFAULTS.rankSteps),
    pjamPerEntry: clampInt(n(raw?.pjamPerEntry), 1, 1_000_000_000_000_000, RAFFLE_DEFAULTS.pjamPerEntry),
    pjamMint: mint,
    grindOnlinePerEntry: clampInt(n(raw?.grindOnlinePerEntry), 1, 100, RAFFLE_DEFAULTS.grindOnlinePerEntry),
    grindWinsPerEntry: clampInt(n(raw?.grindWinsPerEntry), 1, 100, RAFFLE_DEFAULTS.grindWinsPerEntry),
    bonusCap: clampInt(n(raw?.bonusCap), 0, 20, RAFFLE_DEFAULTS.bonusCap),
  };
}

/** The shape stored in pokejam_config under the key `raffle`. */
export function configToJson(cfg: RaffleConfig): Record<string, number | string> {
  return {
    offline_games: cfg.offlineGames,
    online_games: cfg.onlineGames,
    social: cfg.social,
    rank_steps: cfg.rankSteps,
    pjam_per_entry: cfg.pjamPerEntry,
    pjam_mint: cfg.pjamMint,
    grind_online_per_entry: cfg.grindOnlinePerEntry,
    grind_wins_per_entry: cfg.grindWinsPerEntry,
    bonus_cap: cfg.bonusCap,
  };
}

export function configFromJson(raw: Record<string, unknown> | null | undefined): RaffleConfig {
  return clampConfig({
    offlineGames: raw?.offline_games as number,
    onlineGames: raw?.online_games as number,
    social: raw?.social as number,
    rankSteps: raw?.rank_steps as number,
    pjamPerEntry: raw?.pjam_per_entry as number,
    pjamMint: raw?.pjam_mint as string,
    grindOnlinePerEntry: raw?.grind_online_per_entry as number,
    grindWinsPerEntry: raw?.grind_wins_per_entry as number,
    bonusCap: raw?.bonus_cap as number,
  });
}

export interface RaffleCounts {
  offline: number;
  online: number;
  onlineWins: number;
  socialMatches: number;
  shares: number;
  rankSteps: number;
  /** Already at Zenith, the top of the ladder, so there is no further rank to climb. */
  zenith: boolean;
}

export interface RaffleScore {
  base: boolean;
  grind: number;
  holder: number;
  bonus: number;
  total: number;
  socialHave: number;
  rankDone: boolean;
}

export const socialHave = (c: RaffleCounts) => c.socialMatches + c.shares;

export const rankDone = (c: RaffleCounts, cfg: RaffleConfig) => c.zenith || c.rankSteps >= cfg.rankSteps;

/** Extra online games past the base online challenge, and online wins, each gate one grind entry. */
export function grindEntries(c: RaffleCounts, cfg: RaffleConfig): number {
  const extra = Math.max(0, c.online - cfg.onlineGames);
  const fromGames = Math.floor(extra / cfg.grindOnlinePerEntry);
  const fromWins = Math.floor(Math.max(0, c.onlineWins) / cfg.grindWinsPerEntry);
  return Math.min(fromGames, fromWins);
}

/** 1 bonus entry per `pjamPerEntry` whole tokens. Dust below one token does not count. */
export function holderEntries(wholeTokens: bigint, cfg: RaffleConfig): number {
  if (wholeTokens <= 0n || cfg.pjamPerEntry <= 0) return 0;
  const n = wholeTokens / BigInt(cfg.pjamPerEntry);
  return n > BigInt(HOLDER_ENTRY_CAP) ? HOLDER_ENTRY_CAP : Number(n);
}

export function baseComplete(c: RaffleCounts, cfg: RaffleConfig): boolean {
  return c.offline >= cfg.offlineGames && c.online >= cfg.onlineGames && socialHave(c) >= cfg.social && rankDone(c, cfg);
}

/** Entries for one player. 0 unless every base challenge is done, then 1 plus up to `bonusCap` bonus entries. */
export function scoreRaffle(c: RaffleCounts, cfg: RaffleConfig, wholeTokens: bigint): RaffleScore {
  const grind = grindEntries(c, cfg);
  const holder = holderEntries(wholeTokens, cfg);
  const bonus = Math.min(cfg.bonusCap, Math.max(0, grind) + Math.max(0, holder));
  const base = baseComplete(c, cfg);
  return { base, grind, holder, bonus, total: base ? 1 + bonus : 0, socialHave: socialHave(c), rankDone: rankDone(c, cfg) };
}

/** First 8 bytes of the seed, unsigned big-endian, modulo total. total must be > 0. */
export function raffleTicket(seed: Uint8Array, total: bigint): bigint {
  if (seed.length < 8) throw new Error('seed');
  if (total <= 0n) throw new Error('total');
  let n = 0n;
  for (let i = 0; i < 8; i++) n = (n << 8n) + BigInt(seed[i]!);
  return n % total;
}

export interface WeightedEntrant { id: string; entries: number }

/**
 * Weighted pick. Entrants are sorted by id (canonical UUID text order, same as Postgres uuid order),
 * then the ticket walks the weights. A player with 4 entries is four tickets wide.
 */
export function pickWinner(entrants: readonly WeightedEntrant[], seed: Uint8Array): string | null {
  const live = entrants.filter((e) => e.entries > 0).slice().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const total = live.reduce((n, e) => n + e.entries, 0);
  if (total <= 0) return null;
  let acc = 0n;
  const ticket = raffleTicket(seed, BigInt(total));
  for (const e of live) {
    acc += BigInt(e.entries);
    if (ticket < acc) return e.id;
  }
  return live[live.length - 1]?.id ?? null;
}

/** Only a game the player actually played counts. Sim and watch do not. */
export const creditsOffline = (resolution: string) => resolution === 'played';
