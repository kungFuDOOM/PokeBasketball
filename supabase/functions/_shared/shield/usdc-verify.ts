// Checks one Solana transaction against one USDC intent. Pure: the transaction JSON (getTransaction, jsonParsed) goes in,
// a verdict comes out. A payment is accepted only if EVERYTHING matches: it succeeded, it is in the intent's time window, the
// player's linked wallet signed it, it carries the intent's one-time reference key and memo, and exactly one TransferChecked
// of the intent's mint and EXACT amount moved from that wallet's token account to the house wallet's token account (and the
// house balance rose by exactly that amount, so no second transfer can hide in an inner instruction).
import { PROGRAM, deriveAta } from './usdc-chain.ts';
import { EARLY_SKEW_SECONDS, EXPIRY_GRACE_SECONDS } from './usdc-config.ts';

export interface IntentFacts {
  amount: number | string;
  mint: string;
  receiver: string;
  wallet: string;
  reference: string;
  memo: string;
  /** Epoch seconds. */
  createdAt: number;
  expiresAt: number;
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
  | 'pending' | 'tx_failed' | 'bad_tx' | 'expired' | 'too_early' | 'wrong_signer' | 'missing_reference' | 'missing_memo'
  | 'no_transfer' | 'wrong_mint' | 'wrong_recipient' | 'wrong_amount' | 'multiple_transfers';

export type Verdict = { ok: true; blockTime: number } | { ok: false; code: VerifyCode; message: string };

const no = (code: VerifyCode, message: string): Verdict => ({ ok: false, code, message });

/** Plain-language reasons, safe to show a player. */
export const VERIFY_MESSAGES: Record<VerifyCode, string> = {
  pending: 'Waiting for the transaction to confirm on Solana',
  tx_failed: 'The transaction failed on Solana, so you were not charged',
  bad_tx: 'That is not the payment we were waiting for',
  expired: 'This payment window has expired. Start a new purchase',
  too_early: 'That transaction is older than this purchase',
  wrong_signer: 'The payment was not signed by your signed-in wallet',
  missing_reference: 'The payment does not carry this purchase\'s reference',
  missing_memo: 'The payment does not carry this purchase\'s memo',
  no_transfer: 'No USDC transfer found in that transaction',
  wrong_mint: 'The payment used the wrong token',
  wrong_recipient: 'The payment did not go to the shop wallet',
  wrong_amount: 'The payment amount does not match the price',
  multiple_transfers: 'The transaction has more than one transfer',
};

const parsedOf = (ix: Ix): { type?: string; info?: Obj } | null => (ix.parsed && typeof ix.parsed === 'object' ? ix.parsed as { type?: string; info?: Obj } : null);
const str = (v: unknown) => (typeof v === 'string' ? v : '');

export async function verifyUsdcTx(tx: ChainTx | null | undefined, signature: string, f: IntentFacts): Promise<Verdict> {
  if (!tx) return no('pending', VERIFY_MESSAGES.pending);
  const msg = tx.transaction?.message;
  if (!msg || tx.transaction?.signatures?.[0] !== signature) return no('bad_tx', VERIFY_MESSAGES.bad_tx);
  if (tx.meta?.err !== null && tx.meta?.err !== undefined) return no('tx_failed', VERIFY_MESSAGES.tx_failed);
  if (!tx.meta) return no('bad_tx', VERIFY_MESSAGES.bad_tx);
  const bt = tx.blockTime;
  if (typeof bt !== 'number') return no('pending', VERIFY_MESSAGES.pending);
  if (bt < f.createdAt - EARLY_SKEW_SECONDS) return no('too_early', VERIFY_MESSAGES.too_early);
  if (bt > f.expiresAt + EXPIRY_GRACE_SECONDS) return no('expired', VERIFY_MESSAGES.expired);

  const keys = (msg.accountKeys ?? []).map((k) => (typeof k === 'string' ? { pubkey: k, signer: false, writable: false } : { pubkey: k.pubkey, signer: k.signer === true, writable: k.writable === true }));
  const idxOf = (a: string) => keys.findIndex((k) => k.pubkey === a);
  const payer = keys.find((k) => k.pubkey === f.wallet);
  if (!payer?.signer) return no('wrong_signer', VERIFY_MESSAGES.wrong_signer);
  const ref = keys.find((k) => k.pubkey === f.reference);
  if (!ref || ref.signer || ref.writable) return no('missing_reference', VERIFY_MESSAGES.missing_reference);
  const top = msg.instructions ?? [];
  const memoOk = top.some((ix) => (ix.programId === PROGRAM.memo || ix.programId === 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo') && ix.parsed === f.memo);
  if (!memoOk) return no('missing_memo', VERIFY_MESSAGES.missing_memo);

  const all: Ix[] = [...top, ...(tx.meta.innerInstructions ?? []).flatMap((i) => i.instructions ?? [])];
  const tokenIxs = all.filter((ix) => ix.programId === PROGRAM.token).map((ix) => ({ type: parsedOf(ix)?.type, info: parsedOf(ix)?.info ?? {} }));
  const receiverAta = await deriveAta(f.receiver, f.mint);
  // Any token movement into the house account must be a TransferChecked; an unchecked `transfer` carries no mint.
  if (tokenIxs.some((t) => t.type === 'transfer' && str(t.info.destination) === receiverAta)) return no('no_transfer', VERIFY_MESSAGES.no_transfer);
  const checked = tokenIxs.filter((t) => t.type === 'transferChecked');
  if (!checked.length) return no('no_transfer', VERIFY_MESSAGES.no_transfer);
  const toHouse = checked.filter((t) => str(t.info.destination) === receiverAta);
  if (!toHouse.length) {
    const code = checked.some((t) => str(t.info.mint) !== f.mint) ? 'wrong_mint' : 'wrong_recipient';
    return no(code, VERIFY_MESSAGES[code]);
  }
  if (toHouse.length > 1) return no('multiple_transfers', VERIFY_MESSAGES.multiple_transfers);
  const info = toHouse[0].info;
  if (str(info.mint) !== f.mint) return no('wrong_mint', VERIFY_MESSAGES.wrong_mint);
  const ta = (info.tokenAmount ?? {}) as Obj;
  if (str(ta.amount) !== String(f.amount) || ta.decimals !== 6) return no('wrong_amount', VERIFY_MESSAGES.wrong_amount);
  if ((str(info.authority) || str(info.multisigAuthority)) !== f.wallet) return no('wrong_signer', VERIFY_MESSAGES.wrong_signer);

  // The balances agree: the source belongs to the wallet, the house account (owned by the house, right mint) rose by exactly the price.
  const pre = tx.meta.preTokenBalances ?? [];
  const post = tx.meta.postTokenBalances ?? [];
  const srcIdx = idxOf(str(info.source));
  const src = [...pre, ...post].find((b) => b.accountIndex === srcIdx);
  if (srcIdx < 0 || !src || src.owner !== f.wallet || src.mint !== f.mint) return no('wrong_signer', VERIFY_MESSAGES.wrong_signer);
  const dstIdx = idxOf(receiverAta);
  const after = post.find((b) => b.accountIndex === dstIdx);
  if (dstIdx < 0 || !after || after.owner !== f.receiver || after.mint !== f.mint) return no('wrong_recipient', VERIFY_MESSAGES.wrong_recipient);
  const before = pre.find((b) => b.accountIndex === dstIdx);
  const delta = BigInt(after.uiTokenAmount.amount) - BigInt(before?.uiTokenAmount.amount ?? '0');
  if (delta !== BigInt(f.amount)) return no('wrong_amount', VERIFY_MESSAGES.wrong_amount);
  return { ok: true, blockTime: bt };
}

/** getTransaction with the parameters the verifier relies on. `call` is Rpc.call (or a test double). */
export function fetchTransaction(call: <T>(method: string, params: unknown[]) => Promise<T>, signature: string, commitment: 'confirmed' | 'finalized'): Promise<ChainTx | null> {
  return call<ChainTx | null>('getTransaction', [signature, { encoding: 'jsonParsed', commitment, maxSupportedTransactionVersion: 0 }]);
}
