// Keeps the courtside banner's booked ads fresh: on start, then every ten minutes while the page is open and visible.
// Ads run for hours and each carries its own end time, so they drop off on time without faster polling. The last board
// is cached in localStorage so tabs and reloads share one fetch; failures back off (doubling, up to 30 minutes).
import { MODE_ADS } from '../config/features';
import { setLiveAds } from '../data/ads';
import { ADS_CONFIGURED, adsApi, type Board } from './api';

export const EVERY = 600_000;
export const MAX_WAIT = 1_800_000;
export const CACHE_KEY = 'pokejam.ads.board';

interface Cached { at: number; live: { text: string; theme: string; ends_at: string }[] }

let timer: ReturnType<typeof setTimeout> | undefined;
let started = false;
let lastOk = 0;
let lastTry = 0;
let failures = 0;
let inflight = false;

function writeCache(b: Board) {
  try {
    const c: Cached = { at: Date.now(), live: b.live.map((a) => ({ text: a.text, theme: a.theme, ends_at: a.ends_at })) };
    localStorage.setItem(CACHE_KEY, JSON.stringify(c));
  } catch { /* storage full, blocked or private mode: just fetch more often */ }
}

/** The cached board if it is fresh (younger than EVERY), else null. */
function readCache(): Cached | null {
  try {
    const c = JSON.parse(localStorage.getItem(CACHE_KEY) ?? 'null') as Cached | null;
    if (!c || typeof c.at !== 'number' || !Array.isArray(c.live)) return null;
    const age = Date.now() - c.at;
    return age >= 0 && age < EVERY ? c : null;
  } catch { return null; }
}

function show(live: Cached['live']) {
  setLiveAds(live.map((a) => ({ text: a.text, theme: a.theme as never, until: Date.parse(a.ends_at) })));
}

/** Shows a board the page just got and shares it (the cache, the refresh clock). The Advertise page calls this too. */
export function applyBoard(b: Board) {
  show(b.live);
  writeCache(b);
  lastOk = Date.now();
  failures = 0;
}

export async function refreshLiveAds(): Promise<Board | null> {
  lastTry = Date.now();
  try {
    const b = await adsApi.board();
    applyBoard(b);
    return b;
  } catch {
    failures++;
    return null; // the banner keeps what it had (or the house ad)
  }
}

const wait = () => (failures ? Math.min(EVERY * 2 ** failures, MAX_WAIT) : EVERY);
/** When the next fetch is due. */
const due = () => (failures ? lastTry + wait() : lastOk + EVERY);

function schedule() {
  clearTimeout(timer);
  timer = undefined;
  if (document.hidden) return; // the visibilitychange handler restarts it
  timer = setTimeout(() => void tick(), Math.max(1000, due() - Date.now()));
}

async function tick() {
  timer = undefined;
  if (document.hidden) return;
  if (Date.now() < due()) { schedule(); return; }
  const c = readCache(); // another tab may have fetched already
  if (c && !failures) { show(c.live); lastOk = c.at; } else if (!inflight) {
    inflight = true;
    try { await refreshLiveAds(); } finally { inflight = false; }
  }
  schedule();
}

export function startLiveAds() {
  if (!MODE_ADS || !ADS_CONFIGURED || started) return;
  started = true;
  const c = readCache();
  if (c) { show(c.live); lastOk = c.at; }
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && Date.now() >= due()) void tick(); else schedule();
  });
  if (c) schedule(); else void tick();
}

/** Test hook: forget all state. */
export function resetLiveAdsForTest() {
  clearTimeout(timer);
  timer = undefined; started = false; lastOk = 0; lastTry = 0; failures = 0; inflight = false;
}
