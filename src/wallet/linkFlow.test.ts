import { describe, expect, it } from 'vitest';
// @ts-ignore Node's fs has no type declarations in this project.
import { readFileSync } from 'node:fs';
import { base58Decode, base58Encode, randomBytes } from '../../supabase/functions/_shared/pack/bytes.ts';
import { buildLinkMessage, checkLinkMessage } from '../../supabase/functions/_shared/wallet/link';
import { generateKeypair } from '../../supabase/functions/_shared/pack/ed25519.ts';
import { boxBefore, boxPublicKey, boxSeal } from './nacl';
import { LINK_PENDING_KEY, advance, loadPending, parseCallback, signLink, type Store } from './phantomLink';
import { beginLinkHandoff, beginLinkInBrowser, openLinkResult, parseLinkCallback, requestLinkNonce, sealLinkResult } from './linkFlow';

const USER = '11111111-1111-4111-8111-111111111111';
const WALLET = '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV';
const loc = { origin: 'https://pokejam.xyz', pathname: '/' };
const NOW = Date.parse('2026-11-03T02:00:00.000Z');
const env = { host: 'pokejam.xyz', uri: 'https://pokejam.xyz/', now: NOW };

function mem(): Store & { m: Map<string, string> } {
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
  const toUrl = (redirect: string, params: Record<string, string>) => {
    const u = new URL(redirect);
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
    return u.search;
  };
  return {
    connect(link: string, wallet = WALLET) {
      const q = new URL(link).searchParams;
      return toUrl(q.get('redirect_link')!, { phantom_encryption_public_key: pub, ...answer(q.get('dapp_encryption_public_key')!, { public_key: wallet, session: 'sess' }) });
    },
    sign(link: string, signature = randomBytes(64)) {
      const q = new URL(link).searchParams;
      return toUrl(q.get('redirect_link')!, answer(q.get('dapp_encryption_public_key')!, { signature: base58Encode(signature) }));
    },
  };
}

describe('linking does not look like a sign-in', () => {
  it('the browser link uses pj_wlink and the account id, and Phantom sign-in still uses pj_phantom', () => {
    const s = mem();
    const link = beginLinkInBrowser(s, { loc, userId: USER, now: NOW });
    const redir = new URL(link).searchParams.get('redirect_link') ?? '';
    expect(redir).toContain('pj_wlink=');
    expect(redir).toContain(`pj_uid=${USER}`);
    expect(redir).not.toContain('pj_phantom');
    expect(parseCallback(new URL(link).search)).toBeNull();
    expect(loadPending(s, NOW).pending).toBeNull();
    expect(loadPending(s, NOW, LINK_PENDING_KEY).pending?.purpose).toBe('link');
  });
  it('the signed message is the link message, not Sign in with Solana, and the seal round-trips', async () => {
    const s = mem();
    const ph = fakePhantom();
    const link = beginLinkInBrowser(s, { loc, userId: USER, now: NOW });
    const pending = loadPending(s, NOW, LINK_PENDING_KEY).pending!;
    const stepped = advance(s, pending, parseLinkCallback(ph.connect(link))!.response, env);
    if (stepped.kind !== 'need-sign') throw new Error('expected a sign step');
    expect(stepped.pending.message).toContain(`Link this wallet to account ${USER}`);
    expect(stepped.pending.message).not.toContain('Chain ID:');
    expect(checkLinkMessage(stepped.pending.message!, { address: WALLET, userId: USER, nonce: stepped.pending.nonce!, now: NOW })).toBe('ok');
    const sign = signLink(stepped.pending, loc);
    const signBack = new URL(sign).searchParams.get('redirect_link') ?? '';
    expect(signBack).toContain('pj_wlink=');
    expect(signBack).not.toContain('pj_phantom');
    const signed = advance(s, { ...stepped.pending, opened: true }, parseLinkCallback(ph.sign(sign))!.response, env);
    if (signed.kind !== 'signed') throw new Error('expected a signature');
    expect(signed.signature).toHaveLength(64);
    const { keypair } = await generateKeypair();
    const message = buildLinkMessage({ host: 'pokejam.xyz', uri: 'https://pokejam.xyz/', address: keypair.address, userId: USER, nonce: 'nonceNonce123456', issuedAt: NOW, expiresAt: NOW + 60_000 });
    const signature = await keypair.sign(new TextEncoder().encode(message));
    const pub = base58Encode(boxPublicKey(randomBytes(32)));
    const secret = randomBytes(32);
    const realPub = base58Encode(boxPublicKey(secret));
    const box = sealLinkResult(message, signature, realPub);
    expect(openLinkResult(box, base58Encode(secret))).toEqual({ message, signature: base58Encode(signature) });
    expect(() => openLinkResult(box, pub)).toThrow();
    const home = new URL(beginLinkHandoff(mem(), { loc, userId: USER, returnTo: 'ranked', now: NOW })).searchParams.get('redirect_link') ?? '';
    expect(home).toContain('pj_wh=');
    expect(home).not.toContain('pj_phantom');
    expect(parseCallback('?' + home.slice(home.indexOf('?')))).toBeNull();
  });
  it('asks the server to store the nonce before the wallet signs, and the sign step uses that nonce', async () => {
    const opened: string[] = [];
    const nonce = await requestLinkNonce(async (n) => { opened.push(n); return true; });
    expect(opened).toEqual([nonce]);
    expect(nonce).toMatch(/^[1-9A-HJ-NP-Za-km-z]{16,64}$/);
    await expect(requestLinkNonce(async () => false)).rejects.toThrow(/start the wallet link/);
    const s = mem();
    const ph = fakePhantom();
    const link = beginLinkInBrowser(s, { loc, userId: USER, now: NOW });
    const pending = loadPending(s, NOW, LINK_PENDING_KEY).pending!;
    const stepped = advance(s, pending, parseLinkCallback(ph.connect(link))!.response, { ...env, nonce: 'nonceNonce123456' });
    if (stepped.kind !== 'need-sign') throw new Error('expected a sign step');
    expect(stepped.pending.nonce).toBe('nonceNonce123456');
    expect(stepped.pending.message).toContain('Nonce: nonceNonce123456');
  });
  it('the link screen does not sign in or sign out', () => {
    const src = readFileSync(new URL('./linkSheet.ts', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(src).not.toMatch(/\bsignInWithWeb3\b|\bsignOut\b/);
  });
});
