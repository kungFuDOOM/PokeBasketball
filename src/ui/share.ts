// Share text for the final results screen. Pure: only display names and scores go in, nothing else.
export const SHARE_URL = 'https://pokejam.xyz';
/** A loss by this many points or fewer is "a close one". */
export const CLOSE_MARGIN = 3;

export interface ShareInput {
  /** Who the user played: a gym, a team, or an online opponent's display name. */
  opponent: string;
  userScore: number;
  oppScore: number;
  /** Player of the game, when there is one. */
  potg?: { name: string; pts: number } | null;
}

export function shareText({ opponent, userScore, oppScore, potg }: ShareInput): string {
  const opp = opponent.trim() || 'the CPU';
  const star = potg?.name ? ` Player of the game: ${potg.name} (${potg.pts} PTS)` : '';
  if (userScore > oppScore) return `I beat ${opp} ${userScore}-${oppScore} on PokeJam! 🏀${star}`;
  if (userScore === oppScore) return `Played ${opp} to a ${userScore}-${oppScore} tie on PokeJam 🏀 Can you beat them?`;
  if (oppScore - userScore <= CLOSE_MARGIN) return `Lost a close one ${userScore}-${oppScore} to ${opp} on PokeJam 🏀 Can you beat them?`;
  return `Got blown out ${userScore}-${oppScore} by ${opp} on PokeJam 🏀 Think you can do better?`;
}

/** Web intent link for posting on X. */
export const xIntentUrl = (text: string): string =>
  `https://x.com/intent/post?text=${encodeURIComponent(text)}&url=${encodeURIComponent(SHARE_URL)}`;

/** What "Copy link" puts on the clipboard. */
export const copyText = (text: string): string => `${text} ${SHARE_URL}`;
