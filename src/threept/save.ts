// Personal best, persisted under pokejam.threept.v1 (a pokejam.* key, so "Delete saved data" clears it).
import { MAX_SCORE } from './types';

export const THREEPT_KEY = 'pokejam.threept.v1';

export interface ThreePtBest {
  score: number;
  dex: number;
  name: string;
  at: number;
}

const validScore = (n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MAX_SCORE;

/** Read the best; null when missing, corrupt, the wrong shape, or storage is unavailable. Never throws. */
export function loadBest(): ThreePtBest | null {
  try {
    const raw = globalThis.localStorage?.getItem(THREEPT_KEY);
    if (!raw) return null;
    const v = JSON.parse(raw) as Partial<ThreePtBest> | null;
    if (!v || typeof v !== 'object') return null;
    if (!validScore(v.score) || typeof v.dex !== 'number' || !Number.isFinite(v.dex) || typeof v.name !== 'string' || typeof v.at !== 'number') return null;
    return { score: v.score, dex: v.dex, name: v.name, at: v.at };
  } catch {
    return null;
  }
}

/**
 * Save only when `score` beats the stored best (ties keep the old one). With nothing stored any score above 0
 * counts: a first-ever 0 is not a "new high score" and is not saved. Rejects scores outside 0..34 or non-integers.
 * Returns true when it wrote a new high score. Never throws.
 */
export function saveIfBest(score: number, dex: number, name: string, now = Date.now()): boolean {
  if (!validScore(score)) return false;
  const prev = loadBest();
  if (score <= (prev?.score ?? 0)) return false;
  try {
    const ls = globalThis.localStorage;
    if (!ls) return false;
    ls.setItem(THREEPT_KEY, JSON.stringify({ score, dex, name, at: now } satisfies ThreePtBest));
    return true;
  } catch {
    return false;
  }
}
