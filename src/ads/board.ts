// Keeps the courtside banner's booked ads fresh: on start, then every two minutes while the page is open.
import { MODE_ADS } from '../config/features';
import { setLiveAds } from '../data/ads';
import { ADS_CONFIGURED, adsApi, type Board } from './api';

const EVERY = 120_000;
let timer: number | undefined;

export function applyBoard(b: Board) {
  setLiveAds(b.live.map((a) => ({ text: a.text, theme: a.theme, until: Date.parse(a.ends_at) })));
}

export async function refreshLiveAds(): Promise<Board | null> {
  try {
    const b = await adsApi.board();
    applyBoard(b);
    return b;
  } catch {
    return null; // the banner keeps what it had (or the house ad)
  }
}

export function startLiveAds() {
  if (!MODE_ADS || !ADS_CONFIGURED || timer !== undefined) return;
  void refreshLiveAds();
  timer = window.setInterval(() => { if (!document.hidden) void refreshLiveAds(); }, EVERY);
}
