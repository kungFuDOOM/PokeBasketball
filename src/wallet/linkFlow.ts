// Link a Phantom wallet to the account that is already signed in. Sign-in is a different path (phantomLink.ts) and is not used here.
// Desktop and the Phantom in-app browser sign with the injected provider. Everywhere else, Phantom's universal link
// opens Safari, so a home-screen app seals the signature back through the same relay and submits it with its own session.
import { USER_ID_RE, buildLinkMessage, checkLinkMessage } from '../../supabase/functions/_shared/wallet/link';
import { base58Decode, base58Encode, randomBytes } from '../../supabase/functions/_shared/pack/bytes.ts';
import { boxBefore, boxOpen, boxPublicKey, boxSeal } from './nacl';
import {
  FLOW_TTL_MS, LINK_PENDING_KEY, PHANTOM_UL, beginConnect, newId, redirectLink, relayPut, relayTake,
  type HandoffRef, type PhantomResponse, type RelayClient, type ReturnTo, type Store,
} from './phantomLink';

export { LINK_PENDING_KEY };
export const LINK_HANDOFF_KEY = 'pokejam.link.handoff';
export const LINK_LANDING_KEY = 'pokejam.link.landing';
const ID_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const B58_RE = /^[1-9A-HJ-NP-Za-km-z]{1,3500}$/;
const CODE_RE = /^-?\d{1,6}$/;

export interface LinkHandoff {
  v: 1;
  id: string;
  secret: string;
  userId: string;
  returnTo: ReturnTo;
  expiresAt: number;
}

export interface LinkCallback {
  id: string;
  app: boolean;
  response: PhantomResponse;
  handoff?: HandoffRef;
  userId?: string;
}

const b58 = (b: Uint8Array) => base58Encode(b);

/** The connect link for a same-browser link (Safari or Chrome). The trip is kept in localStorage so a new tab can finish it. */
export function beginLinkInBrowser(store: Store, o: { loc: { origin: string; pathname: string }; userId: string; now: number }): string {
  if (!USER_ID_RE.test(o.userId)) throw new Error('Sign in before linking a wallet.');
  return beginConnect(store, { loc: o.loc, app: false, returnTo: 'ranked', now: o.now, purpose: 'link', userId: o.userId });
}

/** The home-screen app: Safari does the Phantom trips, because the redirect never comes back to the app. */
export function beginLinkHandoff(store: Store, o: { loc: { origin: string; pathname: string }; userId: string; returnTo: ReturnTo; now: number }): string {
  if (!USER_ID_RE.test(o.userId)) throw new Error('Sign in before linking a wallet.');
  const dapp = randomBytes(32);
  const hand = randomBytes(32);
  const ref: HandoffRef = { id: newId(), pub: b58(boxPublicKey(hand)), secret: b58(dapp) };
  const rec: LinkHandoff = { v: 1, id: ref.id, secret: b58(hand), userId: o.userId, returnTo: o.returnTo, expiresAt: o.now + FLOW_TTL_MS };
  store.setItem(LINK_HANDOFF_KEY, JSON.stringify(rec));
  const q = new URLSearchParams({
    app_url: o.loc.origin,
    dapp_encryption_public_key: b58(boxPublicKey(dapp)),
    redirect_link: redirectLink(o.loc, newId(), true, ref, 'link', o.userId),
    cluster: 'mainnet-beta',
  });
  return `${PHANTOM_UL}/connect?${q}`;
}

export function loadLinkHandoff(store: Store, now: number): { handoff: LinkHandoff | null; expired: boolean } {
  let raw: string | null = null;
  try { raw = store.getItem(LINK_HANDOFF_KEY); } catch { return { handoff: null, expired: false }; }
  if (!raw) return { handoff: null, expired: false };
  try {
    const h = JSON.parse(raw) as LinkHandoff;
    if (h && h.v === 1 && typeof h.id === 'string' && typeof h.secret === 'string' && USER_ID_RE.test(h.userId) && typeof h.expiresAt === 'number') {
      if (h.expiresAt > now) return { handoff: { ...h, returnTo: h.returnTo === 'profile' ? 'profile' : 'ranked' }, expired: false };
      clearLinkHandoff(store);
      return { handoff: null, expired: true };
    }
  } catch { /* corrupt */ }
  clearLinkHandoff(store);
  return { handoff: null, expired: false };
}

export function clearLinkHandoff(store: Store): void {
  try { store.removeItem(LINK_HANDOFF_KEY); } catch { /* ignore */ }
}

/** Phantom's answer on a link redirect. Not a sign-in callback: different parameter names, so the sign-in page ignores it. */
export function parseLinkCallback(search: string): LinkCallback | null {
  const q = new URLSearchParams(search.replace(/^\?/, '').replace(/\?/g, '&'));
  const id = q.get('pj_wlink');
  if (!id || !ID_RE.test(id)) return null;
  const app = q.get('pj_wapp') === '1';
  const uid = q.get('pj_uid');
  const userId = uid && USER_ID_RE.test(uid) ? uid : undefined;
  const hid = q.get('pj_wh'), hpub = q.get('pj_wk'), hsec = q.get('pj_ws');
  let handoff: HandoffRef | undefined;
  if (hid !== null || hpub !== null || hsec !== null) {
    if (!hid || !hpub || !hsec || !ID_RE.test(hid) || !ID_RE.test(hpub) || !ID_RE.test(hsec)) return null;
    handoff = { id: hid, pub: hpub, secret: hsec };
  }
  const e = q.get('errorCode');
  if (e !== null) return CODE_RE.test(e) ? { id, app, response: { e }, ...(handoff ? { handoff } : {}), ...(userId ? { userId } : {}) } : null;
  const n = q.get('nonce');
  const d = q.get('data');
  const k = q.get('phantom_encryption_public_key');
  if (!n || !d || !B58_RE.test(n) || !B58_RE.test(d) || (k !== null && !ID_RE.test(k))) return null;
  return { id, app, response: k ? { k, n, d } : { n, d }, ...(handoff ? { handoff } : {}), ...(userId ? { userId } : {}) };
}

/** Seals the signed message for the app. The relay only ever sees this box. */
export function sealLinkResult(message: string, signature: Uint8Array, pub: string): PhantomResponse {
  const eph = randomBytes(32);
  const nonce = randomBytes(24);
  const box = boxSeal(new TextEncoder().encode(JSON.stringify({ m: message, s: base58Encode(signature) })), nonce, boxBefore(base58Decode(pub), eph));
  return { k: b58(boxPublicKey(eph)), n: b58(nonce), d: b58(box) };
}

export function openLinkResult(r: PhantomResponse, secret: string): { message: string; signature: string } {
  try {
    const plain = boxOpen(base58Decode(r.d ?? ''), base58Decode(r.n ?? ''), boxBefore(base58Decode(r.k ?? ''), base58Decode(secret)));
    const body: unknown = plain && JSON.parse(new TextDecoder().decode(plain));
    const m = body && typeof body === 'object' ? (body as { m?: unknown; s?: unknown }).m : undefined;
    const s = body && typeof body === 'object' ? (body as { m?: unknown; s?: unknown }).s : undefined;
    if (typeof m === 'string' && typeof s === 'string' && m && s) return { message: m, signature: s };
  } catch { /* same answer as a bad tag */ }
  throw new Error('The app couldn\'t read the handed-back wallet link.');
}

export async function putLinkResult(relay: RelayClient, id: string, message: string, signature: Uint8Array, pub: string): Promise<void> {
  const stored = await relayPut(relay, { id, app: true, response: sealLinkResult(message, signature, pub) }).catch(() => false);
  if (!stored) throw new Error('Could not hand the wallet link back to the app.');
}

export async function takeLinkResult(relay: RelayClient, h: LinkHandoff): Promise<{ message: string; signature: string } | null> {
  const answer = await relayTake(relay, h.id).catch(() => null);
  if (!answer) return null;
  if (answer.e !== undefined) throw new Error('Linking was cancelled.');
  return openLinkResult(answer, h.secret);
}

/** The message an injected wallet signs. Ten minutes, same window the server allows. */
export function injectedLinkMessage(o: { host: string; uri: string; address: string; userId: string; now: number }): { message: string; nonce: string } {
  const nonce = base58Encode(randomBytes(16));
  const message = buildLinkMessage({ ...o, nonce, issuedAt: o.now, expiresAt: o.now + FLOW_TTL_MS });
  return { message, nonce };
}

/** Confirms the opened message really belongs to this account before it is sent to the server. */
export function assertLinkForUser(message: string, userId: string, now: number): void {
  const fields = message.split('\n');
  const address = fields[1] ?? '';
  const nonce = /^Nonce: ([1-9A-HJ-NP-Za-km-z]{16,64})$/.exec(fields[8] ?? '')?.[1] ?? '';
  const c = checkLinkMessage(message, { address, userId, nonce, now });
  if (c !== 'ok') throw new Error(c === 'expired' ? 'That link request expired. Try again.' : 'That link request does not match this account.');
}
