import { describe, expect, it } from 'vitest';
import {
  PHANTOM_DOWNLOAD_URL, WalletError, getPhantomProvider, getSolanaAddress, isMobile, isPhantomInstalled, phantomAction, phantomDeepLink,
  signInWithPhantom, type PhantomProvider, type WalletHost, type Web3Client,
} from './phantom';

const ADDR = '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV';
const phantom: PhantomProvider = { isPhantom: true };
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148';
const DESKTOP = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Safari/537.36';
const loc = { href: 'https://pokejam.xyz/?ranked=1', origin: 'https://pokejam.xyz' };

describe('detecting Phantom', () => {
  it('finds window.phantom.solana, falls back to window.solana, and ignores other wallets', () => {
    expect(getPhantomProvider({ phantom: { solana: phantom } })).toBe(phantom);
    expect(getPhantomProvider({ solana: phantom })).toBe(phantom);
    expect(getPhantomProvider({ solana: {} })).toBeNull(); // some other wallet claiming window.solana
    expect(getPhantomProvider({})).toBeNull();
    expect(isPhantomInstalled({ phantom: { solana: phantom } })).toBe(true);
    expect(isPhantomInstalled({})).toBe(false);
  });
  it('tells phones from desktops', () => {
    expect(isMobile({ navigator: { userAgent: IPHONE } })).toBe(true);
    expect(isMobile({ navigator: { userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile' } })).toBe(true);
    expect(isMobile({ navigator: { userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 5 } })).toBe(true); // iPadOS
    expect(isMobile({ navigator: { userAgent: DESKTOP } })).toBe(false);
    expect(isMobile({ navigator: { userAgent: 'Mozilla/5.0 (Macintosh)', platform: 'MacIntel', maxTouchPoints: 0 } })).toBe(false);
    expect(isMobile({})).toBe(false);
  });
});

describe('the deep link and what to offer', () => {
  it('builds the Phantom browse link with the page and the origin encoded', () => {
    expect(phantomDeepLink('https://pokejam.xyz/?ranked=1', 'https://pokejam.xyz'))
      .toBe('https://phantom.app/ul/browse/https%3A%2F%2Fpokejam.xyz%2F%3Franked%3D1?ref=https%3A%2F%2Fpokejam.xyz');
    expect(phantomDeepLink('https://pokejam.xyz/a b')).toContain('?ref=https%3A%2F%2Fpokejam.xyz');
  });
  it('signs in when the wallet is there; deep-links on a phone; sends desktops to the download page', () => {
    expect(phantomAction({ phantom: { solana: phantom }, navigator: { userAgent: DESKTOP }, location: loc })).toEqual({ kind: 'sign-in' });
    expect(phantomAction({ navigator: { userAgent: IPHONE }, location: loc })).toEqual({ kind: 'open-in-phantom', href: phantomDeepLink(loc.href, loc.origin) });
    expect(phantomAction({ navigator: { userAgent: DESKTOP }, location: loc })).toEqual({ kind: 'install', href: PHANTOM_DOWNLOAD_URL });
  });
});

describe('signInWithPhantom', () => {
  const client = (result: { error: { message: string; code?: number } | null } | Error) => {
    const calls: unknown[] = [];
    const sb: Web3Client = {
      auth: { signInWithWeb3: async (c) => { calls.push(c); if (result instanceof Error) throw result; return { data: {}, error: result.error }; } },
    };
    return { sb, calls };
  };
  const w: WalletHost = { phantom: { solana: phantom } };

  it('asks Supabase for a Solana sign-in with Phantom as the wallet and a one-line statement', async () => {
    const c = client({ error: null });
    await signInWithPhantom(c.sb, w);
    expect(c.calls).toHaveLength(1);
    const arg = c.calls[0] as { chain: string; statement: string; wallet: unknown };
    expect(arg.chain).toBe('solana');
    expect(arg.wallet).toBe(phantom);
    expect(arg.statement).not.toMatch(/\n/);
  });
  it('throws a WalletError without calling Supabase when Phantom is missing', async () => {
    const c = client({ error: null });
    await expect(signInWithPhantom(c.sb, {})).rejects.toBeInstanceOf(WalletError);
    expect(c.calls).toHaveLength(0);
  });
  it('marks a declined prompt as cancelled, and passes other errors on', async () => {
    const no = await signInWithPhantom(client(Object.assign(new Error('User rejected the request.'), { code: 4001 })).sb, w).catch((e) => e);
    expect(no).toBeInstanceOf(WalletError);
    expect(no.cancelled).toBe(true);
    const bad = await signInWithPhantom(client({ error: { message: 'Web3 provider is disabled' } }).sb, w).catch((e) => e);
    expect(bad.cancelled).toBe(false);
    expect(bad.message).toMatch(/disabled/);
  });
});

describe('getSolanaAddress', () => {
  it('reads the identity_data custom_claims address (the usual shape)', () => {
    expect(getSolanaAddress({ identities: [{ provider: 'web3', identity_data: { custom_claims: { address: ADDR, chain: 'solana' } } }] })).toBe(ADDR);
  });
  it('reads a flat identity_data address, or the sub / provider_id "web3:solana:<address>"', () => {
    expect(getSolanaAddress({ identities: [{ provider: 'web3', identity_data: { address: ADDR, chain: 'solana' } }] })).toBe(ADDR);
    expect(getSolanaAddress({ identities: [{ provider: 'web3', identity_data: { sub: `web3:solana:${ADDR}` } }] })).toBe(ADDR);
    expect(getSolanaAddress({ identities: [{ provider: 'web3', identity_data: { provider_id: `web3:solana:${ADDR}` } }] })).toBe(ADDR);
  });
  it('falls back to user_metadata for a web3 user whose identities are missing', () => {
    expect(getSolanaAddress({ app_metadata: { provider: 'web3' }, user_metadata: { custom_claims: { address: ADDR, chain: 'solana' } } })).toBe(ADDR);
    expect(getSolanaAddress({ app_metadata: { provider: 'google' }, user_metadata: { custom_claims: { address: ADDR, chain: 'solana' } } })).toBeNull();
  });
  it('is null for guests, Google users, other chains, junk and nothing', () => {
    expect(getSolanaAddress(null)).toBeNull();
    expect(getSolanaAddress(undefined)).toBeNull();
    expect(getSolanaAddress({})).toBeNull();
    expect(getSolanaAddress({ identities: [{ provider: 'google', identity_data: { email: 'a@b.c' } }] })).toBeNull();
    expect(getSolanaAddress({ identities: [{ provider: 'web3', identity_data: { custom_claims: { address: '0xabc', chain: 'ethereum' } } }] })).toBeNull();
    expect(getSolanaAddress({ identities: [{ provider: 'web3', identity_data: { custom_claims: { address: 'short', chain: 'solana' } } }] })).toBeNull();
    expect(getSolanaAddress({ identities: [{ provider: 'web3', identity_data: null }] })).toBeNull();
  });
});
