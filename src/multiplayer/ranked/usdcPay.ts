// The browser half of paying for Rank Shields in USDC with Phantom: build the SPL TransferChecked transaction for a server
// intent, hand it to the wallet to sign and send, and wait for the server to confirm it. No private key, no Solana SDK: the
// transaction bytes come from the same code the Edge Functions use to check the payment (usdc-chain.ts). The wallet is the
// only thing that can move the player's funds; the server credits only after it has read the payment back from Solana.
import { base58Decode, base58Encode } from '../../../supabase/functions/_shared/pack/bytes.ts';
import { PUBLIC_RPC, buildUsdcTransfer, type BuiltTransfer, type UsdcCluster } from '../../../supabase/functions/_shared/shield/usdc-chain.ts';

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
}

export class UsdcPayError extends Error {
  name = 'UsdcPayError';
  constructor(message: string, public kind: 'rejected' | 'no-phantom' | 'wrong-wallet' | 'shop-wallet' | 'failed' = 'failed') { super(message); }
}

/** Reads the fields of a shield-usdc-intent answer; throws if any is missing (a changed server is not guessed at). */
export function parseIntent(raw: unknown): UsdcIntent {
  const r = raw as Record<string, unknown> | null;
  const s = (k: string) => { const v = r?.[k]; if (typeof v !== 'string' || !v) throw new UsdcPayError('Could not start the payment. Try again in a moment.'); return v; };
  const cluster = s('cluster');
  if (cluster !== 'devnet' && cluster !== 'mainnet-beta') throw new UsdcPayError('Could not start the payment. Try again in a moment.');
  const decimals = Number(r?.decimals);
  if (!/^[0-9]{1,18}$/.test(s('amount')) || decimals !== 6) throw new UsdcPayError('Could not start the payment. Try again in a moment.');
  return { intentId: s('intentId'), reference: s('reference'), memo: s('memo'), receiver: s('receiver'), mint: s('mint'), cluster, amount: s('amount'), decimals };
}

export type RpcCall = <T>(method: string, params: unknown[]) => Promise<T>;

/** A minimal JSON-RPC caller for the cluster's public endpoint (blockhash and an account check only). */
export function rpcFor(cluster: UsdcCluster, fetchFn: typeof fetch = (...a) => fetch(...a), url = PUBLIC_RPC[cluster]): RpcCall {
  let id = 0;
  return async <T>(method: string, params: unknown[]) => {
    const res = await fetchFn(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params }) });
    if (!res.ok) throw new Error(`RPC ${method}: HTTP ${res.status}`);
    const body = (await res.json()) as { result?: T; error?: { message?: string } };
    if (body.error) throw new Error(`RPC ${method}: ${body.error.message ?? 'error'}`);
    return body.result as T;
  };
}

/**
 * The unsigned transfer for an intent. Needs the shop wallet's USDC token account to exist (the owner creates it once);
 * a missing one is reported before the player is asked to sign anything.
 */
export async function prepareTransfer(intent: UsdcIntent, payer: string, rpc: RpcCall): Promise<BuiltTransfer> {
  const blockhash = await rpc<{ value: { blockhash: string } }>('getLatestBlockhash', [{ commitment: 'confirmed' }]).then((r) => r.value.blockhash).catch(() => {
    throw new UsdcPayError('Could not reach Solana. Try again in a moment.');
  });
  const built = await buildUsdcTransfer({ payer, mint: intent.mint, receiver: intent.receiver, amount: BigInt(intent.amount), decimals: intent.decimals, reference: intent.reference, memo: intent.memo, blockhash });
  const dest = await rpc<{ value: unknown }>('getAccountInfo', [built.destination, { encoding: 'base64', commitment: 'confirmed' }]).catch(() => null);
  if (dest && dest.value === null) throw new UsdcPayError('USDC payments are not ready yet. Try again later.', 'shop-wallet');
  return built;
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

/**
 * Asks the server to confirm until it says 'credited' (resolves with that answer) or the time runs out (resolves with
 * 'timeout'). A refusal (the confirm call throws) ends the wait. The same signature can be confirmed again at any time.
 */
export async function pollConfirm(confirm: () => Promise<ConfirmAnswer>, o: {
  intervalMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number; stop?: () => boolean;
} = {}): Promise<ConfirmAnswer | 'timeout'> {
  const interval = o.intervalMs ?? 2500;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const end = now() + (o.timeoutMs ?? 90_000);
  for (;;) {
    const a = await confirm();
    if (a.status === 'credited') return a;
    if (o.stop?.() || now() + interval > end) return 'timeout';
    await sleep(interval);
  }
}
