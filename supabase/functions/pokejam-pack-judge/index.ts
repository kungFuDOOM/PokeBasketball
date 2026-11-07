// pokejam-pack-judge: decide finished Pack Battles from both players' signed inputs, and settle them.
// Run it every minute with the service key (pg_cron + pg_net, or a scheduled invocation). Players also call it right
// after their game (with their own sign-in) so the result comes sooner; it only ever settles battles that are due,
// so who calls it doesn't matter. Each run refunds searches nobody is polling any more, then judges up to 5 battles.
// See supabase/functions/README.md.

import { createClient } from 'npm:@supabase/supabase-js@2';
import { authorized, json } from '../_shared/pack/config.ts';
// The judge and the game engine, bundled from the app's sources (scripts/build-pack-judge.mjs).
import { judgeBattle } from './judge.bundle.js';

interface DueBattle {
  match_id: string; tier: string; seed: number | string; quarter_len: number; host: string; guest: string;
  host_key: string | null; guest_key: string | null; host_name: string; guest_name: string; uploads: string[];
}
type Settlement = { result: 'host' | 'guest' | 'void' | 'review'; outcome: string; note: string };

Deno.serve(async (req) => {
  const url = Deno.env.get('SUPABASE_URL');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceKey) return json({ error: 'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required' }, 500);
  const sb = createClient(url, serviceKey, { auth: { persistSession: false } });

  // The service key (cron), or any signed-in player: a player's call can only settle battles that are already due.
  if (!authorized(req, { serviceKey })) {
    const token = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
    const { data } = token ? await sb.auth.getUser(token) : { data: { user: null } };
    if (!data.user) return json({ error: 'sign in first' }, 401);
  }

  const rpc = async <T>(fn: string, args: Record<string, unknown>): Promise<T> => {
    const { data, error } = await sb.rpc(fn, args);
    if (error) throw new Error(`${fn}: ${error.message}`);
    return data as T;
  };

  const swept = await rpc<number>('pokejam_pack_sweep', { p_limit: 50 });
  const due = await rpc<DueBattle[]>('pokejam_pack_due_battles', { p_limit: 5 });
  const results: { match: string; result: string; outcome: string }[] = [];
  for (const b of due ?? []) {
    let s: Settlement;
    try {
      s = (await judgeBattle(b)) as Settlement;
    } catch (e) {
      // A judge that crashes decides nothing: hold the battle for a person, money untouched.
      s = { result: 'review', outcome: 'judge-error', note: (e as Error).message };
    }
    await rpc('pokejam_pack_settle', { p_match: b.match_id, p_result: s.result, p_outcome: s.outcome, p_note: s.note });
    console.log(`pack-judge: ${b.match_id} ${s.result} (${s.outcome}) ${s.note}`);
    results.push({ match: b.match_id, result: s.result, outcome: s.outcome });
  }
  return json({ ok: true, swept, results });
});
