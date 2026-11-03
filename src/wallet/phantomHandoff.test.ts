// @ts-ignore Node's fs has no type declarations in this project.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { base58Decode, base58Encode, randomBytes } from '../../supabase/functions/_shared/pack/bytes.ts';
import { boxBefore, boxOpen, boxPublicKey, boxSeal } from './nacl';
import {
  HANDOFF_KEY, LANDING_KEY, beginHandoff, clearHandoff, finishInSafari, handoffCode, landingStore, landingTrip, loadHandoff, openRefreshToken,
  reportFailure, restoreInApp, sealRefreshToken, type AppAuth, type SafariAuth,
} from './phantomHandoff';
import { FLOW_TTL_MS, PENDING_KEY, PhantomLinkError, advance, authError, loadPending, newId, parseCallback, relayPut, signLink, stepError, type RelayClient, type Store } from './phantomLink';
import { sheetHtml } from './phantomView';

const WALLET = '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV';
const PHANTOM_SESSION = 'phantom-session-token-secret';
const REFRESH = 'rt-super-secret-refresh-token';
const loc = { origin: 'https://pokejam.xyz', pathname: '/' };
const env = (now: number) => ({ host: 'pokejam.xyz', uri: 'https://pokejam.xyz/', now });
const NOW = Date.parse('2026-11-02T12:00:00.000Z');

function memStore(): Store & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
}

/** Plays Phantom's part, like in phantomLink.test.ts. */
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
    connect: (link: string) => { const q = new URL(link).searchParams; return toSearch(q.get('redirect_link')!, { phantom_encryption_public_key: pub, ...answer(q.get('dapp_encryption_public_key')!, { public_key: WALLET, session: PHANTOM_SESSION }) }); },
    sign: (link: string, sig = randomBytes(64)) => { const q = new URL(link).searchParams; return toSearch(q.get('redirect_link')!, answer(q.get('dapp_encryption_public_key')!, { signature: base58Encode(sig) })); },
    error: (link: string, code: string) => toSearch(new URL(link).searchParams.get('redirect_link')!, { errorCode: code, errorMessage: 'free tokens' }),
  };
}

function mockRelay() {
  const rows = new Map<string, unknown>();
  const sent: unknown[] = [];
  const sb: RelayClient = {
    rpc: async (fn, a) => {
      sent.push(a);
      const id = a.p_id as string;
      if (fn === 'pokejam_phantom_relay_put') { if (rows.has(id)) return { data: false, error: null }; rows.set(id, a.p_payload); return { data: true, error: null }; }
      const v = rows.get(id) ?? null; rows.delete(id); return { data: v, error: null };
    },
  };
  return { sb, rows, sent };
}

function mockSafariAuth(fail = false) {
  const calls: string[] = [];
  const auth: SafariAuth = {
    signInWithWeb3: async () => { calls.push('signIn'); return fail ? { data: null, error: { message: 'bad' } } : { data: { session: { refresh_token: REFRESH } }, error: null }; },
    signOut: async (o) => { calls.push(`signOut:${o.scope}`); },
  };
  return { auth, calls };
}
function mockAppAuth(ok = true) {
  const used: string[] = [];
  const auth: AppAuth = { refreshSession: async (c) => { used.push(c.refresh_token); return ok ? { data: { session: {} }, error: null } : { data: null, error: { message: 'x' } }; } };
  return { auth, used };
}

/** Safari's first landing: no storage of the app's, only what is in the URL. */
function safariConnect(safari: Store, ph: ReturnType<typeof fakePhantom>, link: string, now = NOW) {
  const cb = parseCallback(ph.connect(link))!;
  const landing = landingStore(safari);
  const trip = landingTrip(cb, loadPending(landing, now).pending, now)!;
  const out = advance(landing, trip, cb.response, env(now));
  if (out.kind !== 'need-sign') throw new Error('expected need-sign');
  return { cb, landing, pending: out.pending };
}

describe('home-screen URLs', () => {
  it('connect link carries the trip id, handoff id, handoff PUBLIC key and dapp secret, and the app keeps only the handoff secret', () => {
    const app = memStore();
    const link = beginHandoff(app, { loc, returnTo: 'ranked', now: NOW });
    const u = new URL(link);
    expect(u.origin + u.pathname).toBe('https://phantom.com/ul/v1/connect');
    const r = new URL(u.searchParams.get('redirect_link')!);
    expect(r.origin + r.pathname).toBe('https://pokejam.xyz/');
    const cb = parseCallback(fakePhantom().connect(link))!;
    expect(cb.app).toBe(true);
    expect(base58Decode(cb.id)).toHaveLength(32);
    expect(base58Decode(cb.handoff!.id)).toHaveLength(32);
    const rec = loadHandoff(app, NOW).handoff!;
    expect(rec.id).toBe(cb.handoff!.id);
    expect(rec.id).not.toBe(cb.id);
    // the link's handoff key is the public half of the app's secret; the Phantom key is a separate pair
    expect(base58Encode(boxPublicKey(base58Decode(rec.secret)))).toBe(cb.handoff!.pub);
    expect(base58Encode(boxPublicKey(base58Decode(cb.handoff!.secret)))).toBe(u.searchParams.get('dapp_encryption_public_key'));
    expect(cb.handoff!.secret).not.toBe(rec.secret);
    // the app's own secret never leaves it
    expect(link).not.toContain(rec.secret);
    expect(JSON.stringify([...app.m.values()])).not.toContain(cb.handoff!.secret);
    expect(rec.expiresAt).toBe(NOW + FLOW_TTL_MS);
  });
  it('every tap makes new keys and ids', () => {
    const a = memStore(), b = memStore();
    const ph = fakePhantom();
    const [x, y] = [parseCallback(ph.connect(beginHandoff(a, { loc, returnTo: 'ranked', now: NOW })))!, parseCallback(ph.connect(beginHandoff(b, { loc, returnTo: 'ranked', now: NOW })))!];
    expect(new Set([x.id, y.id, x.handoff!.id, y.handoff!.id, x.handoff!.pub, y.handoff!.pub, x.handoff!.secret, y.handoff!.secret]).size).toBe(8);
  });
  it('parses a handoff on a connect answer, a sign answer and an error; all three params or none', () => {
    const ph = fakePhantom();
    const link = beginHandoff(memStore(), { loc, returnTo: 'ranked', now: NOW });
    const c = parseCallback(ph.connect(link))!;
    expect(c.handoff).toBeTruthy();
    expect(c.response.k).toBeTruthy();
    expect(parseCallback(ph.error(link, '4001'))).toMatchObject({ response: { e: '4001' }, handoff: c.handoff });
    const search = ph.connect(link);
    expect(parseCallback(search.replace(/&pj_ds=[^&]+/, ''))).toBeNull();
    expect(parseCallback(search.replace(/pj_hk=[^&]+/, 'pj_hk=bad!'))).toBeNull();
  });
  it('a sign link from Safari repeats the handoff in its redirect and the same dapp key', () => {
    const ph = fakePhantom();
    const link = beginHandoff(memStore(), { loc, returnTo: 'ranked', now: NOW });
    const { pending } = safariConnect(memStore(), ph, link);
    const sign = signLink(pending, loc);
    const cb2 = parseCallback(ph.sign(sign))!;
    expect(cb2.id).toBe(pending.id);
    expect(cb2.handoff).toEqual(pending.handoff);
    expect(new URL(sign).searchParams.get('dapp_encryption_public_key')).toBe(new URL(link).searchParams.get('dapp_encryption_public_key'));
    expect(sign).not.toContain(PHANTOM_SESSION);
  });
  it('shows a short check code that is the same on both screens', () => {
    const id = base58Encode(randomBytes(32));
    expect(handoffCode(id)).toBe(id.slice(-4).toUpperCase());
    expect(sheetHtml({ kind: 'wait-safari', code: 'AB12' })).toContain('AB12');
    expect(sheetHtml({ kind: 'sign-ready', href: 'https://x', newTab: false, code: 'AB12' })).toContain('AB12');
    expect(sheetHtml({ kind: 'safari-done', code: 'AB12' })).toContain('Signed in — go back to the PokeJam app on your home screen');
  });
});

describe('Safari finishes the sign-in without the app\'s storage', () => {
  it('both trips, then the sealed token reaches the app; nothing secret in the relay', async () => {
    const ph = fakePhantom();
    const app = memStore(), safari = memStore(); // separate storage, like the home-screen app and Safari
    const relay = mockRelay();
    const link = beginHandoff(app, { loc, returnTo: 'profile', now: NOW });
    const handoffId = loadHandoff(app, NOW).handoff!.id;

    // Trip 1 lands in Safari: it has only the URL.
    expect(safari.m.size).toBe(0);
    const { cb, landing, pending } = safariConnect(safari, ph, link);
    expect(pending.session).toBe(PHANTOM_SESSION);
    expect(pending.wallet).toBe(WALLET);
    expect(pending.message).toContain(WALLET);
    expect([...safari.m.keys()]).toEqual([LANDING_KEY]);
    expect(app.m.has(PENDING_KEY)).toBe(false);

    // The button is tapped: opened, then trip 2 lands (maybe in a new tab, same localStorage).
    const sign = signLink(pending, loc);
    const sig = randomBytes(64);
    const cb2 = parseCallback(ph.sign(sign, sig))!;
    expect(landingTrip(cb2, loadPending(landing, NOW).pending, NOW)!.step).toBe('connect'); // not tapped yet: not trusted as a sign answer
    const tapped = { ...loadPending(landing, NOW).pending!, opened: true };
    landing.setItem(PENDING_KEY, JSON.stringify(tapped));
    const trip2 = landingTrip(cb2, loadPending(landing, NOW).pending, NOW)!;
    expect(trip2.step).toBe('sign');
    const signed = advance(landing, trip2, cb2.response, env(NOW + 5000));
    if (signed.kind !== 'signed') throw new Error('expected signed');
    expect([...signed.signature]).toEqual([...sig]);
    expect(safari.m.size).toBe(0); // trip state wiped

    const sa = mockSafariAuth();
    await finishInSafari(sa.auth, relay.sb, { message: signed.message, signature: signed.signature, handoff: cb.handoff! });
    expect(sa.calls).toEqual(['signIn', 'signOut:local']);
    expect(relay.rows.size).toBe(1);
    expect(relay.rows.has(handoffId)).toBe(true);
    const wire = JSON.stringify(relay.sent);
    for (const secret of [REFRESH, PHANTOM_SESSION, cb.handoff!.secret, loadHandoff(app, NOW).handoff!.secret, base58Encode(sig)]) expect(wire).not.toContain(secret);
    expect(Object.keys(relay.rows.get(handoffId) as object).sort()).toEqual(['d', 'k', 'n']);

    // The app restores the session from the relay, once.
    const aa = mockAppAuth();
    const r = await restoreInApp(app, relay.sb, aa.auth, NOW + 6000);
    expect(r).toEqual({ kind: 'done', returnTo: 'profile' });
    expect(aa.used).toEqual([REFRESH]);
    expect(app.m.size).toBe(0);
    expect(relay.rows.size).toBe(0);
    expect(await restoreInApp(app, relay.sb, aa.auth, NOW + 7000)).toEqual({ kind: 'none' });
    expect(aa.used).toHaveLength(1);
  });
  it('a cancel in Phantom on either trip reaches the waiting app as a quiet cancel', async () => {
    const ph = fakePhantom();
    const app = memStore();
    const relay = mockRelay();
    const link = beginHandoff(app, { loc, returnTo: 'ranked', now: NOW });
    const cb = parseCallback(ph.error(link, '4001'))!;
    await reportFailure(relay.sb, cb.handoff!, true);
    await expect(restoreInApp(app, relay.sb, mockAppAuth().auth, NOW)).rejects.toMatchObject({ cancelled: true });
    expect(app.m.size).toBe(0);
  });
  it('Safari reports a failed sign-in and does not leave a session behind, nor a half-sealed token', async () => {
    const relay = mockRelay();
    const ph = fakePhantom();
    const link = beginHandoff(memStore(), { loc, returnTo: 'ranked', now: NOW });
    const { cb } = safariConnect(memStore(), ph, link);
    const sa = mockSafariAuth(true);
    await expect(finishInSafari(sa.auth, relay.sb, { message: 'm', signature: new Uint8Array(64), handoff: cb.handoff! })).rejects.toMatchObject({ diag: expect.stringMatching(/^W3-/) });
    expect(relay.rows.size).toBe(0);
  });
  it('signs out locally only, after the relay write, and says so when the relay refuses', async () => {
    const ph = fakePhantom();
    const { cb } = safariConnect(memStore(), ph, beginHandoff(memStore(), { loc, returnTo: 'ranked', now: NOW }));
    const sa = mockSafariAuth();
    const bad: RelayClient = { rpc: async () => ({ data: null, error: { message: 'x' } }) };
    await expect(finishInSafari(sa.auth, bad, { message: 'm', signature: new Uint8Array(64), handoff: cb.handoff! })).rejects.toMatchObject({ diag: 'HO-PUT' });
    expect(sa.calls).toEqual(['signIn', 'signOut:local']);
  });
  it('keeps the session when this very page is the app', async () => {
    const ph = fakePhantom();
    const { cb } = safariConnect(memStore(), ph, beginHandoff(memStore(), { loc, returnTo: 'ranked', now: NOW }));
    const relay = mockRelay();
    const sa = mockSafariAuth();
    await finishInSafari(sa.auth, relay.sb, { message: 'm', signature: new Uint8Array(64), handoff: cb.handoff!, keepSession: true });
    expect(sa.calls).toEqual(['signIn']);
    expect(relay.rows.size).toBe(0);
  });
  it('a sign answer with no stored state fails to read instead of signing anyone in', () => {
    const ph = fakePhantom();
    const link = beginHandoff(memStore(), { loc, returnTo: 'ranked', now: NOW });
    const { pending } = safariConnect(memStore(), ph, link);
    const cb2 = parseCallback(ph.sign(signLink(pending, loc)))!;
    const trip = landingTrip(cb2, null, NOW)!;
    expect(() => advance(memStore(), trip, cb2.response, env(NOW))).toThrow(/couldn't be read/);
  });
});

describe('handoff seal and open', () => {
  const hand = randomBytes(32);
  const pub = base58Encode(boxPublicKey(hand));
  const rec = { secret: base58Encode(hand) };
  it('round-trips only the refresh token', () => {
    const sealed = sealRefreshToken(REFRESH, pub);
    expect(Object.keys(sealed).sort()).toEqual(['d', 'k', 'n']);
    expect(JSON.stringify(sealed)).not.toContain(REFRESH);
    expect(openRefreshToken(sealed, rec)).toBe(REFRESH);
    const plain = boxOpen(base58Decode(sealed.d!), base58Decode(sealed.n!), boxBefore(base58Decode(sealed.k!), hand))!;
    expect(JSON.parse(new TextDecoder().decode(plain))).toEqual({ rt: REFRESH });
  });
  it('a new key and nonce each time', () => {
    const a = sealRefreshToken(REFRESH, pub), b = sealRefreshToken(REFRESH, pub);
    expect(a.k).not.toBe(b.k);
    expect(a.n).not.toBe(b.n);
  });
  it('rejects the wrong key, a tampered box, and a body without a token, all with the same error', () => {
    const sealed = sealRefreshToken(REFRESH, pub);
    expect(() => openRefreshToken(sealed, { secret: base58Encode(randomBytes(32)) })).toThrow(/couldn't read the handed-back/);
    const d = base58Decode(sealed.d!); d[3] ^= 1;
    expect(() => openRefreshToken({ ...sealed, d: base58Encode(d) }, rec)).toThrow(/couldn't read the handed-back/);
    expect(() => openRefreshToken({ n: sealed.n }, rec)).toThrow(/couldn't read the handed-back/);
    const n = randomBytes(24), eph = randomBytes(32);
    const noRt = { k: base58Encode(boxPublicKey(eph)), n: base58Encode(n), d: base58Encode(boxSeal(new TextEncoder().encode('{"x":1}'), n, boxBefore(base58Decode(pub), eph))) };
    expect(() => openRefreshToken(noRt, rec)).toThrow(/couldn't read the handed-back/);
  });
  it('the app wipes its handoff when the answer is for another key, and never applies it', async () => {
    const app = memStore();
    beginHandoff(app, { loc, returnTo: 'ranked', now: NOW });
    const id = loadHandoff(app, NOW).handoff!.id;
    const relay = mockRelay();
    relay.rows.set(id, sealRefreshToken(REFRESH, pub)); // sealed to somebody else's key
    const aa = mockAppAuth();
    await expect(restoreInApp(app, relay.sb, aa.auth, NOW)).rejects.toThrow(/couldn't read the handed-back/);
    expect(aa.used).toEqual([]);
    expect(app.m.size).toBe(0);
  });
  it('fails cleanly when the session cannot be restored', async () => {
    const app = memStore();
    beginHandoff(app, { loc, returnTo: 'ranked', now: NOW });
    const h = loadHandoff(app, NOW).handoff!;
    const relay = mockRelay();
    relay.rows.set(h.id, sealRefreshToken(REFRESH, base58Encode(boxPublicKey(base58Decode(h.secret)))));
    await expect(restoreInApp(app, relay.sb, mockAppAuth(false).auth, NOW)).rejects.toMatchObject({ diag: expect.stringMatching(/^RF-/) });
    expect(app.m.size).toBe(0);
  });
});

describe('single use, expiry, waiting', () => {
  it('waits while the relay is empty, and survives an iOS reload (state is in storage)', async () => {
    const app = memStore();
    beginHandoff(app, { loc, returnTo: 'ranked', now: NOW });
    const relay = mockRelay();
    expect(await restoreInApp(app, relay.sb, mockAppAuth().auth, NOW + 60_000)).toEqual({ kind: 'waiting' });
    expect(loadHandoff(app, NOW + 9 * 60_000).handoff).not.toBeNull();
    expect(app.m.has(HANDOFF_KEY)).toBe(true);
  });
  it('treats a relay error as nothing yet', async () => {
    const app = memStore();
    beginHandoff(app, { loc, returnTo: 'ranked', now: NOW });
    const bad: RelayClient = { rpc: async () => { throw new Error('offline'); } };
    expect(await restoreInApp(app, bad, mockAppAuth().auth, NOW)).toEqual({ kind: 'waiting' });
  });
  it('expires after 10 minutes: wiped and reported once', async () => {
    const app = memStore();
    beginHandoff(app, { loc, returnTo: 'ranked', now: NOW });
    const relay = mockRelay();
    relay.rows.set(loadHandoff(app, NOW).handoff!.id, sealRefreshToken(REFRESH, base58Encode(boxPublicKey(randomBytes(32)))));
    await expect(restoreInApp(app, relay.sb, mockAppAuth().auth, NOW + FLOW_TTL_MS)).rejects.toThrow(/expired/);
    expect(app.m.size).toBe(0);
    expect(await restoreInApp(app, relay.sb, mockAppAuth().auth, NOW + FLOW_TTL_MS)).toEqual({ kind: 'none' });
    expect(relay.rows.size).toBe(1); // an expired app never reads it
  });
  it('a cancel during the request wins: nothing is applied', async () => {
    const app = memStore();
    beginHandoff(app, { loc, returnTo: 'ranked', now: NOW });
    const h = loadHandoff(app, NOW).handoff!;
    const aa = mockAppAuth();
    const sb: RelayClient = { rpc: async () => { clearHandoff(app); return { data: sealRefreshToken(REFRESH, base58Encode(boxPublicKey(base58Decode(h.secret)))), error: null }; } };
    expect(await restoreInApp(app, sb, aa.auth, NOW)).toEqual({ kind: 'none' });
    expect(aa.used).toEqual([]);
  });
  it('Safari\'s trip state expires too, and corrupt state is wiped', () => {
    const ph = fakePhantom();
    const safari = memStore();
    const { landing } = safariConnect(safari, ph, beginHandoff(memStore(), { loc, returnTo: 'ranked', now: NOW }));
    expect(loadPending(landing, NOW + 1000).pending).not.toBeNull();
    expect(loadPending(landing, NOW + FLOW_TTL_MS + 1).expired).toBe(true);
    expect(safari.m.size).toBe(0);
    safari.m.set(LANDING_KEY, '{nope');
    expect(loadPending(landing, NOW).pending).toBeNull();
    expect(safari.m.size).toBe(0);
    app: { const a = memStore(); a.m.set(HANDOFF_KEY, 'junk'); expect(loadHandoff(a, NOW).handoff).toBeNull(); expect(a.m.size).toBe(0); }
  });
});

describe('no secrets in the console, and where they may be stored', () => {
  it('a whole home-screen sign-in logs nothing', async () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) => vi.spyOn(console, k));
    const ph = fakePhantom();
    const app = memStore(), safari = memStore();
    const relay = mockRelay();
    const link = beginHandoff(app, { loc, returnTo: 'ranked', now: NOW });
    const { cb, landing, pending } = safariConnect(safari, ph, link);
    landing.setItem(PENDING_KEY, JSON.stringify({ ...pending, opened: true }));
    const cb2 = parseCallback(ph.sign(signLink(pending, loc)))!;
    const s = advance(landing, landingTrip(cb2, loadPending(landing, NOW).pending, NOW)!, cb2.response, env(NOW));
    if (s.kind === 'signed') await finishInSafari(mockSafariAuth().auth, relay.sb, { message: s.message, signature: s.signature, handoff: cb.handoff! });
    await restoreInApp(app, relay.sb, mockAppAuth().auth, NOW);
    await expect(restoreInApp(app, relay.sb, mockAppAuth().auth, NOW + FLOW_TTL_MS)).resolves.toBeDefined();
    for (const sp of spies) { expect(sp).not.toHaveBeenCalled(); sp.mockRestore(); }
  });
  it('the handoff and sheet code never log, and touch localStorage only through the Store they are given', () => {
    const read = (f: string) => readFileSync(new URL(f, import.meta.url), 'utf8');
    expect(read('./phantomHandoff.ts').replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[^]*?\*\//g, '')).not.toMatch(/console\.|localStorage|sessionStorage/);
    expect(read('./phantomSheet.ts')).not.toMatch(/console\./);
  });
  it('the sheet only wraps localStorage for the app handoff, Safari\'s trip and the reopen-Ranked marker', () => {
    const sheet = readFileSync(new URL('./phantomSheet.ts', import.meta.url), 'utf8');
    expect(sheet.match(/localStorage\.[a-zA-Z]+\([^)]*\)/g)).toEqual(['localStorage.setItem(RETURN_KEY, rt)']);
  });
  it('main.ts looks for the same storage keys the modules use', () => {
    const main = readFileSync(new URL('../main.ts', import.meta.url), 'utf8');
    expect(main).toContain(`'${HANDOFF_KEY}'`);
    expect(main).toContain(`'${LANDING_KEY}'`);
  });
});

describe('stripping the URL (public/phantom-return.js)', () => {
  const src = readFileSync(new URL('../../public/phantom-return.js', import.meta.url), 'utf8');
  function run(search: string, win: Record<string, unknown> = {}) {
    const replaced: string[] = [];
    const w: Record<string, unknown> = { ...win };
    new Function('window', 'location', 'history', src)(w, { search, pathname: '/', hash: '' }, { replaceState: (_a: unknown, _b: unknown, u: string) => replaced.push(u) });
    return { w, replaced };
  }
  it('removes the handoff id, public key and dapp secret with the rest, before analytics, keeping them in memory only', () => {
    const ph = fakePhantom();
    const search = ph.connect(beginHandoff(memStore(), { loc, returnTo: 'ranked', now: NOW }));
    const r = run(`${search}&keep=1`);
    expect(r.replaced).toEqual(['/?keep=1']);
    for (const k of ['pj_h', 'pj_hk', 'pj_ds', 'pj_phantom', 'pj_app', 'data', 'nonce']) expect(r.replaced[0]).not.toContain(k + '=');
    expect(parseCallback(r.w.__phantomCb as string)?.handoff).toBeTruthy();
  });
  it('strips an error answer carrying a handoff too', () => {
    const ph = fakePhantom();
    expect(run(ph.error(beginHandoff(memStore(), { loc, returnTo: 'ranked', now: NOW }), '4001')).replaced).toEqual(['/']);
  });
  it('resumePhantom drops the in-memory copy', () => {
    expect(readFileSync(new URL('./phantomSheet.ts', import.meta.url), 'utf8')).toMatch(/__phantomCb\?: string \}\)\.__phantomCb = undefined/);
  });
});

describe('failures reach the waiting app with the same step and message', () => {
  const setup = () => {
    const app = memStore();
    const relay = mockRelay();
    const h = parseCallback(fakePhantom().error(beginHandoff(app, { loc, returnTo: 'ranked', now: NOW }), '4001'))!.handoff!;
    return { app, relay, h };
  };
  const cases: [string, PhantomLinkError][] = [
    ['connect unreadable', stepError('CN-READ')],
    ['connect refused by Phantom', stepError('CN-PH')],
    ['signature unreadable', stepError('SG-READ')],
    ['sign refused by Phantom', stepError('SG-PH')],
    ['expired', stepError('EXP')],
    ['mismatch', stepError('MIS')],
    ['server said Chain ID is not valid', authError('W3', { status: 400, code: 'validation_failed', message: 'siws: Chain ID is not valid' })],
    ['server rate limit', authError('W3', { status: 429, message: 'rate limit' })],
    ['no network', authError('W3', { status: 0, name: 'AuthRetryableFetchError', message: 'Failed to fetch' })],
  ];
  for (const [name, err] of cases) {
    it(`${name}: the app shows Safari's message and code`, async () => {
      const { app, relay, h } = setup();
      await reportFailure(relay.sb, h, err);
      const put = relay.sent[0] as { p_payload: { e: string } };
      expect(put.p_payload.e).toMatch(/^-?[0-9]{1,6}$/);
      const got = await restoreInApp(app, relay.sb, mockAppAuth().auth, NOW).catch((e) => e as PhantomLinkError);
      expect(got).toBeInstanceOf(PhantomLinkError);
      if (!(got instanceof PhantomLinkError)) return;
      expect(got.diag).toBe(err.diag);
      expect(got.message).toBe(err.message);
      expect(got.cancelled).toBe(false);
    });
  }
  it('cancel stays 4001', async () => {
    const { app, relay, h } = setup();
    await reportFailure(relay.sb, h, stepError('CXL'));
    expect((relay.sent[0] as { p_payload: { e: string } }).p_payload.e).toBe('4001');
    await expect(restoreInApp(app, relay.sb, mockAppAuth().auth, NOW)).rejects.toMatchObject({ cancelled: true, diag: 'CXL' });
  });
  it('an unknown error, or a failure that cannot be told, is reported as code 1 and shows the generic Phantom message', async () => {
    const { app, relay, h } = setup();
    await reportFailure(relay.sb, h, new Error('boom with a token eyJhbGciOi'));
    expect(JSON.stringify(relay.sent)).not.toContain('eyJ');
    await expect(restoreInApp(app, relay.sb, mockAppAuth().auth, NOW)).rejects.toMatchObject({ diag: 'PH-UNK' });
  });
  it('a refreshSession refusal in the app keeps its status and reason', async () => {
    const { app, relay, h } = setup();
    const ph = fakePhantom();
    void ph;
    // Safari's good result, then the server turns the refresh token down with a 400.
    await relayPut(relay.sb, { id: h.id, app: true, response: sealRefreshToken(REFRESH, h.pub) });
    const auth: AppAuth = { refreshSession: async () => ({ data: null, error: { status: 400, code: 'refresh_token_not_found', message: 'Invalid Refresh Token: Refresh Token Not Found' } }) };
    await expect(restoreInApp(app, relay.sb, auth, NOW)).rejects.toMatchObject({ diag: 'RF-400-OTHER', message: expect.stringMatching(/app couldn't use the handed-back sign-in/) });
  });
  it('a refreshSession that throws (offline) is RF NET', async () => {
    const { app, relay, h } = setup();
    await relayPut(relay.sb, { id: h.id, app: true, response: sealRefreshToken(REFRESH, h.pub) });
    const auth: AppAuth = { refreshSession: async () => { throw new TypeError('Load failed'); } };
    await expect(restoreInApp(app, relay.sb, auth, NOW)).rejects.toMatchObject({ diag: 'RF-0-NET' });
  });
});

describe('records left by an older build', () => {
  it('a handoff or pending record with missing or odd fields does not crash and is either normalized or wiped', () => {
    const s = memStore();
    s.setItem(HANDOFF_KEY, JSON.stringify({ v: 1, id: 'x', secret: 's', expiresAt: NOW + 1000 }));
    expect(loadHandoff(s, NOW).handoff?.returnTo).toBe('ranked');
    s.setItem(HANDOFF_KEY, JSON.stringify({ v: 2, id: 'x' }));
    expect(loadHandoff(s, NOW)).toEqual({ handoff: null, expired: false });
    expect(s.m.size).toBe(0);
    s.setItem(HANDOFF_KEY, 'null');
    expect(loadHandoff(s, NOW)).toEqual({ handoff: null, expired: false });
    s.setItem(HANDOFF_KEY, '{not json');
    expect(loadHandoff(s, NOW)).toEqual({ handoff: null, expired: false });
    const p = memStore();
    p.setItem(PENDING_KEY, JSON.stringify({ v: 1, id: 'i', secret: 's', step: 'connect' })); // no expiresAt
    expect(loadPending(p, NOW)).toEqual({ pending: null, expired: false });
    p.setItem(PENDING_KEY, JSON.stringify({ v: 1, id: 'i', secret: 's', step: 'sign', expiresAt: NOW + 1000, handoff: 'junk' }));
    const got = loadPending(p, NOW).pending!;
    expect(got.handoff).toBeUndefined();
    expect(got).toMatchObject({ app: false, opened: false, returnTo: 'ranked' });
    p.setItem(PENDING_KEY, 'null');
    expect(loadPending(p, NOW)).toEqual({ pending: null, expired: false });
  });
  it('a sign step with no message from an older build fails as STATE, not a crash', () => {
    const p = { v: 1 as const, id: newId(), step: 'sign' as const, app: false, opened: true, returnTo: 'ranked' as const, expiresAt: NOW + 1000, secret: base58Encode(randomBytes(32)) };
    expect(() => advance(memStore(), p, { n: 'a', d: 'b' }, env(NOW))).toThrow(expect.objectContaining({ diag: 'STATE' }));
  });
});
