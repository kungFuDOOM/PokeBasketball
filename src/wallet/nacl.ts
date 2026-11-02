// The small part of NaCl that Phantom's deeplinks need: x25519 key agreement and crypto_box (xsalsa20-poly1305). WebCrypto
// has neither on the browsers we support, and this avoids a new dependency. Ported from TweetNaCl.js (public domain), and
// checked in nacl.test.ts against NaCl's published box vectors, RFC 7748 and Node's own x25519. No BigInt: the build targets es2019.

type Gf = Float64Array;
const gf = (init?: number[]): Gf => { const r = new Float64Array(16); if (init) r.set(init); return r; };
const BASE = (() => { const b = new Uint8Array(32); b[0] = 9; return b; })();
const G121665 = gf([0xdb41, 1]);

function carry(o: Gf) {
  let c = 1;
  for (let i = 0; i < 16; i++) { const v = o[i] + c + 65535; c = Math.floor(v / 65536); o[i] = v - c * 65536; }
  o[0] += c - 1 + 37 * (c - 1);
}
function select(p: Gf, q: Gf, b: number) {
  const c = ~(b - 1);
  for (let i = 0; i < 16; i++) { const t = c & (p[i] ^ q[i]); p[i] ^= t; q[i] ^= t; }
}
function pack(o: Uint8Array, n: Gf) {
  const m = gf(); const t = gf(); t.set(n);
  carry(t); carry(t); carry(t);
  for (let j = 0; j < 2; j++) {
    m[0] = t[0] - 0xffed;
    for (let i = 1; i < 15; i++) { m[i] = t[i] - 0xffff - ((m[i - 1] >> 16) & 1); m[i - 1] &= 0xffff; }
    m[15] = t[15] - 0x7fff - ((m[14] >> 16) & 1);
    const b = (m[15] >> 16) & 1;
    m[14] &= 0xffff;
    select(t, m, 1 - b);
  }
  for (let i = 0; i < 16; i++) { o[2 * i] = t[i] & 0xff; o[2 * i + 1] = t[i] >> 8; }
}
function unpack(o: Gf, n: Uint8Array) {
  for (let i = 0; i < 16; i++) o[i] = n[2 * i] + (n[2 * i + 1] << 8);
  o[15] &= 0x7fff;
}
const add = (o: Gf, a: Gf, b: Gf) => { for (let i = 0; i < 16; i++) o[i] = a[i] + b[i]; };
const sub = (o: Gf, a: Gf, b: Gf) => { for (let i = 0; i < 16; i++) o[i] = a[i] - b[i]; };
function mul(o: Gf, a: Gf, b: Gf) {
  const t = new Float64Array(31);
  for (let i = 0; i < 16; i++) for (let j = 0; j < 16; j++) t[i + j] += a[i] * b[j];
  for (let i = 0; i < 15; i++) t[i] += 38 * t[i + 16];
  for (let i = 0; i < 16; i++) o[i] = t[i];
  carry(o); carry(o);
}
const square = (o: Gf, a: Gf) => mul(o, a, a);
function invert(o: Gf, i: Gf) {
  const c = gf(); c.set(i);
  for (let a = 253; a >= 0; a--) { square(c, c); if (a !== 2 && a !== 4) mul(c, c, i); }
  o.set(c);
}

/** x25519: scalar n times point p (32 bytes each). */
export function scalarMult(n: Uint8Array, p: Uint8Array): Uint8Array {
  const z = new Uint8Array(n);
  z[31] = (n[31] & 127) | 64;
  z[0] &= 248;
  const x = gf(); unpack(x, p);
  const a = gf(); const b = gf(); b.set(x); const c = gf(); const d = gf(); const e = gf(); const f = gf();
  a[0] = d[0] = 1;
  for (let i = 254; i >= 0; i--) {
    const r = (z[i >>> 3] >>> (i & 7)) & 1;
    select(a, b, r); select(c, d, r);
    add(e, a, c); sub(a, a, c); add(c, b, d); sub(b, b, d);
    square(d, e); square(f, a);
    mul(a, c, a); mul(c, b, e);
    add(e, a, c); sub(a, a, c);
    square(b, a); sub(c, d, f);
    mul(a, c, G121665); add(a, a, d);
    mul(c, c, a); mul(a, d, f); mul(d, b, x);
    square(b, e);
    select(a, b, r); select(c, d, r);
  }
  invert(c, c);
  mul(a, a, c);
  const q = new Uint8Array(32);
  pack(q, a);
  return q;
}

const SIGMA = new Uint8Array([101, 120, 112, 97, 110, 100, 32, 51, 50, 45, 98, 121, 116, 101, 32, 107]); // "expand 32-byte k"
const le32 = (b: Uint8Array, i: number) => (b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)) | 0;
const put32 = (b: Uint8Array, i: number, v: number) => { b[i] = v & 255; b[i + 1] = (v >>> 8) & 255; b[i + 2] = (v >>> 16) & 255; b[i + 3] = (v >>> 24) & 255; };
const rotl = (v: number, n: number) => (v << n) | (v >>> (32 - n));

/** The 20 rounds shared by Salsa20 and HSalsa20, over the 16-byte input `inp`. */
function salsaState(inp: Uint8Array, key: Uint8Array): { start: Int32Array; x: Int32Array } {
  const s = new Int32Array(16);
  for (let i = 0; i < 4; i++) {
    s[[0, 5, 10, 15][i]] = le32(SIGMA, i * 4);
    s[1 + i] = le32(key, i * 4);
    s[6 + i] = le32(inp, i * 4);
    s[11 + i] = le32(key, 16 + i * 4);
  }
  const x = s.slice();
  const q = (a: number, b: number, c: number, d: number) => {
    x[b] ^= rotl((x[a] + x[d]) | 0, 7);
    x[c] ^= rotl((x[b] + x[a]) | 0, 9);
    x[d] ^= rotl((x[c] + x[b]) | 0, 13);
    x[a] ^= rotl((x[d] + x[c]) | 0, 18);
  };
  for (let i = 0; i < 10; i++) {
    q(0, 4, 8, 12); q(5, 9, 13, 1); q(10, 14, 2, 6); q(15, 3, 7, 11);
    q(0, 1, 2, 3); q(5, 6, 7, 4); q(10, 11, 8, 9); q(15, 12, 13, 14);
  }
  return { start: s, x };
}
function hsalsa20(inp: Uint8Array, key: Uint8Array): Uint8Array {
  const { x } = salsaState(inp, key);
  const out = new Uint8Array(32);
  [0, 5, 10, 15, 6, 7, 8, 9].forEach((w, i) => put32(out, i * 4, x[w]));
  return out;
}
/** xsalsa20 keystream XORed over `m`; the first 32 bytes of keystream are skipped by the caller's 32-byte zero prefix. */
function xsalsa20Xor(m: Uint8Array, nonce: Uint8Array, key: Uint8Array): Uint8Array {
  const sub32 = hsalsa20(nonce.subarray(0, 16), key);
  const inp = new Uint8Array(16);
  inp.set(nonce.subarray(16, 24));
  const out = new Uint8Array(m.length);
  const block = new Uint8Array(64);
  for (let off = 0; off < m.length; off += 64) {
    const { start, x } = salsaState(inp, sub32);
    for (let i = 0; i < 16; i++) put32(block, i * 4, (x[i] + start[i]) | 0);
    for (let i = 0; i < 64 && off + i < m.length; i++) out[off + i] = m[off + i] ^ block[i];
    let u = 1;
    for (let i = 8; i < 16; i++) { u += inp[i]; inp[i] = u & 255; u >>>= 8; }
  }
  return out;
}

const MINUS_P = new Uint32Array([5, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 252]);
function add1305(h: Uint32Array, c: Uint32Array) {
  let u = 0;
  for (let j = 0; j < 17; j++) { u = (u + ((h[j] + c[j]) | 0)) | 0; h[j] = u & 255; u >>>= 8; }
}
function poly1305(m: Uint8Array, k: Uint8Array): Uint8Array {
  const x = new Uint32Array(17); const r = new Uint32Array(17); const h = new Uint32Array(17); const c = new Uint32Array(17); const g = new Uint32Array(17);
  for (let j = 0; j < 16; j++) r[j] = k[j];
  r[3] &= 15; r[4] &= 252; r[7] &= 15; r[8] &= 252; r[11] &= 15; r[12] &= 252; r[15] &= 15;
  let pos = 0; let n = m.length;
  while (n > 0) {
    c.fill(0);
    let j = 0;
    for (; j < 16 && j < n; j++) c[j] = m[pos + j];
    c[j] = 1;
    pos += j; n -= j;
    add1305(h, c);
    for (let i = 0; i < 17; i++) {
      x[i] = 0;
      for (let q = 0; q < 17; q++) x[i] = (x[i] + ((h[q] * (q <= i ? r[i - q] : (320 * r[i + 17 - q]) | 0)) | 0)) | 0;
    }
    h.set(x);
    let u = 0;
    for (let q = 0; q < 16; q++) { u = (u + h[q]) | 0; h[q] = u & 255; u >>>= 8; }
    u = (u + h[16]) | 0; h[16] = u & 3; u = (5 * (u >>> 2)) | 0;
    for (let q = 0; q < 16; q++) { u = (u + h[q]) | 0; h[q] = u & 255; u >>>= 8; }
    u = (u + h[16]) | 0; h[16] = u;
  }
  g.set(h);
  add1305(h, MINUS_P);
  const s = -(h[16] >>> 7) | 0;
  for (let j = 0; j < 17; j++) h[j] ^= s & (g[j] ^ h[j]);
  c.fill(0);
  for (let j = 0; j < 16; j++) c[j] = k[j + 16];
  add1305(h, c);
  return Uint8Array.from(h.subarray(0, 16));
}

export const boxPublicKey = (secret: Uint8Array): Uint8Array => scalarMult(secret, BASE);

/** The shared key both sides derive (NaCl's crypto_box_beforenm). */
export function boxBefore(theirPublic: Uint8Array, mySecret: Uint8Array): Uint8Array {
  if (theirPublic.length !== 32 || mySecret.length !== 32) throw new Error('bad key size');
  return hsalsa20(new Uint8Array(16), scalarMult(mySecret, theirPublic));
}

/** Encrypts: 16-byte tag + ciphertext, as nacl.box.after does. */
export function boxSeal(message: Uint8Array, nonce: Uint8Array, shared: Uint8Array): Uint8Array {
  if (nonce.length !== 24) throw new Error('bad nonce size');
  const padded = new Uint8Array(32 + message.length);
  padded.set(message, 32);
  const c = xsalsa20Xor(padded, nonce, shared);
  const tag = poly1305(c.subarray(32), c.subarray(0, 32));
  const out = new Uint8Array(16 + message.length);
  out.set(tag);
  out.set(c.subarray(32), 16);
  return out;
}

/** Decrypts, or null when the tag does not match (wrong key, or tampered). */
export function boxOpen(box: Uint8Array, nonce: Uint8Array, shared: Uint8Array): Uint8Array | null {
  if (nonce.length !== 24 || box.length < 16) return null;
  const firstBlock = xsalsa20Xor(new Uint8Array(32), nonce, shared);
  const tag = poly1305(box.subarray(16), firstBlock);
  let diff = 0;
  for (let i = 0; i < 16; i++) diff |= tag[i] ^ box[i];
  if (diff !== 0) return null;
  const padded = new Uint8Array(32 + box.length - 16);
  padded.set(box.subarray(16), 32);
  return xsalsa20Xor(padded, nonce, shared).subarray(32);
}
