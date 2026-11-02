// The browser half of paying for Rank Shields in USDC with Phantom: build the SPL TransferChecked transaction for a server
// intent, hand it to the wallet to sign and send (Phantom submits it through its own RPC), and wait for the server to confirm
// it. This file never calls a Solana RPC; the server does that. No private key, no Solana SDK: the
// transaction bytes come from the same code the Edge Functions use to check the payment (usdc-chain.ts). The wallet is the
// only thing that can move the player's funds; the server credits only after it has read the payment back from Solana.
import { base58Decode, base58Encode } from '../../../supabase/functions/_shared/pack/bytes.ts';
import { buildUsdcTransfer, type BuiltTransfer, type UsdcCluster } from '../../../supabase/functions/_shared/shield/usdc-chain.ts';

/** shield-usdc-intent's answer. */
export interface UsdcIntent {
  intentId: string;
  reference: string;
  memo: string;
  receiver: string;
  mint: string;
  cluster: UsdcCluster;
  /** Base units, as a string. */
  amount: string;
  decimals: number;
  /** Recent blockhash the server read for this payment (base58). */
  blockhash: string;
}

export class UsdcPayError extends Error {
  name = 'UsdcPayError';
  constructor(message: string, public kind: 'rejected' | 'no-phantom' | 'wrong-wallet' | 'failed' = 'failed') { super(message); }
}

const isBlockhash = (v: string) => { try { return base58Decode(v).length === 32; } catch { return false; } };

/** Reads the fields of a shield-usdc-intent answer; throws if any is missing (a changed server is not guessed at). */
export function parseIntent(raw: unknown): UsdcIntent {
  const r = raw as Record<string, unknown> | null;
  const s = (k: string) => { const v = r?.[k]; if (typeof v !== 'string' || !v) throw new UsdcPayError('Could not start the payment. Try again in a moment.'); return v; };
  const cluster = s('cluster');
  if (cluster !== 'devnet' && cluster !== 'mainnet-beta') throw new UsdcPayError('Could not start the payment. Try again in a moment.');
  const decimals = Number(r?.decimals);
  if (!/^[0-9]{1,18}$/.test(s('amount')) || decimals !== 6) throw new UsdcPayError('Could not start the payment. Try again in a moment.');
  if (!isBlockhash(s('blockhash'))) throw new UsdcPayError('Could not start the payment. Try again in a moment.');
  return { blockhash: s('blockhash'), intentId: s('intentId'), reference: s('reference'), memo: s('memo'), receiver: s('receiver'), mint: s('mint'), cluster, amount: s('amount'), decimals };
}

/**
 * The unsigned transfer for an intent. No network: the server read the blockhash and checked the shop wallet's USDC token
 * account when it made the intent, so the browser never calls a Solana RPC (CSP stays closed; no RPC key can leak).
 */
export function prepareTransfer(intent: UsdcIntent, payer: string): Promise<BuiltTransfer> {
  return buildUsdcTransfer({ payer, mint: intent.mint, receiver: intent.receiver, amount: BigInt(intent.amount), decimals: intent.decimals, reference: intent.reference, memo: intent.memo, blockhash: intent.blockhash });
}

/** The slice of Phantom's injected Solana provider used to pay. */
export interface PayProvider {
  publicKey?: { toString(): string } | null;
  connect?(opts?: { onlyIfTrusted?: boolean }): Promise<unknown>;
  signAndSendTransaction?(tx: unknown): Promise<unknown>;
  request?(a: { method: string; params: unknown }): Promise<unknown>;
}

const rejected = (e: unknown) => {
  const x = e as { code?: number | string; message?: string };
  return x?.code === 4001 || /reject|declin|denied|cancel/i.test(x?.message ?? '');
};
const signatureOf = (r: unknown): string => {
  const sig = typeof r === 'string' ? r : (r as { signature?: unknown } | null)?.signature;
  if (typeof sig !== 'string') throw new UsdcPayError('Phantom did not return a transaction signature.');
  try { if (base58Decode(sig).length === 64) return sig; } catch { /* falls through */ }
  throw new UsdcPayError('Phantom did not return a transaction signature.');
};

/**
 * Asks Phantom to sign and send. Phantom's provider takes a web3.js-style transaction object and calls `serialize()` on it, so
 * a small stand-in with that method is enough; if a build of Phantom rejects the stand-in, the older
 * `request({method: 'signAndSendTransaction'})` form (base58 of the serialized transaction) is tried once. Returns the signature.
 */
export async function signAndSend(provider: PayProvider, built: BuiltTransfer, payer: string): Promise<string> {
  if (!provider.signAndSendTransaction && !provider.request) throw new UsdcPayError('Open PokeJam in the Phantom app or browser extension to pay with USDC.', 'no-phantom');
  try { await provider.connect?.(); } catch (e) { if (rejected(e)) throw new UsdcPayError('Cancelled in Phantom. You were not charged.', 'rejected'); }
  if (provider.publicKey && provider.publicKey.toString() !== payer) throw new UsdcPayError('Switch Phantom to the wallet you signed in with, then try again.', 'wrong-wallet');
  const bytes = built.transaction;
  const stand = { version: 'legacy', serialize: () => bytes, serializeMessage: () => built.message };
  if (provider.signAndSendTransaction) {
    try {
      return signatureOf(await provider.signAndSendTransaction(stand));
    } catch (e) {
      if (rejected(e)) throw new UsdcPayError('Cancelled in Phantom. You were not charged.', 'rejected');
      // Only a TypeError (Phantom could not read the stand-in) means nothing was sent, so only then is a second try safe:
      // after any other failure the payment may already be on its way, and sending twice would charge twice.
      if (!(e instanceof TypeError) || !provider.request) throw e instanceof UsdcPayError ? e : new UsdcPayError('Phantom could not send the payment. Check Phantom before trying again.');
    }
  }
  try {
    return signatureOf(await provider.request!({ method: 'signAndSendTransaction', params: { message: base58Encode(bytes) } }));
  } catch (e) {
    if (rejected(e)) throw new UsdcPayError('Cancelled in Phantom. You were not charged.', 'rejected');
    throw e instanceof UsdcPayError ? e : new UsdcPayError('Phantom could not send the payment. Try again.');
  }
}

export interface ConfirmAnswer { status: 'credited' | 'pending'; credited?: number; /** Shields over the hold cap: refunded by hand. */ short?: number }

/** A payment with a signature that the server has not settled yet. Money may have moved, so it is kept until the server answers. */
export interface PendingPayment { intentId: string; signature: string; wallet: string; at: number }
type PendingStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;
const PENDING_PREFIX = 'pokejam.shop.usdc.';

/** Remembers a payment under its intent id. False when it could not be written (the caller keeps it in memory instead). */
export function savePending(st: PendingStore | null, p: PendingPayment): boolean {
  try {
    if (!st) return false;
    st.setItem(PENDING_PREFIX + p.intentId, JSON.stringify(p));
    return true;
  } catch { return false; }
}

/** This wallet's unsettled payments, oldest first. Another account's on the same device are left alone. */
export function loadPending(st: PendingStore | null, wallet: string): PendingPayment[] {
  const out: PendingPayment[] = [];
  try {
    for (let i = 0; st && i < st.length; i++) {
      const key = st.key(i);
      if (!key?.startsWith(PENDING_PREFIX)) continue;
      let r: Partial<PendingPayment> | null = null;
      try { r = JSON.parse(st.getItem(key) ?? 'null'); } catch { /* not ours: skipped */ }
      if (r && r.intentId === key.slice(PENDING_PREFIX.length) && typeof r.signature === 'string' && r.wallet === wallet) out.push({ intentId: r.intentId, signature: r.signature, wallet, at: Number(r.at) || 0 });
    }
  } catch { /* storage unavailable */ }
  return out.sort((a, b) => a.at - b.at);
}

export function clearPending(st: PendingStore | null, intentId: string): void {
  try { st?.removeItem(PENDING_PREFIX + intentId); } catch { /* ignore */ }
}

/** The shield-usdc-confirm refusals that retrying cannot change. Anything else (RPC, database, network, an expired session) is retried. */
const FINAL_CODES = new Set(['bad_request', 'no_intent', 'wrong_signer', 'cluster_changed', 'intent_done', 'signature_used', 'expired', 'tx_failed', 'bad_tx', 'too_early',
  'missing_reference', 'missing_memo', 'no_transfer', 'wrong_mint', 'wrong_recipient', 'wrong_amount', 'multiple_transfers']);
export const isFinalRefusal = (e: unknown): boolean => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === 'string' && FINAL_CODES.has(code);
};

/**
 * Sends the payment and remembers its signature before anything else can fail, so a lost network, a failed RPC or a reload
 * can never leave the player charged with nothing to retry.
 */
export async function sendAndRemember(provider: PayProvider, built: BuiltTransfer, payer: string, intentId: string, remember: (p: PendingPayment) => void, now: () => number = Date.now): Promise<PendingPayment> {
  const p: PendingPayment = { intentId, signature: await signAndSend(provider, built, payer), wallet: payer, at: now() };
  remember(p);
  return p;
}

/**
 * Asks the server to confirm until it says 'credited' (resolves with that answer) or the time runs out (resolves with
 * 'timeout'). A thrown error ends the wait if `isFinal` says so (default: all do); any other counts as "not yet". The same signature can
 * be confirmed again at any time.
 */
export async function pollConfirm(confirm: () => Promise<ConfirmAnswer>, o: {
  intervalMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number; stop?: () => boolean; isFinal?: (e: unknown) => boolean;
} = {}): Promise<ConfirmAnswer | 'timeout'> {
  const interval = o.intervalMs ?? 2500;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const end = now() + (o.timeoutMs ?? 90_000);
  const isFinal = o.isFinal ?? (() => true);
  for (;;) {
    let a: ConfirmAnswer | null = null;
    try { a = await confirm(); } catch (e) { if (isFinal(e)) throw e; }
    if (a?.status === 'credited') return a;
    if (o.stop?.() || now() + interval > end) return 'timeout';
    await sleep(interval);
  }
}
