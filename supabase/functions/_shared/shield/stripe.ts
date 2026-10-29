// Stripe without the SDK: Stripe-Signature verification (Web Crypto HMAC-SHA256), form encoding, and the key guard.
// Pure and Deno/Node portable, so the same file runs in the Edge Functions and in vitest. Nothing here logs a secret.

export const STRIPE_API = 'https://api.stripe.com/v1';
/** How far a webhook timestamp may be from now (seconds), per Stripe's default tolerance. */
export const TOLERANCE_SECONDS = 300;

const enc = new TextEncoder();

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Constant-time string compare (no early exit on the first differing character). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

/** The `Stripe-Signature` header a webhook would carry (tests and docs). */
export async function signPayload(secret: string, body: string, timestamp: number): Promise<string> {
  return `t=${timestamp},v1=${await hmacHex(secret, `${timestamp}.${body}`)}`;
}

export type SignatureResult = { ok: true } | { ok: false; reason: 'missing' | 'malformed' | 'stale' | 'mismatch' };

/**
 * Verifies a Stripe webhook. `payload` must be the RAW request body. Any one of the `v1` signatures may match (Stripe sends
 * several while a signing secret is being rotated). `nowMs` is injectable for tests.
 */
export async function verifySignature(payload: string, header: string | null, secret: string, nowMs = Date.now(),
  toleranceSeconds = TOLERANCE_SECONDS): Promise<SignatureResult> {
  if (!header || !secret) return { ok: false, reason: 'missing' };
  let t = NaN;
  const sigs: string[] = [];
  for (const part of header.split(',')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k === 't') t = Number(v);
    else if (k === 'v1' && /^[0-9a-f]{64}$/.test(v)) sigs.push(v);
  }
  if (!Number.isFinite(t) || sigs.length === 0) return { ok: false, reason: 'malformed' };
  if (Math.abs(nowMs / 1000 - t) > toleranceSeconds) return { ok: false, reason: 'stale' };
  const expected = await hmacHex(secret, `${t}.${payload}`);
  let match = false;
  for (const s of sigs) if (safeEqual(s, expected)) match = true; // check all, no early exit
  return match ? { ok: true } : { ok: false, reason: 'mismatch' };
}

/** Stripe's form encoding: nested keys as a[b][c], arrays as a[0][b]. */
export function formEncode(obj: Record<string, unknown>): string {
  const out: string[] = [];
  const walk = (prefix: string, v: unknown) => {
    if (v === undefined || v === null) return;
    if (Array.isArray(v)) v.forEach((x, i) => walk(`${prefix}[${i}]`, x));
    else if (typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(`${prefix}[${k}]`, x);
    else out.push(`${encodeURIComponent(prefix)}=${encodeURIComponent(String(v))}`);
  };
  for (const [k, v] of Object.entries(obj)) walk(k, v);
  return out.join('&');
}

/**
 * Test mode only for now. A key that doesn't start with sk_test_ is refused unless the owner has also set
 * STRIPE_LIVE_MODE=true. Returns the reason to refuse (never the key), or null when the key may be used.
 */
export function keyRefusal(key: string | undefined, liveMode: string | undefined): string | null {
  if (!key) return 'STRIPE_SECRET_KEY is not set';
  if (key.startsWith('sk_test_')) return null;
  if (liveMode === 'true' && /^(sk|rk)_live_/.test(key)) return null;
  return 'STRIPE_SECRET_KEY is not a test key (sk_test_...) and STRIPE_LIVE_MODE is not true';
}
