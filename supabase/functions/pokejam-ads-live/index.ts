// pokejam-ads-live: the live site's (pokejam.xyz) courtside LED board booking. Same handler as the devnet test site's
// pokejam-ads (_shared/ads/handler.ts), configured by adsConfigLive: mainnet unless ADS_LIVE_CLUSTER is "devnet", and
// it refuses to start on mainnet unless ADS_ALLOW_MAINNET is exactly "true". No faucet on mainnet.
// Secrets: ADS_ALLOW_MAINNET, ADS_PJAM_MINT (optional, defaults to the official $PJAM; needs user confirmation);
// optionally ADS_LIVE_CLUSTER, ADS_LIVE_RPC_URL, ADS_LIVE_ALLOWED_ORIGINS, ADS_LIVE_PRIORITY_MICROLAMPORTS,
// ADS_ALERT_WEBHOOK_URL. The ADS_LIVE_* names keep the devnet function's ADS_* secrets untouched (secrets are
// project-wide). Deploy with --no-verify-jwt: the page calls it without signing in.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { adsConfigLive } from '../_shared/ads/config.ts';
import { adsHandler } from '../_shared/ads/handler.ts';
import { Rpc } from '../_shared/pack/rpc.ts';

const cfg = adsConfigLive((k) => Deno.env.get(k), { cluster: Deno.env.get('ADS_LIVE_CLUSTER')?.trim() === 'devnet' ? 'devnet' : 'mainnet-beta' });
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
