// pokejam-ads: book the courtside LED board by burning $PJAM. See _shared/ads/handler.ts and supabase/functions/README.md.
// Secrets: ADS_CLUSTER (devnet), AD_MINT, AD_FAUCET_SECRET (devnet only); optionally ADS_RPC_URL, ADS_ALLOWED_ORIGINS,
// ADS_PRIORITY_MICROLAMPORTS, AD_FAUCET_AMOUNT, ADS_ALERT_WEBHOOK_URL (reported ads). Deploy with --no-verify-jwt: the
// page calls it without signing in.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { adsConfig } from '../_shared/ads/config.ts';
import { adsHandler } from '../_shared/ads/handler.ts';
import { Rpc } from '../_shared/pack/rpc.ts';

const cfg = adsConfig((k) => Deno.env.get(k));
const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
const rpc = new Rpc(cfg.rpcUrl);
const webhook = Deno.env.get('ADS_ALERT_WEBHOOK_URL')?.trim();

Deno.serve((req) => adsHandler(req, cfg, {
  rpc,
  async db(fn, args) {
    const { data, error } = await admin.rpc(fn, args ?? {});
    if (error) throw new Error(error.message);
    return data;
  },
  // Slack reads `text`, Discord reads `content`.
  alert: webhook ? async (text) => { await fetch(webhook, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, content: text }) }); } : undefined,
}));
