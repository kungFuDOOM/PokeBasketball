// The signed-in player's holder entries. Balance reads use RAFFLE_RPC_URL. See _shared/raffle/holder.ts.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { walletWhole, type Rpc } from '../_shared/raffle/balance.ts';
import { holderHandler } from '../_shared/raffle/holder.ts';

const url = Deno.env.get('SUPABASE_URL')!;
const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const rpcUrl = Deno.env.get('RAFFLE_RPC_URL') ?? 'https://api.mainnet-beta.solana.com';
const admin = createClient(url, service, { auth: { persistSession: false } });
const origins = [...new Set([
  ...(Deno.env.get('RAFFLE_ALLOWED_ORIGINS') ?? 'https://pokejam.xyz,https://www.pokejam.xyz').split(','),
  'https://pokejam.xyz',
  'https://www.pokejam.xyz',
].map((s) => s.trim()).filter(Boolean))];

const rpc: Rpc = { async call(method, params) {
  const res = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = await res.json() as { result?: unknown; error?: { message?: string } };
  if (!res.ok || body.error) throw new Error(body.error?.message ?? `rpc ${res.status}`);
  return body.result;
} };

Deno.serve((req) => holderHandler(req, origins, {
  async userOf(jwt) {
    const { data, error } = await admin.auth.getUser(jwt);
    if (error || !data.user) return null;
    return { id: data.user.id, anonymous: data.user.is_anonymous === true };
  },
  async walletsOf(userId) {
    const { data, error } = await admin.rpc('pokejam_raffle_wallets', { p_user: userId });
    if (error) throw new Error(error.message);
    return Array.isArray(data) ? data.filter((w): w is string => typeof w === 'string') : [];
  },
  async wholes(mint, wallets) {
    const out: bigint[] = [];
    for (const w of wallets) out.push(await walletWhole(rpc, mint, w));
    return out;
  },
  async config() {
    const { data, error } = await admin.rpc('pokejam_raffle_cfg');
    if (error) throw new Error(error.message);
    const cfg = data as { pjam_per_entry?: number; pjam_counted_cap?: number; pjam_mint?: string };
    return {
      pjamPerEntry: Number(cfg.pjam_per_entry),
      pjamCountedCap: Number(cfg.pjam_counted_cap),
      pjamMint: String(cfg.pjam_mint ?? ''),
    };
  },
}));
