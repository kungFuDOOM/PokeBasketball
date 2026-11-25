// Legacy King Kabuto: kept only so franchise saves that already drafted him still load and render as him.
// There is no availability window: he is not offered in any new draft, Quick Play, the 3-Point picker or the trailer.

export const KING_KABUTO = {
  /** Base species: Kabuto. */
  dex: 140,
  name: 'Kabuto King',
  badge: 'KING',
} as const;

/** He is never available any more; kept as a constant-false guard for callers. */
export const kingKabutoActive = (_now: number = Date.now()): false => false;
