// pokejam-human: Turnstile check before online play. See _shared/human/handler.ts and supabase/functions/README.md.
// Secrets: TURNSTILE_SECRET_KEY; optionally HUMAN_PASS_MINUTES (default 20) and HUMAN_ALLOWED_ORIGINS.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { humanConfig, humanHandler } from '../_shared/human/handler.ts';

const url = Deno.env.get('SUPABASE_URL')!;
const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const admin = createClient(url, service, { auth: { persistSession: false } });

Deno.serve((req) => humanHandler(req, humanConfig((k) => Deno.env.get(k)), {
  fetch,
  async userOf(jwt) {
    const { data, error } = await admin.auth.getUser(jwt);
    if (error || !data.user) {
      console.error('pokejam-human: getUser failed:', error ? `${error.message} (status ${error.status})` : 'no user');
      return null;
    }
    return data.user.id;
  },
  async grant(userId, minutes) {
    const { data, error } = await admin.rpc('pokejam_grant_human', { p_user: userId, p_minutes: minutes });
    if (error) throw new Error(error.message);
    return String(data);
  },
}));
