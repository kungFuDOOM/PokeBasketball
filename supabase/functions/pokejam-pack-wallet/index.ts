// pokejam-pack-wallet: Pack Battles money in and out. Players call it (with their session) to prove a wallet, get a
// deposit to sign, and claim it; the cron calls { action: 'run' } every minute with the service key to scan the
// house account for deposits and send withdrawals. See _shared/pack/wallet.ts and supabase/functions/README.md.
// Secrets: those of pokejam-pack-payouts (CLUSTER, HOUSE_SECRET_KEY, HOUSE_USDC_ACCOUNT, RPC_URL on mainnet), plus
// WALLET_ALLOWED_ORIGINS and optionally PRIORITY_MICROLAMPORTS.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { json, packConfig, realMoneyRefusal } from '../_shared/pack/config.ts';
import { keypairFromSecret } from '../_shared/pack/ed25519.ts';
import { MAX_ATTEMPTS, healthAlerts } from '../_shared/pack/payouts.ts';
import { Rpc } from '../_shared/pack/rpc.ts';
import { sqlStore, type RpcCall } from '../_shared/pack/store.ts';
import { checkHouseAccount, runWithdrawals, scanDeposits, walletHandler } from '../_shared/pack/wallet.ts';

let cfg: ReturnType<typeof packConfig>;
try {
  cfg = packConfig((k) => Deno.env.get(k));
} catch (e) {
  const why = (e as Error).message;
  Deno.serve(() => json({ error: why }, 500));
  throw e;
}
const sb = createClient(cfg.supabaseUrl, cfg.serviceKey, { auth: { persistSession: false } });
const call: RpcCall = async (fn, args) => {
  const { data, error } = await sb.rpc(fn, args);
  if (error) throw new Error(`${fn}: ${error.message}`);
  return data;
};
const store = sqlStore(call);
const rpc = new Rpc(cfg.rpcUrl);
const house = await keypairFromSecret(cfg.houseSecret);
const money = { call, rpc, house, houseUsdcAccount: cfg.houseUsdcAccount, usdcMint: cfg.usdcMint, priorityMicroLamports: cfg.priorityMicroLamports, log: console };
const origins = (Deno.env.get('WALLET_ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);

Deno.serve((req) => walletHandler(req, { origins, serviceKey: cfg.serviceKey, cluster: cfg.cluster }, {
  ...money,
  async userOf(jwt) {
    const { data, error } = await sb.auth.getUser(jwt);
    return error || !data.user ? null : data.user.id;
  },
  async runAll() {
    const refusal = realMoneyRefusal(cfg.cluster, await store.health(MAX_ATTEMPTS));
    if (refusal) throw new Error(`refusing to run: ${refusal}`);
    await checkHouseAccount(rpc, { address: house.address, usdcAccount: cfg.houseUsdcAccount, usdcMint: cfg.usdcMint });
    const deposits = await scanDeposits(money);
    const withdrawals = await runWithdrawals(money, 5);
    const houseUsdc = await rpc.tokenBalance(cfg.houseUsdcAccount).catch(() => null);
    const { health, owed, alerts } = await healthAlerts(store, houseUsdc);
    if (deposits.backlog) alerts.push({ key: 'deposit-backlog', text: 'The deposit scan is too far behind to catch up in one run; it is not advancing' });
    for (const a of alerts) {
      console.error(`wallet ALERT: ${a.text}`);
      if (cfg.alertWebhookUrl && (await store.alertDue(a.key, 60).catch(() => false))) {
        const text = `PokeJam Pack Battles (${cfg.cluster}): ${a.text}`;
        await fetch(cfg.alertWebhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, content: text }) })
          .catch((e) => console.error(`wallet: couldn't send the alert: ${(e as Error).message}`));
      }
    }
    return { ok: true, cluster: cfg.cluster, deposits, withdrawals, health: { ...health, owed, house_usdc: houseUsdc }, alerts: alerts.map((a) => a.text) };
  },
}));
