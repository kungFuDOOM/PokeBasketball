import { describe, expect, it } from 'vitest';
import { base58Encode } from '../pack/bytes.ts';
import { generateKeypair, verifySignature } from '../pack/ed25519.ts';
import { buildLinkMessage, checkLinkMessage } from './link.ts';
import { linkWalletHandler, type LinkDeps, type LinkResult } from './linkHandler.ts';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-11-03T02:00:00.000Z');
const ORIGIN = 'https://pokejam.xyz';

function message(address: string, userId = USER, now = NOW) {
  return buildLinkMessage({
    host: 'pokejam.xyz', uri: 'https://pokejam.xyz/', address, userId,
    nonce: 'nonceNonce123456', issuedAt: now, expiresAt: now + 60_000,
  });
}

async function post(body: unknown, opts: { jwt?: string; origin?: string; deps?: Partial<LinkDeps> } = {}) {
  const links: { userId: string; wallet: string; nonce: string }[] = [];
  const deps: LinkDeps = {
    userOf: async () => ({ id: USER, anonymous: false }),
    verify: (address, msg, sig) => verifySignature(address, msg, sig),
    link: async (userId, wallet, nonce) => { links.push({ userId, wallet, nonce }); return { ok: true, wallet }; },
    now: () => NOW,
    ...opts.deps,
  };
  const res = await linkWalletHandler(new Request('https://fn.test', {
    method: 'POST',
    headers: { origin: opts.origin ?? ORIGIN, authorization: opts.jwt === '' ? '' : `Bearer ${opts.jwt ?? 'jwt'}` },
    body: JSON.stringify(body),
  }), [ORIGIN], deps);
  return { status: res.status, body: await res.json() as { ok?: boolean; wallet?: string; code?: string; error?: string }, links };
}

describe('link message', () => {
  it('accepts our own message and refuses a different account, a stale clock, or a sign-in shaped text', () => {
    const m = message('7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV');
    expect(checkLinkMessage(m, { address: '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV', userId: USER, nonce: 'nonceNonce123456', now: NOW })).toBe('ok');
    expect(checkLinkMessage(m, { address: '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV', userId: OTHER, nonce: 'nonceNonce123456', now: NOW })).toBe('mismatch');
    expect(checkLinkMessage(m, { address: '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV', userId: USER, nonce: 'nonceNonce123456', now: NOW + 20 * 60_000 })).toBe('expired');
    expect(checkLinkMessage('pokejam.xyz wants you to sign in with your Solana account:\n', { address: 'x', userId: USER, nonce: 'n', now: NOW })).toBe('bad');
  });
});

describe('link wallet handler', () => {
  it('stores the wallet on the signed-in user when the signature matches', async () => {
    const { keypair } = await generateKeypair();
    const m = message(keypair.address);
    const sig = base58Encode(await keypair.sign(new TextEncoder().encode(m)));
    const r = await post({ message: m, signature: sig });
    expect(r.status).toBe(200);
    expect(r.body.wallet).toBe(keypair.address);
    expect(r.links).toEqual([{ userId: USER, wallet: keypair.address, nonce: 'nonceNonce123456' }]);
  });
  it('refuses a bad signature, a message for someone else, a guest, and no session', async () => {
    const { keypair } = await generateKeypair();
    const other = await generateKeypair();
    const m = message(keypair.address);
    const bad = await post({ message: m, signature: base58Encode(await other.keypair.sign(new TextEncoder().encode(m))) });
    expect(bad.body.code).toBe('bad_signature');
    expect(bad.links).toHaveLength(0);
    const swapped = await post({ message: message(keypair.address, OTHER), signature: base58Encode(await keypair.sign(new TextEncoder().encode(message(keypair.address, OTHER)))) });
    expect(swapped.body.code).toBe('bad_message');
    expect(swapped.links).toHaveLength(0);
    const guest = await post({ message: m, signature: base58Encode(await keypair.sign(new TextEncoder().encode(m))) }, { deps: { userOf: async () => ({ id: USER, anonymous: true }) } });
    expect(guest.status).toBe(403);
    const none = await post({ message: m, signature: 'x' }, { jwt: '' });
    expect(none.status).toBe(401);
  });
  it('passes a database refusal through and does not pretend it linked', async () => {
    const { keypair } = await generateKeypair();
    const m = message(keypair.address);
    const sig = base58Encode(await keypair.sign(new TextEncoder().encode(m)));
    const taken: LinkResult = { ok: false, code: 'taken' };
    const r = await post({ message: m, signature: sig }, { deps: { link: async () => taken } });
    expect(r.status).toBe(409);
    expect(r.body.error).toMatch(/another account/);
  });
});
