// Wires the USDC handlers to Supabase (service role) and the Solana RPC. Shared by the two Edge Functions; has no logic of its own.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { Rpc } from '../pack/rpc.ts';
import { solanaAddressOf, usdcConfig, type UsdcConfig } from './usdc-config.ts';
import type { UsdcDeps } from './usdc-handlers.ts';
import { fetchTransaction } from './usdc-verify.ts';

export function usdcRuntime(): { cfg: UsdcConfig; deps: UsdcDeps } {
  const cfg = usdcConfig((k) => Deno.env.get(k));
  const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });
  const rpc = new Rpc(cfg.rpcUrl);
  const call = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await admin.rpc(fn, args);
    if (error) throw new Error(error.message);
    return data as T;
  };
  const deps: UsdcDeps = {
    log: (m) => console.error(m),
    async userOf(jwt) {
      const { data, error } = await admin.auth.getUser(jwt);
      if (error || !data.user) return null;
      return { id: data.user.id, anonymous: data.user.is_anonymous === true, wallet: solanaAddressOf(data.user) };
    },
    createIntent: (a) => call('pokejam_shield_usdc_intent', {
      p_user: a.user, p_anonymous: a.anonymous, p_sku: a.sku, p_wallet: a.wallet, p_reference: a.reference, p_memo: a.memo,
      p_receiver: a.receiver, p_mint: a.mint, p_cluster: a.cluster,
    }),
    getIntent: (id, user) => call('pokejam_shield_usdc_intent_get', { p_intent: id, p_user: user }),
    credit: (intent, user, signature) => call('pokejam_shield_credit_usdc', { p_intent: intent, p_user: user, p_signature: signature }),
    getTransaction: (signature) => fetchTransaction((m, p) => rpc.call(m, p), signature, cfg.commitment),
  };
  return { cfg, deps };
}
