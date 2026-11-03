// Discord sign-in from the iPhone home-screen app. A standalone web app that opens accounts.discord.com comes back in
// Safari, not in the app, and the two do not share storage. The PKCE verifier has to be created in Safari, or the
// return cannot be exchanged. So Safari finishes the OAuth and hands the app a refresh token through the same relay
// Phantom uses, sealed to a key only the app holds. The app then calls refreshSession. Nobody calls signOut: that
// revokes the session on the server and the app's refresh fails.
//
// Same-tab sign-in (Safari, Chrome, desktop) does not use this. It is a normal signInWithOAuth redirect.
import { base58Decode, base58Encode, randomBytes } from '../../supabase/functions/_shared/pack/bytes.ts';
import { RETURN_KEY } from '../multiplayer/ranked/account';
import { boxPublicKey } from './nacl';
import { openRefreshToken, sealRefreshToken } from './phantomHandoff';
import { FLOW_TTL_MS, newId, relayPut, relayTake, type PhantomResponse, type RelayClient, type ReturnTo, type Store } from './phantomLink';

/** The app's half of a home-screen Discord sign-in (localStorage). */
export const DISCORD_HANDOFF_KEY = 'pokejam.discord.handoff';
/** Safari's note of the handoff across the trip to Discord (localStorage in Safari). */
export const DISCORD_LANDING_KEY = 'pokejam.discord.landing';
/** Storage key of the throwaway Supabase client that exchanges the code in Safari. Not pokejam.auth. */
export const DISCORD_OAUTH_KEY = 'pokejam.discord.oauth';

export interface DiscordHandoff {
  v: 1;
  id: string;
  /** x25519 secret, base58. Stays on this device. */
  secret: string;
  returnTo: ReturnTo;
  expiresAt: number;
}

export interface DiscordLanding {
  v: 1;
  id: string;
  pub: string;
  returnTo: ReturnTo;
  expiresAt: number;
}

const b58 = (b: Uint8Array) => base58Encode(b);

/** Where a home-screen sign-in should run. A standalone app hands off to Safari; every other tab redirects itself. */
export const discordSignInPlan = (standalone: boolean): 'handoff' | 'redirect' => (standalone ? 'handoff' : 'redirect');

/** The Safari URL for a handoff already stored on this device. The secret stays out of it. */
export function discordHandoffUrl(loc: { origin: string; pathname: string }, h: Pick<DiscordHandoff, 'id' | 'secret' | 'returnTo'>): string {
  const q = new URLSearchParams({ pj_discord: h.id, pj_gk: b58(boxPublicKey(base58Decode(h.secret))), pj_to: h.returnTo });
  return `${loc.origin}${loc.pathname}?${q}`;
}

/** The tap in the home-screen app. Synchronous. The secret is not in the URL. */
export function beginDiscordHandoff(store: Store, o: { loc: { origin: string; pathname: string }; returnTo: ReturnTo; now: number }): { url: string; handoff: DiscordHandoff } {
  const secret = randomBytes(32);
  const handoff: DiscordHandoff = { v: 1, id: newId(), secret: b58(secret), returnTo: o.returnTo, expiresAt: o.now + FLOW_TTL_MS };
  store.setItem(DISCORD_HANDOFF_KEY, JSON.stringify(handoff));
  return { url: discordHandoffUrl(o.loc, handoff), handoff };
}

export function clearDiscordHandoff(store: Store): void {
  try { store.removeItem(DISCORD_HANDOFF_KEY); } catch { /* nothing to clear */ }
}

export function loadDiscordHandoff(store: Store, now: number): { handoff: DiscordHandoff | null; expired: boolean } {
  let raw: string | null = null;
  try { raw = store.getItem(DISCORD_HANDOFF_KEY); } catch { return { handoff: null, expired: false }; }
  if (!raw) return { handoff: null, expired: false };
  try {
    const h = JSON.parse(raw) as DiscordHandoff;
    if (h && h.v === 1 && typeof h.id === 'string' && typeof h.secret === 'string' && typeof h.expiresAt === 'number') {
      if (h.expiresAt > now) return { handoff: { ...h, returnTo: h.returnTo === 'profile' ? 'profile' : 'ranked' }, expired: false };
      clearDiscordHandoff(store);
      return { handoff: null, expired: true };
    }
  } catch { /* corrupt */ }
  clearDiscordHandoff(store);
  return { handoff: null, expired: false };
}

export interface DiscordReturn { id: string; pub: string; returnTo: ReturnTo; code?: string; error?: string }

/** The query Safari landed with. Null when this page is not a Discord handoff. */
export function parseDiscordReturn(search: string): DiscordReturn | null {
  const q = new URLSearchParams(search.replace(/^\?/, '').replace(/\?/g, '&'));
  const id = q.get('pj_discord');
  const pub = q.get('pj_gk');
  if (!id || !pub) return null;
  const to = q.get('pj_to') === 'profile' ? 'profile' : 'ranked';
  const code = q.get('code') ?? undefined;
  const error = q.get('error') ?? undefined;
  return { id, pub, returnTo: to, ...(code ? { code } : {}), ...(error ? { error } : {}) };
}

/** Where Discord should send Safari back, still carrying the handoff so the code can be sealed to the app. */
export function discordRedirectTo(loc: { origin: string; pathname: string }, landing: Pick<DiscordLanding, 'id' | 'pub' | 'returnTo'>): string {
  const q = new URLSearchParams({ pj_discord: landing.id, pj_gk: landing.pub, pj_to: landing.returnTo });
  return `${loc.origin}${loc.pathname}?${q}`;
}

export function saveDiscordLanding(store: Store, landing: DiscordLanding): void {
  store.setItem(DISCORD_LANDING_KEY, JSON.stringify(landing));
}

export function loadDiscordLanding(store: Store, now: number): DiscordLanding | null {
  let raw: string | null = null;
  try { raw = store.getItem(DISCORD_LANDING_KEY); } catch { return null; }
  if (!raw) return null;
  try {
    const h = JSON.parse(raw) as DiscordLanding;
    if (h && h.v === 1 && typeof h.id === 'string' && typeof h.pub === 'string' && h.expiresAt > now) {
      return { ...h, returnTo: h.returnTo === 'profile' ? 'profile' : 'ranked' };
    }
  } catch { /* corrupt */ }
  try { store.removeItem(DISCORD_LANDING_KEY); } catch { /* ignore */ }
  return null;
}

export function clearDiscordLanding(store: Store): void {
  try { store.removeItem(DISCORD_LANDING_KEY); } catch { /* ignore */ }
}

export interface DiscordCodeAuth {
  exchangeCodeForSession(code: string): PromiseLike<{ data: { session: { refresh_token?: string } | null } | null; error: unknown }>;
}

/**
 * Safari, after Discord: exchange the code with the throwaway client, seal the refresh token, put it in the relay.
 * Does not sign out and does not touch pokejam.auth. The caller wipes the throwaway client's storage afterwards.
 */
export async function finishDiscordInSafari(auth: DiscordCodeAuth, relay: RelayClient, o: { code: string; id: string; pub: string }): Promise<void> {
  const { data, error } = await auth.exchangeCodeForSession(o.code);
  const rt = data?.session?.refresh_token;
  if (error || !rt) throw new Error('Discord sign-in was refused.');
  const stored = await relayPut(relay, { id: o.id, app: true, response: sealRefreshToken(rt, o.pub) }).catch(() => false);
  if (!stored) throw new Error('Could not hand the sign-in back to the app.');
}

/** Tells a waiting app that Safari stopped, so it does not wait out the clock. Best effort. */
export async function reportDiscordFailure(relay: RelayClient, id: string): Promise<void> {
  await relayPut(relay, { id, app: true, response: { e: '2' } }).catch(() => false);
}

export interface DiscordAppAuth {
  refreshSession(c: { refresh_token: string }): PromiseLike<{ data: { session: unknown } | null; error: unknown }>;
}

export type DiscordRestore = { kind: 'none' } | { kind: 'waiting' } | { kind: 'done'; returnTo: ReturnTo };

/**
 * One poll of the home-screen app. The relay row is deleted by the read, and the handoff is wiped before the token
 * is used, so a second poll cannot spend it. Only one restore runs at a time.
 */
export function restoreDiscordInApp(store: Store, relay: RelayClient, auth: DiscordAppAuth, now: number): Promise<DiscordRestore> {
  restoring ??= restoreOnce(store, relay, auth, now).finally(() => { restoring = null; });
  return restoring;
}
let restoring: Promise<DiscordRestore> | null = null;

async function restoreOnce(store: Store, relay: RelayClient, auth: DiscordAppAuth, now: number): Promise<DiscordRestore> {
  const { handoff, expired } = loadDiscordHandoff(store, now);
  if (expired) throw new Error('This sign-in expired. Try again.');
  if (!handoff) return { kind: 'none' };
  const answer = await relayTake(relay, handoff.id).catch(() => null);
  if (!answer) return { kind: 'waiting' };
  if (loadDiscordHandoff(store, now).handoff?.id !== handoff.id) return { kind: 'none' };
  clearDiscordHandoff(store);
  if (answer.e !== undefined) throw new Error('Discord sign-in didn\'t finish. Try again.');
  const refresh_token = openDiscordToken(answer, handoff.secret);
  const { data, error } = await auth.refreshSession({ refresh_token });
  if (error || !data?.session) throw new Error('The app couldn\'t use the handed-back sign-in.');
  return { kind: 'done', returnTo: handoff.returnTo };
}

function openDiscordToken(r: PhantomResponse, secret: string): string {
  try { return openRefreshToken(r, { secret }); } catch { throw new Error('The app couldn\'t read the handed-back sign-in.'); }
}

/** Removes the throwaway client's keys. This is not a sign-out: the server session stays valid for the app. */
export function wipeDiscordOauthStorage(store: Store & { key?(index: number): string | null; length?: number }): void {
  const doomed: string[] = [];
  const n = store.length ?? 0;
  for (let i = 0; i < n; i++) {
    const k = store.key?.(i);
    if (k && (k === DISCORD_OAUTH_KEY || k.startsWith(`${DISCORD_OAUTH_KEY}-`))) doomed.push(k);
  }
  if (!store.key) {
    // A map-like store used in tests: it may not list keys. Drop the two supabase-js writes.
    doomed.push(DISCORD_OAUTH_KEY, `${DISCORD_OAUTH_KEY}-code-verifier`);
  }
  for (const k of doomed) {
    try { store.removeItem(k); } catch { /* ignore */ }
  }
}

/** Remember to reopen Ranked or Profile after the app reloads into the new session. Same key as the other sign-in paths. */
export function markDiscordReturn(store: Store, returnTo: ReturnTo): void {
  try { store.setItem(RETURN_KEY, returnTo); } catch { /* they land on the menu, signed in */ }
}
