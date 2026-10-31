// pokejam-ads: book the courtside LED board by burning $PJAM. See ../../../migrations/20261104_pokejam_ads.sql
// for how a booking moves, and supabase/functions/README.md for setup.
//
//   GET  ?action=board                        the ads live now, the next 14 days' bookings, prices, totals, the token
//   POST {action:'check', text}               would this text run? (the page asks as the advertiser types)
//   POST {action:'quote', plan, start, wallet?}
//   POST {action:'wallet', wallet}            the wallet's $PJAM and SOL, for the page
//   POST {action:'prepare', wallet, text, theme, plan, start, expect}
//                                             books it (unpaid) and returns the unsigned burn for the wallet to sign
//   POST {action:'confirm', id, signature?, tx?}
//                                             finds the landed burn and pays for the booking. With `tx` (signed,
//                                             base64) it sends it first, for wallets that only sign.
//   POST {action:'mine', wallet}              the wallet's ads, settling any whose burn landed unseen
//   POST {action:'replace', id, text, theme, signature}
//                                             new text for an ad moderators took down, signed by its wallet
//   POST {action:'report', id, reason}        flag a live ad for moderators
//   POST {action:'faucet', wallet}            devnet only: test $PJAM and a little test SOL, once a day
//   POST {action:'sweep'}                     cron (service key): pay every burn on-chain that names a booking
//   POST {action:'usdc-intent', ...}          live only (pokejam-ads-live): pay for a week or a month in USDC
//   POST {action:'usdc-confirm', id, signature?, tx?}
//                                             live only: check the USDC payment on-chain and book the ad
//                                             (both in usdc-handlers.ts; the devnet pokejam-ads answers 'unknown action')
//
// A burn is found three ways, so it always becomes airtime: the page confirms it the moment the wallet signs; the
// wallet's ads are settled whenever it connects (any device); and the sweeper walks the mint's own history for
// every transaction whose memo names a booking, so it needs no page, and spam bookings can't crowd it out.
//
// No action moves anyone's tokens but the advertiser's own wallet signature. The server holds no key on mainnet.

import { base58Decode, base64Decode, isAddress, sha256, hex } from '../pack/bytes.ts';
import { keypairFromSecret, verifySignature } from '../pack/ed25519.ts';
import type { Rpc } from '../pack/rpc.ts';
import { parseTransaction } from '../pack/solana-tx.ts';
import { base58Encode } from '../pack/bytes.ts';
import { decodeTransaction } from '../pack/tx-inspect.ts';
import type { AdsConfig } from './config.ts';
import { adMemo, buildBurnTransaction, buildFaucetTransaction, MEMO_PROGRAM, SPL_2022_PROGRAM, SPL_PROGRAM } from './tx.ts';
import { usdcConfirm, usdcIntent, USDC_PLANS, type Reply } from './usdc-handlers.ts';
import { checkBurn, type ParsedTransaction } from './verify.ts';

/** Calls one SQL function by name with named arguments; throws its error message. */
export type DbCall = <T>(fn: string, args?: Record<string, unknown>) => Promise<T>;

export interface AdsDeps {
  db: DbCall;
  rpc: Pick<Rpc, 'call' | 'latestBlockhash' | 'send' | 'signatureStatus' | 'blockhashValid'>;
  /** Waits between looks at the chain (tests pass a no-op). */
  sleep?: (ms: number) => Promise<void>;
  /** Where reports go (a Slack or Discord incoming webhook), when set. */
  alert?: (text: string) => Promise<void>;
}

export interface Booking {
  id: string;
  code: string;
  wallet: string;
  text: string;
  theme: string;
  /** 'month' only on the live board, paid in USDC. */
  plan: 'hour' | 'day' | 'week' | 'month';
  hours: number;
  price: string;
  state: 'pending' | 'paid' | 'dust' | 'removed';
  starts_at: string | null;
  ends_at: string | null;
  moved: boolean;
  burn_sig: string | null;
  blockhash: string | null;
  created_at: string;
  extra_of: string | null;
  replaced_by: string | null;
  removed_left: number | null;
  banned: boolean;
}

interface Mint { tokenProgram: string; decimals: number; supply: string; at: number }

const PLANS = new Set(['hour', 'day', 'week']);
const THEMES = new Set(['gold', 'fire', 'water', 'grass', 'electric', 'psychic', 'ghost', 'ice']);
const REPORTS = new Set(['offensive', 'scam', 'other']);
/** Lamports a wallet needs for the burn's fee (with room for a priority fee). */
const FEE_RESERVE = 20_000;
const CODE_IN_MEMO = /pokejam-ad:([0-9a-f]{12})/g;

/** What the advertiser signs to put new text on an ad that was taken down (the page builds the same string). */
export const replaceMessage = (id: string, text: string, theme: string) => `Poke Jam ad ${id}: replace the text with "${text}" in ${theme}`;

/** Why the text can't run, in the page's words. */
export const VERDICTS: Record<string, string> = {
  length: 'Write 1 to 24 characters.',
  chars: "Only capital letters, numbers, spaces and $ ! ? . , & + @ # : ' / % - show on the board.",
  link: 'No links or web addresses: use your @handle or $ticker instead.',
  scam: "That reads like a giveaway or wallet scam, so it can't run.",
  impersonation: "Ads can't pose as Poke Jam staff or partners.",
  offensive: "That isn't allowed on the board.",
};

// Per IP, per window (seconds). The board is cached instead.
const LIMITS: Record<string, [number, number]> = {
  check: [120, 60], quote: [60, 60], wallet: [30, 60], prepare: [30, 3600], confirm: [120, 60], mine: [30, 60],
  replace: [10, 3600], report: [10, 3600], faucet: [3, 86_400], 'usdc-intent': [30, 3600], 'usdc-confirm': [120, 60],
};

/** A mistake the caller can fix: shown to them as-is. */
class Refusal extends Error {
  constructor(message: string, readonly status = 400, readonly extra: Record<string, unknown> = {}) { super(message); }
}

let mintCache: Mint | null = null;
let boardCache: { at: number; body: Record<string, unknown> } | null = null;

async function mintInfo(cfg: AdsConfig, rpc: AdsDeps['rpc']): Promise<Mint> {
  if (mintCache && Date.now() - mintCache.at < 60_000) return mintCache;
  const r = await rpc.call<{ value: { owner: string; data: { parsed: { info: { decimals: number; supply: string } } } } | null }>(
    'getAccountInfo', [cfg.mint, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  if (!r.value) throw new Error(`mint ${cfg.mint} not found on ${cfg.cluster}`);
  if (r.value.owner !== SPL_PROGRAM && r.value.owner !== SPL_2022_PROGRAM) throw new Error(`mint ${cfg.mint} is not a token mint`);
  const info = r.value.data.parsed.info;
  mintCache = { tokenProgram: r.value.owner, decimals: info.decimals, supply: info.supply, at: Date.now() };
  return mintCache;
}

/** Forget cached reads after the board or the supply changed. */
function changed() {
  boardCache = null;
  if (mintCache) mintCache.at = 0;
}

/** The wallet's token accounts for the mint, biggest first. */
async function tokenAccounts(cfg: AdsConfig, rpc: AdsDeps['rpc'], wallet: string): Promise<{ address: string; amount: bigint }[]> {
  const r = await rpc.call<{ value: { pubkey: string; account: { data: { parsed: { info: { tokenAmount: { amount: string }; state?: string } } } } }[] }>(
    'getTokenAccountsByOwner', [wallet, { mint: cfg.mint }, { encoding: 'jsonParsed', commitment: 'confirmed' }]);
  return r.value
    .filter((a) => a.account.data.parsed.info.state !== 'frozen')
    .map((a) => ({ address: a.pubkey, amount: BigInt(a.account.data.parsed.info.tokenAmount.amount) }))
    .sort((a, b) => (b.amount > a.amount ? 1 : b.amount < a.amount ? -1 : 0));
}

const solBalance = async (rpc: AdsDeps['rpc'], wallet: string) =>
  (await rpc.call<{ value: number }>('getBalance', [wallet, { commitment: 'confirmed' }])).value;

const getTx = (rpc: AdsDeps['rpc'], sig: string) => rpc.call<ParsedTransaction | null>('getTransaction',
  [sig, { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 }]);

/** Signatures in an address's recent history whose memo names this booking. */
async function findByMemo(rpc: AdsDeps['rpc'], b: Booking, limit = 100): Promise<string[]> {
  const r = await rpc.call<{ signature: string; memo: string | null; err: unknown }[]>('getSignaturesForAddress',
    [b.wallet, { limit, commitment: 'confirmed' }]);
  return r.filter((s) => !s.err && s.memo?.includes(adMemo(b.code))).map((s) => s.signature);
}

/** Checks each landed transaction for a burn naming booking `b`, and pays for airtime with every one that has one. */
async function settle(cfg: AdsConfig, deps: AdsDeps, b: Booking, sigs: string[]): Promise<{ booking: Booking; why?: string; seen: boolean }> {
  const mint = await mintInfo(cfg, deps.rpc);
  let why: string | undefined;
  let seen = false;
  let out = b;
  for (const sig of sigs) {
    const tx = await getTx(deps.rpc, sig);
    if (tx) seen = true;
    const check = checkBurn(tx, { code: b.code, mint: cfg.mint, tokenProgram: mint.tokenProgram });
    if (!check.ok) { why = check.why; continue; }
    const paid = await deps.db<Booking>('pokejam_ad_pay', { p_id: b.id, p_sig: check.signature, p_burned: check.burned.toString(), p_burner: check.burner });
    changed();
    // The booking itself, or (for a second burn) its extra run.
    out = paid;
    why = undefined;
  }
  return { booking: out, why, seen };
}

/** Walks the mint's history since the last run for every burn whose memo names a booking, and pays for each. */
async function sweepChain(cfg: AdsConfig, deps: AdsDeps): Promise<{ scanned: number; burns: number; paid: number }> {
  const cursor = await deps.db<string>('pokejam_ad_cfg', { p_key: 'ad_scan_cursor', p_default: '' });
  const oldest = Date.now() / 1000 - 3 * 86_400;
  let before: string | undefined;
  let newest: string | undefined;
  let scanned = 0;
  const hits: { signature: string; memo: string }[] = [];
  for (let page = 0; page < 50; page++) {
    const opts: Record<string, unknown> = { limit: 1000, commitment: 'confirmed' };
    if (cursor) opts.until = cursor;
    if (before) opts.before = before;
    const sigs = await deps.rpc.call<{ signature: string; memo: string | null; err: unknown; blockTime: number | null }[]>('getSignaturesForAddress', [cfg.mint, opts]);
    if (!sigs.length) break;
    newest ??= sigs[0].signature;
    scanned += sigs.length;
    for (const s of sigs) if (!s.err && s.memo?.includes('pokejam-ad:')) hits.push({ signature: s.signature, memo: s.memo });
    before = sigs[sigs.length - 1].signature;
    // The first run only looks back three days.
    if (sigs.length < 1000 || (!cursor && (sigs[sigs.length - 1].blockTime ?? 0) < oldest)) break;
  }
  let paid = 0;
  // Oldest first, so an ad and its extra run land in the order they were burned.
  for (const h of hits.reverse()) {
    for (const [, code] of h.memo.matchAll(CODE_IN_MEMO)) {
      const b = await deps.db<Booking | null>('pokejam_ad_by_code', { p_code: code });
      if (!b || b.burn_sig === h.signature) continue;
      try {
        if ((await settle(cfg, deps, b, [h.signature])).booking.burn_sig === h.signature) paid++;
      } catch (e) {
        // Already paid by this signature under another code, or a bad memo: nothing to do.
        if (!/burn already used/.test((e as Error).message)) throw e;
      }
    }
  }
  if (newest) await deps.db('pokejam_ad_set_cfg', { p_key: 'ad_scan_cursor', p_value: newest });
  return { scanned, burns: hits.length, paid };
}

/** A JSON-RPC refusal (the node checked the transaction and won't forward it), as opposed to not hearing back. */
const refused = (e: unknown) => {
  const m = (e as Error)?.message ?? '';
  return /^RPC sendTransaction: (?!HTTP)/.test(m);
};

export async function adsHandler(req: Request, cfg: AdsConfig, rawDeps: AdsDeps): Promise<Response> {
  // The live function's tables are pokejam_live_*: every SQL call goes through cfg.dbName (none on devnet).
  const dbName = cfg.dbName;
  const deps: AdsDeps = dbName ? { ...rawDeps, db: (fn, args) => rawDeps.db(dbName(fn), args) } : rawDeps;
  const origin = req.headers.get('origin') ?? '';
  const allowed = !cfg.origins.length || cfg.origins.includes(origin);
  const cors: Record<string, string> = {
    'access-control-allow-origin': allowed ? (origin || '*') : 'null',
    'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    vary: 'origin',
  };
  const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json', ...extra } });
  if (req.method === 'OPTIONS') return new Response(null, { status: allowed ? 204 : 403, headers: cors });
  if (!allowed) return json({ error: 'origin not allowed' }, 403);
  const sleep = deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  let body: Record<string, unknown> = {};
  if (req.method === 'POST') {
    try {
      body = ((await req.json()) ?? {}) as Record<string, unknown>;
    } catch {
      return json({ error: 'bad request' }, 400);
    }
  } else if (req.method === 'GET') {
    body = { action: new URL(req.url).searchParams.get('action') ?? 'board' };
  } else {
    return json({ error: 'GET or POST only' }, 405);
  }
  const action = typeof body.action === 'string' ? body.action : '';
  const str = (k: string, max = 2000) => (typeof body[k] === 'string' ? (body[k] as string).trim().slice(0, max) : '');
  const wallet = () => {
    const w = str('wallet');
    if (!isAddress(w)) throw new Refusal('Connect a Solana wallet first.');
    return w;
  };
  const start = () => {
    const s = str('start');
    if (!s) return null;
    const t = Date.parse(s);
    if (!Number.isFinite(t)) throw new Refusal('Pick a valid start time.');
    return new Date(t).toISOString();
  };
  const booking = async () => {
    const id = str('id');
    const b = /^[0-9a-f-]{36}$/.test(id) ? await deps.db<Booking | null>('pokejam_ad_get', { p_id: id }) : null;
    if (!b) throw new Refusal('No such booking.', 404);
    return b;
  };
  // Who's calling, for rate limits and reports: a salted hash of their IP, never the IP itself.
  const ip = req.headers.get('cf-connecting-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown';
  const caller = hex(await sha256(`${cfg.serviceKey}|${ip}`)).slice(0, 24);

  try {
    // The USDC actions don't exist on the devnet function: not even a rate-limit row for them there.
    const limit = action.startsWith('usdc-') && !cfg.usdc ? undefined : LIMITS[action];
    if (limit && !(await deps.db<boolean>('pokejam_ad_allow', { p_key: `${action}:${caller}`, p_max: limit[0], p_seconds: limit[1] }))) {
      return json({ error: 'Too many requests. Wait a minute and try again.' }, 429);
    }
    switch (action) {
      case 'board': {
        if (!boardCache || Date.now() - boardCache.at > 10_000) {
          const [board, mint] = await Promise.all([deps.db<Record<string, unknown>>('pokejam_ad_board'), mintInfo(cfg, deps.rpc)]);
          boardCache = { at: Date.now(), body: { ...board, cluster: cfg.cluster, mint: cfg.mint, decimals: mint.decimals, supply: mint.supply, faucet: !!cfg.faucetSecret,
            // Where USDC payments go (live only). The prices are the board's own `usdc` (from the database).
            ...(cfg.usdc ? { usdcPay: { mint: cfg.usdc.mint, receiver: cfg.usdc.receiver, decimals: 6 } } : {}) } };
        }
        return json(boardCache.body, 200, { 'cache-control': 'public, max-age=10' });
      }
      case 'check': {
        const why = await deps.db<string | null>('pokejam_ad_verdict', { p: str('text', 200) });
        return json({ ok: !why, reason: why, message: why ? VERDICTS[why] : null });
      }
      case 'quote': {
        const plan = str('plan');
        // A month is a USDC plan: quoted only where USDC is offered.
        if (!PLANS.has(plan) && !(cfg.usdc && USDC_PLANS.has(plan))) throw new Refusal(cfg.usdc ? 'Pick an hour, a day, a week or a month.' : 'Pick an hour, a day or a week.');
        const w = str('wallet');
        return json(await deps.db('pokejam_ad_quote', { p_plan: plan, p_start: start(), p_wallet: isAddress(w) ? w : null }));
      }
      case 'wallet': {
        const w = wallet();
        const [accounts, lamports, mint] = await Promise.all([tokenAccounts(cfg, deps.rpc, w), solBalance(deps.rpc, w), mintInfo(cfg, deps.rpc)]);
        return json({ wallet: w, balance: accounts.reduce((s, a) => s + a.amount, 0n).toString(), lamports, decimals: mint.decimals });
      }
      case 'prepare': {
        // Everything that could refuse the ad is checked before the wallet is asked to burn anything.
        const w = wallet();
        const plan = str('plan');
        const theme = str('theme');
        if (!PLANS.has(plan)) throw new Refusal('Pick an hour, a day or a week.');
        if (!THEMES.has(theme)) throw new Refusal('Pick a colour.');
        const why = await deps.db<string | null>('pokejam_ad_verdict', { p: str('text', 200) });
        if (why) throw new Refusal(VERDICTS[why], 400, { reason: why });
        const quote = await deps.db<{ price: string }>('pokejam_ad_quote', { p_plan: plan, p_start: start(), p_wallet: w });
        const price = BigInt(quote.price);
        const expect = str('expect');
        if (expect && /^\d+$/.test(expect) && BigInt(expect) !== price) {
          throw new Refusal('The price just changed. Check the new price and try again.', 409, { price: price.toString() });
        }
        const [accounts, lamports, mint, blockhash] = await Promise.all([
          tokenAccounts(cfg, deps.rpc, w), solBalance(deps.rpc, w), mintInfo(cfg, deps.rpc), deps.rpc.latestBlockhash()]);
        // One account must hold the whole price: the burn comes out of a single account.
        const from = accounts.find((a) => a.amount >= price);
        const total = accounts.reduce((s, a) => s + a.amount, 0n);
        if (!from) {
          throw new Refusal(total >= price ? 'Your $PJAM is split across token accounts: move it into one first.' : 'Not enough $PJAM in this wallet for that plan.',
            400, { short: true, balance: total.toString(), price: price.toString() });
        }
        if (lamports < FEE_RESERVE) throw new Refusal('This wallet needs a little SOL for the network fee.', 400, { noSol: true });
        const b = await deps.db<Booking>('pokejam_ad_create', {
          p_wallet: w, p_text: str('text', 200), p_theme: theme, p_plan: plan, p_start: start(), p_expect: price.toString(), p_blockhash: blockhash,
        });
        const tx = buildBurnTransaction({
          owner: w, tokenAccount: from.address, mint: cfg.mint, tokenProgram: mint.tokenProgram, amount: BigInt(b.price),
          decimals: mint.decimals, code: b.code, recentBlockhash: blockhash, priorityMicroLamports: cfg.priorityMicroLamports,
        });
        return json({ booking: b, tx, cluster: cfg.cluster });
      }
      case 'confirm': {
        let b = await booking();
        let sig = str('signature', 100);
        // Settled already, and no new burn to look at (a second burn for a paid ad buys an extra run below).
        if (b.state !== 'pending' && !str('tx') && (!sig || sig === b.burn_sig)) return json({ booking: b });
        let blockhash = b.blockhash;
        const signed = str('tx', 4000);
        if (signed) {
          // Only relay this booking's burn: a signed transaction carrying its memo and a burn of the token.
          let decoded;
          try {
            decoded = decodeTransaction(base64Decode(signed));
            const parsed = parseTransaction(base64Decode(signed));
            sig = base58Encode(parsed.signatures[0]);
            blockhash = parsed.recentBlockhash;
          } catch {
            throw new Refusal('That is not a transaction.');
          }
          const memo = new TextEncoder().encode(adMemo(b.code));
          const ours = decoded.instructions.some((ix) => ix.program === MEMO_PROGRAM && ix.data.length === memo.length && ix.data.every((x, i) => x === memo[i]))
            && decoded.instructions.some((ix) => (ix.program === SPL_PROGRAM || ix.program === SPL_2022_PROGRAM) && ix.accounts.includes(cfg.mint));
          if (!ours) throw new Refusal('That transaction is not the burn for this booking.');
          try {
            await deps.rpc.send(signed);
          } catch (e) {
            // A node that checked it and said no: it was never sent, so nothing was burned. Anything else (a timeout,
            // a dropped connection) may still have gone through, so keep looking for it below.
            if (refused(e)) {
              throw new Refusal(`Solana didn't accept the burn, so nothing was burned: ${(e as Error).message.replace(/^RPC \w+: /, '').slice(0, 200)}`, 400, { notBurned: true, booking: b });
            }
          }
        }
        if (!sig) {
          // No signature (the page closed mid-burn, or the wallet didn't say): look for the memo in the wallet's history.
          const found = await findByMemo(deps.rpc, b);
          if (found.length) b = (await settle(cfg, deps, b, found)).booking;
          return json({ booking: b, landing: b.state === 'pending' });
        }
        if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(sig)) throw new Refusal('That is not a transaction signature.');
        // Give a just-sent burn up to 20 seconds to confirm; after that the page asks again.
        for (let i = 0; i < 10; i++) {
          const r = await settle(cfg, deps, b, [sig]);
          if (r.booking.burn_sig === sig) return json({ booking: r.booking });
          if (r.seen) {
            // It landed but isn't a burn for this ad (it failed, or burned nothing). Nothing more will come of it.
            return json({ booking: b, error: `That transaction doesn't pay for this ad: ${r.why}.`, notBurned: r.why === 'transaction failed' }, 400);
          }
          await sleep(2000);
        }
        // Not landed yet. If it can never land now (its blockhash expired unseen), nothing was burned.
        const status = await deps.rpc.signatureStatus(sig).catch(() => 'unknown');
        if (status === null && blockhash && !(await deps.rpc.blockhashValid(blockhash).catch(() => true))) {
          return json({ booking: b, expired: true, error: "Your burn didn't go through in time, so nothing was burned. Try again." });
        }
        return json({ booking: b, landing: true });
      }
      case 'mine': {
        const w = wallet();
        const mine = await deps.db<Booking[]>('pokejam_ad_mine', { p_wallet: w });
        // Settle any of the last day's bookings whose burn landed without the page seeing it.
        const pending = mine.filter((b) => b.state === 'pending').slice(0, 3);
        let any = false;
        for (const b of pending) {
          const sigs = await findByMemo(deps.rpc, b).catch(() => []);
          if (sigs.length && (await settle(cfg, deps, b, sigs)).booking.state !== 'pending') any = true;
        }
        return json({ ads: any ? await deps.db<Booking[]>('pokejam_ad_mine', { p_wallet: w }) : mine });
      }
      case 'replace': {
        const b = await booking();
        const text = str('text', 200);
        const theme = str('theme');
        let sig: Uint8Array;
        try {
          sig = base58Decode(str('signature', 200));
        } catch {
          throw new Refusal('Sign the change with your wallet.');
        }
        if (!(await verifySignature(b.wallet, new TextEncoder().encode(replaceMessage(b.id, text, theme)), sig))) {
          throw new Refusal('Only the wallet that booked this ad can change it.', 403);
        }
        const n = await deps.db<Booking>('pokejam_ad_replace', { p_id: b.id, p_text: text, p_theme: theme });
        changed();
        return json({ booking: n });
      }
      case 'report': {
        const id = str('id');
        const reason = str('reason');
        if (!REPORTS.has(reason)) throw new Refusal('Pick a reason.');
        if (!/^[0-9a-f-]{36}$/.test(id)) throw new Refusal('No such ad on the board.', 404);
        const n = await deps.db<number>('pokejam_ad_report', { p_id: id, p_reporter: caller, p_reason: reason });
        // Only new reports count (0: this caller already reported it).
        if (deps.alert && [1, 3, 10].includes(n)) {
          const b = await deps.db<Booking | null>('pokejam_ad_get', { p_id: id });
          await deps.alert(`PokeJam ad reported (${n} ${n === 1 ? 'person' : 'people'}, ${reason}): "${b?.text}" by ${b?.wallet}. Moderate it in admin.html.`).catch(() => {});
        }
        return json({ ok: true });
      }
      case 'faucet': {
        const w = wallet();
        if (!cfg.faucetSecret) throw new Refusal('There is no faucet here.', 404);
        if (!(await deps.db<boolean>('pokejam_ad_faucet_claim', { p_wallet: w }))) throw new Refusal('This wallet already had its test $PJAM today.', 429);
        try {
          const [faucet, mint, lamports, blockhash] = await Promise.all([
            keypairFromSecret(cfg.faucetSecret), mintInfo(cfg, deps.rpc), solBalance(deps.rpc, w), deps.rpc.latestBlockhash()]);
          // Enough SOL for a few hundred burns' fees, only to wallets with almost none.
          const tx = await buildFaucetTransaction(faucet, w, cfg.mint, mint.tokenProgram, cfg.faucetAmount, mint.decimals,
            lamports < 2_000_000 ? 5_000_000 : 0, blockhash);
          const sig = await deps.rpc.send(tx);
          return json({ signature: sig, amount: cfg.faucetAmount.toString() });
        } catch (e) {
          await deps.db('pokejam_ad_faucet_undo', { p_wallet: w }).catch(() => {});
          throw e;
        }
      }
      case 'sweep': {
        const got = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
        if (!cfg.serviceKey || got !== cfg.serviceKey) return json({ error: 'not allowed' }, 401);
        const chain = await sweepChain(cfg, deps);
        // Belt and braces: the last day's unpaid bookings, through each wallet's own history.
        const pending = await deps.db<Booking[]>('pokejam_ad_unsettled', { p_limit: 20 });
        let wallets = 0;
        for (const b of pending) {
          const sigs = await findByMemo(deps.rpc, b).catch(() => []);
          if (sigs.length && (await settle(cfg, deps, b, sigs).catch(() => null))?.booking.state === 'paid') wallets++;
        }
        return json({ ...chain, looked: pending.length, paidFromWallets: wallets });
      }
      case 'usdc-intent':
      case 'usdc-confirm': {
        if (!cfg.usdc) return json({ error: 'unknown action' }, 400);
        const ctx = { cfg, usdc: cfg.usdc, db: deps.db, rpc: deps.rpc, sleep, log: (m: string) => console.error(m) };
        const r: Reply = action === 'usdc-intent'
          ? await usdcIntent(ctx, { wallet: wallet(), text: str('text', 200), theme: str('theme'), plan: str('plan'), start: start(), expect: str('expect'), themes: THEMES })
          : await usdcConfirm(ctx, { id: str('id'), signature: str('signature', 100), tx: str('tx', 4000) });
        if (r.changed) changed();
        // The text filter's verdict, in the page's words (the same as a burn booking's).
        if (r.body.verdict) return json({ error: VERDICTS[r.body.reason as string] ?? "That text can't run.", reason: r.body.reason }, r.status);
        return json(r.body, r.status);
      }
      default:
        return json({ error: 'unknown action' }, 400);
    }
  } catch (e) {
    if (e instanceof Refusal) return json({ error: e.message, ...e.extra }, e.status);
    const msg = (e as Error).message ?? String(e);
    // The SQL functions' own refusals are written for players.
    const verdict = /ad text not allowed \((\w+)\)/.exec(msg);
    if (verdict) return json({ error: VERDICTS[verdict[1]] ?? "That text can't run.", reason: verdict[1] }, 400);
    if (/paused|not a Solana wallet|unknown plan|60 days|too many unpaid|already used|banned|already replaced|only an ad that was taken down|no time left|no such ad|pick a colour|this plan is paid/.test(msg)) {
      return json({ error: msg.charAt(0).toUpperCase() + msg.slice(1) + '.' }, 400);
    }
    console.error('pokejam-ads:', msg);
    return json({ error: /RPC|fetch|network/i.test(msg) ? 'Could not reach Solana. Try again in a moment.' : 'Something went wrong. Try again in a moment.' }, 502);
  }
}
