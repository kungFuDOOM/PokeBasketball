import { describe, expect, test } from 'bun:test';
import { acceptBattle, cancelBattle, createBattle, deriveSeed, entryOf, finishBattle, firstPick, getBattle, recordPaid, recordPull, voidBattle, voidInterrupted } from '../battles';
import { CollectorCryptPackSource, betaFrom } from '../collector-crypt';
import { DepositScanner } from '../deposits';
import { InsufficientFunds, balanceOf, now, openDb, post } from '../db';
import { base58Decode, base58Encode, base64Decode, base64Encode, randomBytes } from '../lib/bytes';
import { MPL_CORE, buildTransfer, parseAsset } from '../lib/core-transfer';
import { generateKeypair, keypairFromSecret, verifySignature } from '../lib/ed25519';
import { parseTransaction, signTransactionBase64 } from '../lib/solana-tx';
import { PayoutWorker } from '../payouts';
import { Rpc, usdcReceived } from '../solana';
import { allSignaturesValid, buildTx, fakeCollectorCrypt, fakeRpc, partialSign, testConfig } from './helpers';

const MINT = testConfig().usdcMint;
const quiet = { ...console, info: () => {}, error: () => {}, warn: () => {} };

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

describe('transactions', () => {
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

  test('Core TransferV1: signed by the house only, right program, data and account order', async () => {
    const house = (await generateKeypair()).keypair;
    const asset = base58Encode(randomBytes(32));
    const collection = base58Encode(randomBytes(32));
    const to = base58Encode(randomBytes(32));
    const { base64 } = await buildTransfer(house, asset, collection, to, base58Encode(randomBytes(32)));
    const bytes = base64Decode(base64);
    expect(await allSignaturesValid(bytes)).toBe(true);
    const tx = parseTransaction(bytes);
    expect(tx.signers).toEqual([house.address]);
    expect(tx.accountKeys).toContain(MPL_CORE);
    expect(tx.accountKeys.indexOf(asset)).toBeGreaterThan(0);
    // header: 1 signer, 0 readonly signed; readonly unsigned = collection, new owner, program
    expect([...tx.message.slice(0, 3)]).toEqual([1, 0, 3]);
    const data = new Uint8Array([1, ...base58Decode(house.address), 2, ...base58Decode(collection)]);
    expect(parseAsset(data)).toEqual({ owner: house.address, collection });
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

describe('battles, escrow and seeds', () => {
  const setup = () => {
    const db = openDb(':memory:');
    const cfg = testConfig({ restrictedRegions: ['XX'] });
    for (const w of ['host', 'guest', 'kid', 'far']) {
      db.query('insert into users (wallet, adult, region, created_at) values (?, ?, ?, ?)').run(w, w === 'kid' ? 0 : 1, w === 'far' ? 'XX' : 'TX', now());
      post(db, w, 100_000_000, 'adjust', `seed-${w}`);
    }
    return { db, cfg };
  };
  const pull = (entropy: string) => ({ memo: 'pj-1', nftAddress: 'NFT1', name: 'Card', image: null, insuredValue: 50, grade: 'GEM-MT 10', rarity: 'Rare', roll: 42, entropy, vrf: { beta: entropy } });

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
    expect(row.seed).toBeNull(); // the seed waits for the pull's VRF output
    await expect(acceptBattle(db, cfg, 'far', b.id, null)).rejects.toThrow();
    expect(() => cancelBattle(db, 'host', b.id)).toThrow();
  });

  test('the game seed mixes all four sources: change any one and the seed changes', async () => {
    const base = ['s'.repeat(64), 'a'.repeat(32), 'b'.repeat(32), 'battle1', 'f'.repeat(128)] as const;
    const s0 = await deriveSeed(...base);
    for (let i = 0; i < base.length; i++) {
      const v = [...base] as [string, string, string, string, string];
      v[i] = v[i].replace(/.$/, '0');
      expect(await deriveSeed(...v)).not.toBe(s0);
    }
    expect([0, 1]).toContain(await firstPick('s', 'a', 'b', 'x'));
  });

  test('recording the pull sets the seed from its VRF output and holds the card for the winner', async () => {
    const { db, cfg } = setup();
    const b = await createBattle(db, cfg, 'host', 'pokemon_25', 60, null);
    await acceptBattle(db, cfg, 'guest', b.id, null);
    recordPaid(db, b.id, 'pj-1');
    expect((db.query('select state, memo from prizes').get() as { state: string }).state).toBe('buying');
    const seed = await recordPull(db, b.id, pull('e'.repeat(128)), { verifyUrl: 'v', vrfUrl: 'r' });
    const row = getBattle(db, b.id)!;
    expect(row.seed).toBe(seed);
    expect(seed).toBe(await deriveSeed(row.server_seed, row.host_seed, row.guest_seed!, row.id, 'e'.repeat(128)));
    expect((db.query('select state, nft_address from prizes').get() as { state: string; nft_address: string })).toEqual({ state: 'held', nft_address: 'NFT1' });
    finishBattle(db, b.id, 1, [10, 12], false, null);
    finishBattle(db, b.id, 0, [99, 0], false, null); // a second result is ignored
    expect(db.query('select wallet, state from prizes').all()).toEqual([{ wallet: 'guest', state: 'pending' }]);
  });

  test('eligibility: minors and restricted regions cannot enter; nobody can take their own battle', async () => {
    const { db, cfg } = setup();
    await expect(createBattle(db, cfg, 'kid', 'pokemon_25', 60, null)).rejects.toThrow(/18\+/);
    await expect(createBattle(db, cfg, 'far', 'pokemon_25', 60, null)).rejects.toThrow(/XX/);
    const b = await createBattle(db, cfg, 'host', 'pokemon_25', 60, null);
    await expect(acceptBattle(db, cfg, 'host', b.id, null)).rejects.toThrow(/own/);
    await expect(createBattle(db, cfg, 'host', 'pokemon_9999', 60, null)).rejects.toThrow();
  });

  test('void refunds both and leaves a bought card with the house; restarts void live games', async () => {
    const { db, cfg } = setup();
    const a = await createBattle(db, cfg, 'host', 'pokemon_100', 60, null);
    await acceptBattle(db, cfg, 'guest', a.id, null);
    await recordPull(db, a.id, pull('d'.repeat(128)), { verifyUrl: 'v', vrfUrl: 'r' });
    voidBattle(db, a.id, 'test');
    expect(balanceOf(db, 'host')).toBe(100_000_000);
    expect(balanceOf(db, 'guest')).toBe(100_000_000);
    expect((db.query('select state from prizes').get() as { state: string }).state).toBe('house');
    const c = await createBattle(db, cfg, 'host', 'pokemon_25', 60, null);
    await acceptBattle(db, cfg, 'guest', c.id, null);
    db.query("update battles set state = 'playing' where id = ?").run(c.id);
    expect(voidInterrupted(db)).toBe(1);
    expect(getBattle(db, c.id)!.state).toBe('void');
  });
});

describe('deposits', () => {
  test('scanner credits signed-in senders once and records strangers as unmatched', async () => {
    const db = openDb(':memory:');
    const rpc = fakeRpc();
    const cfg = testConfig({ houseUsdcAccount: 'HouseUsdc1111111111111111111111111111111111', rpcUrl: rpc.url });
    db.query('insert into users (wallet, created_at) values (?, ?)').run('PlayerA', now());
    rpc.deposit('sigA', 'PlayerA', cfg.houseUsdcAccount, MINT, 20_000_000);
    rpc.deposit('sigB', 'Stranger', cfg.houseUsdcAccount, MINT, 7_000_000);
    rpc.deposit('sigC', 'PlayerA', cfg.houseUsdcAccount, 'OtherMint', 1_000_000);
    const scanner = new DepositScanner(db, new Rpc(rpc.url), cfg, quiet);
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

  test('usdcReceived ignores failed transactions', () => {
    const tx = { slot: 1, blockTime: 1, meta: { err: { x: 1 }, preTokenBalances: [], postTokenBalances: [] }, transaction: { message: { accountKeys: ['A'] } } };
    expect(usdcReceived(tx, 'A', MINT)).toBeNull();
  });
});

describe('Collector Crypt pulls and prizes', () => {
  const setup = async (opts: { failGenerate?: number; failOpenAfterPay?: number } = {}) => {
    const house = (await generateKeypair()).keypair;
    const winner = (await generateKeypair()).keypair.address;
    const chain = fakeRpc();
    const cc = await fakeCollectorCrypt(house.address, chain, opts);
    const source = new CollectorCryptPackSource({ house, rpc: new Rpc(chain.url), baseUrl: cc.url, openTimeoutMs: 5000 });
    const db = openDb(':memory:');
    const worker = new PayoutWorker(db, source, { rpc: null, houseUsdcAccount: '', pollSeconds: 60 }, quiet);
    const stop = () => { chain.stop(); cc.stop(); };
    return { house, winner, chain, cc, source, db, worker, stop };
  };

  test('buy: the house pays, CC opens the card into the house wallet, and its VRF output becomes the entropy', async () => {
    const t = await setup();
    let paid = '';
    const pull = await t.source.buy('pokemon_25', 'b1', { onPaid: (m) => (paid = m) });
    expect(paid).toBe(pull.memo);
    expect(t.chain.assets.get(pull.nftAddress)!.owner).toBe(t.house.address);
    expect(pull.entropy).toBe(t.cc.memos.get(pull.memo)!.beta);
    expect(pull.entropy).toBe(betaFrom(pull.vrf)!);
    expect(pull).toMatchObject({ name: '1999 Base Set Charizard PSA 10', insuredValue: 420, grade: 'GEM-MT 10', rarity: 'Rare' });
    expect(pull.roll).toBe(Number(BigInt('0x' + pull.entropy.slice(0, 16)) % 100000000n) + 1);
    t.stop();
  });

  test('a held card is transferred to the winner exactly once', async () => {
    const t = await setup();
    const pull = await t.source.buy('pokemon_25', 'b1');
    t.db.query("insert into prizes (id, battle_id, wallet, tier, state, memo, nft_address, created_at, updated_at) values ('p1', 'b1', ?, 'pokemon_25', 'pending', ?, ?, ?, ?)").run(t.winner, pull.memo, pull.nftAddress, now(), now());
    expect(await t.worker.runOnce()).toBe(1);
    expect(await t.worker.runOnce()).toBe(0);
    expect(t.chain.assets.get(pull.nftAddress)!.owner).toBe(t.winner);
    expect(t.chain.transfers).toHaveLength(1);
    expect((t.db.query("select state, transfer_sig from prizes where id = 'p1'").get() as { state: string; transfer_sig: string }).state).toBe('sent');
    t.stop();
  });

  test('a forfeit before the pull: the worker buys it for the winner and sends it', async () => {
    const t = await setup();
    t.db.query("insert into prizes (id, battle_id, wallet, tier, state, created_at, updated_at) values ('p1', 'b1', ?, 'pokemon_50', 'pending', ?, ?)").run(t.winner, now(), now());
    expect(await t.worker.runOnce()).toBe(1);
    expect(t.cc.calls.filter((c) => c.path === '/api/generatePack')).toHaveLength(1);
    expect([...t.chain.assets.values()][0].owner).toBe(t.winner);
    t.stop();
  });

  test('a refusal before payment retries; a failure after payment resumes the memo and never buys twice', async () => {
    const t = await setup({ failGenerate: 1, failOpenAfterPay: 1 });
    t.db.query("insert into prizes (id, battle_id, wallet, tier, state, created_at, updated_at) values ('p1', 'b1', ?, 'pokemon_25', 'pending', ?, ?)").run(t.winner, now(), now());
    expect(await t.worker.runOnce()).toBe(0); // CC refused to sell
    t.db.query('update prizes set next_try_at = 0').run();
    expect(await t.worker.runOnce()).toBe(0); // paid, then openPack failed
    expect((t.db.query("select memo from prizes").get() as { memo: string }).memo).toBeTruthy();
    t.db.query('update prizes set next_try_at = 0').run();
    expect(await t.worker.runOnce()).toBe(1); // resumed from the memo
    expect(t.cc.calls.filter((c) => c.path === '/api/generatePack')).toHaveLength(2); // the refused one + one real purchase
    expect([...t.cc.memos.values()].filter((m) => m.paid)).toHaveLength(1);
    t.stop();
  });

  test('after a crash mid-transfer the worker checks ownership instead of sending again', async () => {
    const t = await setup();
    const pull = await t.source.buy('pokemon_25', 'b1');
    t.chain.assets.get(pull.nftAddress)!.owner = t.winner; // the transfer landed just before the crash
    t.db.query("insert into prizes (id, battle_id, wallet, tier, state, memo, nft_address, created_at, updated_at) values ('p1', 'b1', ?, 'pokemon_25', 'sending', ?, ?, ?, ?)").run(t.winner, pull.memo, pull.nftAddress, now(), now());
    t.worker.recover();
    expect(await t.worker.runOnce()).toBe(1);
    expect(t.chain.transfers).toHaveLength(0);
    t.db.query("insert into prizes (id, battle_id, wallet, tier, state, created_at, updated_at) values ('p2', 'b2', ?, 'pokemon_25', 'sending', ?, ?)").run(t.winner, now(), now());
    t.worker.recover();
    expect((t.db.query("select state, attempts from prizes where id = 'p2'").get() as { attempts: number }).attempts).toBe(8); // parked for an admin
    t.stop();
  });

  test("a voided battle's card can be sold back to Collector Crypt", async () => {
    const t = await setup();
    const pull = await t.source.buy('pokemon_25', 'b1');
    t.db.query("insert into prizes (id, battle_id, tier, state, nft_address, created_at, updated_at) values ('p1', 'b1', 'pokemon_25', 'house', ?, ?, ?)").run(pull.nftAddress, now(), now());
    const r = await t.worker.buyback('p1');
    expect(r?.refundAmount).toBe('18500000');
    expect((t.db.query("select state from prizes").get() as { state: string }).state).toBe('bought_back');
    t.stop();
  });

  test('betaFrom finds the 64-byte VRF output in hex or base64, under any key with beta in its name', () => {
    const h = 'ab'.repeat(64);
    expect(betaFrom({ beta: h })).toBe(h);
    expect(betaFrom({ vrf: { vrf_beta: base64Encode(new Uint8Array(64).fill(0xab)) } })).toBe(h);
    expect(betaFrom({ beta: 'short' })).toBeNull();
    expect(betaFrom(null)).toBeNull();
  });
});
