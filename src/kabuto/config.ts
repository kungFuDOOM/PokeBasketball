// King Kabuto: limited-time special character. This is the ONE place that sets when he is available.
// A tribute to an X collector called Kabuto King (no real names or links anywhere in the game).

export const KING_KABUTO = {
  /** Base species: Kabuto. King Kabuto replaces it in the quick play and 3-point pickers while active. */
  dex: 140,
  name: 'King Kabuto',
  badge: 'KING',
  /** America/Los_Angeles wall clock, written with the PST offset (-08:00, DST has ended by November). */
  tz: 'America/Los_Angeles',
  start: '2026-11-09T00:00:00-08:00',
  end: '2026-11-23T00:00:00-08:00',
} as const;

/** True from `start` (inclusive) until `end` (exclusive). `now` is epoch ms. */
export function kingKabutoActive(now: number = Date.now()): boolean {
  return now >= Date.parse(KING_KABUTO.start) && now < Date.parse(KING_KABUTO.end);
}
