// Sign in with a Solana wallet: the server issues a one-time message, the wallet signs it, the server
// checks the Ed25519 signature against the wallet address and hands back a session token.

import { base58Decode, isAddress, randomId } from './lib/bytes';
import { verifySignature } from './lib/ed25519';
import { now, type Db } from './db';

const NONCE_TTL = 5 * 60_000;
const SESSION_TTL = 30 * 24 * 3600_000;

export function issueNonce(db: Db, wallet: string, domain: string): { message: string } {
  if (!isAddress(wallet)) throw new HttpError(400, 'Not a Solana address');
  const nonce = randomId(16);
  const message = [
    `${domain} wants you to sign in to Poké Jam with your Solana account:`,
    wallet,
    '',
    'Signing proves you own this wallet. It costs nothing and moves no funds.',
    '',
    `Nonce: ${nonce}`,
    `Issued At: ${new Date().toISOString()}`,
  ].join('\n');
  db.query('insert into nonces (nonce, wallet, message, expires_at) values (?, ?, ?, ?)').run(nonce, wallet, message, now() + NONCE_TTL);
  db.query('delete from nonces where expires_at < ?').run(now() - NONCE_TTL);
  return { message };
}

export async function login(db: Db, wallet: string, message: string, signatureB58: string): Promise<{ token: string; expiresAt: number }> {
  const nonce = /^Nonce: (\S+)$/m.exec(message)?.[1];
  const row = nonce ? db.query('select wallet, message, expires_at, used from nonces where nonce = ?').get(nonce) as
    { wallet: string; message: string; expires_at: number; used: number } | null : null;
  if (!row || row.wallet !== wallet || row.message !== message) throw new HttpError(401, 'Unknown sign-in request. Try again.');
  if (row.used || row.expires_at < now()) throw new HttpError(401, 'That sign-in request expired. Try again.');
  let sig: Uint8Array;
  try { sig = base58Decode(signatureB58); } catch { throw new HttpError(400, 'Bad signature encoding'); }
  if (!(await verifySignature(wallet, new TextEncoder().encode(message), sig))) throw new HttpError(401, 'Signature does not match this wallet');
  db.query('update nonces set used = 1 where nonce = ?').run(nonce!);
  db.query('insert into users (wallet, created_at) values (?, ?) on conflict(wallet) do nothing').run(wallet, now());
  const token = randomId(24);
  const expiresAt = now() + SESSION_TTL;
  db.query('insert into sessions (token, wallet, expires_at) values (?, ?, ?)').run(token, wallet, expiresAt);
  return { token, expiresAt };
}

export function sessionWallet(db: Db, token: string | null | undefined): string | null {
  if (!token) return null;
  const row = db.query('select wallet, expires_at from sessions where token = ?').get(token) as { wallet: string; expires_at: number } | null;
  return row && row.expires_at > now() ? row.wallet : null;
}

export function logout(db: Db, token: string) {
  db.query('delete from sessions where token = ?').run(token);
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}
