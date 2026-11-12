// Links a Phantom wallet to the signed-in account after checking a signed message. See _shared/wallet/linkHandler.ts.
// No extra secrets: it uses the project's URL and service role, like the other PokeJam functions.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { verifySignature } from '../_shared/pack/ed25519.ts';
import { linkWalletHandler, type LinkResult } from '../_shared/wallet/linkHandler.ts';

const url = Deno.env.get('SUPABASE_URL')!;
const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const admin = createClient(url, service, { auth: { persistSession: false } });
const origins = (Deno.env.get('LINK_ALLOWED_ORIGINS') ?? 'https://pokejam.xyz,https://www.pokejam.xyz').split(',').map((s) => s.trim()).filter(Boolean);

Deno.serve((req) => linkWalletHandler(req, origins, {
  async userOf(jwt) {
    const { data, error } = await admin.auth.getUser(jwt);
    if (error || !data.user) return null;
    return { id: data.user.id, anonymous: data.user.is_anonymous === true };
  },
  verify: (address, message, signature) => verifySignature(address, message, signature),
  async link(userId, wallet, nonce) {
    const { data, error } = await admin.rpc('pokejam_link_wallet', { p_user: userId, p_wallet: wallet, p_nonce: nonce });
    if (error) throw new Error(error.message);
    return data as LinkResult;
  },
}));
