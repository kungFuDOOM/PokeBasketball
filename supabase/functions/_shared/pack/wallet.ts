// Pack Battles money in and out, on the chain side (migration 20261105_pokejam_pack_wallet.sql holds the books).
//
//   Proving a wallet   The player signs a one-time message (pokejam_pack_wallet_challenge) with their wallet; this
//                      checks the Ed25519 signature and links it (pokejam_pack_wallet_link).
//   Deposits           A USDC transfer into the house's USDC account. Only finalized transactions count, only
//                      transfers of the USDC mint into that account, and only from the player's proven wallet
//                      (anything else is held for a person). Each transfer is credited once: ref = signature +
//                      instruction. Found two ways: the page claims its own transaction right after the wallet
//                      sends it, and the scan pages through the account's history from the last signature it
//                      finished, so an outage or a backlog never skips one.
//   Withdrawals        Already debited from the balance (pokejam_pack_withdraw). The worker sends each to the proven
//                      wallet: the transaction's id and blockhash are recorded before it's submitted, and a lost
//                      reply is settled from the chain (landed: sent; failed, or expired unseen: try again; still
//                      landing: wait). A send that fails for good is credited back once.
//
// The house signs only the withdrawals it builds here: a token-account create (if the wallet has none), one
// TransferChecked from its USDC account, and a memo.

import { ATA_PROGRAM, SPL_PROGRAM, SYSTEM_PROGRAM, associatedAccount, buildMessage, memoIx, priorityIxs, unsignedTransaction, type Ix } from '../ads/tx.ts';
import { base58Decode, base58Encode, base64Decode, base64Encode } from './bytes.ts';
import { verifySignature, type Keypair } from './ed25519.ts';
import type { Rpc } from './rpc.ts';
import { parseTransaction } from './solana-tx.ts';
import type { RpcCall } from './store.ts';

export const DEPOSIT_MEMO = 'pokejam-deposit';
export const withdrawalMemo = (id: string) => `pokejam-withdrawal:${id}`;
/** Sends that fail before a withdrawal is credited back. */
export const MAX_SEND_ATTEMPTS = 3;
/** The house keeps at least this much SOL for fees (and a token-account rent) before it sends. */
const MIN_HOUSE_LAMPORTS = 10_000_000;
/** Pages of 1,000 signatures the scan reads in one run before it calls it a backlog. */
const MAX_SCAN_PAGES = 20;

// ---------- reading deposits out of a landed transaction ----------

interface ParsedIx { programId: string; parsed?: unknown }

/** The parts of a jsonParsed getTransaction result this needs. */
export interface LandedTx {
  slot: number;
  blockTime: number | null;
  meta: { err: unknown; innerInstructions?: { index: number; instructions: ParsedIx[] }[] | null } | null;
  transaction: { signatures: string[]; message: { accountKeys: { pubkey: string; signer: boolean }[]; instructions: ParsedIx[] } };
}

export interface Deposit { ref: string; signature: string; sender: string; amount: bigint; slot: number; blockTime: number | null }

interface TransferInfo { source?: string; destination?: string; mint?: string; authority?: string; multisigAuthority?: string; amount?: string; tokenAmount?: { amount?: string } }

/**
 * Every transfer of USDC into the house's USDC account in a successful transaction, one per instruction (inner
 * ones too: a wallet or an exchange may send through a program). A transaction the house signed is the house's
 * own (a purchase, a buyback, a withdrawal) and never a deposit.
 */
export function depositsIn(tx: LandedTx | null, house: { address: string; usdcAccount: string; usdcMint: string }): Deposit[] {
  if (!tx?.meta || tx.meta.err) return [];
  const sig = tx.transaction.signatures[0];
  if (tx.transaction.message.accountKeys.some((k) => k.signer && k.pubkey === house.address)) return [];
  const found: Deposit[] = [];
  const look = (ix: ParsedIx, ref: string) => {
    if (ix.programId !== SPL_PROGRAM) return;
    const p = ix.parsed as { type?: string; info?: TransferInfo } | undefined;
    if (!p?.info || (p.type !== 'transfer' && p.type !== 'transferChecked')) return;
    const i = p.info;
    if (i.destination !== house.usdcAccount) return;
    // TransferChecked names the mint; a plain Transfer into this account can only be of its mint (the token
    // program refuses any other), which the worker checks is USDC before it reads anything.
    if (p.type === 'transferChecked' && i.mint !== house.usdcMint) return;
    const amount = i.tokenAmount?.amount ?? i.amount;
    if (typeof amount !== 'string' || !/^\d+$/.test(amount) || BigInt(amount) === 0n) return;
    const sender = i.authority ?? i.multisigAuthority;
    if (!sender) return;
    found.push({ ref: `${sig}:${ref}`, signature: sig, sender, amount: BigInt(amount), slot: tx.slot, blockTime: tx.blockTime });
  };
  tx.transaction.message.instructions.forEach((ix, i) => look(ix, String(i)));
  for (const inner of tx.meta.innerInstructions ?? []) inner.instructions.forEach((ix, j) => look(ix, `${inner.index}.${j}`));
  return found;
}

// ---------- the house's USDC account ----------

/** Refuse to read deposits or send withdrawals unless the account really is the house's, for USDC. */
export async function checkHouseAccount(rpc: Pick<Rpc, 'accountInfo'>, house: { address: string; usdcAccount: string; usdcMint: string }) {
  const acct = await rpc.accountInfo(house.usdcAccount);
  if (!acct) throw new Error(`HOUSE_USDC_ACCOUNT ${house.usdcAccount} does not exist`);
  if (acct.owner !== SPL_PROGRAM) throw new Error('HOUSE_USDC_ACCOUNT is not an SPL token account');
  const data = base64Decode(acct.data);
  if (base58Encode(data.slice(0, 32)) !== house.usdcMint) throw new Error('HOUSE_USDC_ACCOUNT is not for the USDC mint');
  if (base58Encode(data.slice(32, 64)) !== house.address) throw new Error('HOUSE_USDC_ACCOUNT is not owned by the house wallet');
}

/** A mint's decimals (SPL mint layout: byte 44). */
export async function mintDecimals(rpc: Pick<Rpc, 'accountInfo'>, mint: string): Promise<number> {
  const acct = await rpc.accountInfo(mint);
  if (!acct) throw new Error(`mint ${mint} does not exist`);
  return base64Decode(acct.data)[44];
}

// ---------- transactions ----------

const u64 = (v: bigint) => {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, v, true);
  return [...b];
};
const compact = (n: number) => {
  const out: number[] = [];
  do { let b = n & 0x7f; n >>= 7; if (n) b |= 0x80; out.push(b); } while (n);
  return out;
};

/** SPL Token TransferChecked (12). */
const transferCheckedIx = (source: string, mint: string, destination: string, owner: string, amount: bigint, decimals: number): Ix => ({
  program: SPL_PROGRAM,
  accounts: [
    { key: source, signer: false, writable: true }, { key: mint, signer: false, writable: false },
    { key: destination, signer: false, writable: true }, { key: owner, signer: true, writable: false },
  ],
  data: new Uint8Array([12, ...u64(amount), decimals]),
});

/** Associated Token Account CreateIdempotent (1): a no-op when the account exists. */
const createAtaIx = (payer: string, ata: string, owner: string, mint: string): Ix => ({
  program: ATA_PROGRAM,
  accounts: [
    { key: payer, signer: true, writable: true }, { key: ata, signer: false, writable: true },
    { key: owner, signer: false, writable: false }, { key: mint, signer: false, writable: false },
    { key: SYSTEM_PROGRAM, signer: false, writable: false }, { key: SPL_PROGRAM, signer: false, writable: false },
  ],
  data: new Uint8Array([1]),
});

/** The player's deposit, unsigned, for their wallet to sign: from their USDC account to the house's, with a memo. */
export async function buildDeposit(i: { wallet: string; houseUsdcAccount: string; usdcMint: string; amount: bigint; decimals: number;
  recentBlockhash: string; priorityMicroLamports: number }): Promise<string> {
  const from = await associatedAccount(i.wallet, i.usdcMint, SPL_PROGRAM);
  const { message, signers } = buildMessage(i.wallet, [
    ...priorityIxs(i.priorityMicroLamports),
    transferCheckedIx(from, i.usdcMint, i.houseUsdcAccount, i.wallet, i.amount, i.decimals),
    memoIx(DEPOSIT_MEMO),
  ], i.recentBlockhash);
  if (signers.length !== 1) throw new Error('the deposit must have the player as its only signer');
  return base64Encode(unsignedTransaction(message, 1));
}

/** A withdrawal, signed by the house: create the wallet's USDC account if needed, then send it the amount. */
export async function buildWithdrawal(house: Keypair, i: { id: string; wallet: string; houseUsdcAccount: string; usdcMint: string; amount: bigint;
  decimals: number; recentBlockhash: string; priorityMicroLamports: number }): Promise<{ base64: string; txid: string }> {
  const to = await associatedAccount(i.wallet, i.usdcMint, SPL_PROGRAM);
  const { message, signers } = buildMessage(house.address, [
    ...priorityIxs(i.priorityMicroLamports, 80_000),
    createAtaIx(house.address, to, i.wallet, i.usdcMint),
    transferCheckedIx(i.houseUsdcAccount, i.usdcMint, to, house.address, i.amount, i.decimals),
    memoIx(withdrawalMemo(i.id)),
  ], i.recentBlockhash);
  if (signers.length !== 1 || signers[0] !== house.address) throw new Error('only the house may sign a withdrawal');
  const sig = await house.sign(message);
  return { base64: base64Encode(new Uint8Array([...compact(1), ...sig, ...message])), txid: base58Encode(sig) };
}

// ---------- deposits ----------

export interface MoneyDeps {
  call: RpcCall;
  rpc: Pick<Rpc, 'accountInfo' | 'parsedTransaction' | 'signaturesFor' | 'latestBlockhash' | 'send' | 'confirm' | 'signatureStatus' | 'blockhashValid' | 'tokenBalance' | 'balance'>;
  house: Keypair;
  houseUsdcAccount: string;
  usdcMint: string;
  priorityMicroLamports: number;
  log?: Pick<Console, 'info' | 'warn' | 'error'>;
}

export type DepositResult = { state: 'pending' } | { state: 'none' } | { state: 'recorded'; deposits: { ref: string; amount: string; state: string; user: string | null }[] };

/** Record every deposit in one transaction. 'pending' while it isn't finalized yet (or isn't found). */
export async function recordSignature(d: MoneyDeps, signature: string): Promise<DepositResult> {
  const tx = await d.rpc.parsedTransaction<LandedTx>(signature, 'finalized');
  if (!tx) return { state: 'pending' };
  const found = depositsIn(tx, { address: d.house.address, usdcAccount: d.houseUsdcAccount, usdcMint: d.usdcMint });
  if (!found.length) return { state: 'none' };
  const deposits = [];
  for (const x of found) {
    const r = await d.call('pokejam_pack_record_deposit', { p_ref: x.ref, p_signature: x.signature, p_sender: x.sender, p_amount: x.amount.toString(),
      p_slot: x.slot, p_block_time: x.blockTime ? new Date(x.blockTime * 1000).toISOString() : null }) as { state: string; user: string | null };
    deposits.push({ ref: x.ref, amount: x.amount.toString(), state: r.state, user: r.user });
  }
  return { state: 'recorded', deposits };
}

/**
 * Page through the house account's finalized history from the last signature finished, oldest first. The cursor
 * only moves past a signature once it's recorded, so a crash or an outage resumes where it stopped. A first run
 * (no cursor yet) reads the newest 1,000.
 */
export async function scanDeposits(d: MoneyDeps): Promise<{ read: number; recorded: number; backlog: boolean }> {
  const cursor = (await d.call('pokejam_pack_deposit_cursor', {})) as string | null;
  const sigs: { signature: string; err: unknown }[] = [];
  let before: string | undefined;
  let backlog = false;
  for (let page = 0; ; page++) {
    if (page >= MAX_SCAN_PAGES) { backlog = true; break; }
    const got = await d.rpc.signaturesFor(d.houseUsdcAccount, { before, until: cursor ?? undefined, limit: 1000, commitment: 'finalized' });
    sigs.push(...got);
    if (got.length < 1000 || !cursor) break;
    before = got[got.length - 1].signature;
  }
  // Too far behind to reach the cursor in one run: don't skip the gap. Say so; a person widens the run.
  if (backlog) {
    d.log?.error(`deposit scan: more than ${MAX_SCAN_PAGES * 1000} signatures since the cursor; not advancing`);
    return { read: sigs.length, recorded: 0, backlog };
  }
  let recorded = 0;
  for (const s of sigs.reverse()) {
    if (!s.err) {
      const r = await recordSignature(d, s.signature);
      if (r.state === 'pending') break; // listed as finalized but not served yet: try again next run
      if (r.state === 'recorded') recorded += r.deposits.length;
    }
    await d.call('pokejam_pack_set_deposit_cursor', { p_signature: s.signature });
  }
  return { read: sigs.length, recorded, backlog };
}

// ---------- withdrawals ----------

interface WithdrawalRow { id: string; user_id: string; wallet: string; amount: number | string; txid: string | null; blockhash: string | null }

export type WithdrawalOutcome = 'sent' | 'waiting' | 'held' | 'retry' | 'refunded' | 'skipped';

/** An RPC error is the node refusing the transaction (it never went out); anything else may have reached it. */
const refusedByNode = (e: unknown) => /^RPC sendTransaction: /.test((e as Error)?.message ?? '');

export async function runWithdrawals(d: MoneyDeps, limit = 5): Promise<{ id: string; outcome: WithdrawalOutcome; note?: string }[]> {
  const rows = (await d.call('pokejam_pack_claim_withdrawals', { p_limit: limit })) as WithdrawalRow[];
  if (!rows?.length) return [];
  const decimals = await mintDecimals(d.rpc, d.usdcMint);
  const out: { id: string; outcome: WithdrawalOutcome; note?: string }[] = [];
  for (const w of rows) {
    try {
      out.push({ id: w.id, ...(await sendOne(d, w, decimals)) });
    } catch (e) {
      // Nothing is lost: the row stays 'sending' with whatever was recorded, and comes back after 10 minutes.
      d.log?.error(`withdrawal ${w.id}: ${(e as Error).message}`);
      out.push({ id: w.id, outcome: 'skipped', note: (e as Error).message });
    }
  }
  return out;
}

async function sendOne(d: MoneyDeps, w: WithdrawalRow, decimals: number): Promise<{ outcome: WithdrawalOutcome; note?: string }> {
  const held = async (why: string, secs: number) => {
    await d.call('pokejam_pack_withdrawal_held', { p_id: w.id, p_reason: why, p_retry_seconds: secs });
    return { outcome: 'held' as const, note: why };
  };
  const failed = async (why: string) => {
    const r = await d.call('pokejam_pack_withdrawal_failed', { p_id: w.id, p_reason: why, p_max: MAX_SEND_ATTEMPTS });
    return { outcome: r === 'refunded' ? 'refunded' as const : 'retry' as const, note: why };
  };
  // A transaction recorded on an earlier run: find out from the chain what became of it first.
  if (w.txid) {
    const st = await d.rpc.signatureStatus(w.txid);
    if (st === 'confirmed') {
      await d.call('pokejam_pack_withdrawal_sent', { p_id: w.id, p_txid: w.txid });
      return { outcome: 'sent' };
    }
    if (st === 'failed') {
      await d.call('pokejam_pack_withdrawal_cleared', { p_id: w.id });
      return failed('the transaction failed on-chain');
    }
    if (w.blockhash && (await d.rpc.blockhashValid(w.blockhash))) {
      await d.call('pokejam_pack_withdrawal_held', { p_id: w.id, p_reason: 'still landing', p_retry_seconds: 20 });
      return { outcome: 'waiting' };
    }
    // Its blockhash expired without it landing, so it never will: send a fresh one.
    await d.call('pokejam_pack_withdrawal_cleared', { p_id: w.id });
  }
  const amount = BigInt(w.amount);
  const why = (await d.call('pokejam_pack_withdraw_check', { p_amount: amount.toString() })) as string | null;
  if (why) return held(why, 600);
  if (BigInt(await d.rpc.tokenBalance(d.houseUsdcAccount)) < amount) return held('the house is short of USDC', 600);
  if ((await d.rpc.balance(d.house.address)) < MIN_HOUSE_LAMPORTS) return held('the house is short of SOL for fees', 600);
  const recentBlockhash = await d.rpc.latestBlockhash();
  const tx = await buildWithdrawal(d.house, { id: w.id, wallet: w.wallet, houseUsdcAccount: d.houseUsdcAccount, usdcMint: d.usdcMint, amount, decimals,
    recentBlockhash, priorityMicroLamports: d.priorityMicroLamports });
  if (!(await d.call('pokejam_pack_withdrawal_submitting', { p_id: w.id, p_txid: tx.txid, p_blockhash: recentBlockhash }))) return { outcome: 'skipped', note: 'not this run\'s' };
  try {
    await d.rpc.send(tx.base64);
  } catch (e) {
    if (!refusedByNode(e)) throw e; // the reply was lost: the next run asks the chain
    await d.call('pokejam_pack_withdrawal_cleared', { p_id: w.id });
    return failed((e as Error).message.replace(/^RPC sendTransaction: /, '').slice(0, 300));
  }
  let landed = false;
  try {
    landed = await d.rpc.confirm(tx.txid, 30_000);
  } catch {
    await d.call('pokejam_pack_withdrawal_cleared', { p_id: w.id });
    return failed('the transaction failed on-chain');
  }
  if (!landed) {
    await d.call('pokejam_pack_withdrawal_held', { p_id: w.id, p_reason: 'still landing', p_retry_seconds: 20 });
    return { outcome: 'waiting' };
  }
  await d.call('pokejam_pack_withdrawal_sent', { p_id: w.id, p_txid: tx.txid });
  return { outcome: 'sent' };
}

// ---------- the HTTP side ----------

export interface WalletHttpConfig {
  /** Sites allowed to call (exact origins). Empty: any origin. */
  origins: string[];
  serviceKey: string;
  cluster: 'devnet' | 'mainnet-beta';
}

export interface WalletHttpDeps extends MoneyDeps {
  /** The signed-in player behind a JWT, or null. */
  userOf(jwt: string): Promise<string | null>;
  /** Runs the scan and the withdrawals (the cron), with health. */
  runAll(): Promise<unknown>;
}

class Refusal extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

const sameKey = (got: string, want: string) => {
  if (!want || got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
};

const decodeSig = (s: string): Uint8Array => {
  const b = /^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(s) ? base58Decode(s) : base64Decode(s);
  if (b.length !== 64) throw new Refusal('That signature is not 64 bytes.');
  return b;
};

/**
 * POST { action, ... }:
 *   prove   { wallet, signature }  the player's wallet signed their challenge: link it
 *   deposit { amount }             an unsigned deposit (USDC base units) for the proven wallet to sign
 *   claim   { signature } | { tx } credit the deposit in this transaction once it's finalized; with a signed
 *                                  transaction (wallets that only sign), send it first
 *   run                            service key only: scan for deposits and send withdrawals (the cron)
 */
export async function walletHandler(req: Request, cfg: WalletHttpConfig, d: WalletHttpDeps): Promise<Response> {
  const origin = req.headers.get('origin') ?? '';
  const allowed = !cfg.origins.length || cfg.origins.includes(origin);
  const cors: Record<string, string> = {
    'access-control-allow-origin': allowed ? (origin || '*') : 'null',
    'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
    vary: 'origin',
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response(null, { status: allowed ? 204 : 403, headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  const jwt = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad request' }, 400);
  }
  try {
    if (body.action === 'run') {
      if (!sameKey(jwt, cfg.serviceKey)) return json({ error: 'service key required' }, 401);
      return json(await d.runAll());
    }
    if (!allowed) return json({ error: 'origin not allowed' }, 403);
    const user = jwt ? await d.userOf(jwt) : null;
    if (!user) return json({ error: 'sign in first' }, 401);

    if (body.action === 'prove') {
      const wallet = String(body.wallet ?? '');
      const c = (await d.call('pokejam_pack_wallet_challenge_of', { p_user: user })) as { wallet: string; message: string } | null;
      if (!c || c.wallet !== wallet) throw new Refusal('That sign-in request has expired. Try linking the wallet again.');
      if (!(await verifySignature(wallet, new TextEncoder().encode(c.message), decodeSig(String(body.signature ?? ''))))) {
        throw new Refusal("That signature isn't from this wallet.");
      }
      return json(await d.call('pokejam_pack_wallet_link', { p_user: user, p_wallet: wallet, p_message: c.message }));
    }

    const wallet = (await d.call('pokejam_pack_wallet_of', { p_user: user })) as string | null;
    if (!wallet) throw new Refusal('Link your wallet first: deposits are only credited from the wallet you proved is yours.');

    if (body.action === 'deposit') {
      const amount = typeof body.amount === 'string' || typeof body.amount === 'number' ? String(body.amount) : '';
      if (!/^\d{1,15}$/.test(amount) || BigInt(amount) === 0n) throw new Refusal('Enter an amount to deposit.');
      const decimals = await mintDecimals(d.rpc, d.usdcMint);
      const tx = await buildDeposit({ wallet, houseUsdcAccount: d.houseUsdcAccount, usdcMint: d.usdcMint, amount: BigInt(amount), decimals,
        recentBlockhash: await d.rpc.latestBlockhash(), priorityMicroLamports: d.priorityMicroLamports });
      return json({ tx, cluster: cfg.cluster, to: d.houseUsdcAccount, mint: d.usdcMint });
    }

    if (body.action === 'claim') {
      let signature = typeof body.signature === 'string' ? body.signature : '';
      if (typeof body.tx === 'string') {
        // Relay a signed deposit for a wallet that only signs: it must be the proven wallet's, paying the house.
        const parsed = parseTransaction(base64Decode(body.tx));
        if (parsed.signers.length !== 1 || parsed.signers[0] !== wallet || !parsed.accountKeys.includes(d.houseUsdcAccount)) {
          throw new Refusal('That is not a deposit from your wallet.');
        }
        signature = base58Encode(parsed.signatures[0]);
        try {
          await d.rpc.send(body.tx);
        } catch (e) {
          if (refusedByNode(e)) throw new Refusal(`Solana didn't accept the deposit, so nothing was sent: ${(e as Error).message.replace(/^RPC \w+: /, '').slice(0, 200)}`);
          throw e;
        }
      }
      if (!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(signature)) throw new Refusal('That is not a transaction signature.');
      const r = await recordSignature(d, signature);
      const mine = r.state === 'recorded' ? r.deposits.filter((x) => x.user === user) : [];
      return json({ signature, state: r.state, credited: mine.filter((x) => x.state === 'credited').reduce((s, x) => s + Number(x.amount), 0),
        deposits: r.state === 'recorded' ? r.deposits.map((x) => ({ amount: x.amount, state: x.user === user || x.user === null ? x.state : 'other' })) : [] });
    }
    return json({ error: 'unknown action' }, 400);
  } catch (e) {
    if (e instanceof Refusal) return json({ error: e.message }, e.status);
    const msg = (e as Error).message ?? String(e);
    // The SQL functions' own refusals are written for players.
    if (/expired|already linked|not a Solana wallet|suspended|Slow down|Link your wallet/.test(msg)) return json({ error: msg.replace(/^pokejam_\w+: /, '') }, 400);
    d.log?.error(`pokejam-pack-wallet: ${msg}`);
    return json({ error: 'Something went wrong. Nothing was moved; try again.' }, 500);
  }
}
