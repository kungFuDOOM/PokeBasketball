// Paying for a billboard ad in USDC: the usdc-intent and usdc-confirm actions of pokejam-ads-live (handler.ts routes them
// here only when the config has USDC settings, so the devnet pokejam-ads never offers them). Adapted from the intent and
// confirm logic of origin/claude/shield-usdc-only (_shared/shield/usdc-handlers.ts), without the sign-in: on the ad page
// the advertiser is just a wallet, the same as a burn, and the payment must be signed by that wallet.
//
//   POST {action:'usdc-intent', wallet, text, theme, plan: 'week'|'month', start?, expect?}
//        Everything that could refuse the ad (text filter, ban, paused sales, the price the page showed, the wallet's USDC
//        and SOL) is checked first; then a one-time intent (reference key, memo, exact amount) and the unsigned transfer
//        to the receiver's USDC account for the wallet to sign.
//   POST {action:'usdc-confirm', id, signature?, tx?}
//        Reads the payment from the chain at the config's commitment (finalized on mainnet) and checks it (usdc-verify.ts),
//        then books the ad. With `tx` (signed, base64) it sends it first, for wallets that only sign. With neither, it looks
//        the payment up by the intent's reference key (the page closed mid-payment). Safe to repeat: the database books
//        once per intent and once per signature.
//
// Nothing is booked on the client's say-so, and the server never holds a key: the advertiser's wallet moves the USDC.
import { base58Encode, base64Decode, base64Encode, hex, randomBytes } from '../pack/bytes.ts';
import { parseTransaction } from '../pack/solana-tx.ts';
import { decodeTransaction } from '../pack/tx-inspect.ts';
import type { AdsConfig, UsdcSettings } from './config.ts';
import type { AdsDeps, DbCall } from './handler.ts';
import { PROGRAM, USDC_DECIMALS, buildUsdcTransfer, deriveAta } from './usdc-chain.ts';
import { fetchTransaction, verifyUsdcTx, type ChainTx, type VerifyCode } from './usdc-verify.ts';

export const USDC_PLANS = new Set(['week', 'month']);
/** Lamports the wallet needs for the transfer's network fee. */
const FEE_RESERVE = 10_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SIGNATURE = /^[1-9A-HJ-NP-Za-km-z]{64,90}$/;

export interface UsdcIntent {
  id: string; wallet: string; text: string; theme: string; plan: string; hours: number; amount: string; wants_start: string;
  mint: string; cluster: string; receiver: string; reference: string; memo: string; status: 'open' | 'paid';
  signature: string | null; payer: string | null; paid_amount: string | null; ad_id: string | null; created_at: number; expires_at: number;
}

export interface UsdcCtx {
  cfg: AdsConfig;
  usdc: UsdcSettings;
  /** Already mapped to the live tables' function names. */
  db: DbCall;
  rpc: AdsDeps['rpc'];
  sleep: (ms: number) => Promise<void>;
  log?: (msg: string) => void;
}

/** What to answer: the handler adds CORS and JSON. `changed`: the board changed (drop its cache). */
export interface Reply { status: number; body: Record<string, unknown>; changed?: boolean }

const ok = (body: Record<string, unknown>, status = 200, changed = false): Reply => ({ status, body, changed });
const refuse = (error: string, status = 400, extra: Record<string, unknown> = {}): Reply => ({ status, body: { error, ...extra } });

/** The receiver's USDC account exists (else every transfer would fail): looked up once per 10 minutes. */
const ataSeen = new Map<string, number>();
async function receiverReady(ctx: UsdcCtx, ata: string): Promise<boolean> {
  const at = ataSeen.get(ata);
  if (at && Date.now() - at < 600_000) return true;
  const r = await ctx.rpc.call<{ value: { owner: string } | null }>('getAccountInfo', [ata, { encoding: 'base64', commitment: 'confirmed' }]);
  if (r.value?.owner !== PROGRAM.token) return false;
  ataSeen.set(ata, Date.now());
  return true;
}

/** The wallet's USDC (its associated account; 0 if it has none). */
async function usdcBalance(ctx: UsdcCtx, wallet: string): Promise<bigint> {
  const r = await ctx.rpc.call<{ value: { data: { parsed?: { info?: { tokenAmount?: { amount?: string } } } } } | null }>(
    'getAccountInfo', [await deriveAta(wallet, ctx.usdc.mint), { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  const a = r.value?.data?.parsed?.info?.tokenAmount?.amount;
  return a && /^\d+$/.test(a) ? BigInt(a) : 0n;
}

export interface IntentInput { wallet: string; text: string; theme: string; plan: string; start: string | null; expect: string; themes: Set<string> }

export async function usdcIntent(ctx: UsdcCtx, i: IntentInput): Promise<Reply> {
  const { usdc } = ctx;
  if (!USDC_PLANS.has(i.plan)) return refuse('Pick a week or a month.');
  if (!i.themes.has(i.theme)) return refuse('Pick a colour.');
  // The text filter runs before anything else is asked of the wallet (and before any intent exists).
  const why = await ctx.db<string | null>('pokejam_ad_verdict', { p: i.text });
  if (why) return { status: 400, body: { reason: why, verdict: true } };
  const quote = await ctx.db<{ usdc: string | null }>('pokejam_ad_quote', { p_plan: i.plan, p_start: i.start, p_wallet: i.wallet });
  if (!quote.usdc) return refuse('That plan is paid by burning $PJAM.');
  const price = BigInt(quote.usdc);
  if (i.expect && /^\d+$/.test(i.expect) && BigInt(i.expect) !== price) {
    return refuse('The price just changed. Check the new price and try again.', 409, { price: price.toString() });
  }
  const receiverAta = await deriveAta(usdc.receiver, usdc.mint);
  const [ready, balance, lamports] = await Promise.all([
    receiverReady(ctx, receiverAta),
    usdcBalance(ctx, i.wallet),
    ctx.rpc.call<{ value: number }>('getBalance', [i.wallet, { commitment: 'confirmed' }]).then((r) => r.value),
  ]);
  if (!ready) {
    ctx.log?.(`pokejam-ads-live: the USDC receiver ${usdc.receiver} has no USDC account (${receiverAta}) on ${ctx.cfg.cluster}`);
    return refuse('Paying in USDC is not open right now. Try burning $PJAM, or come back later.', 503);
  }
  if (balance < price) return refuse('Not enough USDC in this wallet for that plan.', 400, { short: true, balance: balance.toString(), price: price.toString() });
  if (lamports < FEE_RESERVE) return refuse('This wallet needs a little SOL for the network fee.', 400, { noSol: true });

  const reference = base58Encode(randomBytes(32));
  const memo = `pokejam-ad-usdc:${hex(randomBytes(8))}`;
  const intent = await ctx.db<UsdcIntent>('pokejam_ad_usdc_intent', {
    p_wallet: i.wallet, p_text: i.text, p_theme: i.theme, p_plan: i.plan, p_start: i.start, p_reference: reference, p_memo: memo,
    p_receiver: usdc.receiver, p_mint: usdc.mint, p_cluster: ctx.cfg.cluster, p_expect: price.toString(),
  });
  const blockhash = await ctx.rpc.latestBlockhash();
  const built = await buildUsdcTransfer({ payer: i.wallet, mint: usdc.mint, receiver: usdc.receiver, amount: BigInt(intent.amount), reference, memo, blockhash });
  return ok({
    intent, tx: base64Encode(built.transaction), blockhash, cluster: ctx.cfg.cluster,
    mint: usdc.mint, receiver: usdc.receiver, receiverAta, amount: intent.amount, decimals: USDC_DECIMALS,
  });
}

/** A JSON-RPC refusal (the node checked the transaction and won't forward it), as opposed to not hearing back. */
const refused = (e: unknown) => /^RPC sendTransaction: (?!HTTP)/.test((e as Error)?.message ?? '');

const VERIFY_STATUS: Partial<Record<VerifyCode, number>> = { tx_failed: 409 };

export interface ConfirmInput { id: string; signature: string; tx: string }

export async function usdcConfirm(ctx: UsdcCtx, c: ConfirmInput): Promise<Reply> {
  const { usdc } = ctx;
  const intent = UUID.test(c.id) ? await ctx.db<UsdcIntent | null>('pokejam_ad_usdc_intent_get', { p_id: c.id }) : null;
  if (!intent) return refuse('No such booking.', 404, { code: 'no_intent' });
  if (intent.cluster !== ctx.cfg.cluster || intent.mint !== usdc.mint || intent.receiver !== usdc.receiver) {
    return refuse('The ads payment settings changed. Start a new booking.', 409, { code: 'settings_changed' });
  }
  const paidAd = async () => (intent.ad_id ? await ctx.db<Record<string, unknown> | null>('pokejam_ad_get', { p_id: intent.ad_id }) : null);

  let sig = c.signature;
  let blockhash: string | null = null;
  if (c.tx) {
    // Only relay this intent's payment: a signed transaction carrying its memo and its reference key on a token transfer.
    let decoded;
    try {
      const bytes = base64Decode(c.tx);
      decoded = decodeTransaction(bytes);
      const parsed = parseTransaction(bytes);
      sig = base58Encode(parsed.signatures[0]);
      blockhash = parsed.recentBlockhash;
    } catch {
      return refuse('That is not a transaction.');
    }
    const memo = new TextEncoder().encode(intent.memo);
    const ours = decoded.instructions.some((ix) => ix.program === PROGRAM.memo && ix.data.length === memo.length && ix.data.every((x, k) => x === memo[k]))
      && decoded.instructions.some((ix) => ix.program === PROGRAM.token && ix.accounts.includes(intent.reference));
    if (!ours) return refuse('That transaction is not the payment for this booking.', 400, { code: 'bad_tx' });
    if (intent.status !== 'paid') {
      try {
        await ctx.rpc.send(c.tx);
      } catch (e) {
        // A node that checked it and said no never sent it, so no USDC moved. Anything else may still land: keep looking.
        if (refused(e)) {
          return refuse(`Solana didn't accept the payment, so no USDC was sent: ${(e as Error).message.replace(/^RPC \w+: /, '').slice(0, 200)}`, 400, { notPaid: true });
        }
      }
    }
  }

  if (intent.status === 'paid') {
    if (!sig || sig === intent.signature) return ok({ status: 'paid', duplicate: true, intent, ad: await paidAd() });
    return refuse('This booking was already paid with another transaction.', 409, { code: 'intent_done' });
  }

  let candidates: string[];
  if (sig) {
    if (!SIGNATURE.test(sig)) return refuse('That is not a transaction signature.');
    candidates = [sig];
  } else {
    // No signature (the page closed mid-payment): the reference key is in the payment's accounts, so its history finds it.
    const found = await ctx.rpc.call<{ signature: string; err: unknown }[]>('getSignaturesForAddress', [intent.reference, { limit: 20, commitment: 'confirmed' }]);
    candidates = found.filter((s) => !s.err).map((s) => s.signature);
    if (!candidates.length) return ok({ status: 'open', intent }, 202);
  }

  const facts = { amount: intent.amount, mint: intent.mint, receiver: intent.receiver, wallet: intent.wallet, reference: intent.reference, memo: intent.memo, createdAt: intent.created_at };
  // Give a just-sent payment up to ~20 seconds to reach the commitment (finalized on mainnet); after that the page asks again.
  for (let attempt = 0; attempt < 10; attempt++) {
    let pending = false;
    let last: Reply | null = null;
    for (const s of candidates) {
      let tx: ChainTx | null;
      try {
        tx = await fetchTransaction((m, p) => ctx.rpc.call(m, p), s, usdc.commitment);
      } catch (e) {
        ctx.log?.(`pokejam-ads-live usdc-confirm: RPC failed: ${(e as Error).message}`);
        return refuse('Could not reach Solana. Try again in a moment.', 502, { code: 'rpc' });
      }
      const v = await verifyUsdcTx(tx, s, facts);
      if (!v.ok) {
        if (v.code === 'pending') pending = true;
        else last = refuse(`That transaction doesn't pay for this ad: ${v.message}.`, VERIFY_STATUS[v.code] ?? 400, { code: v.code, notPaid: v.code === 'tx_failed' });
        continue;
      }
      const r = await ctx.db<{ status: string; ad?: Record<string, unknown>; intent?: UsdcIntent }>('pokejam_ad_usdc_pay',
        { p_intent: intent.id, p_sig: s, p_amount: v.paid.toString(), p_payer: intent.wallet });
      switch (r.status) {
        case 'paid':
        case 'duplicate':
          return ok({ status: 'paid', duplicate: r.status === 'duplicate', ad: r.ad, intent: r.intent }, 200, r.status === 'paid');
        case 'signature_used':
          return refuse('That transaction already paid for another ad.', 409, { code: 'signature_used' });
        case 'intent_done':
          return refuse('This booking was already paid with another transaction.', 409, { code: 'intent_done' });
        case 'short':
          return refuse('The payment is less than the price of this ad.', 400, { code: 'short_amount' });
        default:
          return refuse('No such booking.', 404, { code: r.status });
      }
    }
    if (!pending) return last ?? refuse('That is not the payment for this booking.', 400, { code: 'bad_tx' });
    await ctx.sleep(2000);
  }
  // Not at the commitment yet. If it can never land now (its blockhash expired unseen), no USDC moved.
  if (sig && blockhash) {
    const status = await ctx.rpc.signatureStatus(sig).catch(() => 'unknown');
    if (status === null && !(await ctx.rpc.blockhashValid(blockhash).catch(() => true))) {
      return refuse("Your payment didn't go through in time, so no USDC was sent. Try again.", 410, { code: 'expired', expired: true });
    }
  }
  return ok({ status: 'pending', intent }, 202);
}

// ---------- recovery: the sweep (cron) books USDC payments whose page closed before usdc-confirm ----------
//
// Two bounded passes, so a payment that really landed is booked with no page open:
//   1. The receiver's USDC account history since the last run (cursor `live_ad_usdc_scan_cursor`), read at the config's
//      commitment (finalized on mainnet) so the cursor never passes a payment that isn't final yet. Each transaction whose
//      memo looks like an intent's ("pokejam-ad-usdc:<16 hex>") is matched to its intent by memo and checked exactly as
//      usdc-confirm checks it. At most SWEEP.pages pages and SWEEP.checks checks per run; when the cap is hit the cursor
//      stops at the last checked payment, so the rest wait for the next run instead of being skipped. The first run only
//      looks back three days.
//   2. Belt and braces: the last day's open intents (at most SWEEP.open), each through its reference key's history, like
//      usdc-confirm with no signature. This covers a gap if more than SWEEP.pages pages arrived between two runs.
// Nothing is booked twice: the database books once per intent and once per signature.

export const SWEEP = { pages: 3, pageSize: 1000, checks: 25, memosPerTx: 3, open: 20, perReference: 5, lookbackSeconds: 3 * 86_400, retrySeconds: 15 * 60 } as const;
const INTENT_MEMO = /pokejam-ad-usdc:[0-9a-f]{16}/g;

type TryPay = 'paid' | 'pending' | 'skip';

/** One look at one signature for one intent, no waiting: books it if it pays the intent. RPC errors throw. */
async function tryPay(ctx: UsdcCtx, intent: UsdcIntent, sig: string): Promise<TryPay> {
  const { usdc } = ctx;
  if (intent.status !== 'open' || intent.cluster !== ctx.cfg.cluster || intent.mint !== usdc.mint || intent.receiver !== usdc.receiver) return 'skip';
  const tx = await fetchTransaction((m, p) => ctx.rpc.call(m, p), sig, usdc.commitment);
  const v = await verifyUsdcTx(tx, sig, { amount: intent.amount, mint: intent.mint, receiver: intent.receiver, wallet: intent.wallet, reference: intent.reference, memo: intent.memo, createdAt: intent.created_at });
  if (!v.ok) return v.code === 'pending' ? 'pending' : 'skip';
  const r = await ctx.db<{ status: string }>('pokejam_ad_usdc_pay', { p_intent: intent.id, p_sig: sig, p_amount: v.paid.toString(), p_payer: intent.wallet });
  return r.status === 'paid' ? 'paid' : 'skip';
}

export interface SweepResult { scanned: number; seen: number; paid: number; open: number; paidByReference: number; capped: boolean }

export async function usdcSweep(ctx: UsdcCtx, now = Date.now()): Promise<SweepResult> {
  const { usdc } = ctx;
  const ata = await deriveAta(usdc.receiver, usdc.mint);
  const cursor = await ctx.db<string>('pokejam_ad_cfg', { p_key: 'ad_usdc_scan_cursor', p_default: '' });
  const oldest = now / 1000 - SWEEP.lookbackSeconds;
  let before: string | undefined;
  let newest: string | undefined;
  let scanned = 0;
  const hits: { signature: string; memos: string[]; blockTime: number | null }[] = [];
  for (let page = 0; page < SWEEP.pages; page++) {
    const opts: Record<string, unknown> = { limit: SWEEP.pageSize, commitment: usdc.commitment };
    if (cursor) opts.until = cursor;
    if (before) opts.before = before;
    const sigs = await ctx.rpc.call<{ signature: string; memo: string | null; err: unknown; blockTime: number | null }[]>('getSignaturesForAddress', [ata, opts]);
    if (!sigs.length) break;
    newest ??= sigs[0].signature;
    scanned += sigs.length;
    for (const s of sigs) {
      // A real payment carries one memo; a few more are looked up, never an unbounded list.
      const memos = !s.err && s.memo ? [...new Set(s.memo.match(INTENT_MEMO) ?? [])].slice(0, SWEEP.memosPerTx) : [];
      if (memos.length) hits.push({ signature: s.signature, memos, blockTime: s.blockTime });
    }
    before = sigs[sigs.length - 1].signature;
    if (sigs.length < SWEEP.pageSize || (!cursor && (sigs[sigs.length - 1].blockTime ?? 0) < oldest)) break;
  }

  // Oldest first, so the cursor can stop exactly after the last payment checked.
  let paid = 0;
  let checks = 0;
  let capped = false;
  let last: string | undefined;
  const handled = new Set<string>();
  outer: for (const h of hits.reverse()) {
    if (checks > 0 && checks + h.memos.length > SWEEP.checks) { capped = true; break; }
    for (const memo of h.memos) {
      checks++;
      const intent = await ctx.db<UsdcIntent | null>('pokejam_ad_usdc_find', { p_memo: memo, p_reference: null });
      if (!intent) continue;
      const r = await tryPay(ctx, intent, h.signature);
      // Listed at the commitment but not readable at it yet (a lagging node): look again next run, unless it has been
      // unreadable for a while, so one odd transaction can't hold the cursor forever (pass 2 still covers its intent).
      if (r === 'pending' && h.blockTime !== null && now / 1000 - h.blockTime < SWEEP.retrySeconds) { capped = true; break outer; }
      if (r === 'paid') { paid++; handled.add(intent.id); }
    }
    last = h.signature;
  }
  const next = capped ? last : newest;
  if (next && next !== cursor) await ctx.db('pokejam_ad_set_cfg', { p_key: 'ad_usdc_scan_cursor', p_value: next });

  let paidByReference = 0;
  const open = (await ctx.db<UsdcIntent[]>('pokejam_ad_usdc_open', { p_limit: SWEEP.open })).filter((i) => !handled.has(i.id));
  for (const intent of open) {
    try {
      const found = await ctx.rpc.call<{ signature: string; err: unknown }[]>('getSignaturesForAddress',
        [intent.reference, { limit: SWEEP.perReference, commitment: usdc.commitment }]);
      for (const s of found.filter((x) => !x.err)) {
        if ((await tryPay(ctx, intent, s.signature)) === 'paid') { paidByReference++; break; }
      }
    } catch (e) {
      // One intent's lookup failing doesn't stop the others; it is tried again next run.
      ctx.log?.(`pokejam-ads-live sweep: intent ${intent.id}: ${(e as Error).message}`);
    }
  }
  return { scanned, seen: hits.length, paid, open: open.length, paidByReference, capped };
}
