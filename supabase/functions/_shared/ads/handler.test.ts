// pokejam-ads end to end against every migration (PGlite) and a pretend Solana that parses what it's sent the way the
// RPC's jsonParsed does. The promise under test: a burn always becomes airtime, however it arrives (or doesn't),
// and the server can't be used to grief the board.
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';
import { base58Encode, base64Decode, base64Encode, randomBytes } from '../pack/bytes.ts';
import { generateKeypair, type Keypair } from '../pack/ed25519.ts';
import { parseTransaction, signTransactionBase64 } from '../pack/solana-tx.ts';
import { decodeTransaction } from '../pack/tx-inspect.ts';
import type { AdsConfig } from './config.ts';
import { adsHandler, replaceMessage, type AdsDeps, type Booking } from './handler.ts';
import { buildMessage, burnCheckedIx, memoIx, MEMO_PROGRAM, SPL_2022_PROGRAM, SPL_PROGRAM, unsignedTransaction } from './tx.ts';
import type { ParsedTransaction } from './verify.ts';

vi.setConfig({ testTimeout: 120_000 });

const DIR = new URL('../../../migrations/', import.meta.url);
const MIGRATIONS = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort().map((f) => readFileSync(new URL(f, DIR), 'utf8'));
const MINT = 'GQe9QiBBV4G6bRUCxx2JgKrzT7G7RD17FJquBWgVpump';
const OTHER_MINT = 'So11111111111111111111111111111111111111112';
const FRIEND_ACCOUNT = 'BSmgKqfYR6ChrxHn7HkkYbZwbDq5E8ZfUJxcwGCNTP4w';
const MY_ACCOUNT = '6PsAwuinQkKqTXwSSzJ8rV7efJRMkz3zweDgirpaA8QR';
const HOUR = 100_000_000_000n;
const DAY = 1_500_000_000_000n;
const H = 3_600_000;

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
  const call = async <T>(fn: string, args: Record<string, unknown> = {}): Promise<T> => {
    const keys = Object.keys(args);
    const r = await db.query<{ r: T }>(`select public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}`).join(', ')}) as r`, keys.map((k) => args[k]));
    return r.rows[0].r;
  };
  return { call, sql: async (q: string, p: unknown[] = []) => (await db.query(q, p)).rows as Record<string, unknown>[] };
}

/**
 * A pretend cluster: token balances, every transaction it was sent (parsed like jsonParsed), each address's history
 * with memos, blockhashes that expire, and switches for a node that refuses, a reply that's lost, and a transaction
 * that is sent but held back from landing.
 */
function chain(me: string, tokenProgram = SPL_2022_PROGRAM) {
  const balances = new Map<string, bigint>([[MY_ACCOUNT, 10n * DAY], [FRIEND_ACCOUNT, 10n * DAY]]);
  const lamports = new Map<string, number>([[me, 1_000_000_000]]);
  const owners = new Map<string, string>([[MY_ACCOUNT, me]]);
  const txs = new Map<string, ParsedTransaction>();
  const history = new Map<string, { signature: string; memo: string | null; err: unknown; blockTime: number }[]>();
  const sw = { refuse: '', lose: false, hold: false, expired: new Set<string>(), held: [] as string[] };
  let slot = 0;
  /** Land a transaction: burns come out of balances, a failed one lands with an error. Returns its signature. */
  const land = (b64: string, fail = false) => {
    const bytes = base64Decode(b64);
    const d = decodeTransaction(bytes);
    const first = parseTransaction(bytes).signatures[0];
    const signature = base58Encode(first.some((x) => x) ? first : randomBytes(64));
    if (txs.has(signature)) return signature;
    const instructions = d.instructions.map((ix) => {
      if (ix.program === MEMO_PROGRAM) return { program: 'spl-memo', programId: ix.program, parsed: new TextDecoder().decode(ix.data) };
      if ((ix.program === SPL_2022_PROGRAM || ix.program === SPL_PROGRAM) && ix.data[0] === 15) {
        const amount = new DataView(ix.data.buffer, ix.data.byteOffset + 1, 8).getBigUint64(0, true);
        if (!fail) balances.set(ix.accounts[0], (balances.get(ix.accounts[0]) ?? 0n) - amount);
        return { program: 'spl-token', programId: ix.program, parsed: { type: 'burnChecked', info: { account: ix.accounts[0], mint: ix.accounts[1], authority: ix.accounts[2], tokenAmount: { amount: amount.toString() } } } };
      }
      return { programId: ix.program };
    });
    const blockTime = Math.floor(Date.now() / 1000);
    txs.set(signature, { slot: ++slot, blockTime, meta: { err: fail ? { InstructionError: [0, 'Custom'] } : null, innerInstructions: [] },
      transaction: { signatures: [signature], message: { accountKeys: d.keys.map((k) => ({ pubkey: k, signer: d.signers.includes(k) })), instructions } } });
    const memo = instructions.filter((i) => i.programId === MEMO_PROGRAM).map((i) => `[${String((i as { parsed: string }).parsed.length)}] ${(i as { parsed: string }).parsed}`).join('; ') || null;
    for (const k of new Set(d.keys)) history.set(k, [{ signature, memo, err: fail ? {} : null, blockTime }, ...(history.get(k) ?? [])]);
    return signature;
  };
  const rpc: AdsDeps['rpc'] = {
    latestBlockhash: async () => base58Encode(randomBytes(32)),
    blockhashValid: async (bh: string) => !sw.expired.has(bh),
    signatureStatus: async (sig: string) => (txs.has(sig) ? (txs.get(sig)!.meta!.err ? 'failed' : 'confirmed') : null),
    send: async (b64: string) => {
      if (sw.refuse) throw new Error(`RPC sendTransaction: ${sw.refuse}`);
      if (sw.hold) { sw.held.push(b64); return base58Encode(parseTransaction(base64Decode(b64)).signatures[0]); }
      const sig = land(b64);
      if (sw.lose) throw new Error('RPC sendTransaction: HTTP 504');
      return sig;
    },
    async call<T>(method: string, params: unknown[]): Promise<T> {
      const p = params as [string, Record<string, unknown>];
      switch (method) {
        case 'getAccountInfo': return { value: { owner: tokenProgram, data: { parsed: { info: { decimals: 6, supply: '952243314036358' } } } } } as T;
        case 'getTokenAccountsByOwner': {
          const accts = [...owners].filter(([, o]) => o === p[0]).map(([a]) => a);
          return { value: p[1].mint === MINT ? accts.map((a) => ({ pubkey: a, account: { data: { parsed: { info: { tokenAmount: { amount: String(balances.get(a)) } } } } } })) : [] } as T;
        }
        case 'getBalance': return { value: lamports.get(p[0]) ?? 0 } as T;
        case 'getTransaction': return (txs.get(p[0]) ?? null) as T;
        case 'getSignaturesForAddress': {
          const opts = (p[1] ?? {}) as { limit?: number; before?: string; until?: string };
          let list = history.get(p[0]) ?? [];
          if (opts.until) { const i = list.findIndex((s) => s.signature === opts.until); if (i >= 0) list = list.slice(0, i); }
          if (opts.before) { const i = list.findIndex((s) => s.signature === opts.before); list = i >= 0 ? list.slice(i + 1) : []; }
          return list.slice(0, opts.limit ?? 1000) as T;
        }
        default: throw new Error(`unexpected ${method}`);
      }
    },
  };
  return { rpc, land, balances, lamports, txs, sw, owners };
}

const CFG: AdsConfig = { cluster: 'devnet', rpcUrl: '', mint: MINT, origins: [], priorityMicroLamports: 0, faucetSecret: undefined, faucetAmount: 25_000_000_000_000n, serviceKey: 'svc' };

async function setup(cfg: Partial<AdsConfig> = {}, tokenProgram = SPL_2022_PROGRAM) {
  const { keypair: me } = await generateKeypair();
  const c = chain(me.address, tokenProgram);
  const alerts: string[] = [];
  const db = await database();
  const deps: AdsDeps = { db: db.call, rpc: c.rpc, sleep: async () => {}, alert: async (t) => { alerts.push(t); } };
  let ip = '1.1.1.1';
  const call = async (body: Record<string, unknown>, headers: Record<string, string> = {}) => {
    const res = await adsHandler(new Request('https://x/', { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': ip, ...headers }, body: JSON.stringify(body) }), { ...CFG, ...cfg }, deps);
    return { status: res.status, body: (await res.json()) as Record<string, any> };
  };
  const prepare = (over: Record<string, unknown> = {}) => call({ action: 'prepare', wallet: me.address, text: 'catch em all', theme: 'fire', plan: 'day', ...over });
  const sign = (b64: string, kp: Keypair = me) => signTransactionBase64(b64, kp);
  const sweep = () => call({ action: 'sweep' }, { authorization: 'Bearer svc' });
  return { ...c, me, deps, db, call, prepare, sign, sweep, alerts, setIp: (x: string) => { ip = x; } };
}

/** A burn crafted by hand: any memo, mint, amount and burner. */
async function crafted(owner: Keypair, account: string, code: string, amount: bigint, mint = MINT, program = SPL_2022_PROGRAM) {
  const { message } = buildMessage(owner.address, [burnCheckedIx(program, account, mint, owner.address, amount, 6), memoIx(`pokejam-ad:${code}`)], base58Encode(randomBytes(32)));
  return signTransactionBase64(base64Encode(unsignedTransaction(message, 1)), owner);
}

const run = (b: Booking) => Date.parse(b.ends_at!) - Date.parse(b.starts_at!);
const blockhashOf = (b64: string) => parseTransaction(base64Decode(b64)).recentBlockhash;

describe('a burn always becomes airtime', () => {
  it('relayed: prepare, sign, send, check, on the board', async () => {
    const t = await setup();
    const p = await t.prepare();
    expect(p.status).toBe(200);
    const b = p.body.booking as Booking;
    expect(b).toMatchObject({ state: 'pending', text: 'CATCH EM ALL', price: String(DAY) });
    expect(decodeTransaction(base64Decode(p.body.tx)).signers).toEqual([t.me.address]);
    const signed = await t.sign(p.body.tx);
    const r = await t.call({ action: 'confirm', id: b.id, tx: signed });
    expect(r.body.booking).toMatchObject({ state: 'paid', moved: false });
    expect(run(r.body.booking)).toBe(24 * H);
    expect(t.balances.get(MY_ACCOUNT)).toBe(9n * DAY);
    const board = await t.call({ action: 'board' });
    expect(board.body.live.map((a: { text: string }) => a.text)).toEqual(['CATCH EM ALL']);
    expect(board.body).toMatchObject({ cluster: 'devnet', mint: MINT, decimals: 6, totals: { burned: String(DAY), ads: 1 } });
    // Asking again, or sending the same signed burn again, changes nothing.
    expect((await t.call({ action: 'confirm', id: b.id, tx: signed })).body.booking.id).toBe(b.id);
    expect(t.balances.get(MY_ACCOUNT)).toBe(9n * DAY);
  });

  it('sent by the wallet: the signature settles it', async () => {
    const t = await setup();
    const p = await t.prepare({ plan: 'hour' });
    const sig = t.land(await t.sign(p.body.tx));
    expect((await t.call({ action: 'confirm', id: p.body.booking.id, signature: sig })).body.booking.state).toBe('paid');
  });

  it("the node's reply is lost after it sent the burn: still found and paid", async () => {
    const t = await setup();
    const p = await t.prepare({ plan: 'hour' });
    t.sw.lose = true;
    const r = await t.call({ action: 'confirm', id: p.body.booking.id, tx: await t.sign(p.body.tx) });
    expect(r.body.booking.state).toBe('paid');
  });

  it('the page closed mid-burn: found by its memo when the page comes back, or when the wallet connects anywhere', async () => {
    const t = await setup();
    const a = await t.prepare({ plan: 'hour' });
    t.land(await t.sign(a.body.tx));
    expect((await t.call({ action: 'confirm', id: a.body.booking.id })).body.booking.state).toBe('paid');
    const b = await t.prepare({ plan: 'hour', text: 'second' });
    t.land(await t.sign(b.body.tx));
    const mine = await t.call({ action: 'mine', wallet: t.me.address });
    expect(mine.body.ads.map((x: Booking) => [x.text, x.state])).toEqual([['SECOND', 'paid'], ['CATCH EM ALL', 'paid']]);
  });

  it('nobody ever comes back: the sweeper finds it in the mint history', async () => {
    const t = await setup();
    const p = await t.prepare({ plan: 'hour' });
    t.land(await t.sign(p.body.tx));
    expect((await t.call({ action: 'sweep' })).status).toBe(401);
    expect((await t.sweep()).body).toMatchObject({ burns: 1, paid: 1 });
    expect((await t.call({ action: 'board' })).body.live).toHaveLength(1);
    // The next run only looks at what's new.
    expect((await t.sweep()).body).toMatchObject({ scanned: 0, burns: 0, paid: 0 });
  });

  it('spam bookings cannot crowd a real burn out of the sweeper', async () => {
    const t = await setup();
    const real = await t.prepare({ plan: 'hour', text: 'real' });
    for (let i = 0; i < 40; i++) {
      await t.db.call('pokejam_ad_create', { p_wallet: base58Encode(randomBytes(32)), p_text: 'SPAM', p_theme: 'gold', p_plan: 'week', p_start: null });
    }
    t.land(await t.sign(real.body.tx));
    expect((await t.sweep()).body).toMatchObject({ paid: 1 });
  });

  it('someone else pays for the ad: it still runs', async () => {
    const t = await setup();
    const p = await t.prepare({ plan: 'hour' });
    const { keypair: friend } = await generateKeypair();
    t.owners.set(FRIEND_ACCOUNT, friend.address);
    const sig = t.land(await crafted(friend, FRIEND_ACCOUNT, p.body.booking.code, HOUR));
    expect((await t.call({ action: 'confirm', id: p.body.booking.id, signature: sig })).body.booking.state).toBe('paid');
  });

  it('a short or a long hand-made burn buys its share; a second burn adds a run straight after', async () => {
    const t = await setup();
    const p = await t.prepare({ plan: 'day' });
    const code = p.body.booking.code;
    const half = await t.call({ action: 'confirm', id: p.body.booking.id, signature: t.land(await crafted(t.me, MY_ACCOUNT, code, DAY / 2n)) });
    expect(half.body.booking.state).toBe('paid');
    expect(run(half.body.booking)).toBe(12 * H);
    const more = await t.call({ action: 'confirm', id: p.body.booking.id, signature: t.land(await crafted(t.me, MY_ACCOUNT, code, DAY)) });
    expect(more.body.booking).toMatchObject({ state: 'paid', extra_of: p.body.booking.id });
    expect(Date.parse(more.body.booking.starts_at)).toBe(Date.parse(half.body.booking.ends_at));
    expect(run(more.body.booking)).toBe(24 * H);
  });

  it('the sweeper pays a second burn too, and never pays one twice', async () => {
    const t = await setup();
    const p = await t.prepare({ plan: 'hour' });
    const signed = await t.sign(p.body.tx);
    t.land(signed);
    t.land(await crafted(t.me, MY_ACCOUNT, p.body.booking.code, HOUR));
    expect((await t.sweep()).body).toMatchObject({ burns: 2, paid: 2 });
    t.land(signed); // the very same transaction again: same signature, nothing new
    expect((await t.sweep()).body).toMatchObject({ paid: 0 });
    const ads = (await t.call({ action: 'mine', wallet: t.me.address })).body.ads as Booking[];
    expect(ads.filter((a) => a.state === 'paid')).toHaveLength(2);
  });

  it('a burn that lands after the page gave up waiting is still paid', async () => {
    const t = await setup();
    const p = await t.prepare({ plan: 'hour' });
    t.sw.hold = true;
    const first = await t.call({ action: 'confirm', id: p.body.booking.id, tx: await t.sign(p.body.tx) });
    expect(first.body).toMatchObject({ landing: true, booking: { state: 'pending' } });
    t.land(t.sw.held[0]);
    expect((await t.sweep()).body.paid).toBe(1);
  });
});

describe('telling the advertiser the truth when nothing was burned', () => {
  it('the node refuses it (not enough funds, an expired blockhash): nothing burned, and it says so', async () => {
    const t = await setup();
    const p = await t.prepare();
    t.sw.refuse = 'Transaction simulation failed: Error processing Instruction 0: insufficient funds';
    const r = await t.call({ action: 'confirm', id: p.body.booking.id, tx: await t.sign(p.body.tx) });
    expect(r).toMatchObject({ status: 400, body: { notBurned: true } });
    expect(r.body.error).toMatch(/nothing was burned: Transaction simulation failed/);
    expect(t.balances.get(MY_ACCOUNT)).toBe(10n * DAY);
  });

  it('it never lands before its blockhash expires: nothing burned, and it says so', async () => {
    const t = await setup();
    const p = await t.prepare();
    t.sw.hold = true;
    const signed = await t.sign(p.body.tx);
    t.sw.expired.add(blockhashOf(signed));
    const r = await t.call({ action: 'confirm', id: p.body.booking.id, tx: signed });
    expect(r.body).toMatchObject({ expired: true, booking: { state: 'pending' } });
    expect(r.body.error).toMatch(/nothing was burned/);
  });

  it('it landed but failed on-chain: nothing burned, and it says so', async () => {
    const t = await setup();
    const p = await t.prepare();
    const r = await t.call({ action: 'confirm', id: p.body.booking.id, signature: t.land(await t.sign(p.body.tx), true) });
    expect(r).toMatchObject({ status: 400, body: { notBurned: true } });
  });
});

describe("burns that aren't for this ad", () => {
  it('another token, another program, or another booking', async () => {
    const t = await setup();
    const [a, b] = [await t.prepare(), await t.prepare({ text: 'other' })];
    for (const [tx, why] of [
      [await crafted(t.me, MY_ACCOUNT, b.body.booking.code, DAY, OTHER_MINT), /no burn of the token/],
      [await crafted(t.me, MY_ACCOUNT, b.body.booking.code, DAY, MINT, SPL_PROGRAM), /no burn of the token/],
      [await t.sign(a.body.tx), /memo does not name this booking/],
    ] as const) {
      const r = await t.call({ action: 'confirm', id: b.body.booking.id, signature: t.land(tx) });
      expect(r.status).toBe(400);
      expect(r.body.error).toMatch(why);
    }
    expect((await t.call({ action: 'confirm', id: b.body.booking.id })).body.booking.state).toBe('pending');
  });

  it("won't relay a transaction that isn't this booking's burn", async () => {
    const t = await setup();
    const [a, b] = [await t.prepare(), await t.prepare({ text: 'other' })];
    const r = await t.call({ action: 'confirm', id: b.body.booking.id, tx: await t.sign(a.body.tx) });
    expect(r).toMatchObject({ status: 400, body: { error: 'That transaction is not the burn for this booking.' } });
    expect((await t.call({ action: 'confirm', id: b.body.booking.id, tx: 'AAAA' })).body.error).toBe('That is not a transaction.');
    expect(t.txs.size).toBe(0);
  });
});

describe('refused before anything is burned', () => {
  it('not enough $PJAM or SOL, bad text, bad plan, no wallet, a price that changed, a banned wallet', async () => {
    const t = await setup();
    t.balances.set(MY_ACCOUNT, DAY);
    expect(await t.prepare({ plan: 'week' })).toMatchObject({ status: 400, body: { short: true, balance: String(DAY), price: '7500000000000' } });
    expect(await t.prepare({ text: 'f u c k' })).toMatchObject({ status: 400, body: { reason: 'offensive', error: "That isn't allowed on the board." } });
    expect(await t.prepare({ text: 'FREE SOL' })).toMatchObject({ status: 400, body: { reason: 'scam' } });
    expect(await t.prepare({ text: 'PJAM.XYZ' })).toMatchObject({ status: 400, body: { reason: 'link' } });
    expect((await t.prepare({ wallet: 'nope' })).body.error).toBe('Connect a Solana wallet first.');
    expect((await t.prepare({ plan: 'month' })).body.error).toBe('Pick an hour, a day or a week.');
    expect((await t.prepare({ theme: 'rainbow' })).body.error).toBe('Pick a colour.');
    expect(await t.prepare({ expect: '1' })).toMatchObject({ status: 409, body: { price: String(DAY) } });
    t.lamports.set(t.me.address, 0);
    expect((await t.prepare()).body).toMatchObject({ noSol: true });
    t.lamports.set(t.me.address, 1e9);
    await t.db.sql(`insert into public.pokejam_ad_bans(wallet, reason) values ($1, 'abuse')`, [t.me.address]);
    expect((await t.prepare()).body.error).toMatch(/banned/);
    expect(t.txs.size).toBe(0);
  });

  it('the live text check gives the same verdict as booking', async () => {
    const t = await setup();
    expect((await t.call({ action: 'check', text: 'HOLD $PJAM' })).body).toEqual({ ok: true, reason: null, message: null });
    expect((await t.call({ action: 'check', text: 'sh1t coin' })).body).toMatchObject({ ok: false, reason: 'offensive' });
    expect((await t.call({ action: 'check', text: 'T.ME/PJAM' })).body.message).toMatch(/@handle or \$ticker/);
  });
});

describe('moderation keeps the advertiser whole', () => {
  it('a removed ad can get new text, signed by its own wallet only', async () => {
    const t = await setup();
    const p = await t.prepare();
    const paid = (await t.call({ action: 'confirm', id: p.body.booking.id, tx: await t.sign(p.body.tx) })).body.booking as Booking;
    await t.db.call('pokejam_ad_remove', { p_id: paid.id, p_reason: 'rude', p_ban: false });
    const msg = (text: string, theme: string) => new TextEncoder().encode(replaceMessage(paid.id, text, theme));
    const { keypair: stranger } = await generateKeypair();
    const forged = await t.call({ action: 'replace', id: paid.id, text: 'MINE NOW', theme: 'ice', signature: base58Encode(await stranger.sign(msg('MINE NOW', 'ice'))) });
    expect(forged.status).toBe(403);
    // Signed for different text than was sent: refused too.
    const swapped = await t.call({ action: 'replace', id: paid.id, text: 'SOMETHING ELSE', theme: 'ice', signature: base58Encode(await t.me.sign(msg('NICE NOW', 'ice'))) });
    expect(swapped.status).toBe(403);
    const bad = await t.call({ action: 'replace', id: paid.id, text: 'F U C K', theme: 'ice', signature: base58Encode(await t.me.sign(msg('F U C K', 'ice'))) });
    expect(bad.body.reason).toBe('offensive');
    const ok = await t.call({ action: 'replace', id: paid.id, text: 'NICE NOW', theme: 'ice', signature: base58Encode(await t.me.sign(msg('NICE NOW', 'ice'))) });
    expect(ok.body.booking).toMatchObject({ state: 'paid', text: 'NICE NOW', theme: 'ice', replaces: paid.id });
    expect((await t.call({ action: 'board' })).body.live.map((a: Booking) => a.text)).toEqual(['NICE NOW']);
  });

  it('reports reach moderators, never take an ad down, and one person counts once', async () => {
    const t = await setup();
    const p = await t.prepare();
    const paid = (await t.call({ action: 'confirm', id: p.body.booking.id, tx: await t.sign(p.body.tx) })).body.booking as Booking;
    for (let i = 0; i < 5; i++) expect((await t.call({ action: 'report', id: paid.id, reason: 'offensive' })).status).toBe(200);
    for (const ip of ['2.2.2.2', '3.3.3.3']) { t.setIp(ip); await t.call({ action: 'report', id: paid.id, reason: 'scam' }); }
    expect(t.alerts).toHaveLength(2);
    expect(t.alerts[1]).toMatch(/3 people/);
    expect((await t.call({ action: 'board' })).body.live).toHaveLength(1);
    expect((await t.call({ action: 'report', id: paid.id, reason: 'because' })).body.error).toBe('Pick a reason.');
  });
});

describe('griefing the server', () => {
  it('rate-limits each action per caller', async () => {
    const t = await setup();
    for (let i = 0; i < 30; i++) expect((await t.prepare({ wallet: 'nope' })).status).toBe(400);
    expect((await t.prepare()).status).toBe(429);
    t.setIp('9.9.9.9');
    expect((await t.prepare()).status).toBe(200);
    const statuses = [];
    for (let i = 0; i < 125; i++) statuses.push((await t.call({ action: 'check', text: 'HI' })).status);
    expect(statuses.filter((s) => s === 429).length).toBe(5);
  });

  it('the devnet faucet: off without a key, once a day per wallet, a few a day per caller', async () => {
    const off = await setup();
    expect((await off.call({ action: 'faucet', wallet: off.me.address })).status).toBe(404);
    const { secret } = await generateKeypair();
    const t = await setup({ faucetSecret: secret });
    const r = await t.call({ action: 'faucet', wallet: t.me.address });
    expect(r.status).toBe(200);
    expect(r.body.amount).toBe('25000000000000');
    expect((await t.call({ action: 'faucet', wallet: t.me.address })).status).toBe(429);
    await t.call({ action: 'faucet', wallet: base58Encode(randomBytes(32)) });
    expect((await t.call({ action: 'faucet', wallet: base58Encode(randomBytes(32)) })).body.error).toMatch(/Too many requests/);
  });
});
