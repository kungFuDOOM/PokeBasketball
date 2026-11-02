// pokejam-judge: judges reported matches on demand for the moderation page. See _shared/judge/handler.ts and
// supabase/functions/README.md. Optional secret: JUDGE_ALLOWED_ORIGINS.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { judgeDeps } from '../_shared/judge/deps.ts';
import { judgeConfig, judgeHandler } from '../_shared/judge/handler.ts';

const url = Deno.env.get('SUPABASE_URL')!;
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const admin = createClient(url, service, { auth: { persistSession: false } });

Deno.serve((req) => judgeHandler(req, judgeConfig((k) => Deno.env.get(k)), {
  ...judgeDeps(admin),
  async isAdmin(jwt) {
    // As the caller, so pokejam_is_admin checks their auth.uid().
    const asCaller = createClient(url, anonKey, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${jwt}` } } });
    const { data, error } = await asCaller.rpc('pokejam_is_admin');
    if (error) {
      console.error('pokejam-judge: pokejam_is_admin failed:', error.message);
      return false;
    }
    return data === true;
  },
}));
