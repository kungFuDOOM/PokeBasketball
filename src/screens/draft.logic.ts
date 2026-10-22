/** The full pick sequence (team indexes): round one in `order`, then alternating direction each round. */
export function snakePicks(order: number[], size: number): number[] {
  const picks: number[] = [];
  for (let r = 0; r < size; r++) picks.push(...(r % 2 ? [...order].reverse() : order));
  return picks;
}

/** 1 -> "1st", 2 -> "2nd", 3 -> "3rd", 4 -> "4th", 11 -> "11th", 22 -> "22nd". */
export function ordinal(n: number): string {
  const s = n % 100;
  if (s >= 11 && s <= 13) return `${n}th`;
  return n + (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
}
