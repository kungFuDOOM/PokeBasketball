// pokejam-pack-machines: refresh pokejam_pack_machines from Collector Crypt's GET /api/machines, so the lobby
// shows live prices and odds and pauses a tier whose machine is missing, empty or repriced. Run it every
// 10 minutes with the service key. Needs no house wallet.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { authorized, json, packConfig } from '../_shared/pack/config.ts';
import { machineRows, parseMachines } from '../_shared/pack/machines.ts';

Deno.serve(async (req) => {
  let cfg;
  try {
    cfg = packConfig((k) => Deno.env.get(k), { needHouse: false });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
  if (!authorized(req, cfg)) return json({ error: 'service key required' }, 401);

  const res = await fetch(`${cfg.ccBaseUrl}/api/machines`, { headers: cfg.ccApiKey ? { 'x-api-key': cfg.ccApiKey } : {} });
  if (!res.ok) return json({ error: `Collector Crypt answered ${res.status}` }, 502);
  const rows = machineRows(parseMachines(await res.json()));
  const sb = createClient(cfg.supabaseUrl, cfg.serviceKey, { auth: { persistSession: false } });
  const { error } = await sb.rpc('pokejam_pack_upsert_machines', { p_rows: rows });
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, cluster: cfg.cluster, machines: rows });
});
