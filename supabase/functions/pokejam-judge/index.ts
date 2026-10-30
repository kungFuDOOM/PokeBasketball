// pokejam-judge: judges reported matches on demand for the moderation page. See _shared/judge/handler.ts and
// supabase/functions/README.md. Optional secret: JUDGE_ALLOWED_ORIGINS.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { judgeConfig, judgeHandler } from '../_shared/judge/handler.ts';

const url = Deno.env.get('SUPABASE_URL')!;
const anonKey = Deno.env.get('SUPABASE_ANON_KEY')!;
const service = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const admin = createClient(url, service, { auth: { persistSession: false } });

Deno.serve((req) => judgeHandler(req, judgeConfig((k) => Deno.env.get(k)), {
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
  async keysOf(id) {
    const { data, error } = await admin.from('pokejam_matches').select('host_key, guest_key').eq('id', id).maybeSingle();
    if (error) throw new Error(error.message);
    return data;
  },
  async hasVerdict(id) {
    const { data, error } = await admin.from('pokejam_match_verdicts').select('match_id').eq('match_id', id).maybeSingle();
    if (error) throw new Error(error.message);
    return !!data;
  },
  async uploadsOf(id) {
    const { data, error } = await admin.from('pokejam_match_evidence').select('evidence').eq('match_id', id)
      .order('created_at').order('user_id').limit(2);
    if (error) throw new Error(error.message);
    return (data ?? []).map((r) => r.evidence as string);
  },
  async record(v) {
    const { error } = await admin.rpc('pokejam_record_verdict', {
      p_match: v.match, p_status: v.status, p_winner_side: v.winnerSide, p_cheater_side: v.cheaterSide,
      p_score_host: v.scoreHost, p_score_guest: v.scoreGuest, p_ticks: v.ticks, p_notes: v.notes,
    });
    if (error) throw new Error(error.message);
  },
}));
