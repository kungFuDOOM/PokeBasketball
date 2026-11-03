// Draws the home-screen Google handoff and finishes it in Safari. The rules are in googleHandoff.ts.
// This file never signs the player out. That would revoke the session the app is about to refresh.
import { ONLINE_CONFIGURED, googleHandoffAuthClient, supabase } from '../multiplayer/shared/supabase';
import {
  beginGoogleHandoff, clearGoogleHandoff, clearGoogleLanding, finishGoogleInSafari, googleHandoffUrl, googleRedirectTo,
  loadGoogleHandoff, loadGoogleLanding, markGoogleReturn, parseGoogleReturn, reportGoogleFailure,
  restoreGoogleInApp, saveGoogleLanding, wipeGoogleOauthStorage, type GoogleLanding, type GoogleReturn,
} from './googleHandoff';
import { googleBodyHtml, googleCode, googleSheetHtml, type GoogleSheet } from './googleView';
import { isStandalone, type ReturnTo } from './phantomLink';

const POLL_MS = 2500;
const TEN_MIN = 10 * 60_000;

type Win = Window & { __googleCb?: string };
const relay = () => supabase() as unknown as Parameters<typeof finishGoogleInSafari>[1];
const local = (): Storage => window.localStorage;
const here = () => ({ origin: location.origin, pathname: location.pathname });
const hostWindow = () => window as unknown as Parameters<typeof isStandalone>[0];

let stop: (() => void) | null = null;

function draw(state: GoogleSheet): void {
  let sheet = document.querySelector<HTMLElement>('[data-google-sheet]');
  if (!sheet) {
    const host = document.createElement('div');
    host.innerHTML = googleSheetHtml(state);
    sheet = host.firstElementChild as HTMLElement;
    document.body.append(sheet);
    sheet.addEventListener('click', onClick);
    return;
  }
  const body = sheet.querySelector('[data-google-body]');
  if (body) body.innerHTML = googleBodyHtml(state);
}

function closeSheet(): void {
  stop?.();
  stop = null;
  document.querySelector('[data-google-sheet]')?.remove();
}

function onClick(e: Event): void {
  const t = e.target as Element;
  if (t.closest('[data-a="google-close"]')) closeSheet();
  else if (t.closest('[data-a="google-cancel"]')) {
    clearGoogleHandoff(local());
    closeSheet();
  }
}

function fail(text: string): void {
  stop?.();
  stop = null;
  draw({ kind: 'failed', text });
}

/** The home-screen app, waiting for Safari to leave the sealed session in the relay. */
function watchGoogle(returnTo: ReturnTo): void {
  if (!loadGoogleHandoff(local(), Date.now()).handoff) return;
  stop?.();
  let busy = false;
  const tick = async () => {
    if (busy || document.visibilityState === 'hidden') return;
    busy = true;
    try {
      const r = await restoreGoogleInApp(local(), relay(), supabase().auth, Date.now());
      if (r.kind === 'done') {
        stop?.();
        markGoogleReturn(local(), r.returnTo || returnTo);
        location.reload();
      } else if (r.kind === 'none') {
        stop?.();
        stop = null;
      }
    } catch (e) {
      fail(e instanceof Error ? e.message : 'Could not finish Google sign-in.');
    } finally {
      busy = false;
    }
  };
  const onWake = () => void tick();
  const timer = setInterval(onWake, POLL_MS);
  document.addEventListener('visibilitychange', onWake);
  window.addEventListener('pageshow', onWake);
  window.addEventListener('focus', onWake);
  stop = () => {
    clearInterval(timer);
    document.removeEventListener('visibilitychange', onWake);
    window.removeEventListener('pageshow', onWake);
    window.removeEventListener('focus', onWake);
  };
  onWake();
}

/** Tap on Continue with Google while this page is the installed app. Opens Safari and waits here. */
export function startGoogleHandoff(returnTo: ReturnTo): void {
  const { url, handoff } = beginGoogleHandoff(local(), { loc: here(), returnTo, now: Date.now() });
  window.open(url, '_blank');
  draw({ kind: 'wait', code: googleCode(handoff.id), url });
  watchGoogle(returnTo);
}

/** Safari: send the browser to Google, or seal the code that just came back. The app is polling the same id. */
async function resumeInSafari(ret: GoogleReturn): Promise<void> {
  const now = Date.now();
  const saved = loadGoogleLanding(local(), now);
  const landing: GoogleLanding = saved && saved.id === ret.id
    ? saved
    : { v: 1, id: ret.id, pub: ret.pub, returnTo: ret.returnTo, expiresAt: now + TEN_MIN };
  if (ret.error || !ONLINE_CONFIGURED) {
    clearGoogleLanding(local());
    await reportGoogleFailure(relay(), ret.id);
    draw({ kind: 'failed', text: 'Google sign-in didn\'t finish. Go back to the PokeJam app and try again.' });
    return;
  }
  if (!ret.code) {
    saveGoogleLanding(local(), landing);
    draw({ kind: 'opening' });
    const { error } = await googleHandoffAuthClient().signInWithOAuth({
      provider: 'google',
      options: { redirectTo: googleRedirectTo(here(), landing), queryParams: { prompt: 'select_account' }, skipBrowserRedirect: false },
    });
    if (error) {
      clearGoogleLanding(local());
      await reportGoogleFailure(relay(), ret.id);
      draw({ kind: 'failed', text: error.message || 'Could not start Google sign-in.' });
    }
    return;
  }
  try {
    await finishGoogleInSafari(googleHandoffAuthClient(), relay(), { code: ret.code, id: landing.id, pub: landing.pub });
    clearGoogleLanding(local());
    wipeGoogleOauthStorage(local());
    draw({ kind: 'done', code: googleCode(landing.id) });
  } catch (e) {
    clearGoogleLanding(local());
    wipeGoogleOauthStorage(local());
    await reportGoogleFailure(relay(), landing.id);
    draw({ kind: 'failed', text: e instanceof Error ? e.message : 'Could not finish Google sign-in.' });
  }
}

/** On load: a Google return stashed by public/google-return.js, or a handoff still in progress. */
export function resumeGoogle(search: string | undefined): void {
  const w = window as Win;
  const stashed = w.__googleCb;
  w.__googleCb = undefined;
  if (!ONLINE_CONFIGURED) return;
  let store: Storage;
  try { store = local(); } catch { return; }
  const ret = parseGoogleReturn(stashed || search || '');
  // The code was exchanged in Safari. A standalone page that somehow sees it still just waits for the relay.
  if (ret && !isStandalone(hostWindow())) {
    void resumeInSafari(ret);
    return;
  }
  const h = loadGoogleHandoff(store, Date.now());
  if (h.handoff) {
    draw({ kind: 'wait', code: googleCode(h.handoff.id), url: googleHandoffUrl(here(), h.handoff) });
    watchGoogle(h.handoff.returnTo);
    return;
  }
  if (h.expired) fail('This sign-in expired. Try again.');
}
