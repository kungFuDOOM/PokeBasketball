// Devnet rehearsal of Pack Battles with two real wallets, money in and out: the real Solana devnet RPC, Collector
// Crypt's real devnet gacha and the real house wallet, with a local Postgres (PGlite, every migration) standing in for
// Supabase. Spends devnet USDC-Dev only: one $25 pull, sold back. Run from the repo root:
//   bun --use-system-ca supabase/functions/_shared/pack/test/devnet-wallet.ts <house keypair json> <house USDC-Dev account> <player 1 keypair json> <player 2 keypair json>
//
//   1. The house sends each player a little test SOL and $40 of USDC-Dev (their own wallets, as if from a faucet).
//   2. Both players link their wallet by signing their one-time message (pokejam-pack-wallet 'prove').
//   3. Both deposit $30: the server builds the transfer, the wallet signs it, the server relays it and credits it
//      once Solana finalizes it ('deposit', 'claim'). The scan then reads the same history and credits nothing twice.
//   4. Both enter the Starter tier and are paired. The battle is settled for player 1 (pokejam_pack_settle; the game
//      and its judge are what #43 tested on real played games, not repeated here).
//   5. The payout worker buys and opens player 1's real pull; player 1 sells it back at the reveal.
//   6. Both withdraw everything to their wallets (pokejam_pack_withdraw, then the worker sends it on devnet).
//   7. The books: both balances back to zero, the house's USDC moved by exactly the fee, and every player's wallet
//      holds what the ledger says it should.
import { readFileSync } from 'node:fs';
import { SPL_PROGRAM, SYSTEM_PROGRAM, associatedAccount, buildMessage } from '../../ads/tx.ts';
import { base58Encode, base64Decode, base64Encode } from '../bytes.ts';
import { CollectorCrypt, CC_DEVNET } from '../collector-crypt.ts';
import { packConfig, realMoneyRefusal } from '../config.ts';
import { keypairFromSecret, type Keypair } from '../ed25519.ts';
import { machineRows, parseMachines } from '../machines.ts';
import { MAX_ATTEMPTS, healthAlerts, runPayouts } from '../payouts.ts';
import { Rpc } from '../rpc.ts';
import { parseTransaction } from '../solana-tx.ts';
import { sqlStore } from '../store.ts';
import { buildWithdrawal, checkHouseAccount, runWithdrawals, scanDeposits, walletHandler, type MoneyDeps } from '../wallet.ts';
import { fullDb } from './full-db.ts';

const [houseFile, houseUsdc, p1File, p2File] = process.argv.slice(2);
if (!p2File) throw new Error('usage: devnet-wallet.ts <house keypair> <house USDC-Dev account> <player 1 keypair> <player 2 keypair>');
const house = await keypairFromSecret(readFileSync(houseFile, 'utf8'));
const cfg = packConfig((k) => ({ SUPABASE_URL: 'local', SUPABASE_SERVICE_ROLE_KEY: 'local', HOUSE_USDC_ACCOUNT: houseUsdc })[k], { needHouse: false });
const rpc = new Rpc('https://api.devnet.solana.com');
const cc = new CollectorCrypt({ house, rpc, baseUrl: CC_DEVNET, openTimeoutMs: 120_000, guard: { houseUsdc, usdcMint: cfg.usdcMint, ccSigner: cfg.ccSigner } });
const t = await fullDb();
const store = sqlStore(async (fn, args) => {
  const r = await t.call(fn, args);
  // sqlStore expects PostgREST-style rows for every call.
  return Array.isArray(r) ? r : [{ [fn]: r }];
});
const log = { info: (m: string) => console.log('  ' + m), warn: (m: string) => console.log('  ! ' + m), error: (m: string) => console.log('  x ' + m) };
const money: MoneyDeps = { call: t.call, rpc, house, houseUsdcAccount: houseUsdc, usdcMint: cfg.usdcMint, priorityMicroLamports: 0, log };
const checks: [string, boolean][] = [];
const check = (what: string, ok: boolean) => { checks.push([what, ok]); console.log(`  ${ok ? '✓' : '✗'} ${what}`); };
const $ = (micro: number) => `$${(micro / 1e6).toFixed(2)}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const houseUsdcNow = async () => rpc.tokenBalance(houseUsdc);
const walletUsdc = async (owner: string) => {
  const ata = await associatedAccount(owner, cfg.usdcMint, SPL_PROGRAM);
  return (await rpc.accountInfo(ata)) ? rpc.tokenBalance(ata) : 0;
};

/** The pokejam-pack-wallet Edge Function, called as a player (or with the service key). */
const post = async (body: unknown, user: string) => {
  const res = await walletHandler(new Request('https://local/pokejam-pack-wallet', { method: 'POST', headers: { authorization: `Bearer jwt-${user}` }, body: JSON.stringify(body) }),
    { origins: [], serviceKey: 'service', cluster: 'devnet' },
    { ...money, userOf: async (jwt) => jwt.replace(/^jwt-/, ''), runAll: async () => ({}) });
  return await res.json() as Record<string, any>;
};

console.log(`house ${house.address}: ${$(await houseUsdcNow())} USDC-Dev, ${(await rpc.balance(house.address)) / 1e9} SOL`);
await checkHouseAccount(rpc, { address: house.address, usdcAccount: houseUsdc, usdcMint: cfg.usdcMint });
check('the house USDC account is the house\'s, for USDC-Dev', true);
check('devnet workers run with real money off', realMoneyRefusal('devnet', await store.health(MAX_ATTEMPTS)) === null);

// ---------- 1. fund the two players from the house (their own wallets, as a faucet would) ----------

const players = await Promise.all([p1File, p2File].map(async (f, i) => ({ name: `Player ${i + 1}`, kp: await keypairFromSecret(readFileSync(f, 'utf8')), db: await t.player(`Player${i + 1}`) })));
console.log('\n1. funding the players with test SOL and USDC-Dev from the house');
for (const p of players) {
  const lamports = await rpc.balance(p.kp.address);
  if (lamports < 20_000_000) {
    const { message } = buildMessage(house.address, [{ program: SYSTEM_PROGRAM, accounts: [{ key: house.address, signer: true, writable: true }, { key: p.kp.address, signer: false, writable: true }],
      data: new Uint8Array([2, 0, 0, 0, ...new Uint8Array(new BigUint64Array([30_000_000n]).buffer)]) }], await rpc.latestBlockhash());
    const sig = await house.sign(message);
    await rpc.send(base64Encode(new Uint8Array([1, ...sig, ...message])));
    await rpc.confirm(base58Encode(sig));
  }
  const have = await walletUsdc(p.kp.address);
  if (have < 40_000_000) {
    const fund = await buildWithdrawal(house, { id: `rehearsal-fund-${p.kp.address.slice(0, 6)}`, wallet: p.kp.address, houseUsdcAccount: houseUsdc, usdcMint: cfg.usdcMint,
      amount: BigInt(40_000_000 - have), decimals: 6, recentBlockhash: await rpc.latestBlockhash(), priorityMicroLamports: 0 });
    await rpc.send(fund.base64);
    await rpc.confirm(fund.txid);
  }
  console.log(`  ${p.name} ${p.kp.address}: ${$(await walletUsdc(p.kp.address))} USDC-Dev, ${(await rpc.balance(p.kp.address)) / 1e9} SOL`);
}

// The deposit scan starts from now, as it would at deploy time (the house's older history is its own purchases).
const [newest] = await rpc.signaturesFor(houseUsdc, { limit: 1, commitment: 'finalized' });
await t.call('pokejam_pack_set_deposit_cursor', { p_signature: newest.signature });
const houseStart = await houseUsdcNow();
const walletStart = await Promise.all(players.map((p) => walletUsdc(p.kp.address)));

// ---------- 2. link both wallets ----------

console.log('\n2. linking each wallet with a signed message');
for (const p of players) {
  const msg = (await p.db.as('select public.pokejam_pack_wallet_challenge($1) as m', [p.kp.address]))[0].m as string;
  const forged = await post({ action: 'prove', wallet: p.kp.address, signature: base58Encode(await house.sign(new TextEncoder().encode(msg))) }, p.db.id);
  check(`${p.name}: a signature from another key is refused`, /isn't from this wallet/.test(forged.error ?? ''));
  const r = await post({ action: 'prove', wallet: p.kp.address, signature: base58Encode(await p.kp.sign(new TextEncoder().encode(msg))) }, p.db.id);
  check(`${p.name}: linked ${p.kp.address}`, r.wallet === p.kp.address);
}

// ---------- 3. deposit $30 each ----------

console.log('\n3. depositing $30 from each wallet');
const signDeposit = async (p: { kp: Keypair }, tx: string) => {
  const raw = base64Decode(tx);
  raw.set(await p.kp.sign(parseTransaction(raw).message), 1);
  return base64Encode(raw);
};
for (const p of players) {
  const { tx, error } = await post({ action: 'deposit', amount: '30000000' }, p.db.id);
  if (error) throw new Error(error);
  let r = await post({ action: 'claim', tx: await signDeposit(p, tx) }, p.db.id);
  if (r.error) throw new Error(r.error);
  const started = Date.now();
  while (r.state === 'pending' && Date.now() - started < 120_000) {
    await sleep(5000);
    r = await post({ action: 'claim', signature: r.signature }, p.db.id);
  }
  console.log(`  ${p.name}: ${r.signature} finalized after ${Math.round((Date.now() - started) / 1000)} s`);
  check(`${p.name}: $30 credited once finalized`, r.state === 'recorded' && r.credited === 30_000_000 && (await p.db.balance()) === 30_000_000);
  const again = await post({ action: 'claim', signature: r.signature }, p.db.id);
  check(`${p.name}: claiming it again credits nothing more`, again.credited === 30_000_000 && (await p.db.balance()) === 30_000_000);
}
const scan1 = await scanDeposits(money);
console.log(`  scan: read ${scan1.read} signatures since the cursor`);
check('the scan finds both deposits and credits neither twice', scan1.recorded === 2 && (await players[0].db.balance()) === 30_000_000 && (await players[1].db.balance()) === 30_000_000);

// ---------- 4. a battle ----------

console.log('\n4. both enter the Starter tier and are paired');
await t.call('pokejam_pack_upsert_machines', { p_rows: machineRows(parseMachines(await cc.machines())) });
const find = (p: typeof players[number]) => p.db.as('select public.pokejam_pack_find($1, $2, false) as m', ['pokemon_25', p.kp.address]).then((r) => r[0].m as string | null);
check('player 1 waits for an opponent', (await find(players[0])) === null);
const mid = await find(players[1]);
check('player 2 is paired with player 1', !!mid);
const entry = 30_000_000 - (await players[0].db.balance());
check(`each paid the ${$(entry)} entry`, entry === 13_125_000 && (await players[1].db.balance()) === 30_000_000 - entry);
await t.call('pokejam_pack_settle', { p_match: mid, p_result: 'host', p_outcome: 'final', p_note: 'devnet rehearsal: settled for player 1' });
const [battle] = await t.sql('select state, winner, prize_id from public.pokejam_pack_battles where match_id = $1', [mid]);
check('player 1 wins, and their pack is queued', battle.state === 'won' && battle.winner === players[0].db.id && !!battle.prize_id);

// ---------- 5. the pull ----------

console.log('\n5. the payout worker buys and opens player 1\'s pull; player 1 sells it back');
const deps = { store, cc, rpc, houseUsdcAccount: houseUsdc, fallbackAfter: 1, choiceSeconds: 120, log,
  onMachines: async (m: ReturnType<typeof parseMachines>) => { await t.call('pokejam_pack_upsert_machines', { p_rows: machineRows(m) }); } };
console.log('  results', JSON.stringify(await runPayouts(deps, 5)));
const prize = async () => (await t.sql('select state, pull, sell_estimate, cash_amount, last_error from public.pokejam_pack_prizes where id = $1', [battle.prize_id]))[0];
let p = await prize();
const card = p.pull as { name?: string; insuredValue?: number } | null;
console.log(`  revealed: ${card?.name} (insured $${card?.insuredValue}), sells back for about ${$(Number(p.sell_estimate))}`);
check('the card is revealed to player 1', p.state === 'revealed');
const chose = (await players[0].db.as('select public.pokejam_pack_choose_prize($1, $2) as ok', [battle.prize_id, 'sell']))[0].ok;
check('player 1 picks Sell it back', chose === true);
console.log('  results', JSON.stringify(await runPayouts(deps, 5)));
p = await prize();
const cash = Number(p.cash_amount);
check(`sold back for ${$(cash)}, credited to player 1`, p.state === 'cashed' && cash > 0 && (await players[0].db.balance()) === 30_000_000 - entry + cash);

// ---------- 6. withdraw everything ----------

console.log('\n6. both withdraw their whole balance');
const owed = await Promise.all(players.map((x) => x.db.balance()));
for (const [i, x] of players.entries()) {
  const [{ r }] = await x.db.as('select public.pokejam_pack_withdraw($1) as r', [owed[i]]) as { r: { state: string } }[];
  check(`${x.name}: ${$(owed[i])} off their balance at once (${r.state})`, r.state === 'pending' && (await x.db.balance()) === 0);
}
let sent = await runWithdrawals(money, 5);
for (let tries = 0; sent.some((w) => w.outcome !== 'sent') && tries < 6; tries++) {
  console.log('  results', JSON.stringify(sent));
  await sleep(20_000);
  await t.sql('update public.pokejam_pack_withdrawals set next_try_at = now()');
  sent = sent.concat(await runWithdrawals(money, 5));
}
console.log('  results', JSON.stringify(sent));
const rows = await t.sql('select user_id, amount, state, txid from public.pokejam_pack_withdrawals order by created_at');
for (const w of rows) console.log(`  ${w.state} ${$(Number(w.amount))} ${w.txid}`);
check('both withdrawals were sent on devnet', rows.length === 2 && rows.every((w) => w.state === 'sent' && !!w.txid));
await sleep(3000);
for (const [i, x] of players.entries()) {
  const now = await walletUsdc(x.kp.address);
  check(`${x.name}'s wallet: ${$(walletStart[i])} − $30 deposit + ${$(owed[i])} withdrawal = ${$(now)}`, now === walletStart[i] - 30_000_000 + owed[i]);
}

// ---------- 7. the books ----------

console.log('\n7. the books');
const scan2 = await scanDeposits(money);
check(`the scan reads the pull, the buyback and the withdrawals (${scan2.read} signatures) and finds no deposit in them`, scan2.recorded === 0);
const houseEnd = await houseUsdcNow();
const { health, owed: stillOwed, alerts } = await healthAlerts(store, houseEnd);
console.log(`  house ${$(houseStart)} → ${$(houseEnd)}; fee revenue ${$(Number(health.fee_revenue))}; still owed ${$(stillOwed)}; alerts: ${alerts.map((a) => a.text).join(' | ') || 'none'}`);
check('nothing is owed to either player any more', stillOwed === 0);
check(`the house's USDC moved by exactly the fee (${$(houseEnd - houseStart)})`, houseEnd - houseStart === Number(health.fee_revenue) && Number(health.fee_revenue) === 1_250_000);

const failed = checks.filter(([, ok]) => !ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed${failed.length ? `; failed: ${failed.map(([w]) => w).join('; ')}` : ''}`);
process.exit(failed.length ? 1 : 0);
