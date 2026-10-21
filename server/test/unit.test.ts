import { describe, expect, test } from 'bun:test';
import { acceptBattle, cancelBattle, createBattle, deriveSeed, entryOf, finishBattle, getBattle, voidBattle, voidInterrupted } from '../battles';
import { CollectorCryptPackSource, keypairWallet } from '../collector-crypt';
import { DepositScanner } from '../deposits';
import { InsufficientFunds, balanceOf, now, openDb, post } from '../db';
import { base58Decode, base58Encode, base64Decode, base64Encode, randomBytes } from '../lib/bytes';
import { generateKeypair, keypairFromSecret, verifySignature } from '../lib/ed25519';
import { parseTransaction, signTransactionBase64 } from '../lib/solana-tx';
import { PayoutWorker } from '../payouts';
import { Rpc, usdcReceived } from '../solana';
import { allSignaturesValid, buildTx, fakeCollectorCrypt, fakeRpc, partialSign, testConfig } from './helpers';

const MINT = testConfig().usdcMint;

describe('bytes and keys', () => {
  test('base58 round trips, including leading zeros', () => {
    expect(base58Encode(new Uint8Array(32))).toBe('11111111111111111111111111111111');
    for (let i = 0; i < 50; i++) {
      const b = randomBytes(1 + (i % 40));
      if (i % 5 === 0) b[0] = 0;
      expect([...base58Decode(base58Encode(b))]).toEqual([...b]);
    }
    expect(base58Encode(new TextEncoder().encode('hello world'))).toBe('StV1DL6CwTryKyV');
  });

  test('house key from a Solana CLI secret signs verifiably, and a mismatched key is refused', async () => {
    const { secret, keypair } = await generateKeypair();
    const again = await keypairFromSecret(secret);
    expect(again.address).toBe(keypair.address);
    const fromB58 = await keypairFromSecret(base58Encode(new Uint8Array(JSON.parse(secret))));
    expect(fromB58.address).toBe(keypair.address);
    const msg = new TextEncoder().encode('x');
    expect(await verifySignature(keypair.address, msg, await again.sign(msg))).toBe(true);
    const bad = JSON.parse(secret) as number[];
    bad[40] ^= 1;
    await expect(keypairFromSecret(JSON.stringify(bad))).rejects.toThrow();
  });
});

describe('transaction signing', () => {
  for (const v0 of [false, true]) {
    test(`adds the house signature and keeps the gacha wallet's (${v0 ? 'v0' : 'legacy'})`, async () => {
      const house = (await generateKeypair()).keypair;
      const gacha = (await generateKeypair()).keypair;
      const tx = await partialSign(buildTx([house.address, gacha.address], 3, v0), gacha);
      expect(await allSignaturesValid(tx)).toBe(false);
      const signed = base64Decode(await signTransactionBase64(base64Encode(tx), house));
      expect(await allSignaturesValid(signed)).toBe(true);
      expect(parseTransaction(signed).version).toBe(v0 ? 0 : 'legacy');
    });
  }

  test('refuses to sign a transaction the house is not a signer of', async () => {
    const house = (await generateKeypair()).keypair;
    const other = (await generateKeypair()).keypair;
    await expect(signTransactionBase64(base64Encode(buildTx([other.address])), house)).rejects.toThrow(/not a signer/);
  });
});

describe('ledger', () => {
  test('balances sum, refs are idempotent, overdrafts are refused', () => {
    const db = openDb(':memory:');
    expect(post(db, 'w', 100, 'deposit', 'sig1')).toBe(true);
    expect(post(db, 'w', 100, 'deposit', 'sig1')).toBe(false);
    expect(balanceOf(db, 'w')).toBe(100);
    expect(() => post(db, 'w', -101, 'entry', 'b:0')).toThrow(InsufficientFunds);
    post(db, 'w', -60, 'entry', 'b:0');
    expect(balanceOf(db, 'w')).toBe(40);
  });
});

describe('battles and escrow', () => {
  const setup = () => {
    const db = openDb(':memory:');
    const cfg = testConfig({ restrictedRegions: ['XX'] });
    for (const w of ['host', 'guest', 'kid', 'far']) {
      db.query('insert into users (wallet, adult, region, created_at) values (?, ?, ?, ?)').run(w, w === 'kid' ? 0 : 1, w === 'far' ? 'XX' : 'TX', now());
      post(db, w, 100_000_000, 'adjust', `seed-${w}`);
    }
    return { db, cfg };
  };

  test('create and accept each take half the machine price; cancel refunds the host', async () => {
    const { db, cfg } = setup();
    const b = await createBattle(db, cfg, 'host', 'pokemon_50', 120, 'ab'.repeat(16));
    expect(entryOf('pokemon_50')).toBe(25_000_000);
    expect(balanceOf(db, 'host')).toBe(75_000_000);
    const c = await createBattle(db, cfg, 'host', 'pokemon_25', 60, null);
    cancelBattle(db, 'host', c.id);
    expect(balanceOf(db, 'host')).toBe(75_000_000);
    await acceptBattle(db, cfg, 'guest', b.id, 'cd'.repeat(16));
    expect(balanceOf(db, 'guest')).toBe(75_000_000);
    const row = getBattle(db, b.id)!;
    expect(row.state).toBe('ready');
    expect(row.seed).toBe(await deriveSeed(row.server_seed, row.host_seed, row.guest_seed!, row.id));
    await expect(acceptBattle(db, cfg, 'far', b.id, null)).rejects.toThrow();
    expect(() => cancelBattle(db, 'host', b.id)).toThrow();
  });

  test('eligibility: minors and restricted regions cannot enter; nobody can take their own battle', async () => {
    const { db, cfg } = setup();
    await expect(createBattle(db, cfg, 'kid', 'pokemon_25', 60, null)).rejects.toThrow(/18\+/);
    await expect(createBattle(db, cfg, 'far', 'pokemon_25', 60, null)).rejects.toThrow(/XX/);
    const b = await createBattle(db, cfg, 'host', 'pokemon_25', 60, null);
    await expect(acceptBattle(db, cfg, 'host', b.id, null)).rejects.toThrow(/own/);
    await expect(createBattle(db, cfg, 'host', 'pokemon_9999', 60, null)).rejects.toThrow();
  });

  test('void refunds both; finish queues one prize for the winner; restarts void live games', async () => {
    const { db, cfg } = setup();
    const a = await createBattle(db, cfg, 'host', 'pokemon_100', 60, null);
    await acceptBattle(db, cfg, 'guest', a.id, null);
    voidBattle(db, a.id, 'test');
    expect(balanceOf(db, 'host')).toBe(100_000_000);
    expect(balanceOf(db, 'guest')).toBe(100_000_000);
    const b = await createBattle(db, cfg, 'host', 'pokemon_25', 60, null);
    await acceptBattle(db, cfg, 'guest', b.id, null);
    finishBattle(db, b.id, 1, [10, 12], false, null);
    finishBattle(db, b.id, 0, [99, 0], false, null); // a second result is ignored
    const prizes = db.query('select * from prizes').all() as { wallet: string; tier: string }[];
    expect(prizes).toHaveLength(1);
    expect(prizes[0].wallet).toBe('guest');
    const c = await createBattle(db, cfg, 'host', 'pokemon_25', 60, null);
    await acceptBattle(db, cfg, 'guest', c.id, null);
    db.query("update battles set state = 'playing' where id = ?").run(c.id);
    expect(voidInterrupted(db)).toBe(1);
    expect(getBattle(db, c.id)!.state).toBe('void');
  });
});

describe('deposits', () => {
  test('parses the received amount and the sender', () => {
    const rpc = fakeRpc();
    rpc.deposit('s1', 'SENDER', 'HOUSEATA', MINT, 5_000_000);
    rpc.stop();
  });

  test('scanner credits signed-in senders once and records strangers as unmatched', async () => {
    const db = openDb(':memory:');
    const rpc = fakeRpc();
    const cfg = testConfig({ houseUsdcAccount: 'HouseUsdc1111111111111111111111111111111111', rpcUrl: rpc.url });
    db.query('insert into users (wallet, created_at) values (?, ?)').run('PlayerA', now());
    rpc.deposit('sigA', 'PlayerA', cfg.houseUsdcAccount, MINT, 20_000_000);
    rpc.deposit('sigB', 'Stranger', cfg.houseUsdcAccount, MINT, 7_000_000);
    rpc.deposit('sigC', 'PlayerA', cfg.houseUsdcAccount, 'OtherMint', 1_000_000);
    const scanner = new DepositScanner(db, new Rpc(rpc.url), cfg, { ...console, warn: () => {} });
    expect(await scanner.scan()).toBe(1);
    expect(await scanner.scan()).toBe(0);
    expect(balanceOf(db, 'PlayerA')).toBe(20_000_000);
    rpc.deposit('sigD', 'PlayerA', cfg.houseUsdcAccount, MINT, 5_000_000);
    expect(await scanner.scan()).toBe(1);
    expect(balanceOf(db, 'PlayerA')).toBe(25_000_000);
    const unmatched = db.query('select * from deposits where wallet is null and amount > 0').all() as { sender: string }[];
    expect(unmatched.map((u) => u.sender)).toEqual(['Stranger']);
    rpc.stop();
  });

  test('usdcReceived ignores failed transactions and other mints', () => {
    const tx = { slot: 1, blockTime: 1, meta: { err: { x: 1 }, preTokenBalances: [], postTokenBalances: [] }, transaction: { message: { accountKeys: ['A'] } } };
    expect(usdcReceived(tx, 'A', MINT)).toBeNull();
  });
});

describe('payouts', () => {
  const setupPrize = (db: ReturnType<typeof openDb>, wallet: string) => {
    db.query("insert into prizes (id, battle_id, wallet, tier, state, created_at, updated_at) values ('p1', 'b1', ?, 'pokemon_25', 'pending', ?, ?)").run(wallet, now(), now());
  };
  const quiet = { ...console, info: () => {}, error: () => {}, warn: () => {} };

  for (const mode of ['gift', 'open'] as const) {
    test(`${mode}: buys one pull for the winner, signed by the house`, async () => {
      const house = (await generateKeypair()).keypair;
      const winner = (await generateKeypair()).keypair.address;
      const cc = await fakeCollectorCrypt(house.address);
      const db = openDb(':memory:');
      setupPrize(db, winner);
      const w = new PayoutWorker(db, new CollectorCryptPackSource({ wallet: keypairWallet(house), baseUrl: cc.url, mode }), { rpc: null, houseUsdcAccount: '', pollSeconds: 1 }, quiet);
      expect(await w.runOnce()).toBe(1);
      expect(await w.runOnce()).toBe(0);
      const p = db.query("select * from prizes where id = 'p1'").get() as { state: string; memo: string; rarity: string | null };
      expect(p.state).toBe('sent');
      expect([...cc.memos.values()][0].recipient).toBe(winner);
      expect(cc.calls.filter((c) => c.path.startsWith('/api/generate'))).toHaveLength(1);
      if (mode === 'open') expect(p.rarity).toBe('Rare');
      cc.stop();
    });
  }

  test('a refusal before payment retries the purchase', async () => {
    const house = (await generateKeypair()).keypair;
    const cc = await fakeCollectorCrypt(house.address, { failGenerate: 1 });
    const db = openDb(':memory:');
    setupPrize(db, 'Winner1111111111111111111111111111111111111');
    const w = new PayoutWorker(db, new CollectorCryptPackSource({ wallet: keypairWallet(house), baseUrl: cc.url }), { rpc: null, houseUsdcAccount: '', pollSeconds: 1 }, quiet);
    expect(await w.runOnce()).toBe(0);
    db.query('update prizes set next_try_at = 0').run();
    expect(await w.runOnce()).toBe(1);
    cc.stop();
  });

  test('a failure after payment resumes the same memo and never buys twice', async () => {
    const house = (await generateKeypair()).keypair;
    const cc = await fakeCollectorCrypt(house.address, { failOpenAfterPay: 1 });
    const db = openDb(':memory:');
    setupPrize(db, 'Winner1111111111111111111111111111111111111');
    const w = new PayoutWorker(db, new CollectorCryptPackSource({ wallet: keypairWallet(house), baseUrl: cc.url, mode: 'open' }), { rpc: null, houseUsdcAccount: '', pollSeconds: 1 }, quiet);
    expect(await w.runOnce()).toBe(0);
    const failed = db.query("select state, memo from prizes where id = 'p1'").get() as { state: string; memo: string };
    expect(failed.state).toBe('failed');
    expect(failed.memo).toBeTruthy();
    db.query('update prizes set next_try_at = 0').run();
    expect(await w.runOnce()).toBe(1);
    expect(cc.calls.filter((c) => c.path === '/api/generatePack')).toHaveLength(1);
    cc.stop();
  });

  test('a crash mid-purchase with no memo is parked for an admin; a short house wallet waits', async () => {
    const db = openDb(':memory:');
    setupPrize(db, 'W');
    db.query("update prizes set state = 'sending'").run();
    const house = (await generateKeypair()).keypair;
    const cc = await fakeCollectorCrypt(house.address);
    const rpc = fakeRpc();
    rpc.setBalance(1);
    const w = new PayoutWorker(db, new CollectorCryptPackSource({ wallet: keypairWallet(house), baseUrl: cc.url }), { rpc: new Rpc(rpc.url), houseUsdcAccount: 'H', pollSeconds: 1 }, quiet);
    w.recover();
    expect(await w.runOnce()).toBe(0);
    expect(cc.calls).toHaveLength(0);
    expect(w.retry('p1')).toBe(true);
    expect(await w.runOnce()).toBe(0); // house wallet too low: waits, buys nothing
    expect((db.query("select last_error from prizes where id='p1'").get() as { last_error: string }).last_error).toMatch(/House wallet/);
    rpc.setBalance(1e12);
    db.query('update prizes set next_try_at = 0').run();
    expect(await w.runOnce()).toBe(1);
    cc.stop();
    rpc.stop();
  });
});
