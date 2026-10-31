// Billboard ads: is this landed transaction a burn that pays for booking <code>? Reads the RPC's jsonParsed form of
// getTransaction, so the token amounts and the memo come from the validator's own parser.

import { adMemo, MEMO_PROGRAM } from './tx.ts';

interface ParsedIx {
  program?: string;
  programId: string;
  parsed?: unknown;
}

/** The parts of a jsonParsed getTransaction result this needs. */
export interface ParsedTransaction {
  slot: number;
  blockTime: number | null;
  meta: { err: unknown; innerInstructions?: { index: number; instructions: ParsedIx[] }[] | null } | null;
  transaction: { signatures: string[]; message: { accountKeys: { pubkey: string; signer: boolean }[]; instructions: ParsedIx[] } };
}

export interface BurnExpectation {
  code: string;
  mint: string;
  /** The program that owns the mint (Token or Token-2022): a burn under any other program is not a burn of this token. */
  tokenProgram: string;
}

export type BurnCheck =
  | { ok: true; signature: string; burned: bigint; burner: string; slot: number; blockTime: number | null }
  | { ok: false; why: string };

interface BurnInfo { mint?: string; authority?: string; multisigAuthority?: string; amount?: string; tokenAmount?: { amount?: string } }

/**
 * Every burn of the mint in a successful transaction whose memo names the booking counts, whoever burned (anyone may
 * pay for an ad; the burn's authority had to sign for it). The amount decides the airtime (pokejam_ad_pay).
 */
export function checkBurn(tx: ParsedTransaction | null, want: BurnExpectation): BurnCheck {
  if (!tx) return { ok: false, why: 'transaction not found' };
  if (!tx.meta) return { ok: false, why: 'transaction has no status' };
  if (tx.meta.err) return { ok: false, why: 'transaction failed' };
  const top = tx.transaction.message.instructions;
  const all = [...top, ...(tx.meta.innerInstructions ?? []).flatMap((x) => x.instructions)];
  // The memo must be a top-level instruction of this transaction, exactly ours.
  if (!top.some((ix) => ix.programId === MEMO_PROGRAM && ix.parsed === adMemo(want.code))) return { ok: false, why: 'memo does not name this booking' };
  let burned = 0n;
  let burner = '';
  for (const ix of all) {
    if (ix.programId !== want.tokenProgram) continue;
    const p = ix.parsed as { type?: string; info?: BurnInfo } | undefined;
    if (!p || (p.type !== 'burn' && p.type !== 'burnChecked') || !p.info) continue;
    const i = p.info;
    if (i.mint !== want.mint) continue;
    const amount = i.tokenAmount?.amount ?? i.amount;
    if (typeof amount !== 'string' || !/^\d+$/.test(amount)) continue;
    burned += BigInt(amount);
    burner ||= i.authority ?? i.multisigAuthority ?? '';
  }
  if (burned === 0n) return { ok: false, why: 'no burn of the token' };
  return { ok: true, signature: tx.transaction.signatures[0], burned, burner, slot: tx.slot, blockTime: tx.blockTime };
}
