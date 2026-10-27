export interface BannerAd { enabled: boolean; tag: string; text: string; bg: string; color: string; border: string; tagBg: string }

/** The sponsor panels in the courtside LED banner, left to right; together they replace the first (team/city) segment of a court's board text (the city already shows on the floor). Each half is independent (text, colors, tag, enabled). */
export const BANNER_ADS: BannerAd[] = [
  { enabled: true, tag: 'AD', text: '$PJAM · OFFICIAL POKEJAM TOKEN', bg: '#10122a', color: '#7dffb2', border: '#2fd37a', tagBg: '#2fd37a' },
  { enabled: true, tag: 'AD', text: 'YOUR AD HERE', bg: '#ffd23a', color: '#10122a', border: '#e03a2a', tagBg: '#e03a2a' },
];

/** A court's board text without its first ★-separated segment (the one the ad panels stand in for). */
export function boardAfterAd(board: string): string {
  return board.split(' ★ ').slice(1).join(' ★ ');
}
