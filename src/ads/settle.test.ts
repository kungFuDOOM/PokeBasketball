// Finishing a signed payment: asking again is always safe, and nothing but a final answer lets go of a payment that may have moved.
import { describe, expect, it } from 'vitest';
import { base58Decode } from '../../supabase/functions/_shared/pack/bytes.ts';
import { AdsError, type Booking, type Confirmed } from './api';
import { PENDING_TTL_MS, heldBy, isFinalRefusal, pollSettled, readPending, relaying, settleBurn, settleUsdc, type Proof, type UsdcAnswer } from './settle';
import { signatureOf } from './wallet';

const fast = { sleep: async () => {}, intervalMs: 1 };
const offline = () => new AdsError('Could not reach the ad server. Check your connection.');
const http = (status: number, body: Record<string, unknown>) => new AdsError(String(body.error ?? `HTTP ${status}`), body, status);
const booking = (state: Booking['state']) => ({ id: 'b', state }) as Booking;

/** Plays a list of answers (throwing the errors), and records each proof sent. */
function script<R>(answers: (R | Error)[]) {
  const sent: Proof[] = [];
  let n = 0;
  const call = async (p: Proof = {}) => {
    sent.push(p);
    const a = answers[Math.min(n++, answers.length - 1)];
    if (a instanceof Error) throw a;
    return a;
  };
  return { call, sent, asked: () => n };
}

describe('which errors are final', () => {
  it('a refusal from the function itself is final', () => {
    for (const s of [400, 404, 409, 410]) expect(isFinalRefusal(http(s, { error: 'No.' }))).toBe(true);
  });

  it('anything else only means "not yet"', () => {
    expect(isFinalRefusal(offline())).toBe(false);
    expect(isFinalRefusal(http(429, { error: 'Too many requests.' }))).toBe(false);
    expect(isFinalRefusal(http(502, { error: 'Could not reach Solana.', code: 'rpc' }))).toBe(false);
    expect(isFinalRefusal(http(500, { error: 'Something went wrong.' }))).toBe(false);
    // The Supabase gateway's own answers aren't the function's word on this payment.
    expect(isFinalRefusal(http(404, { code: 'NOT_FOUND', message: 'Requested function was not found' }))).toBe(false);
    expect(isFinalRefusal(http(401, { message: 'Invalid API key' }))).toBe(false);
    expect(isFinalRefusal(new TypeError('Failed to fetch'))).toBe(false);
  });
});

describe('pollSettled', () => {
  it('keeps asking through failures until it is settled', async () => {
    const s = script<{ ok: boolean }>([offline(), http(502, { error: 'x' }), http(429, { error: 'x' }), { ok: false }, { ok: true }]);
    expect(await pollSettled(() => s.call(), (r) => r.ok, fast)).toEqual({ ok: true });
    expect(s.asked()).toBe(5);
  });

  it('gives up with "timeout", not an error, when the failures outlast it', async () => {
    let t = 0;
    const s = script<never>([offline()]);
    const r = await pollSettled(() => s.call(), () => true, { sleep: async (ms) => { t += ms; }, now: () => t, intervalMs: 1000, timeoutMs: 3000 });
    expect(r).toBe('timeout');
    expect(s.asked()).toBe(4);
  });

  it('stops at a final refusal', async () => {
    const s = script<never>([http(409, { error: 'Already paid.', code: 'signature_used' })]);
    await expect(pollSettled(() => s.call(), () => true, fast)).rejects.toThrow(/Already paid/);
    expect(s.asked()).toBe(1);
  });

  it('asks once with no time to wait, and stops when the page closes', async () => {
    const one = script<{ ok: boolean }>([{ ok: false }]);
    expect(await pollSettled(() => one.call(), (r) => r.ok, { ...fast, timeoutMs: 0 })).toBe('timeout');
    expect(one.asked()).toBe(1);
    const two = script<{ ok: boolean }>([{ ok: false }]);
    expect(await pollSettled(() => two.call(), (r) => r.ok, { ...fast, stop: () => true })).toBe('timeout');
    expect(two.asked()).toBe(1);
  });
});

describe('relaying (a wallet that only signs)', () => {
  it('sends the signed transaction until the server has answered, then only the signature', async () => {
    const s = script<number>([offline(), http(503, { error: 'x' }), 1, 2]);
    const ask = relaying({ signature: 'sig', tx: 'signed' }, s.call);
    await ask().catch(() => {});
    await ask().catch(() => {});
    await ask();
    await ask();
    expect(s.sent).toEqual([{ signature: 'sig', tx: 'signed' }, { signature: 'sig', tx: 'signed' }, { signature: 'sig', tx: 'signed' }, { signature: 'sig' }]);
  });

  it('asks with nothing when it knows nothing: the server looks the payment up', async () => {
    const s = script<number>([1]);
    await relaying({}, s.call)();
    expect(s.sent).toEqual([{}]);
  });
});

describe('settleUsdc', () => {
  const ad = booking('paid');
  it('a paid answer settles, even after failures and "pending"', async () => {
    const s = script<UsdcAnswer>([offline(), { status: 'pending' }, http(502, { error: 'x', code: 'rpc' }), { status: 'open' }, { status: 'paid', ad }]);
    expect(await settleUsdc(() => s.call(), fast)).toEqual({ kind: 'paid', booking: ad });
  });

  it('a retry of a payment already booked comes back as paid', async () => {
    const s = script<UsdcAnswer>([{ status: 'paid', duplicate: true, ad }]);
    expect(await settleUsdc(() => s.call(), fast)).toEqual({ kind: 'paid', booking: ad });
  });

  it('keeps waiting through an outage: nothing tells the page to let go', async () => {
    let t = 0;
    const s = script<UsdcAnswer>([http(502, { error: 'Could not reach Solana.', code: 'rpc' })]);
    expect(await settleUsdc(() => s.call(), { sleep: async (ms) => { t += ms; }, now: () => t, intervalMs: 1000, timeoutMs: 2000 })).toEqual({ kind: 'waiting' });
  });

  it('a payment that went nowhere is final, and says no money moved', async () => {
    for (const body of [{ error: 'Too late.', code: 'expired', expired: true }, { error: "Solana didn't accept it.", notPaid: true }, { error: 'Failed.', code: 'tx_failed', notPaid: true }]) {
      const s = script<UsdcAnswer>([http(410, body)]);
      expect(await settleUsdc(() => s.call(), fast)).toEqual({ kind: 'refused', message: body.error, sent: false });
    }
  });

  it('a refusal that does not rule out a payment is final, and says money may have moved', async () => {
    const s = script<UsdcAnswer>([http(409, { error: 'That transaction already paid for another ad.', code: 'signature_used' })]);
    expect(await settleUsdc(() => s.call(), fast)).toMatchObject({ kind: 'refused', sent: true });
  });
});

describe('settleBurn', () => {
  it('a settled booking settles it, whatever came first', async () => {
    const paid = booking('paid');
    const s = script<Confirmed>([offline(), { booking: booking('pending'), landing: true }, http(502, { error: 'x' }), { booking: paid }]);
    expect(await settleBurn(() => s.call(), fast)).toEqual({ kind: 'paid', booking: paid });
  });

  it('a burn below the price is settled too, with no second try', async () => {
    const dust = booking('dust');
    const s = script<Confirmed>([{ booking: dust }]);
    expect(await settleBurn(() => s.call(), fast)).toEqual({ kind: 'paid', booking: dust });
    expect(s.asked()).toBe(1);
  });

  it('still landing, or no answer, keeps waiting', async () => {
    const landing = script<Confirmed>([{ booking: booking('pending'), landing: true }]);
    expect(await settleBurn(() => landing.call(), { ...fast, timeoutMs: 0 })).toEqual({ kind: 'waiting' });
    const down = script<Confirmed>([offline()]);
    expect(await settleBurn(() => down.call(), { ...fast, timeoutMs: 0 })).toEqual({ kind: 'waiting' });
  });

  it('a burn that never happened is final, and says nothing was burned', async () => {
    const b = booking('pending');
    for (const a of [{ booking: b, expired: true, error: 'Too late.' }, { booking: b, notBurned: true, error: 'Refused.' }]) {
      const s = script<Confirmed>([a]);
      expect(await settleBurn(() => s.call(), fast)).toEqual({ kind: 'refused', message: a.error, sent: false });
    }
  });

  it('a transaction that landed but does not pay for this ad is final, and tokens may have moved', async () => {
    const s = script<Confirmed>([{ booking: booking('pending'), error: "That transaction doesn't pay for this ad: wrong signer." }]);
    expect(await settleBurn(() => s.call(), fast)).toMatchObject({ kind: 'refused', sent: true });
    const used = script<Confirmed>([http(400, { error: 'Burn already used.' })]);
    expect(await settleBurn(() => used.call(), fast)).toEqual({ kind: 'refused', message: 'Burn already used.', sent: true });
  });
});

describe('the saved list', () => {
  const NOW = 1_800_000_000_000;
  it('keeps what it can read, and forgets what is too old', () => {
    const list = [{ id: 'a', at: NOW - 1000, wallet: 'w', signature: 's' }, { id: 'old', at: NOW - PENDING_TTL_MS - 1 }, { id: 'bare', at: NOW }, { id: 7, at: NOW }, null, { id: 'noat' }];
    expect(readPending(JSON.stringify(list), NOW)).toEqual([{ id: 'a', at: NOW - 1000, wallet: 'w', signature: 's' }, { id: 'bare', at: NOW }]);
  });

  it('survives anything else in storage', () => {
    for (const raw of ['', 'not json', '{"id":"a"}', 'null', '7']) expect(readPending(raw, NOW)).toEqual([]);
  });

  it('holds only the wallet that paid', () => {
    const p = { id: 'a', at: NOW, wallet: 'me' };
    expect(heldBy(p, 'me')).toBe(true);
    expect(heldBy(p, 'you')).toBe(false);
    expect(heldBy(p, null)).toBe(false);
    expect(heldBy({ id: 'a', at: NOW }, 'me')).toBe(false);
  });
});

describe('signatureOf (a wallet that only signs)', () => {
  it('reads the first signature, as the base58 Solana calls the transaction', () => {
    const sig = Uint8Array.from({ length: 64 }, (_, i) => i + 1);
    const signed = Uint8Array.from([1, ...sig, 9, 9, 9]);
    const got = signatureOf(signed)!;
    expect([...base58Decode(got)]).toEqual([...sig]);
  });

  it('has nothing to say about an unsigned or malformed transaction', () => {
    expect(signatureOf(new Uint8Array(100).fill(0, 0).map((_, i) => (i === 0 ? 1 : 0)))).toBeUndefined();
    expect(signatureOf(Uint8Array.from([0, 1, 2]))).toBeUndefined();
    expect(signatureOf(Uint8Array.from([1, 1, 2]))).toBeUndefined();
  });
});
