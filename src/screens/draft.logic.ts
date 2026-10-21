/** The full pick sequence (team indexes): round one in `order`, then alternating direction each round. */
export function snakePicks(order: number[], size: number): number[] {
  const picks: number[] = [];
  for (let r = 0; r < size; r++) picks.push(...(r % 2 ? [...order].reverse() : order));
  return picks;
}
