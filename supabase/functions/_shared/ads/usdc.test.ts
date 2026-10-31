// Paying for a live billboard ad in USDC (pokejam-ads-live: usdc-intent / usdc-confirm). The verifier on its own, then
// the whole flow through adsHandler with the live config, every migration (PGlite) and a pretend Solana that parses
// what it's sent the way jsonParsed does. The promise: a USDC payment books an ad only if the right token went to the
// right account (kungfudoom.sns's USDC ATA), for at least the price, signed by the booking wallet, at the required
// commitment, and only once per signature; and the text filter runs before any intent exists.
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';
import { base58Encode, base64Decode, randomBytes } from '../pack/bytes.ts';
import { generateKeypair, type Keypair } from '../pack/ed25519.ts';
import { parseTransaction, signTransactionBase64 } from '../pack/solana-tx.ts';
import { decodeTransaction } from '../pack/tx-inspect.ts';
import { adsConfig, adsConfigLive, liveDbName, type AdsConfig } from './config.ts';
import { adsHandler, type AdsDeps } from './handler.ts';
import { PROGRAM, USDC_MINT, USDC_RECEIVER, buildUsdcTransfer, deriveAta } from './usdc-chain.ts';
import { verifyUsdcTx, type ChainTx, type IntentFacts } from './usdc-verify.ts';

vi.setConfig({ testTimeout: 120_000 });

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const RECEIVER = 'FPwoDYkHTFef4Fg45o1wzReXiVoYGP6KXEgRyfqqBpyk';
const OTHER_MINT = 'So11111111111111111111111111111111111111112';
const WEEK = 150_000_000n;
const MONTH = 500_000_000n;
const newAddress = async () => (await generateKeypair()).keypair.address;

// ---------- the verifier ----------

interface Pay {
  signature: string; wallet: string; reference: string; memo: string; amount: bigint; mint: string; receiver: string;
  /** Overrides: where the transfer goes, who the chain says owns it, its mint as the balances report it. */
  destination?: string; destOwner?: string; destMint?: string; extraDelta?: bigint;
  err?: unknown; blockTime?: number | null; signer?: boolean; withMemo?: boolean; withReference?: boolean; transfers?: number;
}

/** A payment as getTransaction (jsonParsed) returns it. */
async function paymentTx(p: Pay): Promise<ChainTx> {
  const source = await deriveAta(p.wallet, p.mint);
  const destination = p.destination ?? await deriveAta(p.receiver, p.mint);
  const keys = [
    { pubkey: p.wallet, signer: p.signer ?? true, writable: true },
    { pubkey: source, signer: false, writable: true },
    { pubkey: destination, signer: false, writable: true },
    { pubkey: p.mint, signer: false, writable: false },
    ...(p.withReference === false ? [] : [{ pubkey: p.reference, signer: false, writable: false }]),
    { pubkey: PROGRAM.token, signer: false, writable: false },
    { pubkey: PROGRAM.memo, signer: false, writable: false },
  ];
  const xfer = { programId: PROGRAM.token, program: 'spl-token', parsed: { type: 'transferChecked', info: {
    source, destination, mint: p.mint, authority: p.wallet, tokenAmount: { amount: p.amount.toString(), decimals: 6 } } } };
  const n = p.transfers ?? 1;
  return {
    blockTime: p.blockTime === undefined ? Math.floor(Date.now() / 1000) : p.blockTime,
    meta: {
      err: p.err ?? null,
      innerInstructions: [],
      preTokenBalances: [
        { accountIndex: 1, mint: p.mint, owner: p.wallet, uiTokenAmount: { amount: '1000000000' } },
        { accountIndex: 2, mint: p.destMint ?? p.mint, owner: p.destOwner ?? p.receiver, uiTokenAmount: { amount: '7' } },
      ],
      postTokenBalances: [
        { accountIndex: 1, mint: p.mint, owner: p.wallet, uiTokenAmount: { amount: (1_000_000_000n - p.amount * BigInt(n)).toString() } },
        { accountIndex: 2, mint: p.destMint ?? p.mint, owner: p.destOwner ?? p.receiver, uiTokenAmount: { amount: (7n + p.amount * BigInt(n) + (p.extraDelta ?? 0n)).toString() } },
      ],
    },
    transaction: {
      signatures: [p.signature],
      message: {
        accountKeys: keys,
        instructions: [...Array.from({ length: n }, () => xfer), ...(p.withMemo === false ? [] : [{ programId: PROGRAM.memo, program: 'spl-memo', parsed: p.memo }])],
      },
    },
  };
}

describe('verifyUsdcTx', async () => {
  const wallet = await newAddress();
  const reference = base58Encode(randomBytes(32));
  const signature = base58Encode(randomBytes(64));
  const facts: IntentFacts = { amount: WEEK.toString(), mint: USDC, receiver: RECEIVER, wallet, reference, memo: 'pokejam-ad-usdc:0123456789abcdef', createdAt: Math.floor(Date.now() / 1000) - 30 };
  const pay = (o: Partial<Pay> = {}) => paymentTx({ signature, wallet, reference, memo: facts.memo, amount: WEEK, mint: USDC, receiver: RECEIVER, ...o });

  it('accepts the exact price, and more, to the receiver USDC ATA', async () => {
    expect(await verifyUsdcTx(await pay(), signature, facts)).toMatchObject({ ok: true, paid: WEEK });
    expect(await verifyUsdcTx(await pay({ amount: WEEK + 1n }), signature, facts)).toMatchObject({ ok: true, paid: WEEK + 1n });
  });

  it('refuses the wrong mint', async () => {
    // Another SPL token sent to the receiver: its account for that mint is not the USDC ATA.
    expect(await verifyUsdcTx(await pay({ mint: OTHER_MINT }), signature, facts)).toMatchObject({ ok: false, code: 'wrong_mint' });
    // The USDC ATA's address but a balance in another mint (a forged account): still refused.
    expect(await verifyUsdcTx(await pay({ destMint: OTHER_MINT }), signature, facts)).toMatchObject({ ok: false, code: 'wrong_mint' });
  });

  it('refuses the wrong destination ATA, or one the receiver does not own', async () => {
    const elsewhere = await deriveAta(await newAddress(), USDC);
    expect(await verifyUsdcTx(await pay({ destination: elsewhere }), signature, facts)).toMatchObject({ ok: false, code: 'wrong_recipient' });
    // USDC to someone else's wallet's ATA (the receiver in the tx is not ours).
    expect(await verifyUsdcTx(await pay({ receiver: await newAddress() }), signature, facts)).toMatchObject({ ok: false, code: 'wrong_recipient' });
    expect(await verifyUsdcTx(await pay({ destOwner: await newAddress() }), signature, facts)).toMatchObject({ ok: false, code: 'wrong_recipient' });
  });

  it('refuses a short amount', async () => {
    expect(await verifyUsdcTx(await pay({ amount: WEEK - 1n }), signature, facts)).toMatchObject({ ok: false, code: 'short_amount' });
  });

  it('waits on an unconfirmed transaction and refuses a failed one', async () => {
    // null: not visible at the commitment asked for (finalized on mainnet) yet.
    expect(await verifyUsdcTx(null, signature, facts)).toMatchObject({ ok: false, code: 'pending' });
    expect(await verifyUsdcTx(await pay({ blockTime: null }), signature, facts)).toMatchObject({ ok: false, code: 'pending' });
    expect(await verifyUsdcTx(await pay({ err: { InstructionError: [0, 'Custom'] } }), signature, facts)).toMatchObject({ ok: false, code: 'tx_failed' });
  });

  it('refuses another signer, a missing memo or reference, an old transaction, two transfers, or a hidden extra', async () => {
    expect(await verifyUsdcTx(await pay(), base58Encode(randomBytes(64)), facts)).toMatchObject({ ok: false, code: 'bad_tx' });
    expect(await verifyUsdcTx(await pay({ signer: false }), signature, facts)).toMatchObject({ ok: false, code: 'wrong_signer' });
    expect(await verifyUsdcTx(await pay({ wallet: await newAddress() }), signature, facts)).toMatchObject({ ok: false, code: 'wrong_signer' });
    expect(await verifyUsdcTx(await pay({ withMemo: false }), signature, facts)).toMatchObject({ ok: false, code: 'missing_memo' });
    expect(await verifyUsdcTx(await pay({ memo: 'pokejam-ad-usdc:ffffffffffffffff' }), signature, facts)).toMatchObject({ ok: false, code: 'missing_memo' });
    expect(await verifyUsdcTx(await pay({ withReference: false }), signature, facts)).toMatchObject({ ok: false, code: 'missing_reference' });
    expect(await verifyUsdcTx(await pay({ blockTime: facts.createdAt - 3600 }), signature, facts)).toMatchObject({ ok: false, code: 'too_early' });
    expect(await verifyUsdcTx(await pay({ transfers: 2 }), signature, facts)).toMatchObject({ ok: false, code: 'multiple_transfers' });
    expect(await verifyUsdcTx(await pay({ extraDelta: 5n }), signature, facts)).toMatchObject({ ok: false, code: 'multiple_transfers' });
  });
});

describe('the receiver', () => {
  it('is kungfudoom.sns, paid in Circle USDC on mainnet, at its derived ATA', async () => {
    expect(USDC_RECEIVER).toBe(RECEIVER);
    expect(USDC_MINT['mainnet-beta']).toBe(USDC);
    const c = adsConfigLive((k) => ({ ADS_ALLOW_MAINNET: 'true' } as Record<string, string>)[k]);
    expect(c.usdc).toEqual({ mint: USDC, receiver: RECEIVER, commitment: 'finalized' });
    const ata = await deriveAta(RECEIVER, USDC);
    const t = await buildUsdcTransfer({ payer: await newAddress(), mint: USDC, receiver: RECEIVER, amount: WEEK, reference: base58Encode(randomBytes(32)), memo: 'm', blockhash: base58Encode(randomBytes(32)) });
    expect(t.destination).toBe(ata);
    // Devnet: USDC-Dev, read at confirmed. ADS_USDC_RECEIVER may name another wallet; the mint never changes.
    const d = adsConfigLive((k) => ({ ADS_PJAM_MINT: OTHER_MINT, ADS_USDC_RECEIVER: OTHER_MINT, ADS_USDC_MINT: USDC } as Record<string, string>)[k], { cluster: 'devnet' });
    expect(d.usdc).toEqual({ mint: USDC_MINT.devnet, receiver: OTHER_MINT, commitment: 'confirmed' });
    expect(() => adsConfigLive((k) => ({ ADS_ALLOW_MAINNET: 'true', ADS_USDC_RECEIVER: 'kungfudoom.sns' } as Record<string, string>)[k])).toThrow(/ADS_USDC_RECEIVER/);
  });

  it('goes to the live tables, and the devnet function has no USDC', () => {
    expect(liveDbName('pokejam_ad_usdc_pay')).toBe('pokejam_live_ad_usdc_pay');
    expect(liveDbName('pokejam_ad_board')).toBe('pokejam_live_ad_board');
    expect(liveDbName('pokejam_ad_faucet_claim')).toBe('pokejam_ad_faucet_claim');
    const dev = adsConfig((k) => ({ AD_MINT: OTHER_MINT } as Record<string, string>)[k]);
    expect(dev.usdc).toBeUndefined();
    expect(dev.dbName).toBeUndefined();
  });
});

// ---------- end to end ----------

const DIR = new URL('../../../migrations/', import.meta.url);
const MIGRATIONS = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort().map((f) => readFileSync(new URL(f, DIR), 'utf8'));

async function database() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth; create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select null::uuid $$;
    create schema extensions;
    create function extensions.gen_random_bytes(n int) returns bytea language sql volatile as $$
      select decode(string_agg(lpad(to_hex((random() * 255)::int), 2, '0'), ''), 'hex') from generate_series(1, n) $$;
    create schema realtime;
    create table realtime.messages (id serial primary key, topic text not null, extension text not null default 'broadcast', payload jsonb);
    create function realtime.topic() returns text language sql stable as $$ select current_setting('realtime.topic', true) $$;
  `);
  for (const m of MIGRATIONS) await db.exec(m);
  const called: string[] = [];
  const call = async <T>(fn: string, args: Record<string, unknown> = {}): Promise<T> => {
    called.push(fn);
    const keys = Object.keys(args);
    const r = await db.query<{ r: T }>(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`, keys.map((k) => args[k]));
    return r.rows[0].r;
  };
  return { call, called, sql: async (q: string, p: unknown[] = []) => (await db.query(q, p)).rows as Record<string, unknown>[] };
}

/** A pretend mainnet: USDC balances, the receiver's ATA, landed payments (parsed like jsonParsed) and which are finalized. */
async function chain(payer: string) {
  const receiverAta = await deriveAta(RECEIVER, USDC);
  const payerAta = await deriveAta(payer, USDC);
  const usdc = new Map<string, bigint>([[payerAta, 2_000_000_000n], [receiverAta, 0n]]);
  const owners = new Map<string, string>([[payerAta, payer], [receiverAta, RECEIVER]]);
  const txs = new Map<string, ChainTx>();
  const finalized = new Set<string>();
  const byAddress = new Map<string, string[]>();
  const sw = { lamports: 1_000_000_000, hold: false };
  const index = (sig: string, tx: ChainTx) => {
    for (const k of tx.transaction?.message?.accountKeys ?? []) {
      const a = typeof k === 'string' ? k : k.pubkey;
      byAddress.set(a, [sig, ...(byAddress.get(a) ?? [])]);
    }
  };
  /** Land a signed transaction: each TransferChecked moves USDC. */
  const land = (b64: string) => {
    const bytes = base64Decode(b64);
    const d = decodeTransaction(bytes);
    const signature = base58Encode(parseTransaction(bytes).signatures[0]);
    if (txs.has(signature)) return signature;
    const pre = new Map(usdc);
    const instructions = d.instructions.map((ix) => {
      if (ix.program === PROGRAM.memo) return { program: 'spl-memo', programId: ix.program, parsed: new TextDecoder().decode(ix.data) };
      if (ix.program === PROGRAM.token && ix.data[0] === 12) {
        const amount = new DataView(ix.data.buffer, ix.data.byteOffset + 1, 8).getBigUint64(0, true);
        const [source, mint, destination, authority] = ix.accounts;
        usdc.set(source, (usdc.get(source) ?? 0n) - amount);
        usdc.set(destination, (usdc.get(destination) ?? 0n) + amount);
        return { program: 'spl-token', programId: ix.program, parsed: { type: 'transferChecked', info: { source, mint, destination, authority, tokenAmount: { amount: amount.toString(), decimals: ix.data[9] } } } };
      }
      return { programId: ix.program };
    });
    const bal = (m: Map<string, bigint>) => d.keys.flatMap((k, accountIndex) => (owners.has(k) ? [{ accountIndex, mint: USDC, owner: owners.get(k), uiTokenAmount: { amount: (m.get(k) ?? 0n).toString() } }] : []));
    const tx: ChainTx = {
      blockTime: Math.floor(Date.now() / 1000),
      meta: { err: null, innerInstructions: [], preTokenBalances: bal(pre), postTokenBalances: bal(usdc) },
      transaction: { signatures: [signature], message: { accountKeys: d.keys.map((pubkey) => ({ pubkey, signer: d.signers.includes(pubkey), writable: d.writable.has(pubkey) })), instructions } },
    };
    txs.set(signature, tx);
    if (!sw.hold) finalized.add(signature);
    index(signature, tx);
    return signature;
  };
  const rpc: AdsDeps['rpc'] = {
    async call<T>(method: string, params: unknown[]): Promise<T> {
      const [first, opts] = params as [string, Record<string, unknown>];
      switch (method) {
        case 'getAccountInfo':
          if (first === receiverAta) return { value: { owner: PROGRAM.token } } as T;
          if (usdc.has(first)) return { value: { owner: PROGRAM.token, data: { parsed: { info: { tokenAmount: { amount: usdc.get(first)!.toString() } } } } } } as T;
          return { value: null } as T;
        case 'getBalance': return { value: sw.lamports } as T;
        case 'getTransaction': {
          const tx = txs.get(first) ?? null;
          return (tx && (opts.commitment !== 'finalized' || finalized.has(first)) ? tx : null) as T;
        }
        case 'getSignaturesForAddress': return (byAddress.get(first) ?? []).map((signature) => ({ signature, err: null, memo: null })) as T;
        default: throw new Error(`unexpected RPC ${method}`);
      }
    },
    latestBlockhash: async () => base58Encode(randomBytes(32)),
    send: async (b64: string) => land(b64),
    signatureStatus: async (sig: string) => (txs.has(sig) ? 'confirmed' : null),
    blockhashValid: async () => true,
  };
  /** Put any transaction on the chain under `sig` (a crafted one). */
  const inject = (sig: string, tx: ChainTx) => { txs.set(sig, tx); finalized.add(sig); index(sig, tx); };
  return { rpc, sw, usdc, receiverAta, finalized, inject };
}

async function setup(cfg?: AdsConfig) {
  const { keypair } = await generateKeypair();
  const db = await database();
  const ch = await chain(keypair.address);
  const config = cfg ?? adsConfigLive((k) => ({ ADS_ALLOW_MAINNET: 'true' } as Record<string, string>)[k]);
  const deps: AdsDeps = { db: db.call, rpc: ch.rpc, sleep: async () => {} };
  const post = async (body: Record<string, unknown>) => {
    const res = await adsHandler(new Request('https://x/functions/v1/pokejam-ads-live', { method: 'POST', body: JSON.stringify(body), headers: { 'cf-connecting-ip': `10.0.0.${Math.floor(Math.random() * 250)}` } }), config, deps);
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  const intent = (o: Record<string, unknown> = {}) => post({ action: 'usdc-intent', wallet: keypair.address, text: 'BUY $PJAM', theme: 'gold', plan: 'week', ...o });
  const sign = (b64: string, kp: Keypair = keypair) => signTransactionBase64(b64, kp);
  return { db, ch, post, intent, sign, wallet: keypair.address, keypair };
}

describe('usdc-intent and usdc-confirm through pokejam-ads-live', () => {
  it('books a week for $150 and a month for $500 on the live tables, with the transfer to the receiver ATA', async () => {
    const t = await setup();
    const week = await t.intent();
    expect(week.status).toBe(200);
    expect(week.body).toMatchObject({ amount: WEEK.toString(), mint: USDC, receiver: RECEIVER, receiverAta: t.ch.receiverAta, cluster: 'mainnet-beta', decimals: 6 });
    expect(week.body.intent).toMatchObject({ plan: 'week', hours: 168, status: 'open', text: 'BUY $PJAM' });
    // The unsigned transfer: the wallet signs it, TransferChecked of the price to the receiver's USDC ATA.
    const d = decodeTransaction(base64Decode(week.body.tx));
    expect(d.signers).toEqual([t.wallet]);
    const xfer = d.instructions.find((ix) => ix.program === PROGRAM.token)!;
    expect(xfer.accounts).toEqual([await deriveAta(t.wallet, USDC), USDC, t.ch.receiverAta, t.wallet, week.body.intent.reference]);
    expect(xfer.data[0]).toBe(12);

    const done = await t.post({ action: 'usdc-confirm', id: week.body.intent.id, tx: await t.sign(week.body.tx) });
    expect(done.status).toBe(200);
    expect(done.body).toMatchObject({ status: 'paid', duplicate: false, ad: { pay_method: 'usdc', plan: 'week', state: 'paid', usdc_paid: WEEK.toString() } });
    expect(t.ch.usdc.get(t.ch.receiverAta)).toBe(WEEK);

    const month = await t.intent({ plan: 'month', text: 'GM' });
    expect(month.body).toMatchObject({ amount: MONTH.toString(), intent: { plan: 'month', hours: 720 } });
    expect((await t.post({ action: 'usdc-confirm', id: month.body.intent.id, tx: await t.sign(month.body.tx) })).body).toMatchObject({ status: 'paid', ad: { plan: 'month' } });

    // Live tables only: the devnet board never sees it.
    expect(await t.db.sql('select count(*)::int as n from public.pokejam_live_ads where pay_method = $1', ['usdc'])).toEqual([{ n: 2 }]);
    expect(await t.db.sql('select count(*)::int as n from public.pokejam_ads')).toEqual([{ n: 0 }]);
    expect(t.db.called.every((fn) => fn.startsWith('pokejam_live_ad_'))).toBe(true);
    // The board offers USDC and names where it goes.
    const quote = await t.post({ action: 'quote', plan: 'month' });
    expect(quote.body).toMatchObject({ usdc: MONTH.toString(), hours: 720 });
  });

  it('runs the text filter before any intent, and checks price, balance and the receiver first', async () => {
    const t = await setup();
    const bad = await t.intent({ text: 'FREE AIRDROP CLAIM NOW' });
    expect(bad.status).toBe(400);
    expect(bad.body.reason).toBeTruthy();
    expect(bad.body.error).toMatch(/./);
    expect((await t.intent({ text: 'VISIT SCAM.COM' })).status).toBe(400);
    expect((await t.intent({ plan: 'day' })).body.error).toMatch(/week or a month/);
    expect((await t.intent({ expect: '1' })).status).toBe(409);
    t.ch.usdc.set(await deriveAta(t.wallet, USDC), WEEK - 1n);
    expect((await t.intent()).body).toMatchObject({ short: true });
    t.ch.usdc.set(await deriveAta(t.wallet, USDC), WEEK);
    t.ch.sw.lamports = 0;
    expect((await t.intent()).body).toMatchObject({ noSol: true });
    t.ch.sw.lamports = 1_000_000_000;
    expect(await t.db.sql('select count(*)::int as n from public.pokejam_live_ad_usdc_intents')).toEqual([{ n: 0 }]);
    // A burn booking can't buy a month.
    expect((await t.post({ action: 'prepare', wallet: t.wallet, text: 'GM', theme: 'gold', plan: 'month' })).status).toBe(400);
  });

  it('answers 503, with no intent, when the receiver has no USDC account', async () => {
    // A receiver no other test used, so no cached lookup of its account applies.
    const receiver = await newAddress();
    const t = await setup(adsConfigLive((k) => ({ ADS_ALLOW_MAINNET: 'true', ADS_USDC_RECEIVER: receiver } as Record<string, string>)[k]));
    expect((await t.intent()).status).toBe(503);
    expect(await t.db.sql('select count(*)::int as n from public.pokejam_live_ad_usdc_intents')).toEqual([{ n: 0 }]);
  });

  it('waits for an unconfirmed (not finalized) payment, then books it once', async () => {
    const t = await setup();
    const i = await t.intent();
    t.ch.sw.hold = true;
    const signed = await t.sign(i.body.tx);
    const first = await t.post({ action: 'usdc-confirm', id: i.body.intent.id, tx: signed });
    expect(first.status).toBe(202);
    expect(first.body.status).toBe('pending');
    expect(await t.db.sql('select count(*)::int as n from public.pokejam_live_ads')).toEqual([{ n: 0 }]);
    const sig = base58Encode(parseTransaction(base64Decode(signed)).signatures[0]);
    t.ch.finalized.add(sig);
    const paid = await t.post({ action: 'usdc-confirm', id: i.body.intent.id, signature: sig });
    expect(paid.body).toMatchObject({ status: 'paid', duplicate: false });
    // The same signature again is a harmless retry; another one for a paid intent is refused.
    expect((await t.post({ action: 'usdc-confirm', id: i.body.intent.id, signature: sig })).body).toMatchObject({ status: 'paid', duplicate: true });
    expect((await t.post({ action: 'usdc-confirm', id: i.body.intent.id, signature: base58Encode(randomBytes(64)) })).body.code).toBe('intent_done');
    expect(await t.db.sql('select count(*)::int as n from public.pokejam_live_ads')).toEqual([{ n: 1 }]);
  });

  it('finds a payment by its reference when the page lost the signature', async () => {
    const t = await setup();
    const i = await t.intent();
    expect((await t.post({ action: 'usdc-confirm', id: i.body.intent.id })).status).toBe(202);
    await t.ch.rpc.send(await t.sign(i.body.tx));
    expect((await t.post({ action: 'usdc-confirm', id: i.body.intent.id })).body).toMatchObject({ status: 'paid' });
  });

  it('never lets one signature pay for two ads', async () => {
    const t = await setup();
    const a = await t.intent();
    const b = await t.intent({ text: 'GM' });
    const paid = await t.post({ action: 'usdc-confirm', id: a.body.intent.id, tx: await t.sign(a.body.tx) });
    const sig = paid.body.intent.signature as string;
    // A's signature for B: not B's payment (its memo and reference are A's).
    expect((await t.post({ action: 'usdc-confirm', id: b.body.intent.id, signature: sig })).body).toMatchObject({ code: 'missing_reference' });
    // One transfer crafted to carry both intents' memos and references: it passes B's on-chain checks, so only the
    // database's one-signature-one-ad rule stands between it and a second ad.
    const both = base58Encode(randomBytes(64));
    const tx = await paymentTx({ signature: both, wallet: t.wallet, reference: a.body.intent.reference, memo: a.body.intent.memo, amount: WEEK, mint: USDC, receiver: RECEIVER });
    const c = await t.intent({ text: 'GN' });
    tx.transaction!.message!.accountKeys!.push({ pubkey: b.body.intent.reference, signer: false, writable: false }, { pubkey: c.body.intent.reference, signer: false, writable: false });
    tx.transaction!.message!.instructions!.push({ programId: PROGRAM.memo, parsed: b.body.intent.memo }, { programId: PROGRAM.memo, parsed: c.body.intent.memo });
    t.ch.inject(both, tx);
    expect((await t.post({ action: 'usdc-confirm', id: b.body.intent.id, signature: both })).body).toMatchObject({ status: 'paid' });
    const reused = await t.post({ action: 'usdc-confirm', id: c.body.intent.id, signature: both });
    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe('signature_used');
    // And A's first signature can't pay C either.
    expect((await t.post({ action: 'usdc-confirm', id: c.body.intent.id, signature: sig })).status).toBe(400);
    expect(await t.db.sql('select count(*)::int as n from public.pokejam_live_ads')).toEqual([{ n: 2 }]);
  });

  it('refuses a payment of the wrong token, to the wrong account, or short, and books nothing', async () => {
    const t = await setup();
    const i = await t.intent();
    const { reference, memo, id } = i.body.intent;
    const cases: [Partial<Pay>, string][] = [
      [{ mint: OTHER_MINT }, 'wrong_mint'],
      [{ destination: await deriveAta(await newAddress(), USDC) }, 'wrong_recipient'],
      [{ amount: WEEK - 1n }, 'short_amount'],
      [{ err: { InstructionError: [0, 'Custom'] } }, 'tx_failed'],
    ];
    for (const [o, code] of cases) {
      const sig = base58Encode(randomBytes(64));
      t.ch.inject(sig, await paymentTx({ signature: sig, wallet: t.wallet, reference, memo, amount: WEEK, mint: USDC, receiver: RECEIVER, ...o }));
      const r = await t.post({ action: 'usdc-confirm', id, signature: sig });
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(r.body.code).toBe(code);
    }
    expect(await t.db.sql('select count(*)::int as n from public.pokejam_live_ads')).toEqual([{ n: 0 }]);
    // A transaction that isn't this booking's isn't relayed.
    const other = await t.intent({ text: 'GM' });
    expect((await t.post({ action: 'usdc-confirm', id, tx: await t.sign(other.body.tx) })).body.code).toBe('bad_tx');
  });

  it('does not exist on the devnet pokejam-ads', async () => {
    const t = await setup(adsConfig((k) => ({ AD_MINT: OTHER_MINT } as Record<string, string>)[k]));
    expect(await t.intent()).toEqual({ status: 400, body: { error: 'unknown action' } });
    expect((await t.post({ action: 'usdc-confirm', id: crypto.randomUUID() })).body).toEqual({ error: 'unknown action' });
  });
});
