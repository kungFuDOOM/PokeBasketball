// Solana wallet sign-in in the browser, with no SDK: the injected providers Phantom, Solflare and
// Backpack put on window all offer connect() and signMessage().

import { base58Encode } from './bytes';

interface Provider {
  publicKey?: { toString(): string } | null;
  connect(opts?: { onlyIfTrusted?: boolean }): Promise<{ publicKey?: { toString(): string } } | void>;
  disconnect?(): Promise<void>;
  signMessage(message: Uint8Array, encoding?: string): Promise<{ signature: Uint8Array } | Uint8Array>;
}

export interface WalletOption {
  name: string;
  provider: Provider;
}

declare global {
  interface Window {
    phantom?: { solana?: Provider & { isPhantom?: boolean } };
    solflare?: Provider & { isSolflare?: boolean };
    backpack?: Provider;
    solana?: Provider & { isPhantom?: boolean };
  }
}

/** Wallets installed in this browser (extensions on desktop, or the wallet app's own browser on phones). */
export function detectWallets(): WalletOption[] {
  const out: WalletOption[] = [];
  if (window.phantom?.solana) out.push({ name: 'Phantom', provider: window.phantom.solana });
  if (window.solflare) out.push({ name: 'Solflare', provider: window.solflare });
  if (window.backpack) out.push({ name: 'Backpack', provider: window.backpack });
  if (!out.length && window.solana) out.push({ name: 'Solana wallet', provider: window.solana });
  return out;
}

/** Links that reopen this page inside a wallet app's browser, for phones without an extension. */
export function openInWalletLinks(): { name: string; href: string }[] {
  const url = encodeURIComponent(location.href);
  const ref = encodeURIComponent(location.origin);
  return [
    { name: 'Phantom', href: `https://phantom.app/ul/browse/${url}?ref=${ref}` },
    { name: 'Solflare', href: `https://solflare.com/ul/v1/browse/${url}?ref=${ref}` },
  ];
}

export async function connect(w: WalletOption): Promise<string> {
  const r = await w.provider.connect();
  const key = (r && 'publicKey' in r ? r.publicKey : null) ?? w.provider.publicKey;
  if (!key) throw new Error(`${w.name} didn't share an address`);
  return key.toString();
}

/** Ask the wallet to sign `message`; returns the signature in base58. */
export async function signMessage(w: WalletOption, message: string): Promise<string> {
  const r = await w.provider.signMessage(new TextEncoder().encode(message), 'utf8');
  const sig = r instanceof Uint8Array ? r : r.signature;
  return base58Encode(new Uint8Array(sig));
}

/** A Solana Pay link: wallet apps open it as a prefilled USDC transfer to `to`. */
export function solanaPayLink(to: string, usdcMint: string, amountUsd: number, label: string): string {
  const p = new URLSearchParams({ amount: amountUsd.toFixed(2), 'spl-token': usdcMint, label, message: `${label} deposit` });
  return `solana:${to}?${p.toString()}`;
}
