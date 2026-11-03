// @ts-ignore Node's fs has no type declarations in this project.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { base58Decode, base58Encode, base64Encode, randomBytes } from '../../supabase/functions/_shared/pack/bytes.ts';
import { boxBefore, boxOpen, boxPublicKey, boxSeal } from './nacl';
import { parseCallback, relayPut, routeCallback, type Callback, type PhantomResponse, type RelayClient, type Store } from './phantomLink';
import {
  TX_FRESH_MS, applyPay, armPay, beginPayConnect, confirmBody, loadSession, markPayOpened, payFresh, pullPay, rememberSignInSession,
  sessionFor, signAndSendLink, takePayDirect, type PayTrip,
} from './phantomPay';

const WALLET_A = '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV';
const WALLET_B = '5njibWvkiFg4LSyzq4ySFhyCsFEF4YhTqRLJo8Z9q16p';
const SESSION = 'phantom-session-token-secret';
const TX = base64Encode(Uint8Array.from([1, 2, 3, 4, 9, 8, 7]));
const INTENT_A = '11111111-1111-1111-1111-111111111111';
const INTENT_B = '22222222-2222-2222-2222-222222222222';
const loc = { origin: 'https://pokejam.xyz', pathname: '/' };
const NOW = Date.parse('2026-11-03T12:00:00.000Z');

function memStore(): Store & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
}

function fakePhantom() {
  const secret = randomBytes(32);
  const pub = base58Encode(boxPublicKey(secret));
  const answer = (dappPub: string, body: unknown) => {
    const nonce = randomBytes(24);
    return { nonce: base58Encode(nonce), data: base58Encode(boxSeal(new TextEncoder().encode(JSON.stringify(body)), nonce, boxBefore(base58Decode(dappPub), secret))) };
  };
  const toSearch = (redirect: string, params: Record<string, string>) => {
    const u = new URL(redirect);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.search;
  };
  return {
    pub,
    connect(link: string, wallet = WALLET_A): string {
      const q = new URL(link).searchParams;
      return toSearch(q.get('redirect_link')!, { phantom_encryption_public_key: pub, ...answer(q.get('dapp_encryption_public_key')!, { public_key: wallet, session: SESSION }) });
    },
    readPayload(link: string) {
      const q = new URL(link).searchParams;
      const plain = boxOpen(base58Decode(q.get('payload')!), base58Decode(q.get('nonce')!), boxBefore(base58Decode(q.get('dapp_encryption_public_key')!), secret));
      return JSON.parse(new TextDecoder().decode(plain!)) as { transaction: string; session: string };
    },
    /** Answers signAndSendTransaction. `extra` is attacker-controlled junk inside the encrypted body. */
    pay(link: string, signature: Uint8Array, extra: Record<string, unknown> = {}): string {
      const q = new URL(link).searchParams;
      return toSearch(q.get('redirect_link')!, answer(q.get('dapp_encryption_public_key')!, { signature: base58Encode(signature), ...extra }));
    },
    error(link: string, code: string): string {
      return toSearch(new URL(link).searchParams.get('redirect_link')!, { errorCode: code });
    },
  };
}

function mockRelay() {
  const rows = new Map<string, PhantomResponse>();
  const sb: RelayClient = {
    rpc: async (fn, args) => {
      const id = String(args.p_id);
      if (fn.endsWith('_put')) {
        if (rows.has(id)) return { data: false, error: null };
        rows.set(id, args.p_payload as PhantomResponse);
        return { data: true, error: null };
      }
      const row = rows.get(id) ?? null;
      if (row) rows.delete(id);
      return { data: row, error: null };
    },
  };
  return { sb, rows };
}

function connect(wallet = WALLET_A) {
  const ph = fakePhantom();
  const tripStore = memStore();
  const sessions = memStore();
  const link = beginPayConnect(tripStore, { loc, app: true, cluster: 'mainnet-beta', kind: 'ad-burn', now: NOW, hash: '#advertise' });
  const cb = parseCallback(ph.connect(link, wallet))!;
  const out = applyPay(tripStore, sessions, loadOpen(tripStore), cb.response, NOW);
  if (out.kind !== 'connected') throw new Error('expected connected');
  return { ph, sessions, session: out.session };
}

function loadOpen(store: Store): PayTrip {
  const raw = store.getItem('pokejam.phantom.pay');
  return JSON.parse(raw!) as PayTrip;
}

describe('deeplink payment: build', () => {
  it('connects with the cluster and a redirect back to this page, and keeps the dapp secret out of the link', () => {
    const store = memStore();
    const link = beginPayConnect(store, { loc, app: true, cluster: 'mainnet-beta', kind: 'shield', now: NOW, hash: '#advertise', sku: 'shield_7' });
    const u = new URL(link);
    const trip = loadOpen(store);
    expect(u.origin + u.pathname).toBe('https://phantom.com/ul/v1/connect');
    expect(u.searchParams.get('cluster')).toBe('mainnet-beta');
    expect(u.searchParams.get('redirect_link')).toBe(`https://pokejam.xyz/?pj_phantom=${trip.id}&pj_app=1#advertise`);
    expect(link).not.toContain(trip.secret);
    expect(trip.kind).toBe('shield');
    expect(trip.sku).toBe('shield_7');
  });

  it('reuses a sign-in session: the next payment is signAndSendTransaction, not another connect', () => {
    const sessions = memStore();
    rememberSignInSession(sessions, { secret: base58Encode(randomBytes(32)), phantomPub: base58Encode(randomBytes(32)), session: SESSION, wallet: WALLET_A });
    expect(sessionFor(sessions, 'mainnet-beta', WALLET_A)?.session).toBe(SESSION);
    expect(sessionFor(sessions, 'mainnet-beta', WALLET_B)).toBeNull();
    expect(sessionFor(sessions, 'devnet', WALLET_A)).toBeNull();
    expect(loadSession(sessions, 'mainnet-beta')?.wallet).toBe(WALLET_A);
  });

  it('builds signAndSendTransaction with the transaction and session only inside the encrypted payload', () => {
    const { ph, session } = connect();
    const tripStore = memStore();
    const trip = armPay(tripStore, { session, kind: 'ad-usdc', intentId: INTENT_A, txBase64: TX, app: false, now: NOW });
    const link = signAndSendLink(trip, loc, '#advertise');
    const u = new URL(link);
    expect(u.origin + u.pathname).toBe('https://phantom.com/ul/v1/signAndSendTransaction');
    expect(link).not.toContain(SESSION);
    expect(u.searchParams.get('transaction')).toBeNull();
    expect(u.searchParams.get('session')).toBeNull();
    const body = ph.readPayload(link);
    expect(body.session).toBe(SESSION);
    expect(body.transaction).toBe(base58Encode(Uint8Array.from([1, 2, 3, 4, 9, 8, 7])));
    expect(u.searchParams.get('redirect_link')).toBe(`https://pokejam.xyz/?pj_phantom=${trip.id}#advertise`);
    expect(payFresh(trip, NOW + TX_FRESH_MS - 1)).toBe(true);
    expect(payFresh(trip, NOW + TX_FRESH_MS)).toBe(false);
  });
});

describe('deeplink payment: return, relay and confirm', () => {
  it('decrypts the signature and confirms only the intent this device armed', () => {
    const { ph, session, sessions } = connect();
    const tripStore = memStore();
    const trip = armPay(tripStore, { session, kind: 'ad-burn', intentId: INTENT_A, txBase64: TX, app: true, now: NOW });
    const link = signAndSendLink(trip, loc);
    expect(takePayDirect(tripStore, sessions, parseCallback(ph.pay(link, randomBytes(64)))!, NOW)).toBeNull();
    markPayOpened(tripStore, NOW);
    const sig = randomBytes(64);
    const out = takePayDirect(tripStore, sessions, parseCallback(ph.pay(link, sig, { intentId: INTENT_B }))!, NOW);
    expect(confirmBody(out!)).toEqual({ intentId: INTENT_A, signature: base58Encode(sig) });
    expect(out).toMatchObject({ wallet: WALLET_A, payKind: 'ad-burn' });
    expect(takePayDirect(tripStore, sessions, parseCallback(ph.pay(link, sig))!, NOW)).toBeNull();
  });

  it('a landing tab relays the ciphertext; the starter confirms; another player cannot', async () => {
    const { ph, session, sessions } = connect();
    const app = memStore();
    const other = memStore();
    const trip = armPay(app, { session, kind: 'shield', intentId: INTENT_A, txBase64: TX, app: true, now: NOW, sku: 'shield_7' });
    markPayOpened(app, NOW);
    armPay(other, { session, kind: 'shield', intentId: INTENT_B, txBase64: TX, app: true, now: NOW });
    markPayOpened(other, NOW);
    const sig = randomBytes(64);
    const cb = parseCallback(ph.pay(signAndSendLink(trip, loc), sig, { intentId: INTENT_B }))!;
    expect(routeCallback(cb, null)).toBe('relay');
    const relay = mockRelay();
    expect(await relayPut(relay.sb, cb as Callback)).toBe(true);
    expect(JSON.stringify([...relay.rows.values()])).not.toContain(base58Encode(sig));
    expect(JSON.stringify([...relay.rows.values()])).not.toContain(SESSION);
    expect(await pullPay(other, sessions, relay.sb, NOW)).toBe('waiting');
    expect(relay.rows.size).toBe(1);
    const out = await pullPay(app, sessions, relay.sb, NOW);
    if (out === 'waiting' || out === 'none') throw new Error('expected the signature');
    expect(confirmBody(out)).toEqual({ intentId: INTENT_A, signature: base58Encode(sig) });
    expect(takePayDirect(other, sessions, cb, NOW)).toBeNull();
    expect(await pullPay(app, sessions, relay.sb, NOW)).toBe('none');
    expect(relay.rows.size).toBe(0);
  });

  it('a cancelled payment keeps the session; a rejected session does not', () => {
    const { ph, session, sessions } = connect();
    const tripStore = memStore();
    const trip = armPay(tripStore, { session, kind: 'ad-usdc', intentId: INTENT_A, txBase64: TX, app: false, now: NOW });
    markPayOpened(tripStore, NOW);
    expect(() => applyPay(tripStore, sessions, trip, parseCallback(ph.error(signAndSendLink(trip, loc), '4001'))!.response, NOW)).toThrow(/cancel/i);
    expect(loadSession(sessions, 'mainnet-beta')?.session).toBe(SESSION);
    const again = armPay(tripStore, { session, kind: 'ad-usdc', intentId: INTENT_A, txBase64: TX, app: false, now: NOW });
    markPayOpened(tripStore, NOW);
    expect(() => applyPay(tripStore, sessions, again, parseCallback(ph.error(signAndSendLink(again, loc), '-32603'))!.response, NOW)).toThrow();
    expect(loadSession(sessions, 'mainnet-beta')).toBeNull();
  });
});

describe('deeplink payment: nothing secret is logged or stored by the rules module', () => {
  it('the rules file does not touch the DOM storage or the console', () => {
    const src = readFileSync(new URL('./phantomPay.ts', import.meta.url), 'utf8').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[^]*?\*\//g, '');
    expect(src).not.toMatch(/console\.|localStorage|sessionStorage/);
    expect(readFileSync(new URL('../main.ts', import.meta.url), 'utf8')).toContain("'pokejam.phantom.pay'");
  });
});
