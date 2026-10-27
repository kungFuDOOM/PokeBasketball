// The Supabase client for online play, created on first use. Configured by VITE_SUPABASE_URL and
// VITE_SUPABASE_ANON_KEY (the publishable key, public by design). Players get an anonymous account.
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { BotCheckError } from './capacity';
import { CAPTCHA_ON, captchaToken } from './captcha';

const URL = import.meta.env.VITE_SUPABASE_URL;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const ONLINE_CONFIGURED = !!URL && !!KEY;

let client: SupabaseClient | null = null;
/** The player's current access token, kept at hand so a request can go out while the page is closing (keepaliveRpc). */
let accessToken: string | null = null;

export function supabase(): SupabaseClient {
  if (!ONLINE_CONFIGURED) throw new Error('Online play is not configured for this build.');
  if (!client) {
    client = createClient(URL!, KEY!, {
      auth: { persistSession: true, autoRefreshToken: true, storageKey: 'pokejam.auth' },
      realtime: { params: { eventsPerSecond: 40 } },
    });
    client.auth.onAuthStateChange((_event, session) => { accessToken = session?.access_token ?? null; });
  }
  return client;
}

/**
 * An RPC request that outlives the page (fetch with keepalive): for leaving the queue or a match while the tab is
 * closing or going to the background, where a normal request may never be sent. Fire and forget, never throws.
 */
export function rpcBeacon(base: string, key: string, token: () => string | null, send: typeof fetch = (...a) => fetch(...a)) {
  return (fn: string, args: Record<string, unknown> = {}) => {
    const t = token();
    if (!t) return;
    try {
      void send(`${base}/rest/v1/rpc/${fn}`, {
        method: 'POST', keepalive: true,
        headers: { apikey: key, Authorization: `Bearer ${t}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(args),
      }).catch(() => {});
    } catch { /* best effort */ }
  };
}

export const keepaliveRpc = ONLINE_CONFIGURED ? rpcBeacon(URL!, KEY!, () => accessToken) : () => {};

/** What signing in needs from the page: whether Auth CAPTCHA is on for this build, and a fresh Turnstile token. */
export interface SignInDeps {
  captchaOn: boolean;
  token(): Promise<string>;
}
const realDeps: SignInDeps = { captchaOn: CAPTCHA_ON, token: () => captchaToken() };

const authFailure = (e: { message?: string; status?: number; code?: string }) =>
  Object.assign(new Error(e.message || 'Could not sign in'), { status: e.status, code: e.code });
const captchaRefused = (e: { message?: string; code?: string }) => e.code === 'captcha_failed' || /captcha/i.test(e.message ?? '');

/**
 * The one place a player signs in anonymously. Every sign-in (a first visit, a cleared session, a refresh token that
 * no longer works) goes through here and carries a Turnstile token fetched just now: tokens are single-use and expire
 * in minutes, so one is never kept or reused. If Supabase refuses the token (expired, already used), one new check is
 * tried before giving up with a BotCheckError that the screen offers a retry for.
 */
async function signIn(sb: SupabaseClient, d: SignInDeps): Promise<string> {
  // getSession refreshes an expired access token by itself; no session here means there is nothing left to refresh.
  const { data } = await sb.auth.getSession();
  if (data.session?.user) return data.session.user.id;
  for (let attempt = 1; ; attempt++) {
    let captchaToken: string | undefined;
    if (d.captchaOn) {
      try {
        captchaToken = await d.token();
      } catch (e) {
        throw e instanceof BotCheckError ? e : new BotCheckError((e as Error).message || undefined);
      }
    }
    const { data: anon, error } = await sb.auth.signInAnonymously(captchaToken ? { options: { captchaToken } } : undefined);
    if (!error && anon.user) return anon.user.id;
    if (error && captchaRefused(error)) {
      if (attempt < 2 && d.captchaOn) continue;
      throw new BotCheckError(d.captchaOn ? 'The bot check expired or was refused. Try again.' : 'Online sign-in needs a bot check that is not set up in this build.');
    }
    throw authFailure(error ?? { message: 'Could not sign in' });
  }
}

let signingIn: Promise<string> | null = null;
/** Signs in (anonymously the first time; the account is kept on this device) and returns the user id. Callers at once share one sign-in. */
export function ensureSignedIn(sb: SupabaseClient, deps: SignInDeps = realDeps): Promise<string> {
  signingIn ??= signIn(sb, deps).finally(() => { signingIn = null; });
  return signingIn;
}
