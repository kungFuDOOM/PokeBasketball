// Solana pieces for the Rank Shield USDC payment, with no SDK: program ids, the associated-token-account (ATA) address,
// and the unsigned legacy transaction the player's Phantom signs. Shared by the Edge Functions (which recompute the
// receiver's ATA to check a payment) and the browser (which builds the transfer), so both sides agree byte for byte.
// Nothing here holds a key or talks to the network.
import { base58Decode, base58Encode, sha256 } from '../pack/bytes.ts';

export type UsdcCluster = 'devnet' | 'mainnet-beta';

export const PROGRAM = {
  token: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
  ata: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
  memo: 'MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr',
} as const;

/** USDC mints: Circle's on mainnet, the faucet's "USDC-Dev" on devnet (same as Pack Battles' config). */
export const USDC_MINT: Record<UsdcCluster, string> = {
  devnet: 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr',
  'mainnet-beta': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
};
export const USDC_DECIMALS = 6;
/** Public RPC endpoints: the default for the server (override with SHIELD_USDC_RPC_URL) and what the browser uses. */
export const PUBLIC_RPC: Record<UsdcCluster, string> = { devnet: 'https://api.devnet.solana.com', 'mainnet-beta': 'https://api.mainnet-beta.solana.com' };

// ---------- ed25519 "is this 32-byte string a curve point" ----------
const P = (1n << 255n) - 19n;
const modpow = (b: bigint, e: bigint): bigint => {
  let r = 1n;
  b %= P;
  for (; e > 0n; e >>= 1n) {
    if (e & 1n) r = (r * b) % P;
    b = (b * b) % P;
  }
  return r;
};
const D = (P - 121665n) * modpow(121666n, P - 2n) % P;

/** True when `bytes` decompress to a point on edwards25519. A program-derived address must NOT be one. */
export function isOnCurve(bytes: Uint8Array): boolean {
  if (bytes.length !== 32) return false;
  let y = 0n;
  for (let i = 31; i >= 0; i--) y = (y << 8n) | BigInt(i === 31 ? bytes[i] & 0x7f : bytes[i]);
  if (y >= P) return false;
  const sign = (bytes[31] & 0x80) !== 0;
  const y2 = (y * y) % P;
  const u = (y2 - 1n + P) % P;
  const v = (D * y2 + 1n) % P;
  const x2 = (u * modpow(v, P - 2n)) % P;
  if (x2 === 0n) return !sign;
  return modpow(x2, (P - 1n) / 2n) === 1n;
}

const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

/** Program-derived address for `seeds` under `programId`: the first bump from 255 down that lands off the curve. */
export async function findProgramAddress(seeds: Uint8Array[], programId: string): Promise<{ address: string; bump: number }> {
  const pid = base58Decode(programId);
  const tag = new TextEncoder().encode('ProgramDerivedAddress');
  for (let bump = 255; bump >= 0; bump--) {
    const h = await sha256(cat(...seeds, new Uint8Array([bump]), pid, tag));
    if (!isOnCurve(h)) return { address: base58Encode(h), bump };
  }
  throw new Error('no program address found');
}

/** The associated token account of `owner` for `mint` (classic SPL Token program). */
export async function deriveAta(owner: string, mint: string): Promise<string> {
  return (await findProgramAddress([base58Decode(owner), base58Decode(PROGRAM.token), base58Decode(mint)], PROGRAM.ata)).address;
}

// ---------- the transfer transaction ----------
function compactU16(n: number): number[] {
  const out: number[] = [];
  let v = n;
  do {
    let byte = v & 0x7f;
    v >>= 7;
    if (v) byte |= 0x80;
    out.push(byte);
  } while (v);
  return out;
}

export const u64le = (n: bigint): Uint8Array => {
  const out = new Uint8Array(8);
  for (let i = 0; i < 8; i++) out[i] = Number((n >> BigInt(8 * i)) & 0xffn);
  return out;
};

export interface TransferArgs {
  /** The player's wallet: pays the fee, owns the source token account and signs. */
  payer: string;
  mint: string;
  /** The house wallet (its token account for `mint` must already exist). */
  receiver: string;
  /** Base units (6 decimals). */
  amount: bigint;
  decimals?: number;
  /** The intent's reference key: added as a read-only, non-signer account of the transfer (Solana Pay style). */
  reference: string;
  /** The intent's memo, written by the Memo program. */
  memo: string;
  /** Recent blockhash (base58). */
  blockhash: string;
}

export interface BuiltTransfer {
  /** Source and destination token accounts. */
  source: string;
  destination: string;
  /** The message Phantom signs. */
  message: Uint8Array;
  /** The whole transaction with one empty signature slot, ready for signAndSendTransaction. */
  transaction: Uint8Array;
}

/**
 * Legacy transaction: SPL Token TransferChecked(source ATA -> receiver ATA) with the reference as an extra read-only
 * account, then a Memo. Account order: signer+writable payer, writable source/destination, then read-only
 * mint, reference, token program, memo program.
 */
export async function buildUsdcTransfer(a: TransferArgs): Promise<BuiltTransfer> {
  const decimals = a.decimals ?? USDC_DECIMALS;
  if (a.amount <= 0n || a.amount >= 1n << 64n) throw new Error('bad amount');
  const [source, destination] = await Promise.all([deriveAta(a.payer, a.mint), deriveAta(a.receiver, a.mint)]);
  const keys = [a.payer, source, destination, a.mint, a.reference, PROGRAM.token, PROGRAM.memo];
  if (new Set(keys).size !== keys.length) throw new Error('duplicate account in transfer');
  const idx = (k: string) => keys.indexOf(k);
  const ixs: { program: number; accounts: number[]; data: Uint8Array }[] = [
    { program: idx(PROGRAM.token), accounts: [idx(source), idx(a.mint), idx(destination), idx(a.payer), idx(a.reference)],
      data: cat(new Uint8Array([12]), u64le(a.amount), new Uint8Array([decimals])) },
    { program: idx(PROGRAM.memo), accounts: [], data: new TextEncoder().encode(a.memo) },
  ];
  const parts: Uint8Array[] = [
    new Uint8Array([1, 0, 4]), // 1 signer (the payer), 0 read-only signers, 4 read-only unsigned (mint, reference, token, memo)
    new Uint8Array(compactU16(keys.length)),
    ...keys.map((k) => base58Decode(k)),
    base58Decode(a.blockhash),
    new Uint8Array(compactU16(ixs.length)),
  ];
  for (const ix of ixs) {
    parts.push(new Uint8Array([ix.program, ...compactU16(ix.accounts.length), ...ix.accounts, ...compactU16(ix.data.length)]), ix.data);
  }
  const message = cat(...parts);
  return { source, destination, message, transaction: cat(new Uint8Array([1]), new Uint8Array(64), message) };
}
