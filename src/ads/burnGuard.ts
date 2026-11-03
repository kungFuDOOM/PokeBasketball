// The browser half of "a burn is never wasted": before the wallet is asked to sign, the page reads the server's unsigned
// burn and refuses anything that isn't exactly one burn of what this booking needs, from the connected wallet's own
// account, with the booking's memo. Burned tokens can't come back, so a burn below that (which the server would only keep
// as credit) is never offered for signing. What it needs is the locked price minus the burn credit the page showed the
// advertiser (never less than one base unit, because a burn needs an amount).
import { base64Decode } from '../../supabase/functions/_shared/pack/bytes.ts';
import { decodeTransaction } from '../../supabase/functions/_shared/pack/tx-inspect.ts';
import { COMPUTE_BUDGET, MEMO_PROGRAM, SPL_2022_PROGRAM, SPL_PROGRAM, adMemo } from '../../supabase/functions/_shared/ads/tx.ts';

export class BurnGuardError extends Error {
  name = 'BurnGuardError';
}

/** What to burn: the locked price less the credit already held, and at least one base unit. */
export const burnNeeded = (price: bigint, credit: bigint): bigint => (price > credit ? price - credit : 1n);

export interface BurnExpectation {
  /** The connected wallet: the only signer, and the burn's authority. */
  owner: string;
  mint: string;
  code: string;
  /** The booking's locked price, in base units. */
  price: bigint;
  /** The credit the page showed. */
  credit: bigint;
}

/** Throws BurnGuardError unless `tx` is exactly the burn this booking needs. Returns the amount it burns. */
export function checkBurnTransaction(txBase64: string, want: BurnExpectation): bigint {
  const bad = (why: string) => new BurnGuardError(`This burn doesn't look right (${why}), so nothing was burned. Reload the page and try again.`);
  let d;
  try { d = decodeTransaction(base64Decode(txBase64)); } catch { throw bad('not a transaction'); }
  if (d.signers.length !== 1 || d.signers[0] !== want.owner) throw bad('a different signer');
  const burns = d.instructions.filter((ix) => ix.program === SPL_PROGRAM || ix.program === SPL_2022_PROGRAM);
  if (burns.length !== 1) throw bad('not exactly one token instruction');
  const [burn] = burns;
  // BurnChecked is [15, amount u64 LE, decimals] over accounts [token account, mint, authority]: the only burn the server builds.
  if (burn.data[0] !== 15 || burn.data.length !== 10) throw bad('not a burn');
  if (burn.accounts[1] !== want.mint) throw bad('not $PJAM');
  if (burn.accounts[2] !== want.owner) throw bad('not from your own account');
  const amount = new DataView(burn.data.buffer, burn.data.byteOffset + 1, 8).getBigUint64(0, true);
  const needed = burnNeeded(want.price, want.credit);
  if (amount < needed) throw bad('less than the price');
  if (amount !== needed) throw bad('a different amount');
  const memos = d.instructions.filter((ix) => ix.program === MEMO_PROGRAM);
  if (memos.length !== 1 || new TextDecoder().decode(memos[0].data) !== adMemo(want.code)) throw bad("the memo doesn't name this booking");
  if (d.instructions.some((ix) => ix !== burn && ix !== memos[0] && ix.program !== COMPUTE_BUDGET)) throw bad('extra instructions');
  return amount;
}
