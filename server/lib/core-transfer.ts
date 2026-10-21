// Transfer a Metaplex Core asset (Collector Crypt's cards are Core NFTs) from the house wallet to a
// winner, building the transaction by hand so the server needs no Solana SDK.
//
// Instruction: mpl-core TransferV1 (discriminator 14, args { compression_proof: None }).
// Accounts, in order: asset (w), collection (or the program id when the asset has none), payer (w, s),
// authority (s; the house, which owns the card), new owner, system program slot (program id = unused),
// log wrapper slot (program id = unused). This mirrors mpl-core's generated client; confirm it with one
// devnet transfer before mainnet (IMPLEMENTATION.md, step 1). If it ever disagrees, replace buildTransfer
// with @metaplex-foundation/mpl-core's transferV1 and keep the rest of this file.

import { base58Decode, base58Encode, base64Decode } from './bytes';
import type { Keypair } from './ed25519';

export const MPL_CORE = 'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';
const TRANSFER_V1 = 14;

const compact = (n: number) => {
  const out: number[] = [];
  do { let b = n & 0x7f; n >>= 7; if (n) b |= 0x80; out.push(b); } while (n);
  return out;
};

/** Owner and collection from a Core asset account's data (Key=1 AssetV1, owner, update authority). */
export function parseAsset(data: Uint8Array): { owner: string; collection: string | null } {
  if (data[0] !== 1) throw new Error('not a Core asset account');
  const owner = base58Encode(data.slice(1, 33));
  const tag = data[33]; // 0 None, 1 Address, 2 Collection
  const collection = tag === 2 ? base58Encode(data.slice(34, 66)) : null;
  return { owner, collection };
}

interface Meta { key: string; signer: boolean; writable: boolean }

/** A legacy transaction with one instruction, signed by `payer`. Returns base64. */
export async function buildSigned(payer: Keypair, programId: string, metas: Meta[], data: number[], recentBlockhash: string): Promise<{ base64: string; message: Uint8Array }> {
  // Merge duplicate accounts, keeping the strongest role, then order: writable signers, readonly signers,
  // writable non-signers, readonly non-signers (the fee payer first of all).
  const roles = new Map<string, { signer: boolean; writable: boolean }>();
  const add = (k: string, signer: boolean, writable: boolean) => {
    const r = roles.get(k) ?? { signer: false, writable: false };
    roles.set(k, { signer: r.signer || signer, writable: r.writable || writable });
  };
  add(payer.address, true, true);
  for (const m of metas) add(m.key, m.signer, m.writable);
  add(programId, false, false);
  const rank = (k: string) => {
    const r = roles.get(k)!;
    if (k === payer.address) return 0;
    return r.signer ? (r.writable ? 1 : 2) : r.writable ? 3 : 4;
  };
  const keys = [...roles.keys()].sort((a, b) => rank(a) - rank(b));
  const signers = keys.filter((k) => roles.get(k)!.signer);
  if (signers.length !== 1 || signers[0] !== payer.address) throw new Error('only the house wallet may sign this transfer');
  const readonlySigned = signers.filter((k) => !roles.get(k)!.writable).length;
  const readonlyUnsigned = keys.filter((k) => !roles.get(k)!.signer && !roles.get(k)!.writable).length;
  const idx = (k: string) => keys.indexOf(k);
  const message = new Uint8Array([
    signers.length, readonlySigned, readonlyUnsigned,
    ...compact(keys.length), ...keys.flatMap((k) => [...base58Decode(k)]),
    ...base58Decode(recentBlockhash),
    ...compact(1),
    idx(programId), ...compact(metas.length), ...metas.map((m) => idx(m.key)), ...compact(data.length), ...data,
  ]);
  const sig = await payer.sign(message);
  const tx = new Uint8Array([...compact(1), ...sig, ...message]);
  let s = '';
  for (const b of tx) s += String.fromCharCode(b);
  return { base64: btoa(s), message };
}

/** The signed TransferV1 transaction (base64) moving `asset` from the house to `to`. */
export function buildTransfer(house: Keypair, asset: string, collection: string | null, to: string, recentBlockhash: string) {
  return buildSigned(house, MPL_CORE, [
    { key: asset, signer: false, writable: true },
    { key: collection ?? MPL_CORE, signer: false, writable: false },
    { key: house.address, signer: true, writable: true },
    { key: house.address, signer: true, writable: false },
    { key: to, signer: false, writable: false },
    { key: MPL_CORE, signer: false, writable: false },
    { key: MPL_CORE, signer: false, writable: false },
  ], [TRANSFER_V1, 0], recentBlockhash);
}

export const decodeAccountData = (b64: string) => base64Decode(b64);
