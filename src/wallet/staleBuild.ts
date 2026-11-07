// Stale-bundle guard. An iOS home-screen app can be resumed from memory with a JavaScript bundle from before the last deploy, so
// a sign-in would run old code. build-id.txt (written by vite.config.ts) holds the live build's id; when it differs from the
// running one, reload before the player starts a Phantom sign-in. Best effort and silent: any network trouble means "carry on".
// Never runs during a match: it is only called from the sign-in panel and while that panel is on screen.
import type { Store } from './phantomLink';

export const RELOAD_KEY = 'pokejam.stale.reloaded';
const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const MIN_GAP_MS = 20_000;

/** The id baked into this bundle ('dev' in dev server and tests, which never reload). */
export const runningBuild = (): string => (typeof __PJ_BUILD__ === 'string' && ID_RE.test(__PJ_BUILD__) ? __PJ_BUILD__ : 'dev');

/** True when the live id is a valid id that differs from the running build. Dev builds and garbage answers (an HTML error page) are never stale. */
export function isStale(running: string, live: string | null | undefined): boolean {
  const l = (live ?? '').trim();
  return running !== 'dev' && ID_RE.test(l) && l !== running;
}

export interface StaleDeps {
  running: string;
  /** Fetches build-id.txt without using any cache. May reject. */
  fetchLive(): Promise<string>;
  /** Remembers, for this tab session, which live build we already reloaded for, so a cache that keeps serving old code can't loop. */
  store: Store;
  reload(): void;
}

/** Reloads once if a newer build is live. Resolves true when it reloaded. Never rejects. */
export async function reloadIfStale(d: StaleDeps): Promise<boolean> {
  try {
    const live = (await d.fetchLive()).trim();
    if (!isStale(d.running, live)) return false;
    if (d.store.getItem(RELOAD_KEY) === live) return false;
    d.store.setItem(RELOAD_KEY, live);
    d.reload();
    return true;
  } catch {
    return false;
  }
}

let last = 0;
let watching = false;

/** The real thing, for the browser: tiny no-store fetch with a short timeout, throttled. */
export function checkStaleBuild(opts: { now?: number; force?: boolean; beforeReload?: () => void } = {}): Promise<boolean> {
  const now = opts.now ?? Date.now();
  if (typeof window === 'undefined' || runningBuild() === 'dev' || (!opts.force && now - last < MIN_GAP_MS)) return Promise.resolve(false);
  last = now;
  let store: Store;
  try { store = window.sessionStorage; } catch { return Promise.resolve(false); }
  return reloadIfStale({
    running: runningBuild(),
    store,
    reload: () => { opts.beforeReload?.(); location.reload(); },
    fetchLive: async () => {
      const ctl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = setTimeout(() => ctl?.abort(), 4000);
      try {
        const r = await fetch(new URL(`build-id.txt?t=${now}`, document.baseURI).href, { cache: 'no-store', signal: ctl?.signal });
        if (!r.ok) throw new Error('no build id');
        return (await r.text()).slice(0, 80);
      } finally { clearTimeout(timer); }
    },
  });
}

/** sessionStorage key: the screen to reopen after a stale-build reload (read once by main.ts on boot). */
export const RESUME_KEY = 'pokejam.stale.resume';
export type ResumeTo = 'threept';

let safeHere: (() => boolean) | null = null;
let resumeTo: ResumeTo | null = null;
let watchingMenus = false;

/** Reads and clears the screen a stale-build reload asked to reopen. */
export function takeResume(): ResumeTo | null {
  try {
    const v = sessionStorage.getItem(RESUME_KEY);
    if (v) sessionStorage.removeItem(RESUME_KEY);
    return v === 'threept' ? v : null;
  } catch { return null; }
}

/**
 * Call when a menu-like screen is drawn (the title menu, the 3-Point Contest picker): checks for a newer deploy now, and again
 * whenever the tab comes back while `safe()` still says that screen is up. A stale tab (an open tab or a home-screen app resumed
 * from memory, or a cached entry bundle) then reloads onto the new build before the player starts a mode with old code.
 * `resume` reopens that screen after the reload. Never reloads mid-match or during a Phantom sign-in.
 */
export function guardStaleOnMenu(safe: () => boolean, resume: ResumeTo | null = null): void {
  if (typeof document === 'undefined' || runningBuild() === 'dev') return;
  safeHere = safe;
  resumeTo = resume;
  const run = () => {
    if (!safeHere?.() || signInBusy()) return;
    const back = resumeTo;
    void checkStaleBuild({
      beforeReload: () => { if (back) try { sessionStorage.setItem(RESUME_KEY, back); } catch { /* storage unavailable */ } },
    });
  };
  setTimeout(run, 0);
  if (watchingMenus) return;
  watchingMenus = true;
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') run(); });
}

/** Whether a Phantom sign-in is under way (the page must not reload under it). */
function signInBusy(): boolean {
  if (document.querySelector('[data-phantom-sheet]')) return true;
  try {
    return !!(sessionStorage.getItem('pokejam.phantom.pending') || localStorage.getItem('pokejam.phantom.handoff') || localStorage.getItem('pokejam.phantom.landing'));
  } catch { return true; }
}

/**
 * Call when the sign-in panel (with the Phantom button) is drawn: checks now, and again whenever the page becomes visible while that
 * button is still on screen (so never mid-match, where it isn't).
 */
export function guardStaleBuild(): void {
  if (typeof document === 'undefined' || runningBuild() === 'dev') return;
  const onScreen = () => !!document.querySelector('[data-a="phantom-link"]') && !signInBusy();
  setTimeout(() => { if (onScreen()) void checkStaleBuild(); }, 0); // after the caller has put the panel in the page
  if (watching) return;
  watching = true;
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && onScreen()) void checkStaleBuild();
  });
}
