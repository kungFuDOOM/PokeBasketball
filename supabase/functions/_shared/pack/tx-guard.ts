// Ported from the Pack Battles prototype (server/lib/tx-guard.ts).
// What the house will sign for Collector Crypt. The house signs transactions CC builds (a pack purchase,
// a buyback), so a compromised or spoofed CC API could hand it one that drains the house wallet. Before
// signing, every instruction is checked against what CC's real transactions contain (decoded from
// devnet on 2026-10-22), and anything else is refused.
//
//   purchase  compute budget (bounded), memo, and one USDC transfer of at most the escrowed pot from the
//             house's USDC account, signed by the house. The house pays the fee, so the compute price
//             and limit are capped: a huge priority fee would otherwise drain its SOL.
//   buyback   the house signs only the Core transfer of the one card being sold. It moves no tokens and
//             pays nothing; the USDC CC sends to the house's account is counted and returned, so the
//             winner is credited what actually arrives, not what CC's API says.
//
// No address lookup tables, no other programs, no house account in any other instruction.

import { decodeTransaction, type DecodedInstruction } from './tx-inspect.ts';

export const PROGRAM = {
  computeBudget: 'ComputeBudget111111111111111111111111111111',
  memo: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
  memoV1: 'Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo',
  splToken: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  ata: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  core: 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d',
} as const;

export interface GuardOptions {
  house: string;
  /** The house's USDC token account. */
  houseUsdc: string;
  usdcMint: string;
  /** Collector Crypt's gacha wallet, when pinned: it must co-sign, and purchases must pay its token account. */
  ccSigner?: string;
  /** Caps for a transaction the house pays the fee on. */
  maxComputeUnits?: number;
  maxMicroLamportsPerUnit?: number;
}

export class UnsafeTransaction extends Error {
  constructor(why: string) {
    super(`Refusing to sign Collector Crypt's transaction: ${why}`);
  }
}

const u64 = (d: Uint8Array, at: number) => {
  if (d.length < at + 8) throw new UnsafeTransaction('truncated instruction data');
  let v = 0n;
  for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(d[at + i]);
  return v;
};
const u32 = (d: Uint8Array, at: number) => {
  if (d.length < at + 4) throw new UnsafeTransaction('truncated instruction data');
  return d[at] | (d[at + 1] << 8) | (d[at + 2] << 16) | (d[at + 3] << 24 >>> 0);
};

/** A purchase may charge at most `maxPrice` (the pot the winner's battle escrowed). */
type Kind = { kind: 'purchase'; maxPrice: number } | { kind: 'buyback'; nft: string };

/** Throws UnsafeTransaction unless the transaction is one the house should sign. Returns USDC sent to and from the house. */
export function checkCcTransaction(bytes: Uint8Array, o: GuardOptions, k: Kind): { paid: number; received: number } {
  let tx;
  try { tx = decodeTransaction(bytes); } catch (e) { throw new UnsafeTransaction(`can't decode it (${(e as Error).message})`); }
  const mine = new Set([o.house, o.houseUsdc]);
  if (tx.lookups.length) throw new UnsafeTransaction('it uses address lookup tables');
  if (!tx.signers.includes(o.house)) throw new UnsafeTransaction("the house isn't a signer");
  if (o.ccSigner && !tx.signers.includes(o.ccSigner)) throw new UnsafeTransaction(`Collector Crypt's wallet ${o.ccSigner} doesn't sign it`);
  const feePayer = tx.signers[0];
  if (tx.writable.has(o.house) && feePayer !== o.house) throw new UnsafeTransaction('it writes to the house wallet');
  if (k.kind === 'buyback' && feePayer === o.house) throw new UnsafeTransaction('the house would pay the fee for a buyback');

  let paid = 0n;
  let received = 0n;
  let transfersOut = 0;
  let coreTransfers = 0;
  const touches = (ix: DecodedInstruction) => ix.accounts.some((a) => mine.has(a));

  for (const ix of tx.instructions) {
    switch (ix.program) {
      case PROGRAM.computeBudget: {
        const op = ix.data[0];
        if (op === 2) {
          if (u32(ix.data, 1) > (o.maxComputeUnits ?? 600_000)) throw new UnsafeTransaction('compute limit too high');
        } else if (op === 3) {
          if (u64(ix.data, 1) > BigInt(o.maxMicroLamportsPerUnit ?? 1_000_000)) throw new UnsafeTransaction('priority fee too high');
        } else throw new UnsafeTransaction(`unexpected compute-budget instruction ${op}`);
        break;
      }
      case PROGRAM.memo:
      case PROGRAM.memoV1:
        if (touches(ix)) throw new UnsafeTransaction('a memo names a house account as a signer');
        break;
      case PROGRAM.ata: {
        // Create (or create-if-missing) a token account: the payer must not be the house.
        if (ix.data.length && ix.data[0] !== 0 && ix.data[0] !== 1) throw new UnsafeTransaction('unexpected associated-token instruction');
        if (mine.has(ix.accounts[0])) throw new UnsafeTransaction('the house would pay to create a token account');
        break;
      }
      case PROGRAM.splToken: {
        const op = ix.data[0];
        // Transfer: [source, destination, authority]. TransferChecked: [source, mint, destination, authority].
        const checked = op === 12;
        if (op !== 3 && !checked) {
          if (touches(ix)) throw new UnsafeTransaction(`a token instruction (${op}) touches a house account`);
          break;
        }
        const [src, dst, auth] = checked ? [ix.accounts[0], ix.accounts[2], ix.accounts[3]] : [ix.accounts[0], ix.accounts[1], ix.accounts[2]];
        if (checked && ix.accounts[1] !== o.usdcMint && (mine.has(src) || mine.has(dst))) throw new UnsafeTransaction('a house transfer in a token other than USDC');
        const amount = u64(ix.data, 1);
        if (src === o.houseUsdc || auth === o.house) {
          if (k.kind !== 'purchase') throw new UnsafeTransaction('a buyback would move tokens out of the house');
          if (src !== o.houseUsdc || auth !== o.house || !checked) throw new UnsafeTransaction('an unexpected transfer signed by the house');
          if (dst === o.houseUsdc) throw new UnsafeTransaction('a transfer back to the house account');
          if (checked && ix.data[9] !== 6) throw new UnsafeTransaction('USDC transfer with the wrong decimals');
          transfersOut++;
          paid += amount;
        } else if (dst === o.houseUsdc) {
          received += amount;
        } else if (touches(ix)) {
          throw new UnsafeTransaction('a token transfer involving the house');
        }
        break;
      }
      case PROGRAM.core: {
        if (k.kind !== 'buyback') throw new UnsafeTransaction('a purchase moving a card');
        // TransferV1 (discriminator 14): [asset, collection, payer, authority, new owner, system, log wrapper].
        if (ix.data[0] !== 14) throw new UnsafeTransaction(`an unexpected Core instruction (${ix.data[0]})`);
        if (ix.accounts[0] !== k.nft) throw new UnsafeTransaction('a buyback moving a different card');
        if (mine.has(ix.accounts[2])) throw new UnsafeTransaction('the house would pay for the card transfer');
        if (ix.accounts[3] !== o.house) throw new UnsafeTransaction('the card transfer is not signed by the house');
        if (mine.has(ix.accounts[4])) throw new UnsafeTransaction('a card transfer back to the house');
        coreTransfers++;
        break;
      }
      default:
        throw new UnsafeTransaction(`it calls a program the house doesn't sign for (${ix.program})`);
    }
  }

  if (k.kind === 'purchase') {
    if (transfersOut !== 1) throw new UnsafeTransaction(`expected one payment from the house, found ${transfersOut}`);
    if (paid <= 0n || paid > BigInt(k.maxPrice)) throw new UnsafeTransaction(`it charges ${Number(paid) / 1e6} USDC, more than the ${k.maxPrice / 1e6} USDC pot`);
  } else if (coreTransfers !== 1) {
    throw new UnsafeTransaction(`expected one card transfer, found ${coreTransfers}`);
  }
  return { paid: Number(paid), received: Number(received) };
}

/** The destination token account of the purchase's payment (for checking its owner on chain). */
export function purchaseDestination(bytes: Uint8Array, houseUsdc: string): string | null {
  const tx = decodeTransaction(bytes);
  const ix = tx.instructions.find((i) => i.program === PROGRAM.splToken && i.accounts[0] === houseUsdc);
  return ix ? (ix.data[0] === 12 ? ix.accounts[2] : ix.accounts[1]) : null;
}
