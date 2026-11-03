// "Sign in with Phantom" where no wallet is injected (iOS Safari, the iOS home-screen app, Android Chrome), using Phantom's
// universal-link deeplinks: connect, then signMessage, each one a trip to the Phantom app and back. Pure logic: no DOM at import,
// and storage, clock and network are passed in. phantomSheet.ts draws it. See docs/phantom-mobile-signin.md.
//
// Secrets (the dapp x25519 key, Phantom's session token) stay in this tab's sessionStorage and are never logged. Each trip has a
// random one-time id in the redirect link: it rejects unsolicited or replayed callbacks and keys the relay.
import { base58Decode, base58Encode, isAddress, randomBytes } from '../../supabase/functions/_shared/pack/bytes.ts';
import { boxBefore, boxOpen, boxPublicKey, boxSeal } from './nacl';
import { SIGN_IN_STATEMENT } from './phantom';
import { authKey, classifyAuthError, diagMessage, keyFromRelay } from './phantomDiag';

export const PHANTOM_UL = 'https://phantom.com/ul/v1';
/** The whole sign-in, and the lifetime of the signed message. */
export const FLOW_TTL_MS = 10 * 60_000;
export const PENDING_KEY = 'pokejam.phantom.pending';
/** The query marker on the way back. public/phantom-return.js strips it, and Phantom's params, before anything else runs. */
export const RETURN_PARAM = 'pj_phantom';
export const APP_PARAM = 'pj_app';
/** Home-screen sign-ins: what Safari needs to carry on alone. See phantomHandoff.ts. */
export const HANDOFF_ID_PARAM = 'pj_h';
export const HANDOFF_PUB_PARAM = 'pj_hk';
export const HANDOFF_SECRET_PARAM = 'pj_ds';

export type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
export type ReturnTo = 'ranked' | 'profile';

/** Rides in the redirect link of a home-screen sign-in: the app's handoff id and PUBLIC key, and the dapp secret for this one trip. */
export interface HandoffRef { id: string; pub: string; secret: string }

export interface Pending {
  v: 1;
  /** The one-time id of the trip in progress: the state check, and the relay key. */
  id: string;
  step: 'connect' | 'sign';
  /** Started in a home-screen app: only changes the wording of the landing page. */
  app: boolean;
  /** The player has tapped through to Phantom for this step, so a callback is expected. */
  opened: boolean;
  returnTo: ReturnTo;
  expiresAt: number;
  /** The dapp's x25519 secret key, base58. */
  secret: string;
  phantomPub?: string;
  session?: string;
  wallet?: string;
  message?: string;
  nonce?: string;
  /** Set when Safari is finishing a home-screen app's sign-in. */
  handoff?: HandoffRef;
}

/** Phantom's answer, trimmed to fields we use. Also the exact shape stored in the relay: ciphertext, or an error code. */
export interface PhantomResponse { k?: string; n?: string; d?: string; e?: string }
export interface Callback { id: string; app: boolean; response: PhantomResponse; handoff?: HandoffRef }

export class PhantomLinkError extends Error {
  name = 'PhantomLinkError';
  /** `diag` is the step key behind the on-screen code (phantomDiag.ts), e.g. 'CN-READ' or 'W3-400-CHAIN'. */
  constructor(message: string, public cancelled = false, public diag?: string) { super(message); }
}

/** An error for one step: the plain-words message and the key for the diagnostic code. 'CXL' is the cancelled one. */
export const stepError = (key: string): PhantomLinkError => new PhantomLinkError(diagMessage(key), key === 'CXL', key);
/** A failed signInWithWeb3 (step 'W3') or refreshSession (step 'RF'): keeps the HTTP status and a reason token, never the raw text. */
export const authError = (step: 'W3' | 'RF', err: unknown): PhantomLinkError => {
  const { status, reason } = classifyAuthError(err);
  return stepError(authKey(step, status, reason));
};
/** What Phantom (or Safari, through the relay) reported as an error code. 4001 is the player saying no. */
export const phantomErrorFor = (code: string, step: 'connect' | 'sign'): PhantomLinkError => {
  const key = keyFromRelay(code);
  return stepError(key === 'PH-UNK' && code !== '1' ? (step === 'connect' ? 'CN-PH' : 'SG-PH') : key);
};

const ID_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const B58_RE = /^[1-9A-HJ-NP-Za-km-z]{1,3500}$/;
const CODE_RE = /^-?\d{1,6}$/;

type StandaloneHost = { navigator?: { standalone?: boolean }; matchMedia?: (q: string) => { matches: boolean } };
export type StandaloneSignal = 'nav' | 'standalone' | 'fullscreen' | 'minimal-ui';

/** Which signal says this is an installed web app: iOS's navigator.standalone first, then the display-mode media queries. Null when none does. */
export function standaloneSignal(w: StandaloneHost): StandaloneSignal | null {
  if (w.navigator?.standalone === true) return 'nav';
  for (const mode of ['standalone', 'fullscreen', 'minimal-ui'] as const) {
    try { if (w.matchMedia?.(`(display-mode: ${mode})`).matches) return mode; } catch { /* try the next */ }
  }
  return null;
}

/** A home-screen web app, where Phantom's redirect opens in the browser rather than back in this app. */
export const isStandalone = (w: StandaloneHost): boolean => standaloneSignal(w) !== null;

// ---------- Sign in with Solana message ----------

/** Supabase Auth only accepts a Chain ID of the form solana:(main|dev|test|local)net, or none at all. Plain "mainnet" is a 400. */
export const SIWS_CHAIN_ID = 'solana:mainnet';

/** Builds the message the way supabase-js does for a wallet with signMessage, so Supabase verifies it the same way. */
export function buildSiwsMessage(o: { host: string; uri: string; address: string; nonce: string; issuedAt: number; expiresAt: number }): string {
  return [
    `${o.host} wants you to sign in with your Solana account:`,
    o.address,
    '',
    SIGN_IN_STATEMENT,
    '',
    'Version: 1',
    `URI: ${o.uri}`,
    `Issued At: ${new Date(o.issuedAt).toISOString()}`,
    `Expiration Time: ${new Date(o.expiresAt).toISOString()}`,
    `Chain ID: ${SIWS_CHAIN_ID}`,
    `Nonce: ${o.nonce}`,
  ].join('\n');
}

/** Checks our own message before it goes to the server: right wallet, right nonce, not expired. */
export function checkSiwsMessage(message: string, want: { address: string; nonce: string; now: number }): void {
  const lines = message.split('\n');
  const field = (name: string) => lines.find((l) => l.startsWith(`${name}: `))?.slice(name.length + 2);
  const exp = Date.parse(field('Expiration Time') ?? '');
  if (lines[1] !== want.address || field('Nonce') !== want.nonce) throw stepError('MIS');
  if (!Number.isFinite(exp) || exp <= want.now) throw stepError('EXP');
}

// ---------- Encryption ----------

function seal(payload: unknown, shared: Uint8Array): { nonce: string; payload: string } {
  const nonce = randomBytes(24);
  return { nonce: base58Encode(nonce), payload: base58Encode(boxSeal(new TextEncoder().encode(JSON.stringify(payload)), nonce, shared)) };
}

function open(r: PhantomResponse, phantomPub: string, secret: string, onFail: string): Record<string, unknown> {
  try {
    const plain = boxOpen(base58Decode(r.d ?? ''), base58Decode(r.n ?? ''), boxBefore(base58Decode(phantomPub), base58Decode(secret)));
    const parsed: unknown = plain && JSON.parse(new TextDecoder().decode(plain));
    if (parsed && typeof parsed === 'object') return parsed as Record<string, unknown>;
  } catch { /* the same answer as a bad tag */ }
  throw stepError(onFail);
}

/** Encrypts JSON for Phantom with this dapp key and Phantom's key. The same box signMessage uses. */
export function sealFor(phantomPub: string, secret: string, payload: unknown): { nonce: string; payload: string } {
  return seal(payload, boxBefore(base58Decode(phantomPub), base58Decode(secret)));
}

/** Decrypts Phantom's answer. `onFail` is the step key thrown when it can't be read. */
export function openFrom(phantomPub: string, secret: string, r: PhantomResponse, onFail: string): Record<string, unknown> {
  return open(r, phantomPub, secret, onFail);
}

// ---------- Links ----------

export function redirectLink(loc: { origin: string; pathname: string }, id: string, app: boolean, h?: HandoffRef, hash?: string): string {
  const hand = h ? `&${HANDOFF_ID_PARAM}=${h.id}&${HANDOFF_PUB_PARAM}=${h.pub}&${HANDOFF_SECRET_PARAM}=${h.secret}` : '';
  const frag = hash && /^#[A-Za-z0-9_-]*$/.test(hash) ? hash : '';
  return `${loc.origin}${loc.pathname}?${RETURN_PARAM}=${id}${app ? `&${APP_PARAM}=1` : ''}${hand}${frag}`;
}
export const newId = () => base58Encode(randomBytes(32));

/** Starts a sign-in: stores a fresh key and id in this tab and returns the connect link. Synchronous, so it can run inside a tap. */
export function beginConnect(store: Store, o: { loc: { origin: string; pathname: string }; app: boolean; returnTo: ReturnTo; now: number }): string {
  const secret = randomBytes(32);
  const p: Pending = { v: 1, id: newId(), step: 'connect', app: o.app, opened: true, returnTo: o.returnTo, expiresAt: o.now + FLOW_TTL_MS, secret: base58Encode(secret) };
  savePending(store, p);
  const q = new URLSearchParams({
    app_url: o.loc.origin,
    dapp_encryption_public_key: base58Encode(boxPublicKey(secret)),
    redirect_link: redirectLink(o.loc, p.id, o.app),
    cluster: 'mainnet-beta',
  });
  return `${PHANTOM_UL}/connect?${q}`;
}

/** The signMessage link for a pending 'sign' step. */
export function signLink(p: Pending, loc: { origin: string; pathname: string }): string {
  if (p.step !== 'sign' || !p.message || !p.session || !p.phantomPub) throw stepError('STATE');
  const sealed = seal({ message: base58Encode(new TextEncoder().encode(p.message)), session: p.session, display: 'utf8' }, boxBefore(base58Decode(p.phantomPub), base58Decode(p.secret)));
  const q = new URLSearchParams({
    dapp_encryption_public_key: base58Encode(boxPublicKey(base58Decode(p.secret))),
    nonce: sealed.nonce,
    redirect_link: redirectLink(loc, p.id, p.app, p.handoff),
    payload: sealed.payload,
  });
  return `${PHANTOM_UL}/signMessage?${q}`;
}

// ---------- Storage ----------

export function savePending(store: Store, p: Pending): void { store.setItem(PENDING_KEY, JSON.stringify(p)); }
export function clearPending(store: Store): void { try { store.removeItem(PENDING_KEY); } catch { /* nothing to clear */ } }

/** The sign-in in progress in this tab. An expired one is wiped, and reported so the page can say so. */
export function loadPending(store: Store, now: number): { pending: Pending | null; expired: boolean } {
  let raw: string | null = null;
  try { raw = store.getItem(PENDING_KEY); } catch { return { pending: null, expired: false }; }
  if (!raw) return { pending: null, expired: false };
  try {
    // A record left by an older build may have other fields missing or shaped differently: only accept what this build can use.
    const p = JSON.parse(raw) as Pending;
    if (p && p.v === 1 && typeof p.id === 'string' && typeof p.secret === 'string' && (p.step === 'connect' || p.step === 'sign') && typeof p.expiresAt === 'number') {
      if (p.expiresAt > now) {
        const h = p.handoff;
        const handoff = h && typeof h.id === 'string' && typeof h.pub === 'string' && typeof h.secret === 'string' ? h : undefined;
        const { handoff: _drop, ...rest } = p;
        return { pending: { ...rest, app: p.app === true, opened: p.opened === true, returnTo: p.returnTo === 'profile' ? 'profile' : 'ranked', ...(handoff ? { handoff } : {}) }, expired: false };
      }
      clearPending(store);
      return { pending: null, expired: true };
    }
  } catch { /* corrupt: wiped below */ }
  clearPending(store);
  return { pending: null, expired: false };
}

// ---------- Coming back ----------

/** Reads Phantom's callback out of a query string. Null when it isn't one, or has a field of the wrong shape. Phantom's free-text errorMessage is dropped: it's attacker-writable and we have our own copy. */
export function parseCallback(search: string): Callback | null {
  // Tolerates a second "?" in case a wallet appends its params without noticing the query already in the redirect link.
  const q = new URLSearchParams(search.replace(/^\?/, '').replace(/\?/g, '&'));
  const id = q.get(RETURN_PARAM);
  if (!id || !ID_RE.test(id)) return null;
  const app = q.get(APP_PARAM) === '1';
  // All three or none: a half-formed handoff is not one.
  const hid = q.get(HANDOFF_ID_PARAM), hpub = q.get(HANDOFF_PUB_PARAM), hsec = q.get(HANDOFF_SECRET_PARAM);
  let handoff: HandoffRef | undefined;
  if (hid !== null || hpub !== null || hsec !== null) {
    if (!hid || !hpub || !hsec || !ID_RE.test(hid) || !ID_RE.test(hpub) || !ID_RE.test(hsec)) return null;
    handoff = { id: hid, pub: hpub, secret: hsec };
  }
  const e = q.get('errorCode');
  if (e !== null) return CODE_RE.test(e) ? { id, app, response: { e }, ...(handoff ? { handoff } : {}) } : null;
  const n = q.get('nonce');
  const d = q.get('data');
  const k = q.get('phantom_encryption_public_key');
  if (!n || !d || !B58_RE.test(n) || !B58_RE.test(d) || (k !== null && !ID_RE.test(k))) return null;
  return { id, app, response: k ? { k, n, d } : { n, d }, ...(handoff ? { handoff } : {}) };
}

/**
 * What a landing page does with a callback. 'direct': it belongs to the trip in progress in this tab. 'relay': this tab doesn't
 * hold that key (a home-screen app's redirect landing in Safari, or a browser that opened a new tab, as sessionStorage is per tab),
 * so pass the ciphertext to the tab that does. Local state is untouched, so a forged or replayed callback changes nothing here.
 */
export function routeCallback(cb: Callback, pending: Pending | null): 'direct' | 'relay' {
  return pending && pending.opened && pending.id === cb.id ? 'direct' : 'relay';
}

export type Advance =
  | { kind: 'need-sign'; pending: Pending }
  | { kind: 'signed'; message: string; signature: Uint8Array };

/**
 * Applies Phantom's answer to the trip in progress. The id is used up first, so the same callback can't be applied twice; any
 * failure wipes the key and session. Throws PhantomLinkError.
 */
export function advance(store: Store, p: Pending, r: PhantomResponse, o: { host: string; uri: string; now: number }): Advance {
  clearPending(store);
  if (p.expiresAt <= o.now) throw stepError('EXP');
  if (r.e !== undefined) {
    throw phantomErrorFor(r.e, p.step);
  }
  if (p.step === 'connect') {
    if (!r.k) throw stepError('CN-READ');
    const body = open(r, r.k, p.secret, 'CN-READ');
    const wallet = body.public_key;
    const session = body.session;
    if (!isAddress(wallet) || typeof session !== 'string' || !session) throw stepError('CN-READ');
    const expiresAt = o.now + FLOW_TTL_MS;
    const nonce = base58Encode(randomBytes(16));
    const next: Pending = {
      ...p, id: newId(), step: 'sign', opened: false, expiresAt, phantomPub: r.k, session, wallet, nonce,
      message: buildSiwsMessage({ host: o.host, uri: o.uri, address: wallet, nonce, issuedAt: o.now, expiresAt }),
    };
    savePending(store, next);
    return { kind: 'need-sign', pending: next };
  }
  if (!p.phantomPub || !p.message || !p.wallet || !p.nonce) throw stepError('STATE');
  const sig = open(r, p.phantomPub, p.secret, 'SG-READ').signature;
  let signature: Uint8Array | null = null;
  try { signature = typeof sig === 'string' ? base58Decode(sig) : null; } catch { /* reported below */ }
  if (!signature || signature.length !== 64) throw stepError('SG-READ');
  checkSiwsMessage(p.message, { address: p.wallet, nonce: p.nonce, now: o.now });
  return { kind: 'signed', message: p.message, signature };
}

// ---------- Relay ----------

/** The part of the Supabase client the relay uses. Both calls work without a session: Safari may have none. */
export interface RelayClient {
  rpc(fn: string, args: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}

/** Hands a callback to the tab that holds the key. Only ciphertext or an error code is ever sent. */
export async function relayPut(sb: RelayClient, cb: Callback): Promise<boolean> {
  const { k, n, d, e } = cb.response;
  const payload: PhantomResponse = e !== undefined ? { e } : { ...(k ? { k } : {}), n, d };
  const { data, error } = await sb.rpc('pokejam_phantom_relay_put', { p_id: cb.id, p_payload: payload });
  return !error && data === true;
}

/** Fetches and deletes what the landing page left for this id, or null when nothing is there yet. */
export async function relayTake(sb: RelayClient, id: string): Promise<PhantomResponse | null> {
  const { data, error } = await sb.rpc('pokejam_phantom_relay_take', { p_id: id });
  if (error || !data || typeof data !== 'object') return null;
  const r = data as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
  return { k: str(r.k), n: str(r.n), d: str(r.d), e: str(r.e) };
}
