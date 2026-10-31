// Checks one Solana transaction against one ad's USDC intent. Pure: the transaction JSON (getTransaction, jsonParsed, read
// at the config's commitment) goes in, a verdict comes out. Adapted from the USDC payment on
// origin/claude/shield-usdc-only (_shared/shield/usdc-verify.ts). A payment is accepted only if it succeeded, is no older
// than the intent, the intent's wallet signed it, it carries the intent's one-time reference key and memo, and exactly one
// TransferChecked of USDC (the intent's mint) moved at least the intent's amount from that wallet's token account to the
// receiver's associated token account, and the receiver's balance rose by exactly what was transferred (so no second
// transfer can hide in an inner instruction).
//
// Differences from the shield verifier, on purpose:
//   - amount >= price, not ==: an overpayment still books (the DB records what arrived).
//   - no expiry refusal: a USDC payment that really landed is never lost (20261125_pokejam_ads_live.sql books a late
//     one from the first opening). The intent's 15 minutes only bound the blockhash the page signs.
// Whether the signature already paid for something else is the database's call (pokejam_live_ad_usdc_pay).
import { PROGRAM, USDC_DECIMALS, deriveAta } from './usdc-chain.ts';

/** Seconds a block time may precede the intent's creation (block times are estimates). */
export const EARLY_SKEW_SECONDS = 60;

export interface IntentFacts {
  /** USDC base units. */
  amount: number | string;
  mint: string;
  receiver: string;
  wallet: string;
  reference: string;
  memo: string;
  /** Epoch seconds. */
  createdAt: number;
}

type Obj = Record<string, unknown>;
interface TokenBalance { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } }
interface Ix { programId?: string; program?: string; parsed?: unknown }
export interface ChainTx {
  blockTime?: number | null;
  meta?: { err?: unknown; preTokenBalances?: TokenBalance[]; postTokenBalances?: TokenBalance[]; innerInstructions?: { instructions: Ix[] }[] } | null;
  transaction?: { signatures?: string[]; message?: { accountKeys?: ({ pubkey: string; signer?: boolean; writable?: boolean } | string)[]; instructions?: Ix[] } };
}

export type VerifyCode =
  | 'pending' | 'tx_failed' | 'bad_tx' | 'too_early' | 'wrong_signer' | 'missing_reference' | 'missing_memo'
  | 'no_transfer' | 'wrong_mint' | 'wrong_recipient' | 'short_amount' | 'multiple_transfers';

export type Verdict = { ok: true; blockTime: number; paid: bigint } | { ok: false; code: VerifyCode; message: string };

const no = (code: VerifyCode, message: string): Verdict => ({ ok: false, code, message });

/** Plain-language reasons, safe to show an advertiser. */
export const VERIFY_MESSAGES: Record<VerifyCode, string> = {
  pending: 'Waiting for the payment to confirm on Solana',
  tx_failed: 'The transaction failed on Solana, so no USDC was sent',
  bad_tx: 'That is not the payment for this ad',
  too_early: 'That transaction is older than this booking',
  wrong_signer: 'The payment was not sent from the wallet that booked this ad',
  missing_reference: "The payment does not carry this booking's reference",
  missing_memo: "The payment does not carry this booking's memo",
  no_transfer: 'No USDC transfer found in that transaction',
  wrong_mint: 'The payment used the wrong token: pay in USDC',
  wrong_recipient: 'The payment did not go to the Poke Jam ads wallet',
  short_amount: 'The payment is less than the price of this ad',
  multiple_transfers: 'The transaction has more than one transfer to the ads wallet',
};

const MEMO_V1 = 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo';
const parsedOf = (ix: Ix): { type?: string; info?: Obj } | null => (ix.parsed && typeof ix.parsed === 'object' ? ix.parsed as { type?: string; info?: Obj } : null);
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const big = (v: unknown): bigint | null => { try { return typeof v === 'string' && /^\d+$/.test(v) ? BigInt(v) : null; } catch { return null; } };

export async function verifyUsdcTx(tx: ChainTx | null | undefined, signature: string, f: IntentFacts): Promise<Verdict> {
  // Not visible at the required commitment yet (finalized on mainnet): not refused, just not confirmed.
  if (!tx) return no('pending', VERIFY_MESSAGES.pending);
  const msg = tx.transaction?.message;
  if (!msg || tx.transaction?.signatures?.[0] !== signature) return no('bad_tx', VERIFY_MESSAGES.bad_tx);
  if (tx.meta?.err !== null && tx.meta?.err !== undefined) return no('tx_failed', VERIFY_MESSAGES.tx_failed);
  if (!tx.meta) return no('bad_tx', VERIFY_MESSAGES.bad_tx);
  const bt = tx.blockTime;
  if (typeof bt !== 'number') return no('pending', VERIFY_MESSAGES.pending);
  if (bt < f.createdAt - EARLY_SKEW_SECONDS) return no('too_early', VERIFY_MESSAGES.too_early);

  const keys = (msg.accountKeys ?? []).map((k) => (typeof k === 'string' ? { pubkey: k, signer: false, writable: false } : { pubkey: k.pubkey, signer: k.signer === true, writable: k.writable === true }));
  const idxOf = (a: string) => keys.findIndex((k) => k.pubkey === a);
  const payer = keys.find((k) => k.pubkey === f.wallet);
  if (!payer?.signer) return no('wrong_signer', VERIFY_MESSAGES.wrong_signer);
  const ref = keys.find((k) => k.pubkey === f.reference);
  if (!ref || ref.signer || ref.writable) return no('missing_reference', VERIFY_MESSAGES.missing_reference);
  const top = msg.instructions ?? [];
  if (!top.some((ix) => (ix.programId === PROGRAM.memo || ix.programId === MEMO_V1) && ix.parsed === f.memo)) return no('missing_memo', VERIFY_MESSAGES.missing_memo);

  const all: Ix[] = [...top, ...(tx.meta.innerInstructions ?? []).flatMap((i) => i.instructions ?? [])];
  const tokenIxs = all.filter((ix) => ix.programId === PROGRAM.token).map((ix) => ({ type: parsedOf(ix)?.type, info: parsedOf(ix)?.info ?? {} }));
  const receiverAta = await deriveAta(f.receiver, f.mint);
  // Any token movement into the receiver's account must be a TransferChecked; an unchecked `transfer` carries no mint.
  if (tokenIxs.some((t) => t.type === 'transfer' && str(t.info.destination) === receiverAta)) return no('no_transfer', VERIFY_MESSAGES.no_transfer);
  const checked = tokenIxs.filter((t) => t.type === 'transferChecked');
  if (!checked.length) {
    // A Token-2022 transfer (any other mint) is not USDC.
    const other = all.some((ix) => ix.programId !== PROGRAM.token && /transfer/i.test(parsedOf(ix)?.type ?? ''));
    return other ? no('wrong_mint', VERIFY_MESSAGES.wrong_mint) : no('no_transfer', VERIFY_MESSAGES.no_transfer);
  }
  const toReceiver = checked.filter((t) => str(t.info.destination) === receiverAta);
  if (!toReceiver.length) {
    const code = checked.some((t) => str(t.info.mint) !== f.mint) ? 'wrong_mint' : 'wrong_recipient';
    return no(code, VERIFY_MESSAGES[code]);
  }
  if (toReceiver.length > 1) return no('multiple_transfers', VERIFY_MESSAGES.multiple_transfers);
  const info = toReceiver[0].info;
  if (str(info.mint) !== f.mint) return no('wrong_mint', VERIFY_MESSAGES.wrong_mint);
  const ta = (info.tokenAmount ?? {}) as Obj;
  const sent = big(ta.amount);
  if (sent === null || ta.decimals !== USDC_DECIMALS) return no('bad_tx', VERIFY_MESSAGES.bad_tx);
  if (sent < BigInt(f.amount)) return no('short_amount', VERIFY_MESSAGES.short_amount);
  if ((str(info.authority) || str(info.multisigAuthority)) !== f.wallet) return no('wrong_signer', VERIFY_MESSAGES.wrong_signer);

  // The balances agree: the source belongs to the wallet; the destination is the receiver's own USDC account (owner and
  // mint as the chain reports them, not just the derived address) and rose by exactly what was transferred.
  const pre = tx.meta.preTokenBalances ?? [];
  const post = tx.meta.postTokenBalances ?? [];
  const srcIdx = idxOf(str(info.source));
  const src = [...pre, ...post].find((b) => b.accountIndex === srcIdx);
  if (srcIdx < 0 || !src || src.owner !== f.wallet || src.mint !== f.mint) return no('wrong_signer', VERIFY_MESSAGES.wrong_signer);
  const dstIdx = idxOf(receiverAta);
  const after = post.find((b) => b.accountIndex === dstIdx);
  if (dstIdx < 0 || !after || after.owner !== f.receiver) return no('wrong_recipient', VERIFY_MESSAGES.wrong_recipient);
  if (after.mint !== f.mint) return no('wrong_mint', VERIFY_MESSAGES.wrong_mint);
  const before = pre.find((b) => b.accountIndex === dstIdx);
  const delta = (big(after.uiTokenAmount.amount) ?? 0n) - (big(before?.uiTokenAmount.amount ?? '0') ?? 0n);
  if (delta !== sent) return no('multiple_transfers', VERIFY_MESSAGES.multiple_transfers);
  return { ok: true, blockTime: bt, paid: sent };
}

/** getTransaction with the parameters the verifier relies on. `call` is Rpc.call (or a test double). */
export function fetchTransaction(call: <T>(method: string, params: unknown[]) => Promise<T>, signature: string, commitment: 'confirmed' | 'finalized'): Promise<ChainTx | null> {
  return call<ChainTx | null>('getTransaction', [signature, { encoding: 'jsonParsed', commitment, maxSupportedTransactionVersion: 0 }]);
}
