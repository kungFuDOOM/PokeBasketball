// pokejam-raffle-draw: a moderator draws the closed week's card raffle. See _shared/raffle/handler.ts.
// Optional: RAFFLE_RPC_URL (Solana RPC, default mainnet), RAFFLE_ALLOWED_ORIGINS.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { pjamWholes, type Rpc } from '../_shared/raffle/balance.ts';
import { raffleDrawConfig, raffleDrawHandler, type Qualifier } from '../_shared/raffle/handler.ts';

const url = Deno.env.get('SUPABASE_URL')!;
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const rpcUrl = Deno.env.get('RAFFLE_RPC_URL') ?? 'https://api.mainnet-beta.solana.com';
const admin = createClient(url, service, { auth: { persistSession: false } });

const rpc: Rpc = { async call(method, params) {
  const res = await fetch(rpcUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
  const body = await res.json() as { result?: unknown; error?: { message?: string } };
  if (!res.ok || body.error) throw new Error(body.error?.message ?? `rpc ${res.status}`);
  return body.result;
} };

function asCaller(jwt: string) {
  return createClient(url, anonKey, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${jwt}` } } });
}

Deno.serve((req) => raffleDrawHandler(req, raffleDrawConfig((k) => Deno.env.get(k)), {
  async isAdmin(jwt) {
    const { data, error } = await asCaller(jwt).rpc('pokejam_is_admin');
    if (error) return false;
    return data === true;
  },
  async adminId(jwt) {
    const { data } = await asCaller(jwt).auth.getUser();
    return data.user?.id ?? null;
  },
  async prep(week) {
    const { data, error } = await admin.rpc('pokejam_raffle_draw_prep', { p_week: week });
    if (error) throw new Error(error.message);
    return data;
  },
  balances(mint, rows) {
    return pjamWholes(rpc, mint, rows as Qualifier[]);
  },
  async commit(week, balances, adminId) {
    const { data, error } = await admin.rpc('pokejam_raffle_commit_draw', { p_week: week, p_balances: balances, p_admin: adminId });
    if (error) throw new Error(error.message);
    return data;
  },
}));
