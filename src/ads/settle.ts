// Finishing a burn or a USDC payment the wallet has signed. Money may have moved from that moment on, so the record stays until
// the server gives an answer that asking again can't change. Until then, a lost connection, a failed RPC or a busy server only
// means "ask again", and the page takes no new payment from that wallet (screen.ts), so nobody pays twice for one ad. Every
// Solana call is the server's: this file only talks to pokejam-ads-live, through the `ask` functions it is given. Asking
// again is always safe, because the database books once per booking and once per signature.
import { AdsError, type Booking, type Confirmed } from './api';

/** A signed payment the server hasn't settled. */
export interface PendingPay { id: string; at: number; wallet?: string; signature?: string }

/** How long a record is kept. Past this the sweep has settled the payment, or it never landed. */
export const PENDING_TTL_MS = 86_400_000;

/** The records in a saved list that are still current: anything else in storage is dropped. */
export function readPending(raw: string, now = Date.now()): PendingPay[] {
  let list: unknown;
  try { list = JSON.parse(raw || '[]'); } catch { return []; }
  if (!Array.isArray(list)) return [];
  return (list as Partial<PendingPay>[]).flatMap((p) => (p && typeof p.id === 'string' && typeof p.at === 'number' && now - p.at < PENDING_TTL_MS
    ? [{ id: p.id, at: p.at, ...(typeof p.wallet === 'string' ? { wallet: p.wallet } : {}), ...(typeof p.signature === 'string' ? { signature: p.signature } : {}) }]
    : []));
}

/** Whether a record stops this wallet paying again. */
export const heldBy = (p: PendingPay, wallet: string | null | undefined) => !!wallet && p.wallet === wallet;

/**
 * A refusal from the function itself, which asking again can't change. Everything else is "not yet": no connection, a 5xx, rate
 * limiting (429), or a 401/403/404 from the Supabase gateway, which has no `error` in its body (`AdsError.status` is 0 offline).
 */
export const isFinalRefusal = (e: unknown): boolean =>
  e instanceof AdsError && [400, 404, 409, 410].includes(e.status) && typeof e.info.error === 'string';

export interface PollOptions { intervalMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number; stop?: () => boolean }

/** Asks until `done` says the answer is settled, or the time runs out ('timeout'). A final refusal throws; other errors mean "not yet". */
export async function pollSettled<R>(ask: () => Promise<R>, done: (r: R) => boolean, o: PollOptions = {}): Promise<R | 'timeout'> {
  const interval = o.intervalMs ?? 3000;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const end = now() + (o.timeoutMs ?? 120_000);
  for (;;) {
    try {
      const r = await ask();
      if (done(r)) return r;
    } catch (e) {
      if (isFinalRefusal(e)) throw e;
    }
    if (o.stop?.() || now() + interval > end) return 'timeout';
    await sleep(interval);
  }
}

export interface Proof { signature?: string; tx?: string }

/**
 * The proof to send each time. A signed transaction (a wallet that only signs) goes along until the server has answered once: a
 * call that failed may never have reached it, and then nothing was sent to Solana. The server handles a repeat safely.
 */
export function relaying<R>(proof: Proof, call: (p: Proof) => Promise<R>): () => Promise<R> {
  let tx = proof.tx;
  return async () => {
    const r = await call({ ...(proof.signature ? { signature: proof.signature } : {}), ...(tx ? { tx } : {}) });
    tx = undefined;
    return r;
  };
}

/**
 * paid: settled, with the ad if the server returned one. refused: the record can go; `sent` says whether USDC or $PJAM may have
 * left the wallet anyway (the page then says who to contact). waiting: not settled, so the record stays.
 */
export type Settled =
  | { kind: 'paid'; booking: Booking | null }
  | { kind: 'refused'; message: string; sent: boolean }
  | { kind: 'waiting' };

const WAITING: Settled = { kind: 'waiting' };

/** Settles a burn. Every answer that carries an error is final (a refused or failed burn, or one that doesn't pay for this ad). */
export async function settleBurn(ask: () => Promise<Confirmed>, o: PollOptions = {}): Promise<Settled> {
  try {
    const r = await pollSettled(ask, (a) => a.booking.state !== 'pending' || !!a.expired || !!a.notBurned || !!a.error, o);
    if (r === 'timeout') return WAITING;
    if (r.booking.state !== 'pending') return { kind: 'paid', booking: r.booking };
    return { kind: 'refused', message: r.error ?? "Your burn didn't go through, so nothing was burned. Try again.", sent: !r.expired && !r.notBurned };
  } catch (e) {
    return { kind: 'refused', message: (e as Error).message, sent: true };
  }
}

export interface UsdcAnswer { status: 'paid' | 'pending' | 'open'; duplicate?: boolean; ad?: Booking | null }

/** Settles a USDC payment. */
export async function settleUsdc(ask: () => Promise<UsdcAnswer>, o: PollOptions = {}): Promise<Settled> {
  try {
    const r = await pollSettled(ask, (a) => a.status === 'paid', o);
    return r === 'timeout' ? WAITING : { kind: 'paid', booking: r.ad ?? null };
  } catch (e) {
    const info = e instanceof AdsError ? e.info : {};
    return { kind: 'refused', message: (e as Error).message, sent: !info.expired && !info.notPaid };
  }
}
