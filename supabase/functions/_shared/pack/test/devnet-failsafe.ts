// Devnet run of the payout fail-safes (20261211_pokejam_pack_fail_safe.sql): the real Collector Crypt devnet API,
// the real Solana devnet RPC and the real house wallet, with a local Postgres (PGlite) running the pack migrations
// instead of Supabase. Faults are injected only on the network, between the worker and CC: a real submit whose
// reply is thrown away, or a submit that's never sent. Everything else (CC, the chain, the database) is real.
// Spends devnet USDC-Dev only (seven $25 pulls, two of them sold back). Run from the repo root:
//   bun supabase/functions/_shared/pack/test/devnet-failsafe.ts <house keypair json> <house USDC-Dev account> <recipient> <bystander>
import { readFileSync } from 'node:fs';
import { base64Decode } from '../bytes.ts';
import { CollectorCrypt, CC_DEVNET } from '../collector-crypt.ts';
import { packConfig } from '../config.ts';
import { keypairFromSecret } from '../ed25519.ts';
import { machineRows, parseMachines } from '../machines.ts';
import { MAX_ATTEMPTS, healthAlerts, runPayouts, type PayoutDeps } from '../payouts.ts';
import { Rpc, type Fetch } from '../rpc.ts';
import { sqlStore } from '../store.ts';
import { decodeTransaction } from '../tx-inspect.ts';
import { PROGRAM } from '../tx-guard.ts';
import { sql, testDb } from './helpers.ts';

const [houseFile, houseUsdc, recipient, bystander] = process.argv.slice(2);
const house = await keypairFromSecret(readFileSync(houseFile, 'utf8'));
const devnet = packConfig((k) => ({ SUPABASE_URL: 'local', SUPABASE_SERVICE_ROLE_KEY: 'local', HOUSE_USDC_ACCOUNT: houseUsdc })[k], { needHouse: false });
const rpc = new Rpc('https://api.devnet.solana.com');

// Network faults between the worker and CC's submitTransaction, consumed one per submit.
type Fault = 'lose' | 'drop';
const faults: { purchase: Fault[]; buyback: Fault[] } = { purchase: [], buyback: [] };
const submits = { purchase: 0, buyback: 0 };
const ccFetch: Fetch = async (url, init) => {
  if (url.endsWith('/api/submitTransaction')) {
    const raw = base64Decode(String(JSON.parse(String(init?.body)).signedTransaction));
    const kind = decodeTransaction(raw).instructions.some((ix) => ix.program === PROGRAM.core) ? 'buyback' : 'purchase';
    const f = faults[kind].shift();
    if (f === 'drop') throw new Error(`simulated: the ${kind} was never sent (connection reset)`);
    submits[kind]++;
    const res = await fetch(url, init);
    if (f === 'lose') { await res.text(); throw new Error(`simulated: the ${kind} was sent but its reply was lost`); }
    return res;
  }
  return fetch(url, init);
};
const cc = new CollectorCrypt({
  house, rpc, baseUrl: CC_DEVNET, openTimeoutMs: 120_000, fetch: ccFetch,
  guard: { houseUsdc, usdcMint: devnet.usdcMint, ccSigner: devnet.ccSigner },
});

const t = await testDb();
const store = sqlStore(t.service);
const log = { info: (m: string) => console.log('    ' + m), warn: (m: string) => console.log('    ! ' + m), error: (m: string) => console.log('    x ' + m) };
const micro = async () => rpc.tokenBalance(houseUsdc);
const usd = (m: number) => `$${(m / 1e6).toFixed(2)}`;
const checks: [string, boolean][] = [];
const check = (what: string, ok: boolean) => { checks.push([what, ok]); console.log(`  ${ok ? '✓' : '✗'} ${what}`); };
const explorer = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

const winner = await t.user();
const stamp = Date.now();
const queue = async (battle: string, opts: { cash?: boolean; price?: number } = {}) =>
  (await t.service('pokejam_pack_queue_prize', { p_battle: `failsafe-${battle}-${stamp}`, p_user: winner, p_wallet: recipient, p_tier: 'pokemon_25', p_price: opts.price ?? 25_000_000, p_prefer_cash: !!opts.cash }) as Record<string, string>[])[0].pokejam_pack_queue_prize;
const prize = async (id: string) => (await sql(t.db, 'select * from public.pokejam_pack_prizes where id = $1', [id]))[0];
const balance = async () => Number((await t.asPlayer(winner, 'select public.pokejam_pack_balance() as b'))[0].b);
const owner = async (id: string) => { const p = await prize(id); return p.nft_address ? await cc.ownerOf(String(p.nft_address)) : null; };
const generates = () => submits.purchase;
const retryNow = (id: string) => sql(t.db, 'update public.pokejam_pack_prizes set next_try_at = now() where id = $1', [id]);
const crash = (id: string) => sql(t.db, "update public.pokejam_pack_prizes set state = 'sending', updated_at = now() - interval '15 minutes' where id = $1", [id]);
const setConfig = (key: string, value: string) => sql(t.db, 'update public.pokejam_config set value = $2::jsonb where key = $1', [key, value]);
const onChain = async (sig: unknown) => (sig ? await rpc.signatureStatus(String(sig)) : null);
async function waitExpired(blockhash: string) {
  const start = Date.now();
  process.stdout.write(`    waiting for blockhash ${blockhash.slice(0, 8)}… to expire`);
  while (await rpc.blockhashValid(blockhash)) {
    if (Date.now() - start > 240_000) throw new Error('blockhash still valid after 4 minutes');
    process.stdout.write('.');
    await new Promise((r) => setTimeout(r, 5000));
  }
  console.log(` expired after ${Math.round((Date.now() - start) / 1000)} s`);
}

const deps: PayoutDeps = {
  store, cc, rpc, houseUsdcAccount: houseUsdc, fallbackAfter: 1, choiceSeconds: 0, log,
  onMachines: async (m) => { await t.service('pokejam_pack_upsert_machines', { p_rows: machineRows(m) }); },
};
const run = async (label: string, d: PayoutDeps = deps) => {
  const r = await runPayouts(d, 5);
  console.log(`    ${label}: ${JSON.stringify(r.map((x) => x.outcome))}`);
  return r;
};

const start = await micro();
console.log(`house ${house.address}: ${usd(start)} USDC-Dev`);
const m25 = parseMachines(await cc.machines()).get('pokemon_25');
console.log(`Starter machine: ${m25 ? usd(m25.price) : 'missing'}, ${m25?.available ? 'available' : m25?.why}, buyback ${m25?.buyback}`);

// ---------------------------------------------------------------- 1
console.log('\n1. Kill switch, then a purchase whose reply is lost (it landed), then a crash');
{
  const id = await queue('lost-purchase');
  await setConfig('pack_payouts_paused', 'true');
  const before = await micro();
  check('paused: the worker claims nothing and spends nothing', (await run('paused run')).length === 0 && (await prize(id)).state === 'pending' && (await micro()) === before);
  await setConfig('pack_payouts_paused', 'false');
  faults.purchase.push('lose');
  await run('run 1 (reply lost)');
  const p1 = await prize(id);
  check('the purchase was recorded before it was sent (txid, blockhash, $25), with no memo yet', !!p1.pay_txid && !!p1.pay_blockhash && Number(p1.pay_amount) === 25_000_000 && p1.memo === null);
  check(`it really landed on-chain: ${explorer(String(p1.pay_txid))}`, (await onChain(p1.pay_txid)) === 'confirmed');
  await crash(id);
  await store.recover(MAX_ATTEMPTS);
  check('after a crash it goes back in the queue', (await prize(id)).state === 'pending');
  const sentBefore = generates();
  await run('run 2 (settles from the chain)');
  const p2 = await prize(id);
  check('it resumed the landed purchase instead of buying again', generates() === sentBefore && p2.memo === p1.pay_memo);
  check(`the card is in the winner's wallet: ${p2.nft_address}`, p2.state === 'sent' && (await owner(id)) === recipient);
  check(`the house paid exactly one pull (${usd(before - (await micro()))})`, before - (await micro()) === 25_000_000);
}

// ---------------------------------------------------------------- 2
console.log('\n2. A purchase that was never sent: wait while it could still land, then buy again');
{
  const id = await queue('dropped-purchase');
  const before = await micro();
  faults.purchase.push('drop');
  await run('run 1 (never sent)');
  const p1 = await prize(id);
  check('recorded, and not on-chain', !!p1.pay_txid && (await onChain(p1.pay_txid)) === null);
  await retryNow(id);
  await run('run 2 (blockhash still valid)');
  const p2 = await prize(id);
  check(`held without using up an attempt (${p2.last_error})`, p2.state === 'failed' && Number(p2.attempts) === Number(p1.attempts) && /still landing/.test(String(p2.last_error)));
  check('nothing was charged yet', (await micro()) === before);
  await waitExpired(String(p1.pay_blockhash));
  await retryNow(id);
  await run('run 3 (expired: safe to buy)');
  const p3 = await prize(id);
  check('the old record was cleared and a fresh purchase made', p3.pay_txid !== p1.pay_txid && (await onChain(p3.pay_txid)) === 'confirmed');
  check(`the card is in the winner's wallet: ${p3.nft_address}`, p3.state === 'sent' && (await owner(id)) === recipient);
  check(`the house paid exactly one pull (${usd(before - (await micro()))})`, before - (await micro()) === 25_000_000);
}

// ---------------------------------------------------------------- 3
console.log('\n3. A buyback whose reply is lost (it landed)');
{
  const id = await queue('lost-buyback', { cash: true });
  const before = await micro();
  const ledger = await balance();
  faults.buyback.push('lose');
  await run('run 1 (buyback reply lost)');
  const p1 = await prize(id);
  check('the buyback was recorded before it was sent, with what it pays', !!p1.cash_txid && Number(p1.cash_pending) > 0 && p1.state === 'failed');
  check(`it really landed: ${explorer(String(p1.cash_txid))}`, (await onChain(p1.cash_txid)) === 'confirmed');
  check('nothing credited yet, and the card left the house', (await balance()) === ledger && (await owner(id)) !== house.address);
  const bb = submits.buyback;
  await retryNow(id);
  await run('run 2 (settles from the chain)');
  const p2 = await prize(id);
  const got = (await micro()) - before + 25_000_000;
  check(`credited once: ${usd(Number(p2.cash_amount))}, exactly what reached the house (${usd(got)})`, p2.state === 'cashed' && Number(p2.cash_amount) === got && (await balance()) - ledger === got);
  check('no second buyback, and the card was not also sent to the winner', submits.buyback === bb && (await owner(id)) !== recipient);
}

// ---------------------------------------------------------------- 4
console.log('\n4. A buyback that was never sent: wait, then sell it back once');
{
  const id = await queue('dropped-buyback', { cash: true });
  const before = await micro();
  const ledger = await balance();
  faults.buyback.push('drop');
  await run('run 1 (buyback never sent)');
  const p1 = await prize(id);
  check('recorded, not on-chain, and the card is still the house\'s', !!p1.cash_txid && (await onChain(p1.cash_txid)) === null && (await owner(id)) === house.address);
  await retryNow(id);
  await run('run 2 (blockhash still valid)');
  check('held: still could land, so no second buyback', /still landing/.test(String((await prize(id)).last_error)));
  await waitExpired(String(p1.cash_blockhash));
  await retryNow(id);
  await run('run 3 (expired: sell it back)');
  const p3 = await prize(id);
  const got = (await micro()) - before + 25_000_000;
  check(`sold back once and credited ${usd(Number(p3.cash_amount))} (${usd(got)} reached the house)`, p3.state === 'cashed' && Number(p3.cash_amount) === got && (await balance()) - ledger === got);
  check('the card went back to Collector Crypt, not to the winner', ![house.address, recipient].includes(String(await owner(id))));
}

// ---------------------------------------------------------------- 5
console.log('\n5. The hourly spending cap');
{
  const spent = Number((await sql(t.db, "select coalesce(sum(pay_amount), 0) as s from public.pokejam_pack_prizes where paid_at > now() - interval '1 hour'"))[0].s);
  await setConfig('pack_max_spend_per_hour', String(spent + 30_000_000));
  const a = await queue('cap-a');
  const b = await queue('cap-b');
  await run('run 1 (room for one more pull)');
  const pb = await prize(b);
  check('the first is bought and sent', (await prize(a)).state === 'sent');
  check(`the second is held, no attempt used (${pb.last_error})`, pb.state === 'failed' && Number(pb.attempts) === 0 && /hourly spending cap/.test(String(pb.last_error)) && !pb.pay_txid);
  await setConfig('pack_max_spend_per_hour', '1000000000');
  await retryNow(b);
  await run('run 2 (cap raised)');
  check('then it goes through', (await prize(b)).state === 'sent');
}

// ---------------------------------------------------------------- 6
console.log('\n6. A house short of USDC, then a card that leaves the house unexpectedly');
{
  const id = await queue('short-house');
  const poor: PayoutDeps = { ...deps, rpc: { tokenBalance: async () => 1_000_000 }, choiceSeconds: 120 };
  await run('run 1 (house reads $1)', poor);
  const p1 = await prize(id);
  check(`held, no attempt used, nothing bought (${p1.last_error})`, p1.state === 'failed' && Number(p1.attempts) === 0 && !p1.pay_txid);
  await retryNow(id);
  await run('run 2 (funded): open it and wait at the reveal', { ...deps, choiceSeconds: 120 });
  check('revealed, card in the house wallet', (await prize(id)).state === 'revealed' && (await owner(id)) === house.address);
  // Someone moves the card out of the house wallet (here the house itself, to a bystander).
  const moved = await cc.deliver(String((await prize(id)).nft_address), bystander);
  console.log(`    moved the card to a bystander: ${explorer(moved)}`);
  await sql(t.db, "update public.pokejam_pack_prizes set choose_by = now() - interval '1 second' where id = $1", [id]);
  const ledger = await balance();
  await run('run 3 (time up)', { ...deps, choiceSeconds: 120 });
  const p3 = await prize(id);
  check(`parked for a person, nothing credited or sent (${p3.last_error})`, p3.state === 'failed' && Number(p3.attempts) === MAX_ATTEMPTS && /needs a person/.test(String(p3.last_error)) && (await balance()) === ledger);
}

// ---------------------------------------------------------------- 7
console.log('\n7. A pot below the live price: refused before paying, refunded');
{
  const before = await micro();
  const id = await queue('short-pot', { price: 20_000_000 });
  const ledger = await balance();
  await run('run 1');
  check('refunded the $20 pot, nothing bought', (await prize(id)).state === 'refunded' && (await balance()) - ledger === 20_000_000 && (await micro()) === before);
}

// ---------------------------------------------------------------- health
console.log('\n8. Health and the ledger');
{
  const h = await healthAlerts(store, await micro());
  console.log(`    owed ${usd(h.owed)} | house ${usd(await micro())} | alerts: ${h.alerts.map((a) => a.text).join(' / ') || 'none'}`);
  check('the house holds more than it owes', !h.alerts.some((a) => a.key === 'insolvent'));
  check('the parked prize from step 6 is flagged', h.alerts.some((a) => a.key === 'parked'));
  let blocked = false;
  try { await t.db.query('update public.pokejam_pack_ledger set delta = delta * 2'); } catch { blocked = true; }
  check('the ledger refuses edits', blocked);
}

console.log(`\nhouse USDC-Dev: ${usd(start)} -> ${usd(await micro())}`);
const ok = checks.every(([, v]) => v);
console.log(ok ? `\nDEVNET FAIL-SAFES: PASS (${checks.length} checks)` : `\nDEVNET FAIL-SAFES: FAIL (${checks.filter(([, v]) => !v).map(([w]) => w).join('; ')})`);
process.exit(ok ? 0 : 1);
