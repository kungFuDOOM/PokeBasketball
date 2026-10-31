/**
 * The tutorial coach shown in the prompt strip: pure helpers only (no DOM), so they're unit-testable.
 * The coach is the user's own top player, drawn with the existing sprite art (spriteUrl / public/sprites): no new assets.
 */
import type { Mon } from '../data/pokemon';
import { MAX_LINE } from './drills';

/** The coach: the highest-rated player on the user's roster (first on ties, so it's stable for a fixed roster). */
export function coachMon(roster: readonly Mon[]): Mon | null {
  let best: Mon | null = null;
  for (const m of roster) if (!best || m.ovr > best.ovr) best = m;
  return best;
}

/** Fits a coach/prompt line in the strip: collapses whitespace and trims to MAX_LINE chars at a word, with an ellipsis. */
export function fitLine(text: string, max = MAX_LINE): string {
  const s = text.replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  const cut = s.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,.;:–-]+$/, '')}…`;
}

/** Praise the coach says when a step is done, before the next prompt. Short, varied by step index (no randomness). */
const PRAISE = ['Nice!', 'Good work!', 'That\'s it!', 'Great job!'] as const;
export const praiseFor = (index: number): string => PRAISE[((index % PRAISE.length) + PRAISE.length) % PRAISE.length];
