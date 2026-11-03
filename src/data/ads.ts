export interface BannerAd { enabled: boolean; tag: string; text: string; bg: string; color: string; border: string; tagBg: string }

/** Colour themes an ad can run in on the courtside LED banner (the server checks the names). */
export type AdTheme = 'gold' | 'fire' | 'water' | 'grass' | 'electric' | 'psychic' | 'ghost' | 'ice';

export interface ThemeStyle { label: string; bg: string; color: string; border: string; tagBg: string; tagColor: string }

export const AD_THEMES: Record<AdTheme, ThemeStyle> = {
  gold: { label: 'Gold', bg: '#ffd23a', color: '#10122a', border: '#e03a2a', tagBg: '#e03a2a', tagColor: '#ffffff' },
  fire: { label: 'Fire', bg: '#e3350d', color: '#fff4dc', border: '#ffcb05', tagBg: '#10122a', tagColor: '#ffcb05' },
  water: { label: 'Water', bg: '#2f63d4', color: '#ffffff', border: '#9fd3ff', tagBg: '#10122a', tagColor: '#9fd3ff' },
  grass: { label: 'Grass', bg: '#2f9a45', color: '#ffffff', border: '#c9f27a', tagBg: '#10122a', tagColor: '#c9f27a' },
  electric: { label: 'Electric', bg: '#10122a', color: '#ffe14a', border: '#ffe14a', tagBg: '#ffe14a', tagColor: '#10122a' },
  psychic: { label: 'Psychic', bg: '#e0458f', color: '#ffffff', border: '#ffd6ea', tagBg: '#10122a', tagColor: '#ffd6ea' },
  ghost: { label: 'Ghost', bg: '#4a3b8f', color: '#efe8ff', border: '#a98bff', tagBg: '#10122a', tagColor: '#a98bff' },
  ice: { label: 'Ice', bg: '#c4f1ff', color: '#0b2a4a', border: '#3b6fd8', tagBg: '#3b6fd8', tagColor: '#ffffff' },
};
export const THEME_ORDER = Object.keys(AD_THEMES) as AdTheme[];

/** One ad on the banner: its text, as the server cleaned it, and its theme. */
export interface BoardAd { text: string; theme: AdTheme }

/** What the banner shows when nobody has booked it: an ad for the ad space. */
export const HOUSE_AD: BoardAd = { text: 'YOUR AD HERE', theme: 'gold' };

/** The tag in front of every ad, so a paid message is always marked as one. */
export const AD_TAG = 'AD';

/** The characters the LED font and the server allow, 24 at most. */
export const AD_MAX = 24;
export const cleanAdText = (s: string) => s.toUpperCase().replace(/\s+/g, ' ').replace(/^ /, '').slice(0, AD_MAX);
export const adTextOk = (s: string) => /^[A-Z0-9 $!?.,&+@#:'/%-]{1,24}$/.test(s.trim()) && s.trim() !== '';

/** The sponsor panels in the courtside LED banner, left to right; together they replace the first (team/city) segment of a court's board text (the city already shows on the floor). Each half is independent (text, colors, tag, enabled). */
export const BANNER_ADS: BannerAd[] = [
  { enabled: true, tag: 'AD', text: '$PJAM · OFFICIAL POKEJAM TOKEN', bg: '#10122a', color: '#7dffb2', border: '#2fd37a', tagBg: '#2fd37a' },
  { enabled: true, tag: 'AD', text: 'YOUR AD HERE', bg: '#ffd23a', color: '#10122a', border: '#e03a2a', tagBg: '#e03a2a' },
];

/** The fixed house half ($PJAM): every enabled panel except the last, which is the bookable half. */
export const houseAds = (): BannerAd[] => BANNER_ADS.slice(0, -1).filter((a) => a.enabled);

/** The last panel (YOUR AD HERE) is the bookable one: booked ads run there, or HOUSE_AD when nothing is booked. */
export const bookableHalfOn = (): boolean => BANNER_ADS[BANNER_ADS.length - 1].enabled;

/** A court's board text without its first ★-separated segment (the one the ad panels stand in for). */
export function boardAfterAd(board: string): string {
  return board.split(' ★ ').slice(1).join(' ★ ');
}

// The ads booked on the board right now (src/ads/board.ts keeps this fresh). Each carries its end, so an ad
// drops off on time even between refreshes.
let live: (BoardAd & { until: number })[] = [];

export function setLiveAds(ads: (BoardAd & { until: number })[]) {
  live = ads.filter((a) => a.theme in AD_THEMES);
}

/** The ads to run in turn on the banner: the booked ones still running, or the house ad. */
export function boardAds(now = Date.now()): BoardAd[] {
  const on = live.filter((a) => a.until > now);
  return on.length ? on : [HOUSE_AD];
}
