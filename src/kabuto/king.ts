// King Kabuto data and pool helpers. Skeleton: stubs only, see TASKS.md.
import { monByDex, type Mon } from '../data/pokemon';
import { KING_KABUTO, kingKabutoActive } from './config';

/** TODO(T2): buffed card (Sht 97-99, OVR high 80s, moderate rest) built from Kabuto, named King Kabuto. */
export function kingKabutoMon(): Mon {
  return monByDex(KING_KABUTO.dex);
}

/** TODO(T4): while active, `pool` with the regular Kabuto swapped for King Kabuto; otherwise `pool` unchanged. */
export function withKingKabuto(pool: readonly Mon[], _now: number = Date.now()): Mon[] {
  return [...pool];
}

/** TODO(T4): the featured-shooter hook value for src/threept: pinned first while active, null otherwise. */
export function kingFeatured(now: number = Date.now()): { dex: number; badge: string } | null {
  return kingKabutoActive(now) ? { dex: KING_KABUTO.dex, badge: KING_KABUTO.badge } : null;
}
