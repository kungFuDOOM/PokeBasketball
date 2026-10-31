import { DRILL_IDS, type DrillId, type Stars } from './drills';

// Remembers whether the player has finished (or skipped) the tutorial. Local only.
// The `pokejam.` prefix means the existing "Delete saved data" button clears it too.
export const TUTORIAL_DONE_KEY = 'pokejam.tutorialDone';

export function isTutorialDone(): boolean {
  try {
    return localStorage.getItem(TUTORIAL_DONE_KEY) === '1';
  } catch {
    return false; // storage blocked or unavailable: treat as not done
  }
}

export function markTutorialDone(): void {
  try {
    localStorage.setItem(TUTORIAL_DONE_KEY, '1');
  } catch {
    // storage blocked or full: nothing to persist, ignore
  }
}

// Best star grade per training drill, stored as one JSON object under a pokejam.* key.
// Reads are tolerant: corrupt JSON, wrong shapes, unknown drills or bad values are ignored.

export const DRILL_STARS_KEY = 'pokejam.drillStars';

export type BestStars = Record<DrillId, Stars>;

const clampStars = (v: unknown): Stars =>
  typeof v === 'number' && Number.isFinite(v) ? (Math.max(0, Math.min(3, Math.floor(v))) as Stars) : 0;

export function loadBestStars(): BestStars {
  const out = Object.fromEntries(DRILL_IDS.map((id) => [id, 0])) as BestStars;
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(DRILL_STARS_KEY);
  } catch {
    return out; // storage blocked or unavailable
  }
  if (!raw) return out;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return out; // corrupt JSON
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  const obj = parsed as Record<string, unknown>;
  for (const id of DRILL_IDS) out[id] = clampStars(obj[id]);
  return out;
}

export function getBestStars(id: DrillId): Stars {
  return loadBestStars()[id];
}

/** Records a drill result; best stars never decrease. Returns the (possibly unchanged) best. */
export function recordDrillStars(id: DrillId, stars: Stars): Stars {
  const all = loadBestStars();
  const next = clampStars(stars);
  if (next <= all[id]) return all[id];
  all[id] = next;
  try {
    localStorage.setItem(DRILL_STARS_KEY, JSON.stringify(all));
  } catch {
    // storage blocked or full: keep the in-memory answer, nothing persisted
  }
  return next;
}
