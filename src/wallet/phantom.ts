// Phantom (Solana) wallet helper. Detects the browser wallet, builds the mobile deep link, signs in to Supabase with
// "Sign in with Solana" and reads the wallet address back off the Supabase user. No payments, no transactions: it only
// ever asks the wallet to sign the login message. Kept free of DOM globals at import time so it unit-tests in node;
// callers can pass a window-like object. Reused by Ranked sign-in now, and by Pack Battles later.
import type { SolanaWallet } from '@supabase/supabase-js';

/** Where people without the extension / app go. */
export const PHANTOM_DOWNLOAD_URL = 'https://phantom.app/download';
/** The line the wallet shows when asking for the signature (Phantom requires one; no new lines allowed). */
export const SIGN_IN_STATEMENT = 'Sign in to PokeJam. This only proves you own this wallet. It does not move funds or cost anything.';

/** The slice of Phantom's injected provider this module uses (a Supabase SolanaWallet, plus the flag Phantom sets). */
export interface PhantomProvider extends SolanaWallet {
  isPhantom?: boolean;
}

/** What a page exposes: `window` in the browser; a stub in tests. */
export interface WalletHost {
  phantom?: { solana?: PhantomProvider };
  solana?: PhantomProvider;
  navigator?: { userAgent?: string; maxTouchPoints?: number; platform?: string };
  location?: { href: string; origin: string };
}

const host = (): WalletHost => (typeof window === 'undefined' ? {} : (window as unknown as WalletHost));

/** Phantom's Solana provider, or null when it isn't installed. Prefers `window.phantom.solana` (not hijackable by other wallets). */
export function getPhantomProvider(w: WalletHost = host()): PhantomProvider | null {
  const p = w.phantom?.solana;
  if (p?.isPhantom) return p;
  // Older builds only set window.solana.
  return w.solana?.isPhantom ? w.solana : null;
}

export const isPhantomInstalled = (w: WalletHost = host()): boolean => getPhantomProvider(w) !== null;

/** Phones and tablets (iPadOS reports as a Mac with touch). Used to pick the deep link over the download page. */
export function isMobile(w: WalletHost = host()): boolean {
  const n = w.navigator;
  if (!n) return false;
  if (/Android|iPhone|iPad|iPod|Mobile/i.test(n.userAgent ?? '')) return true;
  return n.platform === 'MacIntel' && (n.maxTouchPoints ?? 0) > 1;
}

/** Opens `url` inside Phantom's in-app browser, where the wallet is injected. https://docs.phantom.com/phantom-deeplinks */
export function phantomDeepLink(url: string, origin?: string): string {
  const ref = origin ?? safeOrigin(url);
  return `https://phantom.app/ul/browse/${encodeURIComponent(url)}?ref=${encodeURIComponent(ref)}`;
}
function safeOrigin(url: string): string {
  try { return new URL(url).origin; } catch { return url; }
}

/** What the sign-in panel should offer for Phantom on this device. */
export type PhantomAction =
  | { kind: 'sign-in' }
  | { kind: 'open-in-phantom'; href: string }
  | { kind: 'install'; href: string };

export function phantomAction(w: WalletHost = host()): PhantomAction {
  if (isPhantomInstalled(w)) return { kind: 'sign-in' };
  if (isMobile(w) && w.location) return { kind: 'open-in-phantom', href: phantomDeepLink(w.location.href, w.location.origin) };
  return { kind: 'install', href: PHANTOM_DOWNLOAD_URL };
}

/** The part of the Supabase client used here. */
export interface Web3Client {
  auth: {
    signInWithWeb3(c: { chain: 'solana'; statement: string; wallet: SolanaWallet }): PromiseLike<{ data: unknown; error: { message: string } | null }>;
  };
}

/** The wallet is missing, or the player closed the Phantom prompt. `cancelled` = they said no (not an error to show in red). */
export class WalletError extends Error {
  name = 'WalletError';
  constructor(message: string, public cancelled = false) { super(message); }
}

const rejected = (e: { message?: string; code?: number | string }) => e.code === 4001 || /reject|declin|denied|cancel/i.test(e.message ?? '');

/**
 * Signs in to Supabase with the Phantom wallet (Sign in with Solana). Supabase can't link a wallet to an existing
 * guest account (linkIdentity is OAuth-only), so this is a plain sign-in: the session becomes the wallet's account.
 * Throws WalletError when Phantom isn't there or the player declines.
 */
export async function signInWithPhantom(sb: Web3Client, w: WalletHost = host()): Promise<void> {
  const wallet = getPhantomProvider(w);
  if (!wallet) throw new WalletError('Phantom was not found in this browser.');
  try {
    const { error } = await sb.auth.signInWithWeb3({ chain: 'solana', statement: SIGN_IN_STATEMENT, wallet });
    if (error) throw error;
  } catch (e) {
    const err = e as { message?: string; code?: number | string };
    if (rejected(err)) throw new WalletError('Sign-in cancelled in Phantom.', true);
    throw new WalletError(err.message || 'Could not sign in with Phantom.');
  }
}

/** The bits of a Supabase user this module reads (all optional: Supabase has used several shapes). */
export interface WalletUser {
  app_metadata?: { provider?: string; providers?: string[] } | null;
  user_metadata?: Record<string, unknown> | null;
  identities?: { provider?: string; identity_data?: Record<string, unknown> | null }[] | null;
}

// Solana addresses are base58, 32 bytes: 32 to 44 characters.
const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function fromRecord(r: Record<string, unknown> | null | undefined): string | null {
  if (!r) return null;
  const claims = r.custom_claims as Record<string, unknown> | undefined;
  for (const [addr, chain] of [[claims?.address, claims?.chain], [r.address, r.chain], [r.wallet_address, r.chain]]) {
    if (typeof addr === 'string' && BASE58.test(addr) && (chain === undefined || chain === 'solana')) return addr;
  }
  // `sub` / `provider_id` look like "web3:solana:<address>".
  for (const k of ['sub', 'provider_id']) {
    const m = typeof r[k] === 'string' ? /^web3:solana:(.+)$/.exec(r[k] as string) : null;
    if (m && BASE58.test(m[1])) return m[1];
  }
  return null;
}

/** The Solana address a Supabase user signed in with, or null (a Google or guest user, or a user with no wallet identity). */
export function getSolanaAddress(user: WalletUser | null | undefined): string | null {
  if (!user) return null;
  for (const id of user.identities ?? []) {
    if (id.provider === 'web3') {
      const a = fromRecord(id.identity_data);
      if (a) return a;
    }
  }
  if (user.app_metadata?.provider === 'web3' || user.app_metadata?.providers?.includes('web3')) return fromRecord(user.user_metadata);
  return null;
}
