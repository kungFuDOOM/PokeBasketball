// Loads weekly-challenge progress on demand and remembers it briefly. The screen and the end of a game call
// load(); nothing polls. Signed-in notes are one row each. The server counts the rows.
import { ONLINE_CONFIGURED, supabase } from '../multiplayer/shared/supabase';
import type { OfflineMode } from '../telemetry/offlineStats';

export interface ChallengeBit { have: number; need: number; done: boolean; zenith?: boolean }

export interface RaffleScore {
  base: boolean;
  grind: number;
  holder: number;
  bonus: number;
  total: number;
  social_have: number;
  rank_done: boolean;
  offline: ChallengeBit;
  online: ChallengeBit;
  social: ChallengeBit;
  rank: ChallengeBit;
}

export interface RaffleCounts {
  offline: number;
  online: number;
  online_wins: number;
  social_matches: number;
  shares: number;
  rank_steps: number;
  zenith: boolean;
}

export interface RaffleMe {
  signed_in: boolean;
  week_start: string;
  resets_at: string;
  config: Record<string, number | string>;
  counts: RaffleCounts;
  score: RaffleScore;
  wallet: string | null;
  last_draw: { week_start: string; won: boolean; entries: number; total: number } | null;
}

/** A force-refresh inside this window reuses the fetch that just finished (the screen opening after a game). */
export const FRESH_MS = 5_000;
export const CACHE_MS = 60_000;

export function makeChallengeCache(fetchMe: () => Promise<RaffleMe>, now: () => number = () => Date.now()) {
  let cache: { at: number; data: RaffleMe } | null = null;
  let inflight: Promise<RaffleMe> | null = null;
  return {
    invalidate() { cache = null; },
    load(force = false): Promise<RaffleMe> {
      if (inflight) return inflight;
      const age = cache ? now() - cache.at : Infinity;
      if (cache && age < (force ? FRESH_MS : CACHE_MS)) return Promise.resolve(cache.data);
      inflight = fetchMe().then((data) => {
        cache = { at: now(), data };
        return data;
      }).finally(() => { inflight = null; });
      return inflight;
    },
  };
}

async function fetchMe(): Promise<RaffleMe> {
  const { data, error } = await supabase().rpc('pokejam_raffle_me');
  if (error) throw new Error(error.message);
  return data as RaffleMe;
}

const cache = makeChallengeCache(fetchMe);

export const invalidateChallenges = () => cache.invalidate();

/** One read of this week's progress. Null when online play isn't configured. */
export async function loadChallenges(force = false): Promise<RaffleMe | null> {
  if (!ONLINE_CONFIGURED) return null;
  return cache.load(force);
}

/** Holder entries for the signed-in account. The balance is read by pokejam-raffle-holder, not in the browser. */
export async function loadHolderEntries(): Promise<{ wallet: string | null; holder: number } | null> {
  if (!ONLINE_CONFIGURED) return null;
  const { data, error } = await supabase().functions.invoke('pokejam-raffle-holder', { body: {} });
  if (error) return null;
  const body = data as { ok?: boolean; wallet?: unknown; holder?: unknown } | null;
  if (!body?.ok || typeof body.holder !== 'number' || !Number.isInteger(body.holder) || body.holder < 0) return null;
  return { wallet: typeof body.wallet === 'string' ? body.wallet : null, holder: body.holder };
}

async function signedIn(): Promise<boolean> {
  if (!ONLINE_CONFIGURED) return false;
  try {
    const { data } = await supabase().auth.getSession();
    return !!data.session && !data.session.user.is_anonymous;
  } catch {
    return false;
  }
}

/** Records one played offline game for the signed-in account. Never throws. */
export function noteOfflinePlayed(mode: OfflineMode): void {
  void (async () => {
    try {
      if (!(await signedIn())) return;
      await supabase().rpc('pokejam_raffle_note_offline', { p_mode: mode });
      cache.invalidate();
      await cache.load(true);
    } catch { /* a missed credit must not stop the results screen */ }
  })();
}

/** Records one share. Never throws. */
export function noteShare(): void {
  void (async () => {
    try {
      if (!(await signedIn())) return;
      await supabase().rpc('pokejam_raffle_note_share');
      cache.invalidate();
      await cache.load(true);
    } catch { /* sharing still worked */ }
  })();
}

/** Refreshes the cache after an online game, whose result is already a match row. Never throws. */
export function warmChallenges(): void {
  void loadChallenges(true).catch(() => {});
}
