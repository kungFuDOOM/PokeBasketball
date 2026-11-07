// Personal best, persisted under pokejam.threept.v1. Stubs: see TASKS.md task 7.
export const THREEPT_KEY = 'pokejam.threept.v1';

export interface ThreePtBest {
  score: number;
  dex: number;
  name: string;
  at: number;
}

/** TODO(task 7): read the best; null when missing, corrupt, or storage is unavailable. Never throws. */
export function loadBest(): ThreePtBest | null {
  return null;
}

/** TODO(task 7): save only when `score` beats the stored best. Returns true when it is a new high score. Never throws. */
export function saveIfBest(score: number, dex: number, name: string): boolean {
  void score; void dex; void name;
  return false;
}
