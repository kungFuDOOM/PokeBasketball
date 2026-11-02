// @ts-ignore Node's crypto has no type declarations in this project.
import { diffieHellman, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { boxBefore, boxOpen, boxPublicKey, boxSeal, scalarMult } from './nacl';

const un = (s: string) => new Uint8Array((s.replace(/\s/g, '').match(/../g) ?? []).map((h) => parseInt(h, 16)));
const hex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, '0')).join('');

// "Cryptography in NaCl" (Bernstein), the worked crypto_box example, as shipped in NaCl's tests/box.c and box2.c.
const ALICE_SK = un('77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a');
const ALICE_PK = un('8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a');
const BOB_SK = un('5dab087e624a8a4b79e17f8b83800ee66f3bb1292618b6fd1c2f8b27ff88e0eb');
const BOB_PK = un('de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f');
const NONCE = un('69696ee955b62b73cd62bda875fc73d68219e0036b7a0b37');
const SHARED = un('1b27556473e985d462cd51197a9a46c76009549eac6474f206c4ee0844f68389');
const PLAIN = un(`be075fc53c81f2d5cf141316ebeb0c7b5228c52a4c62cbd44b66849b64244ffc
  e5ecbaaf33bd751a1ac728d45e6c61296cdc3c01233561f41db66cce314adb31
  0e3be8250c46f06dceea3a7fa1348057e2f6556ad6b1318a024a838f21af1fde
  048977eb48f59ffd4924ca1c60902e52f0a089bc76897040e082f937763848645e0705`);
const CIPHER = un(`f3ffc7703f9400e52a7dfb4b3d3305d98e993b9f48681273c29650ba32fc76ce
  48332ea7164d96a4476fb8c531a1186ac0dfc17c98dce87b4da7f011ec48c972
  71d2c20f9b928fe2270d6fb863d51738b48eeee314a7cc8ab932164548e526ae
  90224368517acfeabd6bb3732bc0e9da99832b61ca01b6de56244a9e88d5f9b3
  7973f622a43d14a6599b1f654cb45a74e355a5`);

describe('x25519', () => {
  it('matches RFC 7748 section 6.1', () => {
    expect(hex(boxPublicKey(ALICE_SK))).toBe(hex(ALICE_PK));
    expect(hex(boxPublicKey(BOB_SK))).toBe(hex(BOB_PK));
    expect(hex(scalarMult(ALICE_SK, BOB_PK))).toBe('4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742');
  });
  it('agrees with Node on random keys', () => {
    for (let i = 0; i < 20; i++) {
      const a = generateKeyPairSync('x25519');
      const b = generateKeyPairSync('x25519');
      const raw = (k: unknown, f: 'pkcs8' | 'spki') => new Uint8Array((k as { export(o: unknown): Uint8Array }).export({ format: 'der', type: f })).slice(-32);
      const ours = scalarMult(raw(a.privateKey, 'pkcs8'), raw(b.publicKey, 'spki'));
      const theirs = diffieHellman({ privateKey: a.privateKey, publicKey: b.publicKey });
      expect(hex(ours)).toBe(hex(new Uint8Array(theirs)));
    }
  });
});

describe('crypto_box', () => {
  it('derives the shared key from either side', () => {
    expect(hex(boxBefore(BOB_PK, ALICE_SK))).toBe(hex(SHARED));
    expect(hex(boxBefore(ALICE_PK, BOB_SK))).toBe(hex(SHARED));
  });
  it('matches the published ciphertext and opens it', () => {
    expect(hex(boxSeal(PLAIN, NONCE, SHARED))).toBe(hex(CIPHER));
    expect(hex(boxOpen(CIPHER, NONCE, SHARED)!)).toBe(hex(PLAIN));
  });
  it('round-trips every length across the 16- and 64-byte block edges', () => {
    for (let n = 0; n < 300; n++) {
      const m = new Uint8Array(n).map((_, i) => (i * 7 + n) & 255);
      const c = boxSeal(m, NONCE, SHARED);
      expect(c.length).toBe(n + 16);
      expect(hex(boxOpen(c, NONCE, SHARED)!)).toBe(hex(m));
    }
  });
  it('refuses tampering, the wrong key and the wrong nonce', () => {
    const c = boxSeal(new TextEncoder().encode('hello'), NONCE, SHARED);
    for (let i = 0; i < c.length; i++) { const bad = c.slice(); bad[i] ^= 1; expect(boxOpen(bad, NONCE, SHARED)).toBeNull(); }
    expect(boxOpen(c, NONCE, new Uint8Array(32))).toBeNull();
    expect(boxOpen(c, new Uint8Array(24), SHARED)).toBeNull();
    expect(boxOpen(new Uint8Array(3), NONCE, SHARED)).toBeNull();
  });
});
