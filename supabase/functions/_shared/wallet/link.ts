// The message a Phantom wallet signs to link itself to an already signed-in PokeJam account.
// supabase-js linkIdentity accepts OAuth and ID-token credentials only, not signInWithWeb3, so this is not a
// Supabase identity. The edge function checks the signature; the database stores the address on this user id.
// Rank, history and shields stay where they are because the user id does not change.
import { base58Decode, isAddress } from '../pack/bytes.ts';

export const USER_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HOSTS = new Set(['pokejam.xyz', 'www.pokejam.xyz', 'localhost', '127.0.0.1']);
/** `localhost:5173` is still localhost. The URI line must match the host line, port included. */
const hostName = (host: string) => host.replace(/:\d+$/, '');
/** How far Issued At may be from now, either way, and how long the message may stay valid. */
const SKEW_MS = 10 * 60_000;
const MAX_LIFE_MS = 15 * 60_000;

export const linkStatement = (userId: string): string =>
  `Link this wallet to account ${userId}. Rank, history and shields stay on this account. This does not move funds.`;

/** The exact text Phantom shows. It is not a Sign in with Solana message, so it cannot open a second account. */
export function buildLinkMessage(o: { host: string; uri: string; address: string; userId: string; nonce: string; issuedAt: number; expiresAt: number }): string {
  return [
    `${o.host} wants you to link this wallet to your PokeJam account:`,
    o.address,
    '',
    linkStatement(o.userId),
    '',
    `URI: ${o.uri}`,
    `Issued At: ${new Date(o.issuedAt).toISOString()}`,
    `Expiration Time: ${new Date(o.expiresAt).toISOString()}`,
    `Nonce: ${o.nonce}`,
  ].join('\n');
}

export type LinkCheck = 'ok' | 'mismatch' | 'expired' | 'bad';

/**
 * Checks the message the wallet signed. `ok` only when every line matches, the account id is the one we expect,
 * and the clock window is still open. The signature itself is checked separately.
 */
export function checkLinkMessage(message: string, want: { address: string; userId: string; nonce: string; now: number }): LinkCheck {
  if (typeof message !== 'string' || message.length > 1500) return 'bad';
  const lines = message.split('\n');
  if (lines.length !== 9) return 'bad';
  const host = /^(\S+) wants you to link this wallet to your PokeJam account:$/.exec(lines[0]);
  if (!host || !HOSTS.has(hostName(host[1]))) return 'bad';
  if (lines[1] !== want.address || !isAddress(lines[1])) return lines[1] && isAddress(lines[1]) ? 'mismatch' : 'bad';
  if (lines[2] !== '' || lines[4] !== '') return 'bad';
  if (lines[3] !== linkStatement(want.userId)) {
    return USER_ID_RE.test(lines[3].match(/account ([0-9a-f-]{36})/i)?.[1] ?? '') ? 'mismatch' : 'bad';
  }
  const uri = /^URI: (\S+)$/.exec(lines[5]);
  let parsed: URL;
  try { parsed = new URL(uri?.[1] ?? ''); } catch { return 'bad'; }
  if (parsed.host !== host[1] || parsed.username || parsed.password) return 'bad';
  if (host[1] === 'pokejam.xyz' ? parsed.protocol !== 'https:' : parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return 'bad';
  const issued = Date.parse(/^Issued At: (\S+)$/.exec(lines[6])?.[1] ?? '');
  const exp = Date.parse(/^Expiration Time: (\S+)$/.exec(lines[7])?.[1] ?? '');
  const nonce = /^Nonce: ([1-9A-HJ-NP-Za-km-z]{16,64})$/.exec(lines[8]);
  if (!Number.isFinite(issued) || !Number.isFinite(exp) || !nonce) return 'bad';
  if (nonce[1] !== want.nonce) return 'mismatch';
  if (Math.abs(want.now - issued) > SKEW_MS) return 'expired';
  if (exp <= want.now || exp > issued + MAX_LIFE_MS) return 'expired';
  return 'ok';
}

/**
 * Phantom's signMessage returns a 64-byte signature as a Uint8Array, as `{ signature }`, or already as base58.
 * A value that is not 64 bytes is refused here, before it is sent to the server.
 */
export function signatureBytes(signed: unknown): Uint8Array | null {
  const asBytes = (v: unknown): Uint8Array | null => {
    if (v instanceof Uint8Array) return v.length === 64 ? v : null;
    if (typeof v === 'string') {
      try {
        const b = base58Decode(v);
        return b.length === 64 ? b : null;
      } catch { return null; }
    }
    if (Array.isArray(v) && v.length === 64 && v.every((n) => typeof n === 'number' && n >= 0 && n <= 255)) return new Uint8Array(v);
    return null;
  };
  const direct = asBytes(signed);
  if (direct) return direct;
  if (signed && typeof signed === 'object' && 'signature' in signed) return asBytes((signed as { signature: unknown }).signature);
  return null;
}

/** Reads the address, account id and nonce out of a message that already passed checkLinkMessage against them. */
export function linkFields(message: string): { address: string; userId: string; nonce: string } | null {
  const lines = message.split('\n');
  const userId = lines[3]?.match(/account ([0-9a-f-]{36})/i)?.[1];
  const nonce = /^Nonce: ([1-9A-HJ-NP-Za-km-z]{16,64})$/.exec(lines[8] ?? '')?.[1];
  if (!lines[1] || !userId || !nonce || !isAddress(lines[1])) return null;
  return { address: lines[1], userId, nonce };
}
