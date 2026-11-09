// King Kabuto data and pool helpers. He is a derived Mon: POKEMON / monByDex / saves keep the plain Kabuto.
import { monByDex, withBonus, type Mon, type Ratings } from '../data/pokemon';
import { KING_KABUTO, kingKabutoActive } from './config';

/** His card (SG): an elite shooter with a moderate rest. OVR 87 via the game's own `overall()`. */
export const KING_RATINGS: Ratings = { spd: 78, sht: 98, ins: 74, pas: 76, def: 74, blk: 55, reb: 55, hnd: 82 };

/**
 * King Kabuto: Kabuto's types, position, special and body, with the King card. Built through `withBonus` (the
 * delta from Kabuto's base ratings) so `ovr`, `archetype` and `size` come from the same code as every other card.
 */
export function kingKabutoMon(): Mon {
  return kingKabutoCard();
}

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

/** True for the King Kabuto card (not the plain Kabuto). */
export const isKingKabuto = (m: Pick<Mon, 'dex' | 'name'>) => m.dex === KING_KABUTO.dex && m.name === KING_KABUTO.name;

/** While active, `pool` with the regular Kabuto swapped for King Kabuto (no insertion if absent); otherwise a copy. */
export function withKingKabuto(pool: readonly Mon[], now: number = Date.now()): Mon[] {
  if (!kingKabutoActive(now)) return [...pool];
  const king = kingKabutoMon();
  return pool.map((m) => (m.dex === KING_KABUTO.dex ? king : m));
}

/** The featured-shooter hook value for src/threept: pinned first while active, null otherwise. */
export function kingFeatured(now: number = Date.now()): { dex: number; badge: string } | null {
  return kingKabutoActive(now) ? { dex: KING_KABUTO.dex, badge: KING_KABUTO.badge } : null;
}
