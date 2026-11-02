// pokejam-judge-worker: claims the next ready job from the queue (pokejam_judge_jobs, migration 20261129) and judges it.
// Shadow mode: the verdict is saved and nothing else changes. A throw leaves the lease to expire, so the job is tried
// again until its attempts run out; a crash mid-run ends up in the same place.
import { authorized, json } from '../pack/config.ts';
import type { AdminClient } from './deps.ts';
import { judgeMatch, type JudgeMatchDeps, type MatchResult } from './handler.ts';

/** Jobs claimed per run. One match costs about 1 s of the assumed 2 s CPU limit (docs/multiplayer.md). */
export const CLAIM_PER_RUN = 1;

export interface JudgeJob { match_id: string; rejudge: boolean }

export interface QueueDeps {
  /** pokejam_judge_claim. */
  claim(n: number): Promise<JudgeJob[]>;
  /** pokejam_judge_finish. */
  finish(match: string, ok: boolean): Promise<unknown>;
}

export interface WorkerDeps extends QueueDeps { judge: JudgeMatchDeps }

export function queueDeps(admin: AdminClient): QueueDeps {
  return {
    async claim(n) {
      const { data, error } = await admin.rpc('pokejam_judge_claim', { p_n: n });
      if (error) throw new Error(error.message);
      return (data ?? []) as JudgeJob[];
    },
    async finish(match, ok) {
      const { error } = await admin.rpc('pokejam_judge_finish', { p_match: match, p_ok: ok });
      if (error) throw new Error(error.message);
    },
  };
}

/** Judge what the queue hands out. One job failing doesn't stop the others. */
export async function runWorker(deps: WorkerDeps): Promise<MatchResult[]> {
  const jobs = await deps.claim(CLAIM_PER_RUN);
  const results: MatchResult[] = [];
  for (const job of jobs) {
    try {
      const r = await judgeMatch(job.match_id, deps.judge, { force: job.rejudge });
      await deps.finish(job.match_id, true);
      results.push(r);
    } catch (e) {
      console.error(`pokejam-judge-worker: match ${job.match_id}:`, e);
      results.push({ match_id: job.match_id, result: 'error', reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return results;
}

export async function workerHandler(req: Request, cfg: { serviceKey: string }, deps: WorkerDeps): Promise<Response> {
  if (!authorized(req, cfg)) return json({ error: 'service key required' }, 401);
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  try {
    return json({ ok: true, results: await runWorker(deps) });
  } catch (e) {
    console.error('pokejam-judge-worker: claim failed:', e);
    return json({ error: 'claim failed' }, 500);
  }
}
