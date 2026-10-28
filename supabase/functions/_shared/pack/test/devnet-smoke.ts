// Devnet smoke test for the payouts code (#10, #13): the real Collector Crypt devnet API, the real Solana devnet
// RPC and the real house wallet, with a local Postgres (PGlite) running the pack migrations instead of Supabase.
// Spends devnet USDC-Dev only (three $25 pulls). Run from the repo root:
//   bun supabase/functions/_shared/pack/test/devnet-smoke.ts <house keypair json> <house USDC-Dev account> <recipient>
import { readFileSync } from 'node:fs';
import { CollectorCrypt, CC_DEVNET } from '../collector-crypt.ts';
import { packConfig } from '../config.ts';
import { keypairFromSecret } from '../ed25519.ts';
import { machineRows, parseMachines } from '../machines.ts';
import { runPayouts } from '../payouts.ts';
import { Rpc } from '../rpc.ts';
import { sqlStore } from '../store.ts';
import { sql, testDb } from './helpers.ts';

const [houseFile, houseUsdc, recipient] = process.argv.slice(2);
const house = await keypairFromSecret(readFileSync(houseFile, 'utf8'));
const devnet = packConfig((k) => ({ SUPABASE_URL: 'local', SUPABASE_SERVICE_ROLE_KEY: 'local', HOUSE_USDC_ACCOUNT: houseUsdc })[k], { needHouse: false });
const rpc = new Rpc('https://api.devnet.solana.com');
const cc = new CollectorCrypt({
  house, rpc, baseUrl: CC_DEVNET, openTimeoutMs: 120_000,
  guard: { houseUsdc, usdcMint: devnet.usdcMint, ccSigner: devnet.ccSigner },
});
const t = await testDb();
const store = sqlStore(t.service);
const log = { info: (m: string) => console.log('  ' + m), warn: (m: string) => console.log('  ! ' + m), error: (m: string) => console.log('  x ' + m) };
const usdc = async () => (await rpc.tokenBalance(houseUsdc)) / 1e6;
const checks: [string, boolean][] = [];
const check = (what: string, ok: boolean) => { checks.push([what, ok]); console.log(`  ${ok ? '✓' : '✗'} ${what}`); };

console.log(`house ${house.address}: ${await usdc()} USDC-Dev`);

// 1. Machines from CC devnet into pokejam_pack_machines.
await t.service('pokejam_pack_upsert_machines', { p_rows: machineRows(parseMachines(await cc.machines())) });
for (const m of await sql(t.db, 'select code, price_micro, available, why, buyback from public.pokejam_pack_machines order by code')) console.log('machine', JSON.stringify(m));

// 2. Four prizes. Three are opened and wait at the reveal: the winner picks Sell it back on one, Keep it on one
//    (over a saved preference for cash), and lets the time run out on the last (preference: cash). The fourth's
//    pot is below CC's live price, so it must never be bought.
const winner = await t.user();
const stamp = Date.now();
const queue = async (battle: string, price: number, cash: boolean) =>
  (await t.service('pokejam_pack_queue_prize', { p_battle: `smoke-${battle}-${stamp}`, p_user: winner, p_wallet: recipient, p_tier: 'pokemon_25', p_price: price, p_prefer_cash: cash }) as Record<string, string>[])[0].pokejam_pack_queue_prize;
const sell = await queue('sell', 25_000_000, false);
const keep = await queue('keep', 25_000_000, true);
const timeout = await queue('timeout', 25_000_000, true);
const short = await queue('short', 20_000_000, false);

const prize = async (id: string) => (await sql(t.db, 'select state, nft_address, transfer_sig, cash_amount, sell_estimate, choose_by, last_error, pull from public.pokejam_pack_prizes where id = $1', [id]))[0];
const pull = (p: Record<string, unknown>) => p.pull as { name?: string; insuredValue?: number } | null;
const owner = async (id: string) => { const p = await prize(id); return p.nft_address ? await cc.ownerOf(String(p.nft_address)) : null; };
const choose = async (id: string, choice: string) =>
  (await t.callAs('authenticated', winner)('pokejam_pack_choose_prize', { p_id: id, p_choice: choice }) as Record<string, boolean>[])[0].pokejam_pack_choose_prize;
const balance = async () => Number((await t.asPlayer(winner, 'select public.pokejam_pack_balance() as b'))[0].b) / 1e6;

const before = await usdc();
const deps = { store, cc, rpc, houseUsdcAccount: houseUsdc, fallbackAfter: 1, choiceSeconds: 120, log,
  onMachines: async (m: ReturnType<typeof parseMachines>) => { await t.service('pokejam_pack_upsert_machines', { p_rows: machineRows(m) }); } };

console.log('\nrun 1: buy and open the pulls, then wait at the reveal…');
console.log('results', JSON.stringify(await runPayouts(deps, 5)));
for (const [label, id] of [['sell', sell], ['keep', keep], ['timeout', timeout]] as const) {
  const p = await prize(id);
  console.log(`  ${label}: ${p.state} | ${pull(p)?.name} ($${pull(p)?.insuredValue}) | sell for about $${Number(p.sell_estimate) / 1e6} | choose by ${new Date(String(p.choose_by)).toISOString()}`);
  check(`${label}: revealed, and the card is still in the house wallet`, p.state === 'revealed' && (await owner(id)) === house.address);
}
const ps = await prize(short);
check(`short pot: refused before paying and refunded (${ps.last_error})`, ps.state === 'refunded');
check('a second run before any pick does nothing', (await runPayouts(deps, 5)).length === 0);

console.log('\nthe winner picks: Sell it back on one, Keep it on another; the third runs out of time');
check('someone else cannot pick', !(await t.callAs('authenticated', await t.user())('pokejam_pack_choose_prize', { p_id: sell, p_choice: 'keep' }) as Record<string, boolean>[])[0].pokejam_pack_choose_prize);
check('Sell it back accepted', await choose(sell, 'sell'));
check('Keep it accepted', await choose(keep, 'keep'));
await sql(t.db, "update public.pokejam_pack_prizes set choose_by = now() - interval '1 second' where id = $1", [timeout]);

console.log('\nrun 2: settle the picks…');
console.log('results', JSON.stringify(await runPayouts(deps, 5)));
const [s, k, o] = [await prize(sell), await prize(keep), await prize(timeout)];
console.log(`  sell:    ${s.state} | credited $${Number(s.cash_amount) / 1e6} (estimate $${Number(s.sell_estimate) / 1e6})`);
console.log(`  keep:    ${k.state} | tx ${k.transfer_sig}`);
console.log(`  timeout: ${o.state} | credited $${Number(o.cash_amount) / 1e6}`);
check('sell: sold back to CC and credited', s.state === 'cashed' && (await owner(sell)) !== recipient && (await owner(sell)) !== house.address);
check('keep: the card is in the winner\'s wallet on-chain, despite their cash preference', k.state === 'sent' && (await owner(keep)) === recipient);
check('timeout: the saved preference (cash) applied', o.state === 'cashed');
check('a pick after settling is refused', !(await choose(sell, 'keep')));
const bal = await balance();
const want = Number(s.cash_amount) / 1e6 + Number(o.cash_amount) / 1e6 + 20;
check(`winner's ledger: $${bal} = two buybacks + the $20 refunded pot`, Math.abs(bal - want) < 1e-9);
console.log(`house USDC-Dev: ${before} -> ${await usdc()} (three pulls bought, two buybacks received)`);

const ok = checks.every(([, v]) => v);
console.log(ok ? '\nDEVNET SMOKE: PASS' : `\nDEVNET SMOKE: FAIL (${checks.filter(([, v]) => !v).map(([w]) => w).join('; ')})`);
process.exit(ok ? 0 : 1);
