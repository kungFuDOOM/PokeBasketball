import { describe, expect, it } from 'vitest';
import { base64Decode } from '../pack/bytes.ts';
import { generateKeypair } from '../pack/ed25519.ts';
import { decodeTransaction } from '../pack/tx-inspect.ts';
import { ATA_PROGRAM, COMPUTE_BUDGET, MEMO_PROGRAM, SYSTEM_PROGRAM, SPL_2022_PROGRAM, SPL_PROGRAM, associatedAccount, buildBurnTransaction,
  buildFaucetTransaction } from './tx.ts';

const MINT = 'GQe9QiBBV4G6bRUCxx2JgKrzT7G7RD17FJquBWgVpump';
const OWNER = 'DfKMpBEoYMWnkzGvfVQnHVQhQ2uuLvpwqUDzy45BfUBf';
const ACCOUNT = '6PsAwuinQkKqTXwSSzJ8rV7efJRMkz3zweDgirpaA8QR';
const BLOCKHASH = '11111111111111111111111111111111';

describe('associated token accounts', () => {
  // From @solana/spl-token's getAssociatedTokenAddressSync (checked on 80 random owners, both token programs).
  it('matches the SDK for Token-2022 and Token', async () => {
    expect(await associatedAccount(OWNER, MINT, SPL_2022_PROGRAM)).toBe('6PsAwuinQkKqTXwSSzJ8rV7efJRMkz3zweDgirpaA8QR');
    expect(await associatedAccount(OWNER, MINT, SPL_PROGRAM)).toBe('6zdGiP7tyCyi5bEebnYgm6gVen6HekHqGk85cZRUCGK5');
    expect(await associatedAccount('BacdpThfvMbHFBF36w6P11ikYRMKogHHVHYjynsVfzS', MINT, SPL_2022_PROGRAM)).toBe('3rrysd31jdGagKkJhGoRUZNBLzXXDJBXifKAPaarimg3');
  });
});

describe('the ad burn', () => {
  const tx = (priority = 0) => decodeTransaction(base64Decode(buildBurnTransaction({
    owner: OWNER, tokenAccount: ACCOUNT, mint: MINT, tokenProgram: SPL_2022_PROGRAM, amount: 1_500_000_000_000n, decimals: 6,
    code: 'abc123def456', recentBlockhash: BLOCKHASH, priorityMicroLamports: priority,
  })));

  it('is the advertiser burning the price from their own account, with the booking memo, and nothing else', () => {
    const d = tx();
    expect(d.signers).toEqual([OWNER]);
    expect(d.instructions.map((i) => i.program)).toEqual([SPL_2022_PROGRAM, MEMO_PROGRAM]);
    const [burn, memo] = d.instructions;
    expect(burn.accounts).toEqual([ACCOUNT, MINT, OWNER]);
    expect([...burn.data]).toEqual([15, 0x00, 0x98, 0xf7, 0x3e, 0x5d, 0x01, 0, 0, 6]); // BurnChecked, 1.5e12 LE, 6 decimals
    expect(new TextDecoder().decode(memo.data)).toBe('pokejam-ad:abc123def456');
    expect([...d.writable].sort()).toEqual([ACCOUNT, MINT, OWNER].sort());
  });

  it('adds a priority fee when asked', () => {
    const d = tx(20_000);
    expect(d.instructions.map((i) => i.program)).toEqual([COMPUTE_BUDGET, COMPUTE_BUDGET, SPL_2022_PROGRAM, MEMO_PROGRAM]);
    expect(d.instructions[1].data[0]).toBe(3);
  });
});

describe('the devnet faucet transaction', () => {
  it('creates the account, mints test tokens and sends a little SOL, signed by the faucet alone', async () => {
    const { keypair } = await generateKeypair();
    const d = decodeTransaction(base64Decode(await buildFaucetTransaction(keypair, OWNER, MINT, SPL_2022_PROGRAM, 25_000_000_000_000n, 6, 5_000_000, BLOCKHASH)));
    expect(d.signers).toEqual([keypair.address]);
    expect(d.instructions.map((i) => i.program)).toEqual([ATA_PROGRAM, SPL_2022_PROGRAM, SYSTEM_PROGRAM]);
    expect(d.instructions[0].accounts[1]).toBe(ACCOUNT);
    expect(d.instructions[1].data[0]).toBe(14); // MintToChecked
    expect(d.instructions[2].accounts).toEqual([keypair.address, OWNER]);
  });
});
