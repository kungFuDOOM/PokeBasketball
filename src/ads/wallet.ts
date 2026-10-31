// Solana wallets in the browser through the Wallet Standard (Phantom, Solflare, Backpack and others), with no SDK:
// the page announces itself, wallets register, and each exposes connect and sign features.
// https://github.com/wallet-standard/wallet-standard

export interface WalletAccount { address: string }

interface StdWallet {
  name: string;
  icon: string;
  chains: readonly string[];
  accounts: readonly WalletAccount[];
  features: Record<string, unknown>;
}

interface ConnectFeature { connect(input?: { silent?: boolean }): Promise<{ accounts: readonly WalletAccount[] }> }
interface DisconnectFeature { disconnect(): Promise<void> }
interface SignAndSendFeature {
  signAndSendTransaction(...inputs: { account: WalletAccount; chain: string; transaction: Uint8Array; options?: { commitment?: string } }[]): Promise<readonly { signature: Uint8Array }[]>;
}
interface SignMessageFeature {
  signMessage(...inputs: { account: WalletAccount; message: Uint8Array }[]): Promise<readonly { signature: Uint8Array }[]>;
}
interface SignFeature {
  signTransaction(...inputs: { account: WalletAccount; chain?: string; transaction: Uint8Array }[]): Promise<readonly { signedTransaction: Uint8Array }[]>;
}

export interface Wallet {
  name: string;
  icon: string;
}

const found: StdWallet[] = [];
const listeners = new Set<() => void>();
let started = false;

const solana = (w: StdWallet) => 'standard:connect' in w.features &&
  ('solana:signTransaction' in w.features || 'solana:signAndSendTransaction' in w.features);

function register(...ws: StdWallet[]) {
  for (const w of ws) if (solana(w) && !found.some((x) => x.name === w.name)) found.push(w);
  listeners.forEach((l) => l());
  return () => { /* wallets never unregister here */ };
}

/** Start listening for wallets (they may register at any time) and return the ones found so far. */
export function wallets(onChange?: () => void): Wallet[] {
  if (onChange) listeners.add(onChange);
  if (!started) {
    started = true;
    const api = Object.freeze({ register });
    window.addEventListener('wallet-standard:register-wallet', (e) => (e as CustomEvent<(a: typeof api) => void>).detail(api));
    window.dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: api }));
  }
  return found.map((w) => ({ name: w.name, icon: w.icon }));
}

export const stopWatching = (l: () => void) => listeners.delete(l);

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58(bytes: Uint8Array): string {
  let zeros = 0;
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++;
  const digits: number[] = [];
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i];
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  return '1'.repeat(zeros) + digits.reverse().map((d) => B58[d]).join('');
}

const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const toB64 = (b: Uint8Array) => { let s = ''; for (const x of b) s += String.fromCharCode(x); return btoa(s); };

export class Connected {
  constructor(private w: StdWallet, readonly account: WalletAccount) {}
  get name() { return this.w.name; }
  get icon() { return this.w.icon; }
  get address() { return this.account.address; }

  /**
   * Sign the unsigned transaction (base64). On mainnet a wallet that can send does (it shows the user exactly
   * what it submits); on devnet the wallet only signs and the server sends it, so it works whichever network the
   * wallet is set to.
   */
  async sign(txBase64: string, cluster: 'devnet' | 'mainnet-beta'): Promise<{ signature?: string; tx?: string }> {
    const chain = cluster === 'devnet' ? 'solana:devnet' : 'solana:mainnet';
    const transaction = fromB64(txBase64);
    const send = this.w.features['solana:signAndSendTransaction'] as SignAndSendFeature | undefined;
    const sign = this.w.features['solana:signTransaction'] as SignFeature | undefined;
    if (send && (cluster === 'mainnet-beta' || !sign)) {
      const [out] = await send.signAndSendTransaction({ account: this.account, chain, transaction, options: { commitment: 'confirmed' } });
      return { signature: base58(out.signature) };
    }
    if (!sign) throw new Error(`${this.w.name} can't sign Solana transactions.`);
    const [out] = await sign.signTransaction({ account: this.account, chain, transaction });
    return { tx: toB64(out.signedTransaction) };
  }

  /** Sign a plain-text message (base58 signature), or null when the wallet can't. */
  async signMessage(text: string): Promise<string | null> {
    const f = this.w.features['solana:signMessage'] as SignMessageFeature | undefined;
    if (!f) return null;
    const [out] = await f.signMessage({ account: this.account, message: new TextEncoder().encode(text) });
    return base58(out.signature);
  }

  async disconnect() {
    await (this.w.features['standard:disconnect'] as DisconnectFeature | undefined)?.disconnect().catch(() => {});
  }
}

export async function connect(name: string, silent = false): Promise<Connected> {
  const w = found.find((x) => x.name === name);
  if (!w) throw new Error(`${name} isn't available in this browser.`);
  const { accounts } = await (w.features['standard:connect'] as ConnectFeature).connect(silent ? { silent: true } : undefined);
  const account = accounts[0] ?? w.accounts[0];
  if (!account) throw new Error(`${name} didn't share an account.`);
  return new Connected(w, account);
}

/** Open this page inside a phone wallet's own browser, where the wallet can connect. */
export const mobileWalletLinks = (url: string) => {
  const u = encodeURIComponent(url);
  const ref = encodeURIComponent(new URL(url).origin);
  return [
    { name: 'Phantom', href: `https://phantom.app/ul/browse/${u}?ref=${ref}` },
    { name: 'Solflare', href: `https://solflare.com/ul/v1/browse/${u}?ref=${ref}` },
  ];
};

/** "9wqy…hezh" */
export const shortAddress = (a: string) => `${a.slice(0, 4)}…${a.slice(-4)}`;
