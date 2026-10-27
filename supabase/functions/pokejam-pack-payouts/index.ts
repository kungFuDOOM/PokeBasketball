// pokejam-pack-payouts: settle Pack Battles prizes. Run it every minute (pg_cron + pg_net, or a scheduled
// invocation) with the service key; each run recovers stuck prizes, then buys and sends up to 5.
// See supabase/functions/README.md.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { CollectorCrypt } from '../_shared/pack/collector-crypt.ts';
import { authorized, json, packConfig } from '../_shared/pack/config.ts';
import { keypairFromSecret } from '../_shared/pack/ed25519.ts';
import { machineRows } from '../_shared/pack/machines.ts';
import { MAX_ATTEMPTS, runPayouts } from '../_shared/pack/payouts.ts';
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
  const rpc = new Rpc(cfg.rpcUrl);
  const cc = new CollectorCrypt({
    house: await keypairFromSecret(cfg.houseSecret), rpc, baseUrl: cfg.ccBaseUrl, apiKey: cfg.ccApiKey, openTimeoutMs: 60_000,
    guard: { houseUsdc: cfg.houseUsdcAccount, usdcMint: cfg.usdcMint, ccSigner: cfg.ccSigner },
  });

  await store.recover(MAX_ATTEMPTS);
  const results = await runPayouts({
    store, cc, rpc, houseUsdcAccount: cfg.houseUsdcAccount, fallbackAfter: cfg.fallbackAfter, choiceSeconds: cfg.choiceSeconds,
    onMachines: async (m) => { await call('pokejam_pack_upsert_machines', { p_rows: machineRows(m) }); },
  }, 5);
  return json({ ok: true, cluster: cfg.cluster, results });
});
