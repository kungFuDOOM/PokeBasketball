// Ported from the Pack Battles prototype (server/lib/tx-inspect.ts).
// Decodes a serialized Solana transaction's message into instructions, so the house can check what it's
// about to sign. No Solana SDK: legacy and v0 messages, with address-table lookups reported (not resolved).

import { base58Encode } from './bytes.ts';

export interface DecodedInstruction {
  program: string;
  /** Account addresses in instruction order; a lookup-table account shows as `lookup:<table>:<index>`. */
  accounts: string[];
  data: Uint8Array;
}

export interface DecodedMessage {
  version: 'legacy' | number;
  signers: string[];
  /** Static account keys, then (for v0) one placeholder per looked-up address. */
  keys: string[];
  writable: Set<string>;
  instructions: DecodedInstruction[];
  lookups: { table: string; writable: number[]; readonly: number[] }[];
}

function compactU16(b: Uint8Array, at: number): [number, number] {
  let value = 0;
  for (let i = 0; i < 3; i++) {
    const byte = b[at + i];
    if (byte === undefined) throw new Error('truncated transaction');
    value |= (byte & 0x7f) << (7 * i);
    if ((byte & 0x80) === 0) return [value, at + i + 1];
  }
  throw new Error('bad compact-u16');
}

/** Decode a whole transaction (signatures + message). */
export function decodeTransaction(bytes: Uint8Array): DecodedMessage {
  const [n, at] = compactU16(bytes, 0);
  return decodeMessage(bytes.slice(at + n * 64));
}

export function decodeMessage(m: Uint8Array): DecodedMessage {
  let at = 0;
  let version: 'legacy' | number = 'legacy';
  if (m[0] & 0x80) { version = m[0] & 0x7f; at = 1; }
  if (version !== 'legacy' && version !== 0) throw new Error(`unsupported transaction version ${version}`);
  const [required, roSigned, roUnsigned] = [m[at], m[at + 1], m[at + 2]];
  at += 3;
  const [keyCount, keysAt] = compactU16(m, at);
  const keys: string[] = [];
  for (let i = 0; i < keyCount; i++) keys.push(base58Encode(m.slice(keysAt + i * 32, keysAt + (i + 1) * 32)));
  at = keysAt + keyCount * 32 + 32; // skip the recent blockhash
  const writable = new Set<string>();
  keys.forEach((k, i) => {
    const signed = i < required;
    const w = signed ? i < required - roSigned : i < keyCount - roUnsigned;
    if (w) writable.add(k);
  });
  const [ixCount, ixAt] = compactU16(m, at);
  at = ixAt;
  const raw: { program: number; accounts: number[]; data: Uint8Array }[] = [];
  for (let i = 0; i < ixCount; i++) {
    const program = m[at++];
    const [na, accAt] = compactU16(m, at);
    const accounts = Array.from(m.slice(accAt, accAt + na));
    const [dl, dataAt] = compactU16(m, accAt + na);
    raw.push({ program, accounts, data: m.slice(dataAt, dataAt + dl) });
    at = dataAt + dl;
  }
  const lookups: DecodedMessage['lookups'] = [];
  if (version === 0) {
    const [lc, lAt] = compactU16(m, at);
    at = lAt;
    for (let i = 0; i < lc; i++) {
      const table = base58Encode(m.slice(at, at + 32));
      at += 32;
      const [wn, wAt] = compactU16(m, at);
      const w = Array.from(m.slice(wAt, wAt + wn));
      const [rn, rAt] = compactU16(m, wAt + wn);
      const r = Array.from(m.slice(rAt, rAt + rn));
      at = rAt + rn;
      lookups.push({ table, writable: w, readonly: r });
    }
  }
  // v0: looked-up addresses follow the static keys, all writable ones first, then all readonly ones.
  const all = [...keys];
  for (const l of lookups) for (const i of l.writable) { const k = `lookup:${l.table}:${i}`; all.push(k); writable.add(k); }
  for (const l of lookups) for (const i of l.readonly) all.push(`lookup:${l.table}:${i}`);
  const at_ = (i: number) => {
    const k = all[i];
    if (k === undefined) throw new Error(`instruction refers to account ${i}, which isn't in the message`);
    return k;
  };
  return {
    version, signers: keys.slice(0, required), keys: all, writable, lookups,
    instructions: raw.map((r) => ({ program: at_(r.program), accounts: r.accounts.map(at_), data: r.data })),
  };
}
