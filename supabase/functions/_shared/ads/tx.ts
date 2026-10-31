// Billboard ads: the transactions, built by hand so neither the server nor the browser needs a Solana SDK.
//
// The ad's burn is one transaction the advertiser's wallet signs and pays for: an optional priority fee, an SPL
// Token BurnChecked of the price from their own token account, and a memo naming the booking
// ("pokejam-ad:<code>"). The server never signs it and holds no key for it. The devnet faucet's transaction is
// the only one the server signs (test tokens and a little test SOL, devnet only).

import { base58Decode, base58Encode, base64Encode, sha256 } from '../pack/bytes.ts';
import type { Keypair } from '../pack/ed25519.ts';

export const SPL_PROGRAM = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
export const SPL_2022_PROGRAM = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb';
export const MEMO_PROGRAM = 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr';
export const COMPUTE_BUDGET = 'ComputeBudget111111111111111111111111111111';
export const ATA_PROGRAM = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';
export const SYSTEM_PROGRAM = '11111111111111111111111111111111';

/** The memo that ties a burn to its booking. */
export const adMemo = (code: string) => `pokejam-ad:${code}`;

export interface Meta { key: string; signer: boolean; writable: boolean }
export interface Ix { program: string; accounts: Meta[]; data: Uint8Array }

const compact = (n: number) => {
  const out: number[] = [];
  do { let b = n & 0x7f; n >>= 7; if (n) b |= 0x80; out.push(b); } while (n);
  return out;
};

const u64 = (v: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return [...b];
};
const u32 = (v: number) => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v, true);
  return [...b];
};

/**
 * A legacy message for `ixs` paid by `feePayer`. Accounts are merged (strongest role wins) and ordered the way the
 * runtime expects: the fee payer, other writable signers, readonly signers, writable non-signers, readonly non-signers.
 */
export function buildMessage(feePayer: string, ixs: Ix[], recentBlockhash: string): { message: Uint8Array; signers: string[] } {
  const roles = new Map<string, { signer: boolean; writable: boolean }>();
  const add = (k: string, signer: boolean, writable: boolean) => {
    const r = roles.get(k) ?? { signer: false, writable: false };
    roles.set(k, { signer: r.signer || signer, writable: r.writable || writable });
  };
  add(feePayer, true, true);
  for (const ix of ixs) {
    for (const m of ix.accounts) add(m.key, m.signer, m.writable);
    add(ix.program, false, false);
  }
  const rank = (k: string) => {
    const r = roles.get(k)!;
    if (k === feePayer) return 0;
    return r.signer ? (r.writable ? 1 : 2) : r.writable ? 3 : 4;
  };
  // Array.sort is stable, so accounts keep their first-seen order within a role.
  const keys = [...roles.keys()].sort((a, b) => rank(a) - rank(b));
  const signers = keys.filter((k) => roles.get(k)!.signer);
  const readonlySigned = signers.filter((k) => !roles.get(k)!.writable).length;
  const readonlyUnsigned = keys.filter((k) => !roles.get(k)!.signer && !roles.get(k)!.writable).length;
  const idx = (k: string) => keys.indexOf(k);
  const message = new Uint8Array([
    signers.length, readonlySigned, readonlyUnsigned,
    ...compact(keys.length), ...keys.flatMap((k) => [...base58Decode(k)]),
    ...base58Decode(recentBlockhash),
    ...compact(ixs.length),
    ...ixs.flatMap((ix) => [idx(ix.program), ...compact(ix.accounts.length), ...ix.accounts.map((m) => idx(m.key)), ...compact(ix.data.length), ...ix.data]),
  ]);
  return { message, signers };
}

/** An unsigned transaction: empty signature slots, then the message. */
export function unsignedTransaction(message: Uint8Array, signerCount: number): Uint8Array {
  return new Uint8Array([...compact(signerCount), ...new Array(64 * signerCount).fill(0), ...message]);
}

export const priorityIxs = (microLamports: number, units = 40_000): Ix[] => microLamports > 0 ? [
  { program: COMPUTE_BUDGET, accounts: [], data: new Uint8Array([2, ...u32(units)]) },
  { program: COMPUTE_BUDGET, accounts: [], data: new Uint8Array([3, ...u64(BigInt(Math.round(microLamports)))]) },
] : [];

/** SPL Token BurnChecked (15): the owner burns `amount` base units from `account`. Same layout in Token-2022. */
export const burnCheckedIx = (tokenProgram: string, account: string, mint: string, owner: string, amount: bigint, decimals: number): Ix => ({
  program: tokenProgram,
  accounts: [
    { key: account, signer: false, writable: true },
    { key: mint, signer: false, writable: true },
    { key: owner, signer: true, writable: false },
  ],
  data: new Uint8Array([15, ...u64(amount), decimals]),
});

export const memoIx = (text: string): Ix => ({ program: MEMO_PROGRAM, accounts: [], data: new TextEncoder().encode(text) });

export interface BurnTxInput {
  owner: string;
  tokenAccount: string;
  mint: string;
  tokenProgram: string;
  amount: bigint;
  decimals: number;
  code: string;
  recentBlockhash: string;
  priorityMicroLamports: number;
}

/** The ad's burn, unsigned and base64-encoded, for the advertiser's wallet to sign. */
export function buildBurnTransaction(i: BurnTxInput): string {
  const { message, signers } = buildMessage(i.owner, [
    ...priorityIxs(i.priorityMicroLamports),
    burnCheckedIx(i.tokenProgram, i.tokenAccount, i.mint, i.owner, i.amount, i.decimals),
    memoIx(adMemo(i.code)),
  ], i.recentBlockhash);
  if (signers.length !== 1) throw new Error('the burn must have the advertiser as its only signer');
  return base64Encode(unsignedTransaction(message, 1));
}

// ---------- the devnet faucet ----------

// Ed25519 point decompression, just enough to tell whether 32 bytes are on the curve (a program-derived
// address must not be).
const P = 2n ** 255n - 19n;
const D = (((-121665n * modPow(121666n, P - 2n)) % P) + P) % P;
function modPow(b: bigint, e: bigint): bigint {
  let r = 1n;
  b %= P;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
    e >>= 1n;
  }
  return r;
}
export function onCurve(bytes: Uint8Array): boolean {
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
  const sign = bytes[31] >> 7;
  if (y >= P) return false;
  const y2 = (y * y) % P;
  const u = (y2 - 1n + P) % P;
  const v = (D * y2 + 1n) % P;
  const x2 = (u * modPow(v, P - 2n)) % P;
  if (x2 === 0n) return sign === 0;
  return modPow(x2, (P - 1n) / 2n) === 1n;
}

/** findProgramAddress: the first bump from 255 down whose address is off the curve. */
export async function programAddress(seeds: Uint8Array[], program: string): Promise<string> {
  const pid = base58Decode(program);
  const marker = new TextEncoder().encode('ProgramDerivedAddress');
  for (let bump = 255; bump >= 0; bump--) {
    const h = await sha256(new Uint8Array([...seeds.flatMap((s) => [...s]), bump, ...pid, ...marker]));
    if (!onCurve(h)) return base58Encode(h);
  }
  throw new Error('no program address');
}

/** The owner's associated token account for `mint`. */
export const associatedAccount = (owner: string, mint: string, tokenProgram: string) =>
  programAddress([base58Decode(owner), base58Decode(tokenProgram), base58Decode(mint)], ATA_PROGRAM);

/**
 * Devnet faucet: create the wallet's token account if needed, mint it test tokens, and top it up with a little
 * test SOL for the burn's fee. Signed by the faucet (the test mint's authority), which pays for all of it.
 */
export async function buildFaucetTransaction(faucet: Keypair, to: string, mint: string, tokenProgram: string, amount: bigint, decimals: number,
  lamports: number, recentBlockhash: string): Promise<string> {
  const ata = await associatedAccount(to, mint, tokenProgram);
  const ixs: Ix[] = [
    { program: ATA_PROGRAM, accounts: [
      { key: faucet.address, signer: true, writable: true }, { key: ata, signer: false, writable: true },
      { key: to, signer: false, writable: false }, { key: mint, signer: false, writable: false },
      { key: SYSTEM_PROGRAM, signer: false, writable: false }, { key: tokenProgram, signer: false, writable: false },
    ], data: new Uint8Array([1]) },
    { program: tokenProgram, accounts: [
      { key: mint, signer: false, writable: true }, { key: ata, signer: false, writable: true }, { key: faucet.address, signer: true, writable: false },
    ], data: new Uint8Array([14, ...u64(amount), decimals]) },
  ];
  if (lamports > 0) {
    ixs.push({ program: SYSTEM_PROGRAM, accounts: [
      { key: faucet.address, signer: true, writable: true }, { key: to, signer: false, writable: true },
    ], data: new Uint8Array([...u32(2), ...u64(BigInt(lamports))]) });
  }
  const { message, signers } = buildMessage(faucet.address, ixs, recentBlockhash);
  if (signers.length !== 1) throw new Error('the faucet must be the only signer');
  const sig = await faucet.sign(message);
  return base64Encode(new Uint8Array([...compact(1), ...sig, ...message]));
}
