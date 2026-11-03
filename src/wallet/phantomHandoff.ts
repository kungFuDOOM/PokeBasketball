// The home-screen app's sign-in with Phantom. Phantom's redirect always opens Safari, never the standalone app, and the two have
// separate storage. So Safari finishes the whole sign-in by itself and hands the app a Supabase refresh token, sealed to a key only
// the app holds. Pure logic: storage, clock and network are passed in. phantomSheet.ts draws it. See docs/phantom-mobile-signin.md.
//
//   app:    makes a dapp key for Phantom and a separate handoff key; keeps only the handoff secret (localStorage, 10 min, so an iOS
//           reload loses nothing); sends the dapp secret, handoff id and handoff PUBLIC key along in the redirect link.
//   Safari: decrypts connect, shows the button, runs signMessage, signs in, seals the refresh token to the handoff public key and
//           leaves it in the relay under the handoff id.
//   app:    polls the relay, opens the box, refreshSession(), wipes the handoff.
//
// The dapp secret rides in the URL Phantom already holds for this trip and never reaches the server. It only decrypts this one
// trip's connect and sign answers. Nothing here logs keys, sessions or tokens.
import { base58Decode, base58Encode, randomBytes } from '../../supabase/functions/_shared/pack/bytes.ts';
import { relayCodeOf } from './phantomDiag';
import { boxBefore, boxOpen, boxPublicKey, boxSeal } from './nacl';
import {
  FLOW_TTL_MS, PHANTOM_UL, PhantomLinkError, authError, clearPending, newId, phantomErrorFor, redirectLink, relayPut, relayTake, stepError,
  type Callback, type HandoffRef, type Pending, type PhantomResponse, type RelayClient, type ReturnTo, type Store,
} from './phantomLink';

/** The app's handoff (localStorage in the home-screen app). */
export const HANDOFF_KEY = 'pokejam.phantom.handoff';
/** Safari's trip state between the two Phantom trips (localStorage in Safari: a redirect may open a new tab, and sessionStorage is per tab). */
export const LANDING_KEY = 'pokejam.phantom.landing';

export interface AppHandoff {
  v: 1;
  /** The relay key. */
  id: string;
  /** The handoff x25519 secret, base58. Never leaves this device. */
  secret: string;
  returnTo: ReturnTo;
  expiresAt: number;
}

const b58 = (b: Uint8Array) => base58Encode(b);

/** A short check code shown on both screens, so a player can tell that the Safari page belongs to the sign-in they started. */
export const handoffCode = (id: string): string => id.slice(-4).toUpperCase();

// ---------- The app ----------

/** The tap in the home-screen app: stores the handoff and returns the connect link. Synchronous, so it can run inside a tap. */
export function beginHandoff(store: Store, o: { loc: { origin: string; pathname: string }; returnTo: ReturnTo; now: number }): string {
  const dapp = randomBytes(32);
  const hand = randomBytes(32);
  const ref: HandoffRef = { id: newId(), pub: b58(boxPublicKey(hand)), secret: b58(dapp) };
  const rec: AppHandoff = { v: 1, id: ref.id, secret: b58(hand), returnTo: o.returnTo, expiresAt: o.now + FLOW_TTL_MS };
  store.setItem(HANDOFF_KEY, JSON.stringify(rec));
  const q = new URLSearchParams({
    app_url: o.loc.origin,
    dapp_encryption_public_key: b58(boxPublicKey(dapp)),
    redirect_link: redirectLink(o.loc, newId(), true, ref),
    cluster: 'mainnet-beta',
  });
  return `${PHANTOM_UL}/connect?${q}`;
}

export function clearHandoff(store: Store): void { try { store.removeItem(HANDOFF_KEY); } catch { /* nothing to clear */ } }

/** The handoff in progress. An expired or corrupt one is wiped; expiry is reported so the page can say so. */
export function loadHandoff(store: Store, now: number): { handoff: AppHandoff | null; expired: boolean } {
  let raw: string | null = null;
  try { raw = store.getItem(HANDOFF_KEY); } catch { return { handoff: null, expired: false }; }
  if (!raw) return { handoff: null, expired: false };
  try {
    const h = JSON.parse(raw) as AppHandoff;
    if (h && h.v === 1 && typeof h.id === 'string' && typeof h.secret === 'string' && typeof h.expiresAt === 'number') {
      if (h.expiresAt > now) return { handoff: { ...h, returnTo: h.returnTo === 'profile' ? 'profile' : 'ranked' }, expired: false };
      clearHandoff(store);
      return { handoff: null, expired: true };
    }
  } catch { /* corrupt: wiped below */ }
  clearHandoff(store);
  return { handoff: null, expired: false };
}

/** Opens what Safari sealed. Throws the same error for a wrong key, a tampered box and a malformed body. */
export function openRefreshToken(r: PhantomResponse, h: Pick<AppHandoff, 'secret'>): string {
  try {
    const plain = boxOpen(base58Decode(r.d ?? ''), base58Decode(r.n ?? ''), boxBefore(base58Decode(r.k ?? ''), base58Decode(h.secret)));
    const body: unknown = plain && JSON.parse(new TextDecoder().decode(plain));
    const rt = body && typeof body === 'object' ? (body as { rt?: unknown }).rt : undefined;
    if (typeof rt === 'string' && rt) return rt;
  } catch { /* the same answer as a bad tag */ }
  throw stepError('HB-READ');
}

export interface AppAuth {
  refreshSession(c: { refresh_token: string }): PromiseLike<{ data: { session: unknown } | null; error: unknown }>;
}

export type Restore = { kind: 'none' } | { kind: 'waiting' } | { kind: 'done'; returnTo: ReturnTo };

/**
 * One poll of the home-screen app. Single use: the relay row is deleted by the read, and the local handoff is wiped before the
 * token is applied, so nothing can be replayed. Wipes on every outcome but "waiting". Throws PhantomLinkError.
 */
export async function restoreInApp(store: Store, relay: RelayClient, auth: AppAuth, now: number): Promise<Restore> {
  const { handoff, expired } = loadHandoff(store, now);
  if (expired) throw stepError('EXP');
  if (!handoff) return { kind: 'none' };
  const answer = await relayTake(relay, handoff.id).catch(() => null);
  if (!answer) return { kind: 'waiting' };
  // Cancelled, or replaced by a newer attempt, during the request: this answer is no longer wanted.
  if (loadHandoff(store, now).handoff?.id !== handoff.id) return { kind: 'none' };
  clearHandoff(store);
  if (answer.e !== undefined) {
    throw phantomErrorFor(answer.e, 'connect');
  }
  const refresh_token = openRefreshToken(answer, handoff);
  let failure: unknown = null;
  try {
    const { data, error } = await auth.refreshSession({ refresh_token });
    if (error || !data?.session) failure = error ?? { status: 200 };
  } catch (e) { failure = e; }
  if (failure) throw authError('RF', failure);
  return { kind: 'done', returnTo: handoff.returnTo };
}

// ---------- Safari ----------

/** Safari's trip state lives under one key whatever the pending store asks for, apart from any in-tab sign-in. */
export function landingStore(store: Store): Store {
  return { getItem: () => store.getItem(LANDING_KEY), setItem: (_k, v) => store.setItem(LANDING_KEY, v), removeItem: () => store.removeItem(LANDING_KEY) };
}

/**
 * The trip a handoff callback belongs to. Second trip: Safari's own stored state, if it matches the id and was tapped. Otherwise
 * it is the first trip, and the dapp secret in the link is all it needs to read Phantom's answer. (A sign answer without stored
 * state lands here too and fails to decrypt, which is the right outcome.)
 */
export function landingTrip(cb: Callback, loaded: Pending | null, now: number): Pending | null {
  const h = cb.handoff;
  if (!h) return null;
  if (loaded && loaded.step === 'sign' && loaded.opened && loaded.id === cb.id && loaded.handoff?.id === h.id) return loaded;
  return { v: 1, id: cb.id, step: 'connect', app: true, opened: true, returnTo: 'ranked', expiresAt: now + FLOW_TTL_MS, secret: h.secret, handoff: h };
}

/** Seals the refresh token (and nothing else) to the app's handoff public key, with a one-use key of its own. */
export function sealRefreshToken(refreshToken: string, handoffPub: string): PhantomResponse {
  const eph = randomBytes(32);
  const nonce = randomBytes(24);
  const box = boxSeal(new TextEncoder().encode(JSON.stringify({ rt: refreshToken })), nonce, boxBefore(base58Decode(handoffPub), eph));
  return { k: b58(boxPublicKey(eph)), n: b58(nonce), d: b58(box) };
}

export interface SafariAuth {
  signInWithWeb3(c: { chain: 'solana'; message: string; signature: Uint8Array }): PromiseLike<{ data: { session: { refresh_token?: string } | null } | null; error: unknown }>;
  /** scope 'local': clears this browser only. It must not revoke the session the app is about to use. */
  signOut(o: { scope: 'local' }): PromiseLike<unknown>;
}

/**
 * Safari's last step: sign in, hand the refresh token to the app through the relay, and leave no session behind. The sign-out is
 * local only: the server session lives on, in the app. Throws PhantomLinkError.
 */
export async function finishInSafari(auth: SafariAuth, relay: RelayClient, o: { message: string; signature: Uint8Array; handoff: HandoffRef; keepSession?: boolean }): Promise<void> {
  const { data, error } = await auth.signInWithWeb3({ chain: 'solana', message: o.message, signature: o.signature });
  const rt = data?.session?.refresh_token;
  if (error || !rt) throw authError('W3', error ?? { status: 200 });
  // The app's own page finished this (a redirect that did open in the app): the session stays where it is.
  if (o.keepSession) return;
  const stored = await relayPut(relay, { id: o.handoff.id, app: true, response: sealRefreshToken(rt, o.handoff.pub) }).catch(() => false);
  try { await auth.signOut({ scope: 'local' }); } catch { /* the browser's copy is only a convenience */ }
  if (!stored) throw stepError('HO-PUT');
}

/**
 * Tells a waiting app that Safari gave up, so it stops waiting and shows the same step-specific message. `why` is the error (its
 * step key becomes a numeric code in the relay), or true for "cancelled". Best effort.
 */
export async function reportFailure(relay: RelayClient, h: HandoffRef, why: unknown): Promise<void> {
  const key = why === true || (why instanceof PhantomLinkError && why.cancelled) ? 'CXL' : why instanceof PhantomLinkError ? why.diag ?? 'UNK' : 'UNK';
  await relayPut(relay, { id: h.id, app: true, response: { e: relayCodeOf(key) } }).catch(() => false);
}

/** Wipes Safari's trip state. */
export function clearLanding(landing: Store): void { clearPending(landing); }
