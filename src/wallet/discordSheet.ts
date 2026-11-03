// Draws the home-screen Discord handoff and finishes it in Safari. The rules are in discordHandoff.ts.
// This file never signs the player out. That would revoke the session the app is about to refresh.
import { ONLINE_CONFIGURED, discordHandoffAuthClient, supabase } from '../multiplayer/shared/supabase';
import {
  beginDiscordHandoff, clearDiscordHandoff, clearDiscordLanding, finishDiscordInSafari, discordHandoffUrl, discordRedirectTo,
  loadDiscordHandoff, loadDiscordLanding, markDiscordReturn, parseDiscordReturn, reportDiscordFailure,
  restoreDiscordInApp, saveDiscordLanding, wipeDiscordOauthStorage, type DiscordLanding, type DiscordReturn,
} from './discordHandoff';
import { discordBodyHtml, discordCode, discordSheetHtml, type DiscordSheet } from './discordView';
import { isStandalone, type ReturnTo } from './phantomLink';

const POLL_MS = 2500;
const TEN_MIN = 10 * 60_000;

type Win = Window & { __discordCb?: string };
const relay = () => supabase() as unknown as Parameters<typeof finishDiscordInSafari>[1];
const local = (): Storage => window.localStorage;
const here = () => ({ origin: location.origin, pathname: location.pathname });
const hostWindow = () => window as unknown as Parameters<typeof isStandalone>[0];

let stop: (() => void) | null = null;

function draw(state: DiscordSheet): void {
  let sheet = document.querySelector<HTMLElement>('[data-discord-sheet]');
  if (!sheet) {
    const host = document.createElement('div');
    host.innerHTML = discordSheetHtml(state);
    sheet = host.firstElementChild as HTMLElement;
    document.body.append(sheet);
    sheet.addEventListener('click', onClick);
    return;
  }
  const body = sheet.querySelector('[data-discord-body]');
  if (body) body.innerHTML = discordBodyHtml(state);
}

function closeSheet(): void {
  stop?.();
  stop = null;
  document.querySelector('[data-discord-sheet]')?.remove();
}

function onClick(e: Event): void {
  const t = e.target as Element;
  if (t.closest('[data-a="discord-close"]')) closeSheet();
  else if (t.closest('[data-a="discord-cancel"]')) {
    clearDiscordHandoff(local());
    closeSheet();
  }
}

function fail(text: string): void {
  stop?.();
  stop = null;
  draw({ kind: 'failed', text });
}

/** The home-screen app, waiting for Safari to leave the sealed session in the relay. */
function watchDiscord(returnTo: ReturnTo): void {
  if (!loadDiscordHandoff(local(), Date.now()).handoff) return;
  stop?.();
  let busy = false;
  const tick = async () => {
    if (busy || document.visibilityState === 'hidden') return;
    busy = true;
    try {
      const r = await restoreDiscordInApp(local(), relay(), supabase().auth, Date.now());
      if (r.kind === 'done') {
        stop?.();
        markDiscordReturn(local(), r.returnTo || returnTo);
        location.reload();
      } else if (r.kind === 'none') {
        stop?.();
        stop = null;
      }
    } catch (e) {
      fail(e instanceof Error ? e.message : 'Could not finish Discord sign-in.');
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

/** Tap on Continue with Discord while this page is the installed app. Opens Safari and waits here. */
export function startDiscordHandoff(returnTo: ReturnTo): void {
  const { url, handoff } = beginDiscordHandoff(local(), { loc: here(), returnTo, now: Date.now() });
  window.open(url, '_blank');
  draw({ kind: 'wait', code: discordCode(handoff.id), url });
  watchDiscord(returnTo);
}

/** Safari: send the browser to Discord, or seal the code that just came back. The app is polling the same id. */
async function resumeInSafari(ret: DiscordReturn): Promise<void> {
  const now = Date.now();
  const saved = loadDiscordLanding(local(), now);
  const landing: DiscordLanding = saved && saved.id === ret.id
    ? saved
    : { v: 1, id: ret.id, pub: ret.pub, returnTo: ret.returnTo, expiresAt: now + TEN_MIN };
  if (ret.error || !ONLINE_CONFIGURED) {
    clearDiscordLanding(local());
    await reportDiscordFailure(relay(), ret.id);
    draw({ kind: 'failed', text: 'Discord sign-in didn\'t finish. Go back to the PokeJam app and try again.' });
    return;
  }
  if (!ret.code) {
    saveDiscordLanding(local(), landing);
    draw({ kind: 'opening' });
    const { error } = await discordHandoffAuthClient().signInWithOAuth({
      provider: 'discord',
      options: { redirectTo: discordRedirectTo(here(), landing), scopes: 'identify email', skipBrowserRedirect: false },
    });
    if (error) {
      clearDiscordLanding(local());
      await reportDiscordFailure(relay(), ret.id);
      draw({ kind: 'failed', text: error.message || 'Could not start Discord sign-in.' });
    }
    return;
  }
  try {
    await finishDiscordInSafari(discordHandoffAuthClient(), relay(), { code: ret.code, id: landing.id, pub: landing.pub });
    clearDiscordLanding(local());
    wipeDiscordOauthStorage(local());
    draw({ kind: 'done', code: discordCode(landing.id) });
  } catch (e) {
    clearDiscordLanding(local());
    wipeDiscordOauthStorage(local());
    await reportDiscordFailure(relay(), landing.id);
    draw({ kind: 'failed', text: e instanceof Error ? e.message : 'Could not finish Discord sign-in.' });
  }
}

/** On load: a Discord return stashed by public/discord-return.js, or a handoff still in progress. */
export function resumeDiscord(search: string | undefined): void {
  const w = window as Win;
  const stashed = w.__discordCb;
  w.__discordCb = undefined;
  if (!ONLINE_CONFIGURED) return;
  let store: Storage;
  try { store = local(); } catch { return; }
  const ret = parseDiscordReturn(stashed || search || '');
  // The code was exchanged in Safari. A standalone page that somehow sees it still just waits for the relay.
  if (ret && !isStandalone(hostWindow())) {
    void resumeInSafari(ret);
    return;
  }
  const h = loadDiscordHandoff(store, Date.now());
  if (h.handoff) {
    draw({ kind: 'wait', code: discordCode(h.handoff.id), url: discordHandoffUrl(here(), h.handoff) });
    watchDiscord(h.handoff.returnTo);
    return;
  }
  if (h.expired) fail('This sign-in expired. Try again.');
}
