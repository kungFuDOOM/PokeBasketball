// Paying with Phantom where no wallet is injected (Safari, the iOS home-screen app). Reuses the sign-in deeplink
// machinery: connect once, then /ul/v1/signAndSendTransaction, and the same relay so the signature gets back to the
// tab or home-screen app that started the payment. Pure logic: storage, clock and network are passed in.
//
// Phantom's docs mark signAndSendTransaction deprecated in favour of signTransaction, which only signs and does not
// submit. We still use signAndSendTransaction because this page cannot broadcast (the CSP blocks Solana RPC) and the
// existing confirm endpoints credit a payment only after reading it on-chain. A real phone has to confirm Phantom
// still submits this deeplink.
//
// The relay carries Phantom's encrypted reply only ({k, n, d} or an error code), never a session token, a booking id
// or a signature in the clear. The booking id confirmed is the one this device stored before it opened Phantom.
import { base58Decode, base58Encode, base64Decode, isAddress, randomBytes } from '../../supabase/functions/_shared/pack/bytes.ts';
import { boxPublicKey } from './nacl';
import { handoffCode } from './phantomHandoff';
import {
  FLOW_TTL_MS, PHANTOM_UL, openFrom, phantomErrorFor, redirectLink, relayTake, sealFor, stepError,
  type PhantomResponse, type RelayClient, type Store,
} from './phantomLink';

/** The Phantom session kept after connect (and after sign-in) so the next payment can skip connect. localStorage. */
export const SESSION_KEY = 'pokejam.phantom.session';
/** The payment trip in progress. sessionStorage in a tab (so a new tab relays); localStorage in the home-screen app. */
export const PAY_KEY = 'pokejam.phantom.pay';
/** Set when connect finished and no page was listening yet. The ads page or the shop reads it once. */
export const CONTINUE_KEY = 'pokejam.phantom.payContinue';
/** A blockhash is usable for about a minute. The approve link is rebuilt after this. */
export const TX_FRESH_MS = 45_000;

export type PayCluster = 'mainnet-beta' | 'devnet';
export type PayKind = 'ad-burn' | 'ad-usdc' | 'shield';

export interface PhantomSession {
  v: 1;
  /** The dapp x25519 secret, base58. Stays on this device. */
  secret: string;
  phantomPub: string;
  /** Phantom's session token. Stays on this device; the relay never sees it. */
  session: string;
  wallet: string;
  cluster: PayCluster;
}

export interface PayTrip {
  v: 1;
  /** One-time id: the redirect key and the relay key. */
  id: string;
  step: 'connect' | 'pay';
  app: boolean;
  opened: boolean;
  expiresAt: number;
  secret: string;
  cluster: PayCluster;
  kind: PayKind;
  /** Rank Shield sku, so a reloaded shop can show the right pack. */
  sku?: string;
  intentId?: string;
  phantomPub?: string;
  session?: string;
  wallet?: string;
  builtAt?: number;
  /** Unsigned transaction, base64, only while the approve link is fresh. */
  tx?: string;
}

export interface PayContinue { v: 1; payKind: PayKind; sku?: string }

export type PayOutcome =
  | { kind: 'connected'; session: PhantomSession; payKind: PayKind; sku?: string }
  | { kind: 'signed'; payKind: PayKind; intentId: string; signature: string; wallet: string };

const isCluster = (v: unknown): v is PayCluster => v === 'mainnet-beta' || v === 'devnet';
const isKind = (v: unknown): v is PayKind => v === 'ad-burn' || v === 'ad-usdc' || v === 'shield';

export function saveSession(store: Store, s: PhantomSession): void {
  store.setItem(SESSION_KEY, JSON.stringify(s));
}

export function clearSession(store: Store): void {
  try { store.removeItem(SESSION_KEY); } catch { /* nothing to clear */ }
}

/** The saved session for this cluster, or null when the wallet is not the one this payment is for. A mismatch is left stored. */
export function sessionFor(store: Store, cluster: PayCluster, wallet?: string): PhantomSession | null {
  const s = loadSession(store, cluster);
  if (!s || (wallet && s.wallet !== wallet)) return null;
  return s;
}

/** The saved session for this cluster, or null. A session for another cluster is left where it is. */
export function loadSession(store: Store, cluster: PayCluster): PhantomSession | null {
  let raw: string | null = null;
  try { raw = store.getItem(SESSION_KEY); } catch { return null; }
  if (!raw) return null;
  try {
    const s = JSON.parse(raw) as PhantomSession;
    if (s && s.v === 1 && typeof s.secret === 'string' && typeof s.phantomPub === 'string' && typeof s.session === 'string'
      && isAddress(s.wallet) && isCluster(s.cluster)) {
      // Another cluster's session stays put: a dev page must not wipe a mainnet sign-in.
      return s.cluster === cluster ? s : null;
    }
  } catch { /* corrupt: wiped below */ }
  clearSession(store);
  return null;
}

/** Keeps the connect result from a sign-in (mainnet, which is the only cluster sign-in uses). */
export function rememberSignInSession(store: Store, p: { secret: string; phantomPub?: string; session?: string; wallet?: string }): void {
  if (!p.phantomPub || !p.session || !isAddress(p.wallet)) return;
  saveSession(store, { v: 1, secret: p.secret, phantomPub: p.phantomPub, session: p.session, wallet: p.wallet, cluster: 'mainnet-beta' });
}

export function saveContinue(store: Store, c: Omit<PayContinue, 'v'>): void {
  store.setItem(CONTINUE_KEY, JSON.stringify({ v: 1, payKind: c.payKind, ...(c.sku ? { sku: c.sku } : {}) }));
}

/** Reads and deletes the continue flag. A second reader gets null. */
export function takeContinue(store: Store): PayContinue | null {
  let raw: string | null = null;
  try { raw = store.getItem(CONTINUE_KEY); } catch { return null; }
  try { store.removeItem(CONTINUE_KEY); } catch { /* already gone */ }
  if (!raw) return null;
  try {
    const c = JSON.parse(raw) as PayContinue;
    if (c && c.v === 1 && isKind(c.payKind)) return { v: 1, payKind: c.payKind, ...(typeof c.sku === 'string' && c.sku ? { sku: c.sku } : {}) };
  } catch { /* not ours */ }
  return null;
}

function savePay(store: Store, t: PayTrip): void { store.setItem(PAY_KEY, JSON.stringify(t)); }
export function clearPay(store: Store): void { try { store.removeItem(PAY_KEY); } catch { /* nothing to clear */ } }

export function loadPay(store: Store, now: number): { trip: PayTrip | null; expired: boolean } {
  let raw: string | null = null;
  try { raw = store.getItem(PAY_KEY); } catch { return { trip: null, expired: false }; }
  if (!raw) return { trip: null, expired: false };
  try {
    const t = JSON.parse(raw) as PayTrip;
    if (t && t.v === 1 && typeof t.id === 'string' && typeof t.secret === 'string' && (t.step === 'connect' || t.step === 'pay')
      && isCluster(t.cluster) && isKind(t.kind) && typeof t.expiresAt === 'number') {
      if (t.expiresAt > now) {
        return { trip: { ...t, app: t.app === true, opened: t.opened === true }, expired: false };
      }
      clearPay(store);
      return { trip: null, expired: true };
    }
  } catch { /* corrupt: wiped below */ }
  clearPay(store);
  return { trip: null, expired: false };
}

export interface PayLoc { origin: string; pathname: string }

/** The connect link. Synchronous, so a tap can follow it. Stores the trip first. */
export function beginPayConnect(store: Store, o: { loc: PayLoc; app: boolean; cluster: PayCluster; kind: PayKind; now: number; hash?: string; sku?: string }): string {
  const secret = randomBytes(32);
  const trip: PayTrip = {
    v: 1, id: base58Encode(randomBytes(32)), step: 'connect', app: o.app, opened: true,
    expiresAt: o.now + FLOW_TTL_MS, secret: base58Encode(secret), cluster: o.cluster, kind: o.kind,
    ...(o.sku ? { sku: o.sku } : {}),
  };
  savePay(store, trip);
  const q = new URLSearchParams({
    app_url: o.loc.origin,
    dapp_encryption_public_key: base58Encode(boxPublicKey(secret)),
    redirect_link: redirectLink(o.loc, trip.id, o.app, undefined, o.hash),
    cluster: o.cluster,
  });
  return `${PHANTOM_UL}/connect?${q}`;
}

/**
 * Arms the sign-and-send step on a session this device already has. The transaction was built by the server.
 * `opened` stays false until the player taps the link.
 */
export function armPay(store: Store, o: {
  session: PhantomSession; kind: PayKind; intentId: string; txBase64: string; app: boolean; now: number; sku?: string;
}): PayTrip {
  if (!o.intentId || !o.txBase64) throw stepError('STATE');
  const trip: PayTrip = {
    v: 1, id: base58Encode(randomBytes(32)), step: 'pay', app: o.app, opened: false,
    expiresAt: o.now + FLOW_TTL_MS, secret: o.session.secret, cluster: o.session.cluster, kind: o.kind,
    intentId: o.intentId, phantomPub: o.session.phantomPub, session: o.session.session, wallet: o.session.wallet,
    builtAt: o.now, tx: o.txBase64, ...(o.sku ? { sku: o.sku } : {}),
  };
  savePay(store, trip);
  return trip;
}

export const payFresh = (t: PayTrip, now: number): boolean =>
  t.step === 'pay' && typeof t.builtAt === 'number' && now - t.builtAt >= 0 && now - t.builtAt < TX_FRESH_MS && !!t.tx && !!t.intentId;

export function markPayOpened(store: Store, now: number): PayTrip | null {
  const { trip } = loadPay(store, now);
  if (!trip || trip.step !== 'pay') return null;
  const next = { ...trip, opened: true };
  savePay(store, next);
  return next;
}

/** The signAndSendTransaction link for an armed trip. The session and the transaction are inside the encrypted payload. */
export function signAndSendLink(trip: PayTrip, loc: PayLoc, hash?: string): string {
  if (trip.step !== 'pay' || !trip.tx || !trip.session || !trip.phantomPub || !trip.intentId) throw stepError('STATE');
  const sealed = sealFor(trip.phantomPub, trip.secret, { transaction: base58Encode(base64Decode(trip.tx)), session: trip.session });
  const q = new URLSearchParams({
    dapp_encryption_public_key: base58Encode(boxPublicKey(base58Decode(trip.secret))),
    nonce: sealed.nonce,
    redirect_link: redirectLink(loc, trip.id, trip.app, undefined, hash),
    payload: sealed.payload,
  });
  return `${PHANTOM_UL}/signAndSendTransaction?${q}`;
}

export const payCode = (trip: PayTrip): string => handoffCode(trip.id);

/**
 * Applies Phantom's answer to this trip. The id is used up first. The confirmed booking is `trip.intentId`, never
 * anything found in the decrypted body. Throws PhantomLinkError.
 */
export function applyPay(tripStore: Store, sessionStore: Store, trip: PayTrip, r: PhantomResponse, now: number): PayOutcome {
  clearPay(tripStore);
  if (trip.expiresAt <= now) throw stepError('EXP');
  if (r.e !== undefined) {
    if (trip.step === 'pay' && r.e !== '4001') clearSession(sessionStore);
    throw phantomErrorFor(r.e, trip.step === 'connect' ? 'connect' : 'sign');
  }
  if (trip.step === 'connect') {
    if (!r.k) throw stepError('CN-READ');
    const body = openFrom(r.k, trip.secret, r, 'CN-READ');
    const wallet = body.public_key;
    const session = body.session;
    if (!isAddress(wallet) || typeof session !== 'string' || !session) throw stepError('CN-READ');
    const saved: PhantomSession = { v: 1, secret: trip.secret, phantomPub: r.k, session, wallet, cluster: trip.cluster };
    saveSession(sessionStore, saved);
    return { kind: 'connected', session: saved, payKind: trip.kind, ...(trip.sku ? { sku: trip.sku } : {}) };
  }
  if (!trip.phantomPub || !trip.intentId || !trip.wallet) throw stepError('STATE');
  const body = openFrom(trip.phantomPub, trip.secret, r, 'SG-READ');
  const sig = body.signature;
  let signature = '';
  try {
    if (typeof sig === 'string' && base58Decode(sig).length === 64) signature = sig;
  } catch { /* reported below */ }
  if (!signature) throw stepError('SG-READ');
  return { kind: 'signed', payKind: trip.kind, intentId: trip.intentId, signature, wallet: trip.wallet };
}

/** Phantom's answer for the trip in this store, or null when this store didn't start it. */
export function takePayDirect(tripStore: Store, sessionStore: Store, cb: { id: string; response: PhantomResponse }, now: number): PayOutcome | null {
  const { trip } = loadPay(tripStore, now);
  if (!trip || !trip.opened || trip.id !== cb.id) return null;
  return applyPay(tripStore, sessionStore, trip, cb.response, now);
}

/** One poll of the relay for the trip in this store. */
export async function pullPay(tripStore: Store, sessionStore: Store, relay: RelayClient, now: number): Promise<PayOutcome | 'waiting' | 'none'> {
  const { trip, expired } = loadPay(tripStore, now);
  if (expired) throw stepError('EXP');
  if (!trip?.opened) return 'none';
  const answer = await relayTake(relay, trip.id).catch(() => null);
  if (!answer) return 'waiting';
  if (loadPay(tripStore, now).trip?.id !== trip.id) return 'none';
  return applyPay(tripStore, sessionStore, trip, answer, now);
}

/** What the server is asked to confirm. Only the intent this device armed, with the signature Phantom returned for it. */
export function confirmBody(o: PayOutcome): { intentId: string; signature: string } | null {
  if (o.kind !== 'signed') return null;
  return { intentId: o.intentId, signature: o.signature };
}
