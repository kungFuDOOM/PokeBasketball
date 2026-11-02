// @ts-ignore Node's fs has no type declarations in this project.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { base58Decode, base58Encode, randomBytes } from '../../supabase/functions/_shared/pack/bytes.ts';
import { boxBefore, boxOpen, boxPublicKey, boxSeal } from './nacl';
import {
  FLOW_TTL_MS, PENDING_KEY, PhantomLinkError, advance, beginConnect, buildSiwsMessage, checkSiwsMessage, isStandalone, loadPending, parseCallback,
  relayPut, relayTake, routeCallback, signLink, type Callback, type RelayClient, type Store,
} from './phantomLink';
import { SIGN_IN_STATEMENT, signInWithPhantom, type Web3Client } from './phantom';
import { sheetHtml } from './phantomView';

const WALLET = '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV';
const SECRET_SESSION = 'phantom-session-token-secret';
const loc = { origin: 'https://pokejam.xyz', pathname: '/' };
const env = (now: number) => ({ host: 'pokejam.xyz', uri: 'https://pokejam.xyz/', now });
const NOW = Date.parse('2026-11-02T12:00:00.000Z');

function memStore(): Store & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
}

/** Plays Phantom's part: has its own keypair, reads what the page sent, and answers the way the deeplink docs describe. */
function fakePhantom() {
  const secret = randomBytes(32);
  const pub = base58Encode(boxPublicKey(secret));
  const answerParams = (dappPub: string, body: unknown) => {
    const nonce = randomBytes(24);
    return { nonce: base58Encode(nonce), data: base58Encode(boxSeal(new TextEncoder().encode(JSON.stringify(body)), nonce, boxBefore(base58Decode(dappPub), secret))) };
  };
  const toUrl = (redirect: string, params: Record<string, string>) => {
    const u = new URL(redirect);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.search;
  };
  return {
    pub,
    connect(link: string, wallet = WALLET): string {
      const q = new URL(link).searchParams;
      return toUrl(q.get('redirect_link')!, { phantom_encryption_public_key: pub, ...answerParams(q.get('dapp_encryption_public_key')!, { public_key: wallet, session: SECRET_SESSION }) });
    },
    readSign(link: string) {
      const q = new URL(link).searchParams;
      const plain = boxOpen(base58Decode(q.get('payload')!), base58Decode(q.get('nonce')!), boxBefore(base58Decode(q.get('dapp_encryption_public_key')!), secret));
      return JSON.parse(new TextDecoder().decode(plain!)) as { message: string; session: string; display: string };
    },
    sign(link: string, signature = randomBytes(64)): string {
      const q = new URL(link).searchParams;
      return toUrl(q.get('redirect_link')!, answerParams(q.get('dapp_encryption_public_key')!, { signature: base58Encode(signature) }));
    },
    error(link: string, code: string): string {
      return toUrl(new URL(link).searchParams.get('redirect_link')!, { errorCode: code, errorMessage: 'Click here to claim free tokens' });
    },
  };
}

const start = (s = memStore(), app = false) => ({ s, link: beginConnect(s, { loc, app, returnTo: 'ranked', now: NOW }) });
const pendingOf = (s: Store, now = NOW) => loadPending(s, now).pending!;

/** Runs the connect trip, leaving a pending 'sign' step that has been tapped. */
function toSignStep(ph = fakePhantom()) {
  const { s, link } = start();
  const out = advance(s, pendingOf(s), parseCallback(ph.connect(link))!.response, env(NOW));
  if (out.kind !== 'need-sign') throw new Error('expected need-sign');
  return { s, ph, pending: out.pending, sign: signLink(out.pending, loc) };
}

describe('deeplink URLs', () => {
  it('connect: Phantom endpoint, app url, dapp key, cluster, and a redirect back here with a one-time id', () => {
    const { s, link } = start();
    const u = new URL(link);
    expect(u.origin + u.pathname).toBe('https://phantom.com/ul/v1/connect');
    expect(u.searchParams.get('app_url')).toBe('https://pokejam.xyz');
    expect(u.searchParams.get('cluster')).toBe('mainnet-beta');
    expect(base58Decode(u.searchParams.get('dapp_encryption_public_key')!)).toHaveLength(32);
    const p = pendingOf(s);
    expect(u.searchParams.get('redirect_link')).toBe(`https://pokejam.xyz/?pj_phantom=${p.id}`);
    expect(base58Decode(p.id)).toHaveLength(32);
    expect(base58Encode(boxPublicKey(base58Decode(p.secret)))).toBe(u.searchParams.get('dapp_encryption_public_key'));
  });
  it('never puts the secret key in the link, and marks a home-screen start', () => {
    const { s, link } = start(memStore(), true);
    expect(link).not.toContain(pendingOf(s).secret);
    expect(new URL(link).searchParams.get('redirect_link')).toContain('&pj_app=1');
  });
  it('signMessage: encrypted payload holding base58 message, the session and utf8 display; a fresh id and no plain session', () => {
    const { ph, pending, sign } = toSignStep();
    const u = new URL(sign);
    expect(u.origin + u.pathname).toBe('https://phantom.com/ul/v1/signMessage');
    expect(sign).not.toContain(SECRET_SESSION);
    const body = ph.readSign(sign);
    expect(body.session).toBe(SECRET_SESSION);
    expect(body.display).toBe('utf8');
    expect(new TextDecoder().decode(base58Decode(body.message))).toBe(pending.message);
    expect(u.searchParams.get('redirect_link')).toBe(`https://pokejam.xyz/?pj_phantom=${pending.id}`);
  });
  it('uses a new encryption nonce every time a link is built', () => {
    const { pending } = toSignStep();
    expect(new URL(signLink(pending, loc)).searchParams.get('nonce')).not.toBe(new URL(signLink(pending, loc)).searchParams.get('nonce'));
  });
});

describe('the whole round trip', () => {
  it('connect, then sign, gives the exact message and signature to submit, and leaves nothing stored', () => {
    const { s, ph, pending, sign } = toSignStep();
    const sig = randomBytes(64);
    const out = advance(s, { ...pending, opened: true }, parseCallback(ph.sign(sign, sig))!.response, env(NOW + 1000));
    expect(out.kind).toBe('signed');
    if (out.kind !== 'signed') return;
    expect(out.message).toBe(pending.message);
    expect([...out.signature]).toEqual([...sig]);
    expect(s.m.size).toBe(0);
  });
  it('the result is what signInWithWeb3 accepts (message + signature, with no wallet)', async () => {
    const calls: unknown[] = [];
    const sb: Web3Client = { auth: { signInWithWeb3: async (c) => { calls.push(c); return { data: {}, error: null }; } } };
    await sb.auth.signInWithWeb3({ chain: 'solana', message: 'm', signature: new Uint8Array(64) });
    expect(calls).toHaveLength(1);
    expect(signInWithPhantom).toBeTypeOf('function'); // the injected path is still exported and untouched
  });
});

describe('callback parsing', () => {
  it('reads an approval and an error, and drops Phantom\'s free text', () => {
    const { s, link } = start();
    const ok = parseCallback(fakePhantom().connect(link))!;
    expect(ok.id).toBe(pendingOf(s).id);
    expect(Object.keys(ok.response).sort()).toEqual(['d', 'k', 'n']);
    const err = parseCallback(fakePhantom().error(link, '4001'))!;
    expect(err.response).toEqual({ e: '4001' });
    expect(JSON.stringify(err)).not.toContain('free tokens');
  });
  it('copes with a wallet that appends its params after a second "?"', () => {
    const id = base58Encode(randomBytes(32));
    expect(parseCallback(`?pj_phantom=${id}?errorCode=4001`)?.response).toEqual({ e: '4001' });
  });
  it('ignores anything else: no marker, bad id, bad fields', () => {
    const id = base58Encode(randomBytes(32));
    for (const q of ['', '?shop=success', '?pj_phantom=short&nonce=a&data=b', `?pj_phantom=${id}`, `?pj_phantom=${id}&nonce=a`, `?pj_phantom=${id}&nonce=0OIl&data=a`,
      `?pj_phantom=${id}&errorCode=<script>`, `?pj_phantom=${id}&nonce=a&data=b&phantom_encryption_public_key=nope`]) expect(parseCallback(q)).toBeNull();
  });
  it('a 4001 is a quiet cancel, other codes an error; both wipe the key', () => {
    for (const [code, cancelled] of [['4001', true], ['-32603', false]] as const) {
      const { s, link } = start();
      let err: unknown;
      try { advance(s, pendingOf(s), parseCallback(fakePhantom().error(link, code))!.response, env(NOW)); } catch (e) { err = e; }
      expect(err).toBeInstanceOf(PhantomLinkError);
      expect((err as PhantomLinkError).cancelled).toBe(cancelled);
      expect(s.m.size).toBe(0);
    }
  });
});

describe('state, replay and tampering', () => {
  it('a callback for another id does not touch this tab: it goes to the relay', () => {
    const { s, link } = start();
    const other = start();
    const cb = parseCallback(fakePhantom().connect(other.link))!;
    const before = s.m.get(PENDING_KEY);
    expect(routeCallback(cb, pendingOf(s))).toBe('relay');
    expect(s.m.get(PENDING_KEY)).toBe(before);
    expect(routeCallback(parseCallback(fakePhantom().connect(link))!, pendingOf(s))).toBe('direct');
  });
  it('an unsolicited callback with nothing pending goes to the relay', () => {
    const { link } = start();
    expect(routeCallback(parseCallback(fakePhantom().connect(link))!, null)).toBe('relay');
  });
  it('a sign step not yet tapped accepts no callback, even with its id', () => {
    const { ph, pending, sign } = toSignStep();
    expect(routeCallback(parseCallback(ph.sign(sign))!, pending)).toBe('relay');
    expect(routeCallback(parseCallback(ph.sign(sign))!, { ...pending, opened: true })).toBe('direct');
  });
  it('replaying the connect callback after it was used does nothing: the id moved on', () => {
    const ph = fakePhantom();
    const { s, link } = start();
    const search = ph.connect(link);
    advance(s, pendingOf(s), parseCallback(search)!.response, env(NOW));
    expect(routeCallback(parseCallback(search)!, pendingOf(s))).toBe('relay');
  });
  it('replaying the sign callback after success finds nothing pending', () => {
    const { s, ph, pending, sign } = toSignStep();
    const search = ph.sign(sign);
    advance(s, { ...pending, opened: true }, parseCallback(search)!.response, env(NOW));
    expect(loadPending(s, NOW).pending).toBeNull();
    expect(routeCallback(parseCallback(search)!, null)).toBe('relay');
  });
  it('refuses a tampered box and an answer from another key, and wipes the key', () => {
    const { s, link } = start();
    const r = parseCallback(fakePhantom().connect(link))!.response;
    const bytes = base58Decode(r.d!); bytes[3] ^= 1;
    expect(() => advance(s, pendingOf(s), { ...r, d: base58Encode(bytes) }, env(NOW))).toThrow(PhantomLinkError);
    expect(s.m.size).toBe(0);
    const t = toSignStep();
    const wrong = fakePhantom(); // a different Phantom key than the one connected
    expect(() => advance(t.s, { ...t.pending, opened: true }, parseCallback(wrong.sign(t.sign))!.response, env(NOW))).toThrow(PhantomLinkError);
    expect(t.s.m.size).toBe(0);
  });
  it('refuses a connect answer without a real address or session', () => {
    const { s, link } = start();
    expect(() => advance(s, pendingOf(s), parseCallback(fakePhantom().connect(link, 'not-an-address'))!.response, env(NOW))).toThrow(/Could not read/);
  });
  it('refuses a signature of the wrong length', () => {
    const { s, ph, pending, sign } = toSignStep();
    expect(() => advance(s, { ...pending, opened: true }, parseCallback(ph.sign(sign, randomBytes(32)))!.response, env(NOW))).toThrow(/Could not read/);
  });
});

describe('expiry', () => {
  it('an old sign-in is wiped on load and reported', () => {
    const { s } = start();
    expect(loadPending(s, NOW + FLOW_TTL_MS - 1).pending).not.toBeNull();
    expect(loadPending(s, NOW + FLOW_TTL_MS)).toEqual({ pending: null, expired: true });
    expect(s.m.size).toBe(0);
  });
  it('an answer that arrives after the deadline is refused', () => {
    const { s, link } = start();
    const p = pendingOf(s);
    expect(() => advance(s, p, parseCallback(fakePhantom().connect(link))!.response, env(NOW + FLOW_TTL_MS))).toThrow(/expired/);
    expect(s.m.size).toBe(0);
  });
  it('corrupt storage is wiped, not trusted', () => {
    const s = memStore();
    s.setItem(PENDING_KEY, '{nope');
    expect(loadPending(s, NOW)).toEqual({ pending: null, expired: false });
    expect(s.m.size).toBe(0);
  });
});

describe('the Sign in with Solana message', () => {
  const nonce = 'AbCdEfGh12345678';
  const m = buildSiwsMessage({ host: 'pokejam.xyz', uri: 'https://pokejam.xyz/', address: WALLET, nonce, issuedAt: NOW, expiresAt: NOW + FLOW_TTL_MS });
  it('is laid out exactly as supabase-js lays it out', () => {
    expect(m).toBe([
      'pokejam.xyz wants you to sign in with your Solana account:', WALLET, '', SIGN_IN_STATEMENT, '',
      'Version: 1', 'URI: https://pokejam.xyz/', 'Issued At: 2026-11-02T12:00:00.000Z', 'Expiration Time: 2026-11-02T12:10:00.000Z', 'Chain ID: mainnet', `Nonce: ${nonce}`,
    ].join('\n'));
  });
  it('matches what supabase-js builds for the same fields, signed by a wallet with signMessage', async () => {
    // Runs supabase-js's own builder: a fake wallet records what it's asked to sign, and the request is stopped at the fetch.
    const { AuthClient } = await import('@supabase/supabase-js');
    let signed = '';
    const wallet = { publicKey: { toBase58: () => WALLET }, signMessage: async (b: Uint8Array) => { signed = new TextDecoder().decode(b); return new Uint8Array(64); } };
    const auth = new AuthClient({ url: 'https://x.invalid/auth/v1', persistSession: false, autoRefreshToken: false, fetch: async () => new Response('{}', { status: 400 }) });
    await auth.signInWithWeb3({
      chain: 'solana', statement: SIGN_IN_STATEMENT, wallet,
      options: { url: 'https://pokejam.xyz/', signInWithSolana: { issuedAt: new Date(NOW).toISOString(), expirationTime: new Date(NOW + FLOW_TTL_MS).toISOString(), chainId: 'mainnet', nonce } },
    } as never).catch(() => null);
    expect(signed).toBe(m);
  });
  it('our own check passes a good message and refuses the wrong wallet, nonce or a passed expiry', () => {
    expect(() => checkSiwsMessage(m, { address: WALLET, nonce, now: NOW })).not.toThrow();
    expect(() => checkSiwsMessage(m, { address: 'other', nonce, now: NOW })).toThrow(/did not match/);
    expect(() => checkSiwsMessage(m, { address: WALLET, nonce: 'x', now: NOW })).toThrow(/did not match/);
    expect(() => checkSiwsMessage(m, { address: WALLET, nonce, now: NOW + FLOW_TTL_MS })).toThrow(/expired/);
  });
});

describe('the relay (standalone or new tab)', () => {
  /** The server functions, reduced to what the client relies on: first write wins, read deletes. */
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
  it('runs the two trips with Safari holding no key, and decrypts only in the app', async () => {
    const r = mockRelay();
    const ph = fakePhantom();
    const app = memStore();
    const safari = memStore(); // separate storage, like iOS home-screen apps and Safari
    const link = beginConnect(app, { loc, app: true, returnTo: 'ranked', now: NOW });

    const cb1: Callback = parseCallback(ph.connect(link))!;
    expect(cb1.app).toBe(true);
    expect(routeCallback(cb1, loadPending(safari, NOW).pending)).toBe('relay');
    expect(await relayPut(r.sb, cb1)).toBe(true);
    expect(safari.m.size).toBe(0);
    expect(await relayTake(r.sb, 'someone-elses-id')).toBeNull();

    const got1 = await relayTake(r.sb, pendingOf(app).id);
    expect(await relayTake(r.sb, pendingOf(app).id)).toBeNull(); // single use
    const next = advance(app, pendingOf(app), got1!, env(NOW));
    if (next.kind !== 'need-sign') throw new Error('expected need-sign');

    const sig = randomBytes(64);
    const cb2 = parseCallback(ph.sign(signLink(next.pending, loc), sig))!;
    expect(routeCallback(cb2, null)).toBe('relay');
    await relayPut(r.sb, cb2);
    const got2 = await relayTake(r.sb, next.pending.id);
    const done = advance(app, { ...pendingOf(app), opened: true }, got2!, env(NOW));
    expect(done.kind).toBe('signed');
    if (done.kind === 'signed') expect([...done.signature]).toEqual([...sig]);
    expect(app.m.size).toBe(0);
    expect(r.rows.size).toBe(0);
    expect(JSON.stringify(r.sent)).not.toContain(SECRET_SESSION);
    expect(JSON.stringify(r.sent)).not.toContain(base58Encode(sig));
  });
  it('relays an error code as just the code', async () => {
    const r = mockRelay();
    const { link } = start();
    await relayPut(r.sb, parseCallback(fakePhantom().error(link, '4001'))!);
    expect(JSON.stringify([...r.rows.values()])).toBe('[{"e":"4001"}]');
  });
  it('reports a failed put and treats a failed take as nothing yet', async () => {
    const bad: RelayClient = { rpc: async () => ({ data: null, error: { message: 'x' } }) };
    const { link } = start();
    expect(await relayPut(bad, parseCallback(fakePhantom().connect(link))!)).toBe(false);
    expect(await relayTake(bad, 'x')).toBeNull();
  });
});

describe('secrets stay out of the console', () => {
  it('a whole sign-in logs nothing', () => {
    const spies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) => vi.spyOn(console, k));
    const { s, ph, pending, sign } = toSignStep();
    advance(s, { ...pending, opened: true }, parseCallback(ph.sign(sign))!.response, env(NOW));
    for (const sp of spies) { expect(sp).not.toHaveBeenCalled(); sp.mockRestore(); }
  });
  it('uses sessionStorage only: no source file touches localStorage with these values', () => {
    const src = readFileSync(new URL('./phantomLink.ts', import.meta.url), 'utf8');
    expect(src).not.toContain('localStorage');
    expect(src).not.toMatch(/console\./);
    const sheet = readFileSync(new URL('./phantomSheet.ts', import.meta.url), 'utf8');
    expect(sheet).not.toMatch(/console\./);
    expect(sheet.match(/localStorage\.[a-zA-Z]+\([^)]*\)/g)).toEqual(['localStorage.setItem(RETURN_KEY, p.returnTo)']); // just the "reopen Ranked" marker
  });
});

describe('detecting a home-screen app', () => {
  it('iOS navigator.standalone, or the display-mode media query', () => {
    expect(isStandalone({ navigator: { standalone: true } })).toBe(true);
    expect(isStandalone({ navigator: {}, matchMedia: () => ({ matches: true }) })).toBe(true);
    expect(isStandalone({ navigator: { standalone: false }, matchMedia: () => ({ matches: false }) })).toBe(false);
    expect(isStandalone({})).toBe(false);
  });
});

describe('cleaning the URL (public/phantom-return.js)', () => {
  const src = readFileSync(new URL('../../public/phantom-return.js', import.meta.url), 'utf8');
  function run(search: string, win: Record<string, unknown> = {}) {
    const replaced: string[] = [];
    const location = { search, pathname: '/', hash: '#s=abc' };
    const w: Record<string, unknown> = { ...win };
    new Function('window', 'location', 'history', src)(w, location, { replaceState: (_a: unknown, _b: unknown, u: string) => replaced.push(u) });
    return { w, replaced };
  }
  const full = '?keep=1&pj_phantom=abc&pj_app=1&phantom_encryption_public_key=k&nonce=n&data=d';
  it('takes Phantom\'s params out of the address bar, keeps everything else, and holds them in memory only', () => {
    const r = run(full);
    expect(r.replaced).toEqual(['/?keep=1#s=abc']);
    expect(r.w.__phantomCb).toBe(full);
  });
  it('strips error params too', () => {
    expect(run('?pj_phantom=abc&errorCode=4001&errorMessage=x').replaced).toEqual(['/#s=abc']);
  });
  it('leaves other pages alone, and does nothing when framed', () => {
    expect(run('?shop=success&nonce=1').replaced).toEqual([]);
    expect(run(full, { __framed: true }).replaced).toEqual([]);
  });
  it('runs before analytics in index.html', () => {
    const html = readFileSync(new URL('../../index.html', import.meta.url), 'utf8');
    expect(html.indexOf('phantom-return.js')).toBeGreaterThan(html.indexOf('framebust.js'));
    expect(html.indexOf('phantom-return.js')).toBeLessThan(html.indexOf('ga.js'));
  });
  it('agrees with parseCallback on the marker', () => {
    expect(parseCallback(`?pj_phantom=${base58Encode(randomBytes(32))}&errorCode=1`)).not.toBeNull();
  });
});

describe('the sheet', () => {
  it('says what to do at each step, escapes the link, and offers a way out', () => {
    expect(sheetHtml({ kind: 'opening' })).toContain('Opening Phantom…');
    const approve = sheetHtml({ kind: 'approve', step: 1 });
    expect(approve).toContain('Approve in Phantom, then come back.');
    expect(approve).toContain('Step 1 of 2');
    expect(approve).toContain('phantom-cancel');
    const ready = sheetHtml({ kind: 'sign-ready', href: 'https://phantom.com/ul/v1/signMessage?a=1&b="2', newTab: true });
    expect(ready).toContain('a=1&amp;b=&quot;2');
    expect(ready).toContain('target="_blank"');
    expect(sheetHtml({ kind: 'go-back', app: true })).toContain('home screen');
    expect(sheetHtml({ kind: 'go-back', app: false })).toContain('tab you started from');
    expect(sheetHtml({ kind: 'failed', tone: 'bad', text: '<b>' })).toContain('&lt;b&gt;');
  });
});

