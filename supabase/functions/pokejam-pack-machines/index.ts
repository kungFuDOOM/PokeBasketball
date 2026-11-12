// pokejam-pack-machines: refresh pokejam_pack_machines from Collector Crypt's machines, so the lobby shows live
// prices and odds and pauses a tier whose machine is missing, empty or repriced. With CC_API_KEY, a tier uses our
// own builder-fee machine (GET /api/v1/machines) when the key owns one, and its partner fee is recorded, which
// drops the Pack Battles fee on that tier. Run it every 10 minutes with the service key. Needs no house wallet.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { authorized, json, packConfig } from '../_shared/pack/config.ts';
import { machineRows, parseMachines, tierMachines } from '../_shared/pack/machines.ts';

Deno.serve(async (req) => {
  let cfg;
  try {
    cfg = packConfig((k) => Deno.env.get(k), { needHouse: false });
  } catch (e) {
    return json({ error: (e as Error).message }, 500);
  }
  if (!authorized(req, cfg)) return json({ error: 'service key required' }, 401);

  const headers: Record<string, string> = cfg.ccApiKey ? { 'x-api-key': cfg.ccApiKey } : {};
  const res = await fetch(`${cfg.ccBaseUrl}/api/machines`, { headers });
  if (!res.ok) return json({ error: `Collector Crypt answered ${res.status}` }, 502);
  // Our partner machines; a key that can't be read yet (not approved, or no machines adopted) leaves CC's own.
  let partner = parseMachines(null);
  let partnerNote: string | null = null;
  if (cfg.ccApiKey) {
    const pr = await fetch(`${cfg.ccBaseUrl}/api/v1/machines`, { headers });
    if (pr.ok) partner = parseMachines(await pr.json());
    else partnerNote = `partner machines unavailable (${pr.status}); using Collector Crypt's own machines`;
  }
  const rows = machineRows(tierMachines(parseMachines(await res.json()), partner, cfg.ccMachineCodes));
  const sb = createClient(cfg.supabaseUrl, cfg.serviceKey, { auth: { persistSession: false } });
  const { error } = await sb.rpc('pokejam_pack_upsert_machines', { p_rows: rows });
  if (error) return json({ error: error.message }, 500);
  return json({ ok: true, cluster: cfg.cluster, machines: rows, ...(partnerNote ? { note: partnerNote } : {}) });
});
