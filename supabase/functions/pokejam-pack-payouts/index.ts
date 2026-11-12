// pokejam-pack-payouts: settle Pack Battles prizes. Run it every minute (pg_cron + pg_net, or a scheduled
// invocation) with the service key; each run recovers stuck prizes, then buys and sends up to 5.
// See supabase/functions/README.md.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { CollectorCrypt } from '../_shared/pack/collector-crypt.ts';
import { authorized, json, packConfig, realMoneyRefusal } from '../_shared/pack/config.ts';
import { keypairFromSecret } from '../_shared/pack/ed25519.ts';
import { machineRows } from '../_shared/pack/machines.ts';
import { MAX_ATTEMPTS, healthAlerts, runPayouts } from '../_shared/pack/payouts.ts';
import { Rpc } from '../_shared/pack/rpc.ts';
import { sqlStore, type RpcCall } from '../_shared/pack/store.ts';

Deno.serve(async (req) => {
  let cfg;
  try {
    cfg = packConfig((k) => Deno.env.get(k));
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
  if (!authorized(req, cfg)) return json({ error: 'service key required' }, 401);

  const sb = createClient(cfg.supabaseUrl, cfg.serviceKey, { auth: { persistSession: false } });
  const call: RpcCall = async (fn, args) => {
    const { data, error } = await sb.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data;
  };
  const store = sqlStore(call);
  // Real money only with the database's switches set for it, and test money only on devnet.
  const refusal = realMoneyRefusal(cfg.cluster, await store.health(MAX_ATTEMPTS));
  if (refusal) {
    console.error(`payouts: refusing to run: ${refusal}`);
    return json({ error: `refusing to run: ${refusal}` }, 500);
  }
  const rpc = new Rpc(cfg.rpcUrl);
  const cc = new CollectorCrypt({
    house: await keypairFromSecret(cfg.houseSecret), rpc, baseUrl: cfg.ccBaseUrl, apiKey: cfg.ccApiKey, openTimeoutMs: 60_000,
    guard: { houseUsdc: cfg.houseUsdcAccount, usdcMint: cfg.usdcMint, ccSigner: cfg.ccSigner },
  });

  await store.recover(MAX_ATTEMPTS);
  const results = await runPayouts({
    store, cc, rpc, houseUsdcAccount: cfg.houseUsdcAccount, fallbackAfter: cfg.fallbackAfter, choiceSeconds: cfg.choiceSeconds,
    machineCodes: cfg.ccMachineCodes,
    onMachines: async (m) => { await call('pokejam_pack_upsert_machines', { p_rows: machineRows(m) }); },
  }, 5);
  // What the house owes against what it holds, and anything that needs a person: logged every run, and sent
  // to ALERT_WEBHOOK_URL at most hourly for the same alert.
  const houseUsdc = cfg.houseUsdcAccount ? await rpc.tokenBalance(cfg.houseUsdcAccount).catch(() => null) : null;
  const { health, owed, alerts } = await healthAlerts(store, houseUsdc);
  for (const a of alerts) {
    console.error(`payouts ALERT: ${a.text}`);
    if (cfg.alertWebhookUrl && (await store.alertDue(a.key, 60).catch(() => false))) {
      const text = `PokeJam Pack Battles (${cfg.cluster}): ${a.text}`;
      await fetch(cfg.alertWebhookUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, content: text }) })
        .catch((e) => console.error(`payouts: couldn't send the alert: ${(e as Error).message}`));
    }
  }
  return json({ ok: true, cluster: cfg.cluster, results, health: { ...health, owed, house_usdc: houseUsdc }, alerts: alerts.map((a) => a.text) });
});
