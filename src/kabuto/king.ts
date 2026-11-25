// Legacy King Kabuto card. A saved franchise player flagged `king: true` keeps this card; nothing new ever gets it.
import { monByDex, withBonus, type Mon, type Ratings } from '../data/pokemon';
import { KING_KABUTO } from './config';

/** His card (SG): an elite shooter with a moderate rest. OVR 87 via the game's own `overall()`. */
export const KING_RATINGS: Ratings = { spd: 78, sht: 98, ins: 74, pas: 76, def: 74, blk: 55, reb: 55, hnd: 82 };

/**
 * The King card with franchise growth on top: `bonus` is the player's level-up gains (FPlayer.bonus), added to the
 * King's own ratings the same way they are added to any other card.
 */
export function kingKabutoCard(bonus: Partial<Ratings> = {}): Mon {
  const base = monByDex(KING_KABUTO.dex);
  const delta: Partial<Ratings> = {};
  for (const k of Object.keys(KING_RATINGS) as (keyof Ratings)[]) delta[k] = KING_RATINGS[k] - base.r[k] + (bonus[k] ?? 0);
  return { ...withBonus(KING_KABUTO.dex, delta), name: KING_KABUTO.name };
}

/** True for the King card (not the plain Kabuto). */
export const isKingKabuto = (m: Pick<Mon, 'dex' | 'name'>) => m.dex === KING_KABUTO.dex && m.name === KING_KABUTO.name;

/** Never injects him into a pool: returns the pool unchanged (a copy). Kept so older call sites stay harmless. */
export const withKingKabuto = (pool: readonly Mon[], _now?: number): Mon[] => [...pool];
