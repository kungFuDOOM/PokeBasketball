// Ed25519 (Solana's signature scheme) on WebCrypto: verify wallet sign-ins, sign as the house wallet.

import { base58Decode, base58Encode, bs } from './bytes';

/** Verify `signature` (64 bytes) over `message` by the wallet `address` (base58 public key). */
export async function verifySignature(address: string, message: Uint8Array, signature: Uint8Array): Promise<boolean> {
  try {
    const raw = base58Decode(address);
    if (raw.length !== 32 || signature.length !== 64) return false;
    const key = await crypto.subtle.importKey('raw', bs(raw), { name: 'Ed25519' }, false, ['verify']);
    return await crypto.subtle.verify('Ed25519', key, bs(signature), bs(message));
  } catch {
    return false;
  }
}

// PKCS#8 wrapper for a raw 32-byte Ed25519 seed.
const PKCS8_PREFIX = new Uint8Array([0x30, 0x2e, 0x02, 0x01, 0x00, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x04, 0x22, 0x04, 0x20]);

export interface Keypair {
  address: string;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

/**
 * A Solana keypair from its secret key: the 64-byte array Solana CLI keypair files hold
 * (JSON "[12,34,…]"), or base58 of those 64 bytes (what Phantom exports). The first 32 bytes are the seed.
 */
export async function keypairFromSecret(secret: string): Promise<Keypair> {
  const s = secret.trim();
  const bytes = s.startsWith('[') ? new Uint8Array(JSON.parse(s) as number[]) : base58Decode(s);
  if (bytes.length !== 64) throw new Error('house secret key must be 64 bytes');
  const seed = bytes.slice(0, 32);
  const pkcs8 = new Uint8Array([...PKCS8_PREFIX, ...seed]);
  const key = await crypto.subtle.importKey('pkcs8', pkcs8, { name: 'Ed25519' }, false, ['sign']);
  const address = base58Encode(bytes.slice(32));
  // Make sure the public half really belongs to this seed before we sign anything with it.
  const probe = new TextEncoder().encode('pokejam-keycheck');
  const sig = new Uint8Array(await crypto.subtle.sign('Ed25519', key, probe));
  if (!(await verifySignature(address, probe, sig))) throw new Error('house secret key: public key does not match the seed');
  return { address, sign: async (m) => new Uint8Array(await crypto.subtle.sign('Ed25519', key, bs(m))) };
}

/** A fresh random keypair (tests and local development). Returns the 64-byte secret as JSON too. */
export async function generateKeypair(): Promise<{ keypair: Keypair; secret: string }> {
  const kp = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey('pkcs8', kp.privateKey));
  const pub = new Uint8Array(await crypto.subtle.exportKey('raw', kp.publicKey));
  const secret = JSON.stringify([...pkcs8.slice(16), ...pub]);
  return { keypair: await keypairFromSecret(secret), secret };
}
