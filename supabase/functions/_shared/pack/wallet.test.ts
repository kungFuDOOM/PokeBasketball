// The chain side of Pack Battles deposits and withdrawals (wallet.ts), on a real Postgres (PGlite) running every
// migration, with a fake Solana RPC and real Ed25519 keys: proving a wallet, reading deposits out of landed
// transactions, the scan's cursor, and every way a withdrawal can go (sent, lost reply, refused, expired, short).
import { describe, expect, it, vi } from 'vitest';
import { MEMO_PROGRAM, SPL_PROGRAM, associatedAccount } from '../ads/tx.ts';
import { base58Encode, base64Encode } from './bytes.ts';
import { realMoneyRefusal } from './config.ts';
import { generateKeypair, verifySignature, type Keypair } from './ed25519.ts';
import { parseTransaction } from './solana-tx.ts';
import { fullDb } from './test/full-db.ts';
import { buildDeposit, buildWithdrawal, depositsIn, runWithdrawals, scanDeposits, walletHandler, withdrawalMemo, type LandedTx, type MoneyDeps } from './wallet.ts';

vi.setConfig({ testTimeout: 60_000 });

const USDC = 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr';
const HOUSE_USDC = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
const quiet = { info: () => {}, warn: () => {}, error: () => {} };
const randomSig = () => base58Encode(crypto.getRandomValues(new Uint8Array(64)));

async function testDb() {
  const t = await fullDb();
  const player = async () => ({ ...(await t.player()), kp: (await generateKeypair()).keypair });
  return { ...t, player };
}
type Db = Awaited<ReturnType<typeof testDb>>;
type Player = Awaited<ReturnType<Db['player']>>;

/** A fake Solana RPC: transactions by signature, the house account's history, and what sends do. */
function fakeRpc(house: Keypair) {
  const txs = new Map<string, LandedTx>();
  const history: { signature: string; err: unknown; slot: number }[] = []; // newest first
  const statuses = new Map<string, 'confirmed' | 'failed' | 'processed'>();
  const sent: string[] = [];
  const s = { usdc: 1_000_000_000, lamports: 1_000_000_000, blockhashValid: false, sendMode: 'land' as 'land' | 'lose' | 'refuse' | 'fail-on-chain' };
  const rpc: MoneyDeps['rpc'] = {
    accountInfo: async (a) => a === USDC ? { owner: SPL_PROGRAM, data: base64Encode(new Uint8Array([...new Array(44).fill(0), 6, 1, 0])) }
      : a === HOUSE_USDC ? { owner: SPL_PROGRAM, data: base64Encode(new Uint8Array([...new Array(32).fill(0), ...new Array(133).fill(0)])) } : null,
    parsedTransaction: async <T>(sig: string) => (txs.get(sig) ?? null) as T | null,
    signaturesFor: async (_addr, o) => {
      let list = history;
      if (o.before) list = list.slice(list.findIndex((x) => x.signature === o.before) + 1);
      if (o.until) { const i = list.findIndex((x) => x.signature === o.until); if (i >= 0) list = list.slice(0, i); }
      return list.slice(0, o.limit ?? 1000);
    },
    latestBlockhash: async () => base58Encode(crypto.getRandomValues(new Uint8Array(32))),
    send: async (b64) => {
      const tx = parseTransaction(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
      const sig = base58Encode(tx.signatures[0]);
      if (s.sendMode === 'refuse') throw new Error('RPC sendTransaction: Transaction simulation failed: insufficient funds');
      sent.push(b64);
      if (s.sendMode === 'lose') { statuses.set(sig, 'processed'); throw new Error('RPC sendTransaction: HTTP 502'.replace('RPC sendTransaction: ', 'fetch failed: ')); }
      statuses.set(sig, s.sendMode === 'fail-on-chain' ? 'failed' : 'confirmed');
      return sig;
    },
    confirm: async (sig) => {
      if (statuses.get(sig) === 'failed') throw new Error(`transaction ${sig} failed`);
      return statuses.get(sig) === 'confirmed';
    },
    signatureStatus: async (sig) => statuses.get(sig) ?? null,
    blockhashValid: async () => s.blockhashValid,
    tokenBalance: async () => s.usdc,
    balance: async () => s.lamports,
  };
  /** A finalized transfer of `amount` USDC into the house account, signed by `from`, added to the history. */
  const deposit = (from: string, amount: number, o: { mint?: string; to?: string; err?: unknown; houseSigns?: boolean; inner?: boolean; plain?: boolean; unlisted?: boolean } = {}) => {
    const signature = randomSig();
    const transfer = { programId: SPL_PROGRAM, parsed: o.plain
      ? { type: 'transfer', info: { source: 'src', destination: o.to ?? HOUSE_USDC, authority: from, amount: String(amount) } }
      : { type: 'transferChecked', info: { source: 'src', destination: o.to ?? HOUSE_USDC, mint: o.mint ?? USDC, authority: from, tokenAmount: { amount: String(amount) } } } };
    const memo = { programId: MEMO_PROGRAM, parsed: 'pokejam-deposit' };
    txs.set(signature, {
      slot: history.length + 1, blockTime: 1_800_000_000,
      meta: { err: o.err ?? null, innerInstructions: o.inner ? [{ index: 0, instructions: [transfer] }] : [] },
      transaction: { signatures: [signature], message: {
        accountKeys: [{ pubkey: from, signer: true }, ...(o.houseSigns ? [{ pubkey: house.address, signer: true }] : [])],
        instructions: o.inner ? [{ programId: 'SomeRouter111111111111111111111111111111111' }, memo] : [transfer, memo],
      } },
    });
    if (!o.unlisted) history.unshift({ signature, err: o.err ?? null, slot: history.length + 1 });
    return signature;
  };
  return { rpc, s, txs, history, statuses, sent, deposit };
}

async function setup() {
  const t = await testDb();
  const house = (await generateKeypair()).keypair;
  const chain = fakeRpc(house);
  const d: MoneyDeps = { call: t.call, rpc: chain.rpc, house, houseUsdcAccount: HOUSE_USDC, usdcMint: USDC, priorityMicroLamports: 0, log: quiet };
  /** Link a player's wallet the whole way: challenge, sign with the wallet's key, prove over HTTP. */
  const prove = async (p: Player, signer: Keypair = p.kp) => {
    const msg = (await p.as('select public.pokejam_pack_wallet_challenge($1) as m', [p.kp.address]))[0].m as string;
    const signature = base58Encode(await signer.sign(new TextEncoder().encode(msg)));
    return post({ action: 'prove', wallet: p.kp.address, signature }, p.id);
  };
  const post = async (body: unknown, user: string | null, auth = user ? `jwt-${user}` : '') => {
    const res = await walletHandler(new Request('https://fn.test', { method: 'POST', headers: { authorization: `Bearer ${auth}`, origin: 'https://test.site' }, body: JSON.stringify(body) }),
      { origins: ['https://test.site'], serviceKey: 'service-key', cluster: 'devnet' },
      { ...d, userOf: async (jwt) => (jwt.startsWith('jwt-') ? jwt.slice(4) : null), runAll: async () => ({ deposits: await scanDeposits(d), withdrawals: await runWithdrawals(d) }) });
    return { status: res.status, body: await res.json() as Record<string, any> };
  };
  return { t, house, chain, d, prove, post };
}

describe('proving a wallet', () => {
  it("links a wallet only with its own signature over this player's challenge", async () => {
    const s = await setup();
    const p = await s.t.player();
    const stranger = (await generateKeypair()).keypair;
    expect(await s.prove(p, stranger)).toMatchObject({ status: 400, body: { error: "That signature isn't from this wallet." } });
    expect(await s.t.call('pokejam_pack_wallet_of', { p_user: p.id })).toBeNull();
    expect(await s.prove(p)).toMatchObject({ status: 200, body: { wallet: p.kp.address } });
    expect(await s.t.call('pokejam_pack_wallet_of', { p_user: p.id })).toBe(p.kp.address);
    // The challenge was used up.
    expect((await s.post({ action: 'prove', wallet: p.kp.address, signature: randomSig() }, p.id)).body.error).toMatch(/expired/);
  });

  it('needs a session for player actions and the service key for the cron', async () => {
    const s = await setup();
    expect((await s.post({ action: 'deposit', amount: 5 }, null)).status).toBe(401);
    expect((await s.post({ action: 'run' }, null, 'jwt-someone')).status).toBe(401);
    expect((await s.post({ action: 'run' }, null, 'service-key')).status).toBe(200);
    const p = await s.t.player();
    expect((await s.post({ action: 'deposit', amount: 5_000_000 }, p.id)).body.error).toMatch(/Link your wallet first/);
  });
});

describe('deposits', () => {
  it('builds a deposit the wallet signs: its own USDC account to the house, nothing else', async () => {
    const s = await setup();
    const p = await s.t.player();
    await s.prove(p);
    const r = await s.post({ action: 'deposit', amount: '25000000' }, p.id);
    const tx = parseTransaction(Uint8Array.from(atob(r.body.tx), (c) => c.charCodeAt(0)));
    expect(tx.signers).toEqual([p.kp.address]);
    expect(tx.accountKeys).toEqual(expect.arrayContaining([HOUSE_USDC, USDC, await associatedAccount(p.kp.address, USDC, SPL_PROGRAM), SPL_PROGRAM, MEMO_PROGRAM]));
    expect(tx.accountKeys).not.toContain(s.house.address);
    expect(await buildDeposit({ wallet: p.kp.address, houseUsdcAccount: HOUSE_USDC, usdcMint: USDC, amount: 1n, decimals: 6, recentBlockhash: tx.recentBlockhash, priorityMicroLamports: 0 }))
      .toBeTruthy();
  });

  it('reads only finalized USDC transfers into the house account, and never the house\'s own', async () => {
    const s = await setup();
    const house = { address: s.house.address, usdcAccount: HOUSE_USDC, usdcMint: USDC };
    const from = (await generateKeypair()).keypair.address;
    const tx = (sig: string) => s.chain.txs.get(sig)!;
    expect(depositsIn(tx(s.chain.deposit(from, 5_000_000)), house)).toMatchObject([{ sender: from, amount: 5_000_000n }]);
    expect(depositsIn(tx(s.chain.deposit(from, 5_000_000, { plain: true })), house)).toHaveLength(1);
    const inner = s.chain.deposit(from, 7_000_000, { inner: true });
    expect(depositsIn(tx(inner), house)).toMatchObject([{ ref: `${inner}:0.0`, amount: 7_000_000n }]);
    expect(depositsIn(tx(s.chain.deposit(from, 5_000_000, { mint: 'FakeUsdc1111111111111111111111111111111111' })), house)).toEqual([]);
    expect(depositsIn(tx(s.chain.deposit(from, 5_000_000, { to: 'SomeoneElse11111111111111111111111111111111' })), house)).toEqual([]);
    expect(depositsIn(tx(s.chain.deposit(from, 5_000_000, { err: { InstructionError: [0, 'Custom'] } })), house)).toEqual([]);
    expect(depositsIn(tx(s.chain.deposit(from, 5_000_000, { houseSigns: true })), house)).toEqual([]);
    expect(depositsIn(null, house)).toEqual([]);
  });

  it('credits a claimed deposit once it is finalized, once, and the scan agrees', async () => {
    const s = await setup();
    const p = await s.t.player();
    await s.prove(p);
    const sig = s.chain.deposit(p.kp.address, 30_000_000, { unlisted: true });
    const landed = s.chain.txs.get(sig)!;
    s.chain.txs.delete(sig);
    expect((await s.post({ action: 'claim', signature: sig }, p.id)).body).toMatchObject({ state: 'pending', credited: 0 }); // not finalized yet
    s.chain.txs.set(sig, landed);
    expect((await s.post({ action: 'claim', signature: sig }, p.id)).body).toMatchObject({ state: 'recorded', credited: 30_000_000 });
    expect((await s.post({ action: 'claim', signature: sig }, p.id)).body).toMatchObject({ state: 'recorded', credited: 30_000_000 });
    expect(await p.balance()).toBe(30_000_000);
    // The scan finds the same transfer in the house's history and records nothing new.
    s.chain.history.unshift({ signature: sig, err: null, slot: 99 });
    expect(await scanDeposits(s.d)).toMatchObject({ read: 1, recorded: 1 });
    expect(await p.balance()).toBe(30_000_000);
  });

  it('relays a deposit from a wallet that only signs, if it is the proven wallet paying the house', async () => {
    const s = await setup();
    const p = await s.t.player();
    await s.prove(p);
    const { tx } = (await s.post({ action: 'deposit', amount: 5_000_000 }, p.id)).body;
    const raw = Uint8Array.from(atob(tx), (c) => c.charCodeAt(0));
    const parsed = parseTransaction(raw);
    raw.set(await p.kp.sign(parsed.message), 1);
    const r = await s.post({ action: 'claim', tx: base64Encode(raw) }, p.id);
    expect(r.body).toMatchObject({ state: 'pending', signature: base58Encode(raw.slice(1, 65)) });
    expect(s.chain.sent).toHaveLength(1);
    // Someone else's signed transaction isn't relayed.
    const q = await s.t.player();
    await s.prove(q);
    expect((await s.post({ action: 'claim', tx: base64Encode(raw) }, q.id)).body.error).toMatch(/not a deposit from your wallet/);
    expect(s.chain.sent).toHaveLength(1);
  });

  it('scans the house history oldest first from its cursor, holds strangers, and resumes after a gap', async () => {
    const s = await setup();
    const [a, b] = [await s.t.player(), await s.t.player()];
    await s.prove(a);
    await s.prove(b);
    const stranger = (await generateKeypair()).keypair.address;
    s.chain.deposit(a.kp.address, 10_000_000);
    s.chain.deposit(stranger, 50_000_000);
    s.chain.deposit(b.kp.address, 20_000_000, { err: { InstructionError: [0, 'Custom'] } });
    expect(await scanDeposits(s.d)).toMatchObject({ read: 3, recorded: 2, backlog: false });
    expect([await a.balance(), await b.balance()]).toEqual([10_000_000, 0]);
    expect(await s.t.sql(`select state, amount from public.pokejam_pack_deposits where sender = $1`, [stranger])).toEqual([{ state: 'held', amount: 50_000_000 }]);
    // A deposit the RPC lists but can't serve yet stops the scan without moving the cursor past it.
    const late = s.chain.deposit(b.kp.address, 15_000_000);
    const lateTx = s.chain.txs.get(late)!;
    s.chain.txs.delete(late);
    s.chain.deposit(b.kp.address, 5_000_000);
    expect(await scanDeposits(s.d)).toMatchObject({ read: 2, recorded: 0 });
    expect(await b.balance()).toBe(0);
    s.chain.txs.set(late, lateTx);
    expect(await scanDeposits(s.d)).toMatchObject({ read: 2, recorded: 2 });
    expect(await b.balance()).toBe(20_000_000);
    expect(await scanDeposits(s.d)).toMatchObject({ read: 0 });
  });
});

describe('withdrawals', () => {
  async function requested(amount = 20_000_000) {
    const s = await setup();
    const p = await s.t.player();
    await s.prove(p);
    await s.t.call('pokejam_pack_post', { p_user: p.id, p_delta: 100_000_000, p_kind: 'test', p_ref: 'fund', p_note: null });
    const [{ r }] = await p.as('select public.pokejam_pack_withdraw($1) as r', [amount]) as { r: { id: string } }[];
    const row = async () => (await s.t.sql('select * from public.pokejam_pack_withdrawals where id = $1', [r.id]))[0];
    const retryNow = () => s.t.sql('update public.pokejam_pack_withdrawals set next_try_at = now()');
    return { ...s, p, id: r.id, row, retryNow };
  }

  it('sends the USDC to the proven wallet, signed by the house, with the withdrawal in the memo', async () => {
    const s = await requested();
    expect(await runWithdrawals(s.d)).toEqual([{ id: s.id, outcome: 'sent' }]);
    expect(await s.row()).toMatchObject({ state: 'sent', attempts: 0 });
    const tx = parseTransaction(Uint8Array.from(atob(s.chain.sent[0]), (c) => c.charCodeAt(0)));
    expect(tx.signers).toEqual([s.house.address]);
    expect(await verifySignature(s.house.address, tx.message, tx.signatures[0])).toBe(true);
    const to = await associatedAccount(s.p.kp.address, USDC, SPL_PROGRAM);
    expect(tx.accountKeys).toEqual(expect.arrayContaining([HOUSE_USDC, USDC, to, s.p.kp.address]));
    expect(new TextDecoder().decode(tx.message)).toContain(withdrawalMemo(s.id));
    expect((await s.row()).txid).toBe(base58Encode(tx.signatures[0]));
    expect(await runWithdrawals(s.d)).toEqual([]); // nothing more to send
    expect(await s.p.balance()).toBe(80_000_000);
  });

  it('settles a lost reply from the chain instead of sending twice', async () => {
    const s = await requested();
    s.chain.s.sendMode = 'lose';
    expect((await runWithdrawals(s.d))[0].outcome).toBe('skipped'); // reply lost: left recorded
    expect(s.chain.sent).toHaveLength(1);
    // Still landing: wait.
    await s.t.sql(`update public.pokejam_pack_withdrawals set updated_at = now() - interval '11 minutes'`);
    s.chain.s.blockhashValid = true;
    expect((await runWithdrawals(s.d))[0].outcome).toBe('waiting');
    // It landed after all: marked sent, never sent again.
    s.chain.statuses.set((await s.row()).txid as string, 'confirmed');
    await s.retryNow();
    expect((await runWithdrawals(s.d))[0].outcome).toBe('sent');
    expect(s.chain.sent).toHaveLength(1);
  });

  it('sends a fresh transaction once the first expired unseen', async () => {
    const s = await requested();
    s.chain.s.sendMode = 'lose';
    await runWithdrawals(s.d);
    const first = (await s.row()).txid as string;
    s.chain.statuses.delete(first); // never seen by the chain
    await s.t.sql(`update public.pokejam_pack_withdrawals set updated_at = now() - interval '11 minutes'`);
    s.chain.s.sendMode = 'land';
    expect((await runWithdrawals(s.d))[0].outcome).toBe('sent');
    expect((await s.row()).txid).not.toBe(first);
    expect(await s.p.balance()).toBe(80_000_000);
  });

  it('credits a withdrawal back once after the node refuses it three times', async () => {
    const s = await requested();
    s.chain.s.sendMode = 'refuse';
    for (const outcome of ['retry', 'retry', 'refunded']) {
      await s.retryNow();
      expect((await runWithdrawals(s.d))[0].outcome).toBe(outcome);
    }
    expect(await s.row()).toMatchObject({ state: 'refunded', attempts: 3, txid: null });
    expect(await s.p.balance()).toBe(100_000_000);
  });

  it('counts a transaction that failed on-chain as a failed attempt', async () => {
    const s = await requested();
    s.chain.s.sendMode = 'fail-on-chain';
    expect((await runWithdrawals(s.d))[0].outcome).toBe('retry');
    expect(await s.row()).toMatchObject({ state: 'pending', attempts: 1, txid: null });
  });

  it('holds without using an attempt while the house is short of USDC or SOL, or over its cap', async () => {
    const s = await requested();
    s.chain.s.usdc = 1_000_000;
    expect(await runWithdrawals(s.d)).toMatchObject([{ outcome: 'held', note: 'the house is short of USDC' }]);
    s.chain.s.usdc = 1e9;
    s.chain.s.lamports = 1000;
    await s.retryNow();
    expect(await runWithdrawals(s.d)).toMatchObject([{ outcome: 'held', note: 'the house is short of SOL for fees' }]);
    s.chain.s.lamports = 1e9;
    await s.t.sql(`update public.pokejam_config set value = '"10000000"' where key = 'pack_withdraw_house_daily_cap'`);
    await s.retryNow();
    expect((await runWithdrawals(s.d))[0].note).toMatch(/house daily withdrawal cap/);
    expect(await s.row()).toMatchObject({ state: 'pending', attempts: 0 });
    expect(s.chain.sent).toEqual([]);
  });

  it('never claims one waiting for review', async () => {
    const s = await requested(90_000_000);
    expect((await runWithdrawals(s.d))[0].outcome).toBe('sent');
    await s.t.sql(`update public.pokejam_config set value = '"10000000"' where key = 'pack_withdraw_review_over'`);
    await s.t.call('pokejam_pack_post', { p_user: s.p.id, p_delta: 50_000_000, p_kind: 'test', p_ref: 'fund2', p_note: null });
    await s.p.as('select public.pokejam_pack_withdraw($1)', [20_000_000]);
    expect(await runWithdrawals(s.d)).toEqual([]);
  });
});

describe('the mainnet interlock', () => {
  it('runs real money only with the database switched for it', () => {
    expect(realMoneyRefusal('devnet', { real_money: false, test_credits: true })).toBeNull();
    expect(realMoneyRefusal('devnet', { real_money: true })).toMatch(/workers are on devnet/);
    expect(realMoneyRefusal('mainnet-beta', { real_money: false })).toMatch(/pack_real_money is off/);
    expect(realMoneyRefusal('mainnet-beta', { real_money: true, test_credits: true })).toMatch(/turn it off before launch/);
    expect(realMoneyRefusal('mainnet-beta', { real_money: true, test_credits: false })).toBeNull();
  });

  it('builds withdrawals the house alone signs', async () => {
    const house = (await generateKeypair()).keypair;
    const w = await buildWithdrawal(house, { id: crypto.randomUUID(), wallet: (await generateKeypair()).keypair.address, houseUsdcAccount: HOUSE_USDC, usdcMint: USDC,
      amount: 5n, decimals: 6, recentBlockhash: base58Encode(new Uint8Array(32).fill(7)), priorityMicroLamports: 20_000 });
    expect(parseTransaction(Uint8Array.from(atob(w.base64), (c) => c.charCodeAt(0))).signers).toEqual([house.address]);
  });
});
