// Billboard ads: is this landed transaction a burn that pays for booking <code>? Reads the RPC's jsonParsed form of
// getTransaction, so the token amounts and the memo come from the validator's own parser.

import { adMemo, MEMO_PROGRAM } from './tx.ts';

interface TokenBalance { accountIndex: number; mint?: string; owner?: string }

interface ParsedIx {
  program?: string;
  programId: string;
  parsed?: unknown;
}

/** The parts of a jsonParsed getTransaction result this needs. */
export interface ParsedTransaction {
  slot: number;
  blockTime: number | null;
  meta: { err: unknown; innerInstructions?: { index: number; instructions: ParsedIx[] }[] | null; preTokenBalances?: TokenBalance[] | null; postTokenBalances?: TokenBalance[] | null } | null;
  transaction: { signatures: string[]; message: { accountKeys: { pubkey: string; signer: boolean }[]; instructions: ParsedIx[] } };
}

export interface BurnExpectation {
  code: string;
  mint: string;
  /** The program that owns the mint (Token or Token-2022): a burn under any other program is not a burn of this token. */
  tokenProgram: string;
  /**
   * Live board: the booking's wallet must have signed, and only burns it authorised from its own token account count.
   * Unset on the devnet board, where anyone may pay for an ad.
   */
  wallet?: string;
  /** Live board: the mint's decimals, which a burnChecked must state. */
  decimals?: number;
  /** Live board: the booking's creation (epoch seconds). An older transaction can't be the payment for it. */
  notBefore?: number;
}

/** Seconds a block time may precede the booking's creation (block times are estimates). */
export const BURN_EARLY_SKEW_SECONDS = 60;

export type BurnCheck =
  | { ok: true; signature: string; burned: bigint; burner: string; slot: number; blockTime: number | null }
  | { ok: false; why: string };

interface BurnInfo { account?: string; mint?: string; authority?: string; multisigAuthority?: string; amount?: string; tokenAmount?: { amount?: string; decimals?: number } }

/**
 * Every burn of the mint in a successful transaction whose memo names the booking counts. On the devnet board that's
 * whoever burned (the burn's authority had to sign for it); on the live board only the booking wallet's own burns from its
 * own account (want.wallet). The amount decides the airtime (pokejam_ad_pay; on the live board, at least the price).
 */
export function checkBurn(tx: ParsedTransaction | null, want: BurnExpectation): BurnCheck {
  if (!tx) return { ok: false, why: 'transaction not found' };
  if (!tx.meta) return { ok: false, why: 'transaction has no status' };
  if (tx.meta.err) return { ok: false, why: 'transaction failed' };
  const top = tx.transaction.message.instructions;
  const all = [...top, ...(tx.meta.innerInstructions ?? []).flatMap((x) => x.instructions)];
  // The memo must be a top-level instruction of this transaction, exactly ours.
  if (!top.some((ix) => ix.programId === MEMO_PROGRAM && ix.parsed === adMemo(want.code))) return { ok: false, why: 'memo does not name this booking' };
  const keys = tx.transaction.message.accountKeys;
  if (want.wallet && !keys.some((k) => k.pubkey === want.wallet && k.signer)) return { ok: false, why: 'the wallet that booked this ad did not sign it' };
  if (want.notBefore !== undefined) {
    if (typeof tx.blockTime !== 'number') return { ok: false, why: 'transaction has no block time' };
    if (tx.blockTime < want.notBefore - BURN_EARLY_SKEW_SECONDS) return { ok: false, why: 'transaction is older than this booking' };
  }
  const balances = [...(tx.meta.preTokenBalances ?? []), ...(tx.meta.postTokenBalances ?? [])];
  const ownerOf = (account: string | undefined) => {
    const at = keys.findIndex((k) => k.pubkey === account);
    return at < 0 ? undefined : balances.find((b) => b.accountIndex === at && b.mint === want.mint)?.owner;
  };
  let burned = 0n;
  let burner = '';
  let foreign = false;
  for (const ix of all) {
    if (ix.programId !== want.tokenProgram) continue;
    const p = ix.parsed as { type?: string; info?: BurnInfo } | undefined;
    if (!p || (p.type !== 'burn' && p.type !== 'burnChecked') || !p.info) continue;
    const i = p.info;
    if (i.mint !== want.mint) continue;
    const amount = i.tokenAmount?.amount ?? i.amount;
    if (typeof amount !== 'string' || !/^\d+$/.test(amount)) continue;
    if (want.decimals !== undefined && i.tokenAmount && i.tokenAmount.decimals !== want.decimals) continue;
    if (want.wallet && (i.authority !== want.wallet || ownerOf(i.account) !== want.wallet)) { foreign = true; continue; }
    burned += BigInt(amount);
    burner ||= i.authority ?? i.multisigAuthority ?? '';
  }
  if (burned === 0n) return { ok: false, why: foreign ? 'the burn did not come from the wallet that booked this ad' : 'no burn of the token' };
  return { ok: true, signature: tx.transaction.signatures[0], burned, burner, slot: tx.slot, blockTime: tx.blockTime };
}
