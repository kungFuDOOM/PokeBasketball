import { describe, expect, it } from 'vitest';
import { buildBurnTransaction, buildMessage, burnCheckedIx, memoIx, unsignedTransaction, SPL_2022_PROGRAM } from '../../supabase/functions/_shared/ads/tx.ts';
import { base64Encode } from '../../supabase/functions/_shared/pack/bytes.ts';
import { BurnGuardError, burnNeeded, checkBurnTransaction } from './burnGuard';

const MINT = 'GQe9QiBBV4G6bRUCxx2JgKrzT7G7RD17FJquBWgVpump';
const OWNER = 'DfKMpBEoYMWnkzGvfVQnHVQhQ2uuLvpwqUDzy45BfUBf';
const ACCOUNT = '6PsAwuinQkKqTXwSSzJ8rV7efJRMkz3zweDgirpaA8QR';
const OTHER = 'A4ahkivAG4NoZAE8Sy4qv8nn2DU9yoXRQcttuCeGtTJv';
const BLOCKHASH = '11111111111111111111111111111111';
const PRICE = 100_000_000_000n;
const CODE = 'abc123def456';

const burn = (amount: bigint, o: { code?: string; owner?: string; mint?: string } = {}) => buildBurnTransaction({
  owner: o.owner ?? OWNER, tokenAccount: ACCOUNT, mint: o.mint ?? MINT, tokenProgram: SPL_2022_PROGRAM, amount, decimals: 6,
  code: o.code ?? CODE, recentBlockhash: BLOCKHASH, priorityMicroLamports: 0,
});
const want = (credit = 0n) => ({ owner: OWNER, mint: MINT, code: CODE, price: PRICE, credit });

describe('the page signs a burn of exactly what the booking needs', () => {
  it('needs the price less the credit, and at least one base unit', () => {
    expect(burnNeeded(PRICE, 0n)).toBe(PRICE);
    expect(burnNeeded(PRICE, 40_000_000_000n)).toBe(60_000_000_000n);
    expect(burnNeeded(PRICE, PRICE)).toBe(1n);
    expect(burnNeeded(PRICE, PRICE * 3n)).toBe(1n);
  });

  it('accepts the exact price, and the exact price less the credit shown', () => {
    expect(checkBurnTransaction(burn(PRICE), want())).toBe(PRICE);
    expect(checkBurnTransaction(burn(60_000_000_000n), want(40_000_000_000n))).toBe(60_000_000_000n);
    expect(checkBurnTransaction(burn(1n), want(PRICE))).toBe(1n);
  });

  it('blocks anything less than the price (or than price - credit) before signing', () => {
    expect(() => checkBurnTransaction(burn(PRICE - 1n), want())).toThrow(BurnGuardError);
    expect(() => checkBurnTransaction(burn(PRICE - 1n), want())).toThrow(/less than the price/);
    expect(() => checkBurnTransaction(burn(1n), want())).toThrow(/less than the price/);
    expect(() => checkBurnTransaction(burn(59_999_999_999n), want(40_000_000_000n))).toThrow(/less than the price/);
    // Credit the page never showed does not lower the bar.
    expect(() => checkBurnTransaction(burn(60_000_000_000n), want(0n))).toThrow(BurnGuardError);
  });

  it('blocks more than needed, another booking, token, signer or extra instructions', () => {
    expect(() => checkBurnTransaction(burn(PRICE + 1n), want())).toThrow(/different amount/);
    expect(() => checkBurnTransaction(burn(PRICE, { code: 'ffffffffffff' }), want())).toThrow(/memo/);
    expect(() => checkBurnTransaction(burn(PRICE, { mint: OTHER }), want())).toThrow(/not \$PJAM/);
    expect(() => checkBurnTransaction(burn(PRICE, { owner: OTHER }), want())).toThrow(/different signer/);
    const two = base64Encode(unsignedTransaction(buildMessage(OWNER, [burnCheckedIx(SPL_2022_PROGRAM, ACCOUNT, MINT, OWNER, PRICE, 6),
      burnCheckedIx(SPL_2022_PROGRAM, ACCOUNT, MINT, OWNER, PRICE, 6), memoIx(`pokejam-ad:${CODE}`)], BLOCKHASH).message, 1));
    expect(() => checkBurnTransaction(two, want())).toThrow(/exactly one/);
    expect(() => checkBurnTransaction('not base64!', want())).toThrow(BurnGuardError);
  });
});
