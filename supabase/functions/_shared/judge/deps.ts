// What the judge reads and writes, against the database with the service role. Shared by the moderators' pokejam-judge
// and the queue's pokejam-judge-worker.
import { judgeSetupFromRow, type ServerMatchRow } from '../../../../src/multiplayer/shared/matchSetup.ts';
import type { JudgeMatchDeps } from './handler.ts';

interface DbResult { data: unknown; error: { message: string } | null }

/** The parts of a service-role Supabase client the judge uses. */
export interface AdminClient {
  // deno-lint-ignore no-explicit-any
  rpc(fn: string, args?: Record<string, unknown>): any;
  // deno-lint-ignore no-explicit-any
  from(table: string): any;
}

export function judgeDeps(admin: AdminClient): JudgeMatchDeps {
  return {
    async setupOf(id) {
      const { data, error } = await admin.rpc('pokejam_match_setup', { p_match: id }) as DbResult;
      if (error) throw new Error(error.message);
      return data ? judgeSetupFromRow(data as ServerMatchRow) : null;
    },
    async hasVerdict(id) {
      const { data, error } = await admin.from('pokejam_match_verdicts').select('match_id').eq('match_id', id).maybeSingle() as DbResult;
      if (error) throw new Error(error.message);
      return !!data;
    },
    async uploadsOf(id) {
      const { data, error } = await admin.from('pokejam_match_evidence').select('evidence, user_id').eq('match_id', id)
        .order('created_at').order('user_id').limit(2) as DbResult;
      if (error) throw new Error(error.message);
      return ((data ?? []) as { evidence: string; user_id: string }[]).map((r) => ({ evidence: r.evidence, user: r.user_id }));
    },
    async record(v) {
      const { error } = await admin.rpc('pokejam_record_verdict', {
        p_match: v.match, p_status: v.status, p_winner_side: v.winnerSide, p_cheater_side: v.cheaterSide,
        p_score_host: v.scoreHost, p_score_guest: v.scoreGuest, p_ticks: v.ticks, p_notes: v.notes,
        p_last_host: v.lastFrameHost, p_last_guest: v.lastFrameGuest, p_fault_user: v.faultUser,
      }) as DbResult;
      if (error) throw new Error(error.message);
    },
  };
}
