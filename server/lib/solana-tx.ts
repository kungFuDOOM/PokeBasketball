// Adds a signature to a serialized Solana transaction without any Solana SDK.
//
// Wire format: compact-u16 signature count, that many 64-byte signatures, then the message. The message
// starts with a header (legacy) or 0x80|version followed by the header (versioned); the first
// `numRequiredSignatures` account keys are the signers, in the same order as the signatures. Signing a
// transaction means Ed25519-signing the message bytes and putting the result in the signer's slot,
// which leaves every other signature (Collector Crypt's gacha wallet, for one) untouched.

import { base58Decode, base58Encode, base64Decode, base64Encode } from './bytes';
import type { Keypair } from './ed25519';

function readCompactU16(b: Uint8Array, at: number): [value: number, next: number] {
  let value = 0;
  for (let i = 0; i < 3; i++) {
    const byte = b[at + i];
    if (byte === undefined) throw new Error('truncated transaction');
    value |= (byte & 0x7f) << (7 * i);
    if ((byte & 0x80) === 0) return [value, at + i + 1];
  }
  throw new Error('bad compact-u16');
}

export interface ParsedTx {
  signatures: Uint8Array[];
  message: Uint8Array;
  version: 'legacy' | number;
  signers: string[];
  accountKeys: string[];
}

export function parseTransaction(bytes: Uint8Array): ParsedTx {
  const [n, sigStart] = readCompactU16(bytes, 0);
  const signatures: Uint8Array[] = [];
  for (let i = 0; i < n; i++) signatures.push(bytes.slice(sigStart + i * 64, sigStart + (i + 1) * 64));
  const msgStart = sigStart + n * 64;
  const message = bytes.slice(msgStart);
  let at = 0;
  let version: 'legacy' | number = 'legacy';
  if (message[0] & 0x80) {
    version = message[0] & 0x7f;
    at = 1;
  }
  const required = message[at];
  at += 3; // numRequiredSignatures, numReadonlySigned, numReadonlyUnsigned
  const [keyCount, keysAt] = readCompactU16(message, at);
  const accountKeys: string[] = [];
  for (let i = 0; i < keyCount; i++) accountKeys.push(base58Encode(message.slice(keysAt + i * 32, keysAt + (i + 1) * 32)));
  if (required !== n) throw new Error(`transaction has ${n} signature slots but needs ${required}`);
  return { signatures, message, version, signers: accountKeys.slice(0, required), accountKeys };
}

export function serializeTransaction(tx: ParsedTx): Uint8Array {
  const n = tx.signatures.length;
  const len: number[] = [];
  let v = n;
  do {
    let byte = v & 0x7f;
    v >>= 7;
    if (v) byte |= 0x80;
    len.push(byte);
  } while (v);
  const out = new Uint8Array(len.length + n * 64 + tx.message.length);
  out.set(len, 0);
  tx.signatures.forEach((s, i) => out.set(s, len.length + i * 64));
  out.set(tx.message, len.length + n * 64);
  return out;
}

/** Sign a base64 transaction as `kp` (which must be one of its signers) and return it base64-encoded. */
export async function signTransactionBase64(base64Tx: string, kp: Keypair): Promise<string> {
  const tx = parseTransaction(base64Decode(base64Tx));
  const slot = tx.signers.indexOf(kp.address);
  if (slot < 0) throw new Error(`house wallet ${kp.address} is not a signer of this transaction`);
  tx.signatures[slot] = await kp.sign(tx.message);
  return base64Encode(serializeTransaction(tx));
}

/** Address from base58, for tests. */
export const addressBytes = (a: string) => base58Decode(a);
