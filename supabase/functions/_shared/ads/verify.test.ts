// The live board's reading of a burn: the booking's wallet burned, from its own account, the configured mint, in a
// transaction that succeeded and is no older than the booking. Amount >= price is the database's call
// (pokejam_live_ad_pay; supabase/tests/ads-live.test.ts).
import { describe, expect, it } from 'vitest';
import { MEMO_PROGRAM, SPL_2022_PROGRAM, SPL_PROGRAM, adMemo } from './tx.ts';
import { checkBurn, type BurnExpectation, type ParsedTransaction } from './verify.ts';

const WALLET = '9wqysMYY4DTcbPjSZpGQU3pF29YUw9w6A1a8XDKVhezh';
const STRANGER = 'A4ahkivAG4NoZAE8Sy4qv8nn2DU9yoXRQcttuCeGtTJv';
const WALLET_ACCOUNT = '6PsAwuinQkKqTXwSSzJ8rV7efJRMkz3zweDgirpaA8QR';
const STRANGER_ACCOUNT = 'BSmgKqfYR6ChrxHn7HkkYbZwbDq5E8ZfUJxcwGCNTP4w';
const MINT = 'GQe9QiBBV4G6bRUCxx2JgKrzT7G7RD17FJquBWgVpump';
const FAKE_MINT = 'So11111111111111111111111111111111111111112';
const CODE = 'abcdef012345';
const NOW = 1_800_000_000;

const WANT: BurnExpectation = { code: CODE, mint: MINT, tokenProgram: SPL_2022_PROGRAM, wallet: WALLET, decimals: 6, notBefore: NOW };

const burnIx = (o: { account?: string; authority?: string; mint?: string; amount?: string; decimals?: number; program?: string; type?: string } = {}) => ({
  program: 'spl-token', programId: o.program ?? SPL_2022_PROGRAM,
  parsed: { type: o.type ?? 'burnChecked', info: { account: o.account ?? WALLET_ACCOUNT, mint: o.mint ?? MINT, authority: o.authority ?? WALLET, tokenAmount: { amount: o.amount ?? '100', decimals: o.decimals ?? 6 } } },
});
const memoIx = (m = adMemo(CODE)) => ({ program: 'spl-memo', programId: MEMO_PROGRAM, parsed: m });

/** Accounts [wallet, stranger, wallet's token account, stranger's token account]. */
function tx(instructions: unknown[], o: { signers?: string[]; err?: unknown; blockTime?: number | null; inner?: unknown[] } = {}): ParsedTransaction {
  const signers = o.signers ?? [WALLET];
  return {
    slot: 1, blockTime: o.blockTime === undefined ? NOW + 5 : o.blockTime,
    meta: {
      err: o.err ?? null,
      innerInstructions: o.inner ? [{ index: 0, instructions: o.inner as never }] : [],
      preTokenBalances: [{ accountIndex: 2, mint: MINT, owner: WALLET }, { accountIndex: 3, mint: MINT, owner: STRANGER }],
      postTokenBalances: [{ accountIndex: 2, mint: MINT, owner: WALLET }, { accountIndex: 3, mint: MINT, owner: STRANGER }],
    },
    transaction: { signatures: ['sig1'], message: {
      accountKeys: [WALLET, STRANGER, WALLET_ACCOUNT, STRANGER_ACCOUNT].map((pubkey) => ({ pubkey, signer: signers.includes(pubkey) })),
      instructions: instructions as never,
    } },
  };
}

describe('a burn on the live board', () => {
  it("counts the booking wallet's burn from its own account, with the burned amount", () => {
    expect(checkBurn(tx([burnIx({ amount: '100000000000' }), memoIx()]), WANT)).toMatchObject({ ok: true, signature: 'sig1', burned: 100000000000n, burner: WALLET });
  });

  it('adds up the wallet\'s own burns, ignoring a stranger\'s in the same transaction', () => {
    const r = checkBurn(tx([burnIx({ amount: '60' }), burnIx({ amount: '40' }), burnIx({ amount: '999', authority: STRANGER, account: STRANGER_ACCOUNT }), memoIx()], { signers: [WALLET, STRANGER] }), WANT);
    expect(r).toMatchObject({ ok: true, burned: 100n });
  });

  it('refuses when the booking wallet did not sign', () => {
    expect(checkBurn(tx([burnIx({ authority: STRANGER, account: STRANGER_ACCOUNT }), memoIx()], { signers: [STRANGER] }), WANT))
      .toEqual({ ok: false, why: 'the wallet that booked this ad did not sign it' });
  });

  it("refuses a stranger's burn even when the booking wallet co-signed", () => {
    expect(checkBurn(tx([burnIx({ authority: STRANGER, account: STRANGER_ACCOUNT }), memoIx()], { signers: [WALLET, STRANGER] }), WANT))
      .toEqual({ ok: false, why: 'the burn did not come from the wallet that booked this ad' });
  });

  it("refuses a burn from someone else's account made as their delegate", () => {
    expect(checkBurn(tx([burnIx({ account: STRANGER_ACCOUNT }), memoIx()]), WANT)).toMatchObject({ ok: false, why: expect.stringMatching(/did not come from/) });
  });

  it('refuses a multisig burn: the wallet is not its authority', () => {
    const multi = burnIx();
    const info = multi.parsed.info as Record<string, unknown>;
    delete info.authority;
    info.multisigAuthority = WALLET;
    expect(checkBurn(tx([multi, memoIx()]), WANT)).toMatchObject({ ok: false, why: expect.stringMatching(/did not come from/) });
  });

  it('refuses another mint, another program, or stated decimals that disagree', () => {
    expect(checkBurn(tx([burnIx({ mint: FAKE_MINT }), memoIx()]), WANT)).toMatchObject({ ok: false, why: 'no burn of the token' });
    expect(checkBurn(tx([burnIx({ program: SPL_PROGRAM }), memoIx()]), WANT)).toMatchObject({ ok: false, why: 'no burn of the token' });
    expect(checkBurn(tx([burnIx({ decimals: 9 }), memoIx()]), WANT)).toMatchObject({ ok: false, why: 'no burn of the token' });
  });

  it('refuses a transfer, a failed transaction, or no transaction', () => {
    expect(checkBurn(tx([burnIx({ type: 'transferChecked' }), memoIx()]), WANT)).toMatchObject({ ok: false, why: 'no burn of the token' });
    expect(checkBurn(tx([burnIx(), memoIx()], { err: { InstructionError: [0, 'Custom'] } }), WANT)).toEqual({ ok: false, why: 'transaction failed' });
    expect(checkBurn(null, WANT)).toEqual({ ok: false, why: 'transaction not found' });
  });

  it('refuses a memo for another booking, a memo only in an inner instruction, or none', () => {
    expect(checkBurn(tx([burnIx(), memoIx('pokejam-ad:ffffffffffff')]), WANT)).toMatchObject({ ok: false, why: expect.stringMatching(/memo/) });
    expect(checkBurn(tx([burnIx()], { inner: [memoIx()] }), WANT)).toMatchObject({ ok: false, why: expect.stringMatching(/memo/) });
    expect(checkBurn(tx([burnIx()]), WANT)).toMatchObject({ ok: false, why: expect.stringMatching(/memo/) });
  });

  it('refuses a transaction older than the booking, allowing for block-time skew', () => {
    expect(checkBurn(tx([burnIx(), memoIx()], { blockTime: NOW - 61 }), WANT)).toEqual({ ok: false, why: 'transaction is older than this booking' });
    expect(checkBurn(tx([burnIx(), memoIx()], { blockTime: NOW - 60 }), WANT)).toMatchObject({ ok: true });
    expect(checkBurn(tx([burnIx(), memoIx()], { blockTime: null }), WANT)).toEqual({ ok: false, why: 'transaction has no block time' });
  });

  it('the devnet board stays as it was: anyone may pay', () => {
    const devnet: BurnExpectation = { code: CODE, mint: MINT, tokenProgram: SPL_2022_PROGRAM };
    expect(checkBurn(tx([burnIx({ authority: STRANGER, account: STRANGER_ACCOUNT }), memoIx()], { signers: [STRANGER] }), devnet)).toMatchObject({ ok: true, burner: STRANGER });
  });
});
