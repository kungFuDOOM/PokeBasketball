// pokejam-ice: TURN credentials for an online match's direct link. See _shared/ice/handler.ts and
// supabase/functions/README.md. Secrets: TURN_KEY_ID, TURN_KEY_API_TOKEN, optionally ICE_ALLOWED_ORIGINS.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { iceConfig, iceHandler } from '../_shared/ice/handler.ts';

const url = Deno.env.get('SUPABASE_URL')!;
const anon = Deno.env.get('SUPABASE_ANON_KEY')!;

Deno.serve((req) => iceHandler(req, iceConfig((k) => Deno.env.get(k)), {
  fetch,
  async iceOk(jwt, matchId) {
    const sb = createClient(url, anon, { global: { headers: { authorization: `Bearer ${jwt}` } }, auth: { persistSession: false } });
    const { data, error } = await sb.rpc('pokejam_ice_ok', { p_match: matchId });
    if (error) throw new Error(error.message);
    return data === true;
  },
}));
