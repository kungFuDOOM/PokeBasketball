// The browser half of paying for a courtside ad in USDC (pokejam-ads-live's usdc-intent / usdc-confirm). Adapted from the
// Rank Shield USDC payment on origin/claude/shield-usdc-only (src/multiplayer/ranked/usdcPay.ts), without Phantom-only code:
// the ad page signs through the Wallet Standard (wallet.ts), like a burn.
//
// The server builds the unsigned transfer, but the page doesn't take its word for it: before the wallet is asked to sign,
// the page rebuilds the same transfer from the intent with the same code the server uses (usdc-chain.ts) and checks the bytes
// match, the mint is Circle's USDC and the money goes to kungfudoom.sns's USDC account. Nothing here holds a key or talks
// to Solana: the advertiser's wallet moves the USDC and the server books the ad only after reading the payment back.
import { base64Decode } from '../../supabase/functions/_shared/pack/bytes.ts';
import { USDC_DECIMALS, USDC_MINT, USDC_RECEIVER, buildUsdcTransfer, type UsdcCluster } from '../../supabase/functions/_shared/ads/usdc-chain.ts';

/** What USDC buys: the bookable courtside half, for a week or a month (ticker and combo stay contact-sales). */
export type UsdcPlan = 'week' | 'month';
export const USDC_PLANS: UsdcPlan[] = ['week', 'month'];
export const USDC_PLAN_HOURS: Record<UsdcPlan, number> = { week: 168, month: 720 };
/** The list prices in dollars (src/data/ads.ts's courtside half). The server's price is what's charged. */
export const USDC_PLAN_USD: Record<UsdcPlan, number> = { week: 150, month: 500 };

export const isUsdcPlan = (p: unknown): p is UsdcPlan => p === 'week' || p === 'month';

/** USDC base units for a plan's list price. */
export const planBaseUnits = (p: UsdcPlan): bigint => BigInt(USDC_PLAN_USD[p]) * 10n ** BigInt(USDC_DECIMALS);

/** Base units → "$150" or "$150.50" (USDC is a dollar). */
export function usd(base: string | bigint, decimals = USDC_DECIMALS): string {
  const v = BigInt(base);
  const unit = 10n ** BigInt(decimals);
  const whole = (v / unit).toLocaleString('en-US');
  const cents = ((v % unit) * 100n) / unit;
  return `$${whole}${cents ? `.${cents.toString().padStart(2, '0')}` : ''}`;
}

export class UsdcPayError extends Error {
  name = 'UsdcPayError';
}

/** usdc-intent's answer, read strictly: a server that answers differently is not guessed at. */
export interface UsdcIntentReply {
  id: string;
  plan: UsdcPlan;
  wallet: string;
  amount: string;
  mint: string;
  receiver: string;
  reference: string;
  memo: string;
  cluster: UsdcCluster;
  blockhash: string;
  /** The unsigned transfer (base64). */
  tx: string;
}

const START_FAILED = 'Could not start the payment. Try again in a moment.';

export function parseUsdcIntent(raw: unknown): UsdcIntentReply {
  const r = raw as Record<string, unknown> | null;
  const i = r?.intent as Record<string, unknown> | undefined;
  const str = (o: Record<string, unknown> | null | undefined, k: string) => {
    const v = o?.[k];
    if (typeof v !== 'string' || !v) throw new UsdcPayError(START_FAILED);
    return v;
  };
  const cluster = str(r, 'cluster');
  const plan = str(i, 'plan');
  const amount = str(i, 'amount');
  if ((cluster !== 'devnet' && cluster !== 'mainnet-beta') || !isUsdcPlan(plan) || !/^[0-9]{1,18}$/.test(amount) || Number(r?.decimals) !== USDC_DECIMALS) {
    throw new UsdcPayError(START_FAILED);
  }
  return {
    id: str(i, 'id'), plan, wallet: str(i, 'wallet'), amount, mint: str(i, 'mint'), receiver: str(i, 'receiver'),
    reference: str(i, 'reference'), memo: str(i, 'memo'), cluster, blockhash: str(r, 'blockhash'), tx: str(r, 'tx'),
  };
}

const same = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, k) => x === b[k]);

/**
 * Checks the server's unsigned transfer before the wallet sees it: it must be exactly the transfer this page would build
 * for the intent (payer = the connected wallet, Circle's USDC for the cluster, to kungfudoom.sns's USDC account, the
 * quoted amount, the intent's reference and memo). Throws UsdcPayError otherwise. Returns the destination token account.
 */
export async function checkTransfer(intent: UsdcIntentReply, o: { payer: string; expectAmount?: string | null }): Promise<{ destination: string }> {
  const bad = (why: string) => new UsdcPayError(`This payment doesn't look right (${why}), so nothing was sent. Reload the page and try again.`);
  if (intent.wallet !== o.payer) throw bad('a different wallet');
  if (intent.mint !== USDC_MINT[intent.cluster]) throw bad('not USDC');
  if (intent.receiver !== USDC_RECEIVER) throw bad('a different receiver');
  if (o.expectAmount && intent.amount !== o.expectAmount) throw bad('a different price');
  let built;
  try {
    built = await buildUsdcTransfer({ payer: o.payer, mint: intent.mint, receiver: intent.receiver, amount: BigInt(intent.amount), reference: intent.reference, memo: intent.memo, blockhash: intent.blockhash });
  } catch {
    throw bad('it could not be rebuilt');
  }
  let theirs: Uint8Array;
  try { theirs = base64Decode(intent.tx); } catch { throw bad('not a transaction'); }
  if (!same(theirs, built.transaction)) throw bad('the transaction differs');
  return { destination: built.destination };
}

/** usdc-confirm's answer. */
export interface UsdcConfirmReply { status: 'paid' | 'pending' | 'open'; duplicate?: boolean }

/**
 * Asks the server to confirm until it says 'paid' (resolves with that answer) or the time runs out ('timeout'). A refusal
 * (confirm throws) ends the wait. The same intent can be confirmed again at any time: the database books it once.
 */
export async function pollUsdcConfirm<R extends UsdcConfirmReply>(confirm: () => Promise<R>, o: {
  intervalMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number; stop?: () => boolean;
} = {}): Promise<R | 'timeout'> {
  const interval = o.intervalMs ?? 3000;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const end = now() + (o.timeoutMs ?? 120_000);
  for (;;) {
    const a = await confirm();
    if (a.status === 'paid') return a;
    if (o.stop?.() || now() + interval > end) return 'timeout';
    await sleep(interval);
  }
}
