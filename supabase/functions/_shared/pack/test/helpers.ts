// Test helpers: a real Postgres (PGlite) with the payouts migration, and fetch-level fakes of Collector
// Crypt's gacha API and the Solana RPC. The fakes check every signature, so a mis-signed transaction fails.

import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { base58Decode, base58Encode, base64Decode, base64Encode, randomBytes } from '../bytes.ts';
import { MPL_CORE } from '../core-transfer.ts';
import { generateKeypair, verifySignature, type Keypair } from '../ed25519.ts';
import type { Fetch } from '../rpc.ts';
import { parseTransaction, serializeTransaction } from '../solana-tx.ts';
import type { RpcCall } from '../store.ts';
import { decodeTransaction } from '../tx-inspect.ts';
import { PROGRAM } from '../tx-guard.ts';

const MIGRATIONS = ['20261023_pokejam_pack_payouts.sql', '20261024_pokejam_pack_keep_or_sell.sql']
  .map((f) => new URL(`../../../../migrations/${f}`, import.meta.url));

/** Postgres with Supabase's roles and a stand-in auth schema, then the real migrations, in order. */
export async function testDb() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    grant usage on schema auth to anon, authenticated, service_role;
    grant usage on schema public to anon, authenticated, service_role;
  `);
  for (const m of MIGRATIONS) await db.exec(readFileSync(m, 'utf8'));
  /** Call a SQL function by name with named args, as `role` (PostgREST's sb.rpc does the same). */
  const callAs = (role: string, uid: string | null = null): RpcCall => async (fn, args) => {
    const keys = Object.keys(args);
    const params = keys.map((k) => { const v = args[k]; return v !== null && typeof v === 'object' ? JSON.stringify(v) : v; });
    const named = keys.map((k, i) => `${k} => $${i + 1}${args[k] !== null && typeof args[k] === 'object' ? '::jsonb' : ''}`).join(', ');
    return db.transaction(async (tx) => {
      await tx.exec(`set local role ${role}`);
      if (uid) await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid]);
      const r = await tx.query(`select * from public.${fn}(${named})`, params);
      return r.rows;
    });
  };
  const user = async () => {
    const id = crypto.randomUUID();
    await db.query('insert into auth.users(id) values ($1)', [id]);
    return id;
  };
  /** Run SQL as a signed-in player. */
  const asPlayer = (uid: string, sql: string, params: unknown[] = []) => db.transaction(async (tx) => {
    await tx.exec('set local role authenticated');
    await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid]);
    return (await tx.query(sql, params)).rows as Record<string, unknown>[];
  });
  return { db, service: callAs('service_role'), callAs, user, asPlayer };
}

export const sql = async (db: PGlite, q: string, p: unknown[] = []) => (await db.query(q, p)).rows as Record<string, unknown>[];

// ---------------------------------------------------------------- transactions

const compact = (n: number) => {
  const out: number[] = [];
  do { let b = n & 0x7f; n >>= 7; if (n) b |= 0x80; out.push(b); } while (n);
  return out;
};

/** A minimal transaction (no instructions) whose signers are `signers`, as real Solana wire bytes. */
export function buildTx(signers: string[]): Uint8Array {
  const keys = [...signers, base58Encode(randomBytes(32))];
  const msg = [signers.length, 0, 1, ...compact(keys.length), ...keys.flatMap((k) => [...base58Decode(k)]), ...randomBytes(32), ...compact(0)];
  return new Uint8Array([...compact(signers.length), ...new Array(64 * signers.length).fill(0), ...msg]);
}

export interface Ix { program: string; accounts: { key: string; signer?: boolean; writable?: boolean }[]; data: number[] }

const u64le = (v: bigint | number) => { let x = BigInt(v); return Array.from({ length: 8 }, () => { const b = Number(x & 0xffn); x >>= 8n; return b; }); };

/** A legacy transaction with real instructions, compiled the way Solana does (fee payer first, signers, then the rest). */
export function buildIxTx(feePayer: string, ixs: Ix[]): Uint8Array {
  const meta = new Map<string, { s: boolean; w: boolean }>();
  const add = (k: string, sg: boolean, w: boolean) => { const m = meta.get(k) ?? { s: false, w: false }; m.s ||= sg; m.w ||= w; meta.set(k, m); };
  add(feePayer, true, true);
  for (const ix of ixs) { for (const a of ix.accounts) add(a.key, !!a.signer, !!a.writable); add(ix.program, false, false); }
  const rank = (k: string) => { const m = meta.get(k)!; return k === feePayer ? 0 : m.s ? (m.w ? 1 : 2) : m.w ? 3 : 4; };
  const keys = [...meta.keys()].sort((a, b) => rank(a) - rank(b));
  const signers = keys.filter((k) => meta.get(k)!.s);
  const roSigned = signers.filter((k) => !meta.get(k)!.w).length;
  const roUnsigned = keys.filter((k) => !meta.get(k)!.s && !meta.get(k)!.w).length;
  const msg = [
    signers.length, roSigned, roUnsigned,
    ...compact(keys.length), ...keys.flatMap((k) => [...base58Decode(k)]),
    ...randomBytes(32),
    ...compact(ixs.length),
    ...ixs.flatMap((ix) => [keys.indexOf(ix.program), ...compact(ix.accounts.length), ...ix.accounts.map((a) => keys.indexOf(a.key)), ...compact(ix.data.length), ...ix.data]),
  ];
  return new Uint8Array([...compact(signers.length), ...new Array(64 * signers.length).fill(0), ...msg]);
}

export async function partialSign(tx: Uint8Array, kp: Keypair): Promise<Uint8Array> {
  const p = parseTransaction(tx);
  p.signatures[p.signers.indexOf(kp.address)] = await kp.sign(p.message);
  return serializeTransaction(p);
}

export async function allSignaturesValid(tx: Uint8Array): Promise<boolean> {
  const p = parseTransaction(tx);
  for (let i = 0; i < p.signers.length; i++) if (!(await verifySignature(p.signers[i], p.message, p.signatures[i]))) return false;
  return true;
}

function parseInstruction(message: Uint8Array) {
  let at = 3;
  const readCompact = () => { let v = 0, i = 0; for (;;) { const b = message[at++]; v |= (b & 0x7f) << (7 * i++); if (!(b & 0x80)) return v; } };
  const nKeys = readCompact();
  const keys = Array.from({ length: nKeys }, (_, i) => base58Encode(message.slice(at + i * 32, at + (i + 1) * 32)));
  at += nKeys * 32 + 32;
  readCompact();
  const program = keys[message[at++]];
  const nAcc = readCompact();
  const accounts = Array.from({ length: nAcc }, () => keys[message[at++]]);
  const nData = readCompact();
  return { program, accounts, data: [...message.slice(at, at + nData)] };
}

const reply = (id: unknown, result: unknown) => Response.json({ jsonrpc: '2.0', id, result });
const fail = (id: unknown, message: string) => Response.json({ jsonrpc: '2.0', id, error: { message } });

// ---------------------------------------------------------------- fake Solana

/** A fake RPC with a tiny ledger of Core cards (and non-Core ones, to check they're refused). */
export function fakeChain() {
  const assets = new Map<string, { owner: string; collection: string | null; core: boolean }>();
  const tokenAccounts = new Map<string, { mint: string; owner: string }>();
  const transfers: { asset: string; from: string; to: string }[] = [];
  let balance = 1e12;
  const handle: Fetch = async (_url, init) => {
    const { id, method, params } = JSON.parse(String(init?.body)) as { id: number; method: string; params: unknown[] };
    if (method === 'getTokenAccountBalance') return reply(id, { value: { amount: String(balance) } });
    if (method === 'getLatestBlockhash') return reply(id, { value: { blockhash: base58Encode(randomBytes(32)) } });
    if (method === 'getSignatureStatuses') return reply(id, { value: [{ err: null, confirmationStatus: 'confirmed' }] });
    if (method === 'getAccountInfo') {
      const t = tokenAccounts.get(String(params[0]));
      if (t) return reply(id, { value: { owner: PROGRAM.splToken, data: [base64Encode(new Uint8Array([...base58Decode(t.mint), ...base58Decode(t.owner), ...new Array(101).fill(0)])), 'base64'] } });
      const a = assets.get(String(params[0]));
      if (!a) return reply(id, { value: null });
      // A pNFT's SPL mint account starts with byte 1 too: exactly the case the Core check guards against.
      if (!a.core) return reply(id, { value: { owner: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', data: [base64Encode(new Uint8Array([1, 0, 0, 0, ...randomBytes(78)])), 'base64'] } });
      const data = new Uint8Array([1, ...base58Decode(a.owner), a.collection ? 2 : 0, ...(a.collection ? base58Decode(a.collection) : [])]);
      return reply(id, { value: { owner: MPL_CORE, data: [base64Encode(data), 'base64'] } });
    }
    if (method === 'sendTransaction') {
      const raw = base64Decode(String(params[0]));
      if (!(await allSignaturesValid(raw))) return fail(id, 'signature verification failed');
      const tx = parseTransaction(raw);
      const ix = parseInstruction(tx.message);
      if (ix.program !== MPL_CORE || ix.data.join() !== '14,0') return fail(id, 'not a Core TransferV1');
      const [asset, collection, payer, authority, to] = ix.accounts;
      const a = assets.get(asset);
      if (!a?.core) return fail(id, 'asset not found');
      if (authority !== a.owner || payer !== tx.signers[0]) return fail(id, 'authority is not the owner');
      if ((a.collection ?? MPL_CORE) !== collection) return fail(id, 'wrong collection account');
      transfers.push({ asset, from: a.owner, to });
      a.owner = to;
      return reply(id, base58Encode(tx.signatures[0]));
    }
    return fail(id, `unknown method ${method}`);
  };
  return { url: 'https://rpc.test', handle, assets, tokenAccounts, transfers, setBalance: (b: number) => { balance = b; } };
}

// ---------------------------------------------------------------- fake Collector Crypt

/** Ways a compromised Collector Crypt API could try to rob the house, for the transaction-guard tests. */
export type EvilCc = 'overcharge' | 'drain-sol' | 'fee-spike' | 'set-authority' | 'unknown-program' | 'redirect' | 'lookup-table'
  | 'buyback-steal' | 'buyback-short' | 'buyback-other-card' | 'buyback-house-pays';

export async function fakeCollectorCrypt(houseAddress: string, chain: ReturnType<typeof fakeChain>, opts: { failGenerate?: number; failOpenAfterPay?: number; card?: 'core' | 'pnft' } = {}) {
  const gacha = (await generateKeypair()).keypair;
  const rnd = () => base58Encode(randomBytes(32));
  const [houseUsdc, mint, treasury, attacker, attackerUsdc] = [rnd(), rnd(), rnd(), rnd(), rnd()];
  chain.tokenAccounts.set(houseUsdc, { mint, owner: houseAddress });
  chain.tokenAccounts.set(treasury, { mint, owner: gacha.address });
  chain.tokenAccounts.set(attackerUsdc, { mint, owner: attacker });
  const state: { evil: EvilCc | null } = { evil: null };
  const budget = (price = 20_000n) => [
    { program: PROGRAM.computeBudget, accounts: [], data: [2, ...u64le(80_000).slice(0, 4)] },
    { program: PROGRAM.computeBudget, accounts: [], data: [3, ...u64le(price)] },
  ];
  const memoIx = (memo: string) => ({ program: PROGRAM.memo, accounts: [{ key: gacha.address, signer: true }], data: [...new TextEncoder().encode(memo)] });
  /** A purchase shaped like CC's real ones (decoded from devnet), unless `state.evil` says otherwise. */
  const purchaseTx = (memo: string, price: number) => {
    const e = state.evil;
    const ixs: Ix[] = [...budget(e === 'fee-spike' ? 10n ** 12n : 20_000n), memoIx(`${memo}:open`)];
    ixs.push({ program: PROGRAM.splToken, accounts: [{ key: houseUsdc, writable: true }, { key: mint }, { key: e === 'redirect' ? attackerUsdc : treasury, writable: true }, { key: houseAddress, signer: true, writable: true }],
      data: [12, ...u64le(e === 'overcharge' ? price * 2 : price), 6] });
    if (e === 'drain-sol') ixs.push({ program: '11111111111111111111111111111111', accounts: [{ key: houseAddress, signer: true, writable: true }, { key: attacker, writable: true }], data: [2, 0, 0, 0, ...u64le(5e9)] });
    if (e === 'set-authority') ixs.push({ program: PROGRAM.splToken, accounts: [{ key: houseUsdc, writable: true }, { key: houseAddress, signer: true }], data: [6, 2, 1, ...base58Decode(attacker)] });
    if (e === 'unknown-program') ixs.push({ program: rnd(), accounts: [{ key: houseAddress, signer: true, writable: true }], data: [1] });
    let tx = buildIxTx(houseAddress, ixs);
    if (e === 'lookup-table') {
      const n = tx[0];
      tx = new Uint8Array([...tx.slice(0, 1 + n * 64), 0x80, ...tx.slice(1 + n * 64), 1, ...base58Decode(rnd()), 1, 0, 0]);
    }
    return tx;
  };
  /** A buyback shaped like CC's real ones: CC pays the fee, the house signs only the card transfer. */
  const buybackTx = (nft: string, collectionKey: string, amount: number) => {
    const e = state.evil;
    const ixs: Ix[] = [...budget(),
      { program: PROGRAM.core, accounts: [{ key: e === 'buyback-other-card' ? rnd() : nft, writable: true }, { key: collectionKey }, { key: e === 'buyback-house-pays' ? houseAddress : gacha.address, signer: true, writable: true }, { key: houseAddress, signer: true }, { key: gacha.address }, { key: PROGRAM.core }, { key: PROGRAM.core }], data: [14, 0] },
      { program: PROGRAM.ata, accounts: [{ key: gacha.address, signer: true, writable: true }, { key: houseUsdc, writable: true }, { key: houseAddress }, { key: mint }, { key: '11111111111111111111111111111111' }, { key: PROGRAM.splToken }], data: [1] },
      { program: PROGRAM.splToken, accounts: [{ key: treasury, writable: true }, { key: mint }, { key: houseUsdc, writable: true }, { key: gacha.address, signer: true }], data: [12, ...u64le(e === 'buyback-short' ? amount - 1_000_000 : amount), 6] },
    ];
    if (e === 'buyback-steal') ixs.push({ program: PROGRAM.splToken, accounts: [{ key: houseUsdc, writable: true }, { key: mint }, { key: attackerUsdc, writable: true }, { key: houseAddress, signer: true }], data: [12, ...u64le(1e9), 6] });
    ixs.push(memoIx(`${nft.slice(0, 6)}:buyback`));
    return buildIxTx(e === 'buyback-house-pays' ? houseAddress : gacha.address, ixs);
  };
  const collection = base58Encode(randomBytes(32));
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const memos = new Map<string, { paid: boolean; nft: string | null; beta: string }>();
  const machines = new Map<string, { code: string; price: number; public: boolean; instantBuyback: number; ev: number; odds: Record<string, number>; stock: Record<string, number> }>();
  for (const [code, price] of [['pokemon_25', 25], ['pokemon_50', 50], ['pokemon_100', 100]] as const) {
    machines.set(code, { code, price, public: true, instantBuyback: 85, ev: price * 1.1, odds: { common: 0.75, uncommon: 0.2, rare: 0.04, epic: 0.01 }, stock: { common: 9, uncommon: 9, rare: 9, epic: 9 } });
  }
  let failGenerate = opts.failGenerate ?? 0;
  let failOpen = opts.failOpenAfterPay ?? 0;
  let n = 0;
  const ok = (d: unknown, status = 200) => Response.json(d, { status });
  const handle: Fetch = async (url, init) => {
    const u = new URL(url);
    const body = init?.method === 'POST' ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    calls.push({ path: u.pathname, body });
    if (u.pathname === '/api/machines') return ok({ machines: [...machines.values()] });
    if (u.pathname === '/api/generatePack') {
      if (failGenerate > 0) { failGenerate--; return ok({ error: 'Machine is low', details: 'Machine is low' }, 500); }
      if (String(body.playerAddress) !== houseAddress) return ok({ error: 'wrong payer' }, 400);
      const memo = `cc-${++n}`;
      memos.set(memo, { paid: false, nft: null, beta: [...randomBytes(64)].map((b) => b.toString(16).padStart(2, '0')).join('') });
      // Like devnet: CC's gacha wallet pre-signs; the house's slot is the only empty one.
      const price = machines.get(String(body.packType))!.price * 1_000_000;
      return ok({ memo, transaction: base64Encode(await partialSign(purchaseTx(memo, price), gacha)) });
    }
    if (u.pathname === '/api/submitTransaction') {
      const raw = base64Decode(String(body.signedTransaction));
      if (!(await allSignaturesValid(raw))) return ok({ error: 'bad signatures' }, 403);
      const core = decodeTransaction(raw).instructions.find((ix) => ix.program === PROGRAM.core);
      if (core) {
        // A buyback: the card goes back to CC once the house's signature lands.
        const a = chain.assets.get(core.accounts[0]);
        if (a) a.owner = gacha.address;
      } else for (const m of memos.values()) if (!m.paid) { m.paid = true; break; }
      return ok({ success: true, signature: `sig${n}` });
    }
    if (u.pathname === '/api/openPack') {
      const m = memos.get(String(body.memo));
      if (!m?.paid) return ok({ code: 'WAITING_FOR_WEBHOOK' });
      if (failOpen > 0) { failOpen--; return ok({ error: 'processing error' }, 500); }
      if (!m.nft) {
        m.nft = base58Encode(randomBytes(32));
        chain.assets.set(m.nft, { owner: houseAddress, collection, core: (opts.card ?? 'core') === 'core' });
      }
      return ok({
        success: true, rarity: 'Uncommon', nft_address: m.nft, roll: 7870906,
        nftWon: { content: { metadata: { name: 'Garganacl', json_name: '2023 #285 Garganacl PSA 10', insuredValue: '54', attributes: [{ trait_type: 'The Grade', value: 'GEM-MT 10' }] }, files: [{ cc_cdn: 'https://dq63y5568o1bp.cloudfront.net/x' }] } },
      });
    }
    if (u.pathname === '/api/vrf/verify') {
      const m = memos.get(u.searchParams.get('memo') ?? '');
      if (!m?.nft) return ok({ error: 'not found' }, 404);
      // Devnet returns beta as 0x-prefixed hex, with named validity flags.
      return ok({ valid: true, ecvrfValid: true, selectionValid: true, memo: u.searchParams.get('memo'), beta: `0x${m.beta}` });
    }
    if (u.pathname === '/api/buyback') {
      const a = chain.assets.get(String(body.nftAddress));
      if (!a || a.owner !== String(body.playerAddress)) return ok({ error: 'not owner' }, 400);
      return ok({ serializedTransaction: base64Encode(await partialSign(buybackTx(String(body.nftAddress), a.collection ?? PROGRAM.core, 45_900_000), gacha)), refundAmount: 45_900_000, memo: `bb-${n}` });
    }
    return ok({ error: 'not found' }, 404);
  };
  return {
    url: 'https://gacha.test', handle, calls, memos, machines, gacha: gacha.address, state,
    /** What the house's CC client should be told it may sign. */
    guard: { houseUsdc, usdcMint: mint, ccSigner: gacha.address },
  };
}

/** One fetch for both fakes. */
export const route = (cc: { url: string; handle: Fetch }, chain: { url: string; handle: Fetch }): Fetch =>
  (url, init) => (url.startsWith(cc.url) ? cc.handle(url, init) : chain.handle(url, init));
