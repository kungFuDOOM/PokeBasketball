import { afterEach, describe, expect, it, vi } from 'vitest';
import { pack } from '../../../../src/multiplayer/shared/evidence.ts';
import { MIN_DELAY } from '../../../../src/multiplayer/shared/lockstep.ts';
import { matchKey, signTicks, type Evidence } from '../../../../src/multiplayer/shared/winnerCheck.ts';
import { ENGINE_VERSION } from '../../../../src/game/types.ts';
import { type Db, testDb } from '../../../tests/testDb.ts';
import { judgeDeps, type AdminClient } from './deps.ts';
import type { JudgeMatchDeps } from './handler.ts';
import { CLAIM_PER_RUN, queueDeps, runWorker, workerHandler, type JudgeJob, type WorkerDeps } from './worker.ts';

vi.setConfig({ testTimeout: 60_000 });
afterEach(() => vi.restoreAllMocks());

const KEY = 'service-key';
const post = (auth = `Bearer ${KEY}`, method = 'POST') => new Request('https://f.test/pokejam-judge-worker', { method, headers: { authorization: auth } });

/** Fakes for the queue and the judge. `verdictFor` throws for a match to stand in for a failing run. */
function fakes(jobs: JudgeJob[]) {
  const finished: [string, boolean][] = [];
  const applied: string[] = [];
  const claims: number[] = [];
  const recorded: string[] = [];
  const judge: JudgeMatchDeps = {
    setupOf: async () => null,
    hasVerdict: async () => false,
    uploadsOf: async (id) => { if (id === 'bad') throw new Error('database down'); return []; },
    record: async (v) => { recorded.push(v.match); },
  };
  const deps: WorkerDeps = {
    claim: async (n) => { claims.push(n); return jobs; },
    finish: async (m, ok) => { finished.push([m, ok]); },
    apply: async (m) => { applied.push(m); },
    judge,
  };
  return { deps, finished, claims, recorded, applied };
}

describe('pokejam-judge-worker', () => {
  it('takes the service key only, and POST only', async () => {
    const { deps, claims } = fakes([]);
    for (const auth of ['', 'Bearer nope', `Bearer ${KEY}x`]) expect((await workerHandler(post(auth), { serviceKey: KEY }, deps)).status).toBe(401);
    expect((await workerHandler(post(`Bearer ${KEY}`), { serviceKey: '' }, deps)).status).toBe(401);
    expect((await workerHandler(post(`Bearer ${KEY}`, 'GET'), { serviceKey: KEY }, deps)).status).toBe(405);
    expect(claims).toEqual([]);
  });

  it('claims exactly one match per run', async () => {
    const { deps, claims } = fakes([]);
    const r = await workerHandler(post(), { serviceKey: KEY }, deps);
    expect(await r.json()).toEqual({ ok: true, results: [] });
    expect(CLAIM_PER_RUN).toBe(1);
    expect(claims).toEqual([1]);
  });

  it('a failing match is not finished, so its lease runs out, and it does not stop another', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { deps, finished } = fakes([{ match_id: 'bad', rejudge: false }, { match_id: 'good', rejudge: false }]);
    const r = await workerHandler(post(), { serviceKey: KEY }, deps);
    expect(r.status).toBe(200);
    expect((await r.json()).results).toEqual([
      { match_id: 'bad', result: 'error', reason: 'database down' },
      { match_id: 'good', result: 'skipped', reason: 'no evidence' },
    ]);
    expect(finished).toEqual([['good', true]]);
  });

  it('a failed claim is a 500 with no details', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const { deps } = fakes([]);
    deps.claim = async () => { throw new Error('secret detail'); };
    const r = await workerHandler(post(), { serviceKey: KEY }, deps);
    expect(r.status).toBe(500);
    expect(await r.text()).not.toContain('secret');
  });

  it('logs how long each match took, also when it fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const { deps } = fakes([{ match_id: 'bad', rejudge: false }, { match_id: 'good', rejudge: false }]);
    await runWorker(deps);
    expect(log.mock.calls.map((c) => c[0])).toEqual([
      expect.stringMatching(/^pokejam-judge: match bad error database down in \d+ ms$/),
      expect.stringMatching(/^pokejam-judge: match good skipped no evidence in \d+ ms$/),
    ]);
  });
});

/** The client the Edge Functions get, over the test database, so argument names and row shapes are the real ones. */
function dbClient(t: Db): AdminClient {
  return {
    rpc: async (fn: string, args: Record<string, unknown> = {}) => {
      const names = Object.keys(args);
      const call = `public.${fn}(${names.map((n, i) => `${n} => $${i + 1}`).join(', ')})`;
      try {
        const vals = Object.values(args);
        if (fn === 'pokejam_judge_claim') return { data: await t.service(`select * from ${call}`, vals), error: null };
        return { data: (await t.service(`select ${call} as r`, vals))[0].r, error: null };
      } catch (e) {
        return { data: null, error: { message: (e as Error).message } };
      }
    },
    from: (table: string) => {
      let id = '';
      const rows = () => t.sql(`select * from public.${table} where match_id = $1 order by ${table === 'pokejam_match_evidence' ? 'created_at, user_id' : 'match_id'}`, [id]);
      const q = {
        select: () => q,
        eq: (_: string, v: string) => { id = v; return q; },
        order: () => q,
        limit: () => rows().then((data) => ({ data, error: null })),
        maybeSingle: () => rows().then((r) => ({ data: r[0] ?? null, error: null })),
      };
      return q;
    },
  };
}

describe('a Ranked match through the queue, on the real judge', () => {
  const z = { mx: 0.5, my: 0, b: 0 };
  const setup = (matchId: string) => ({ matchId, engineVersion: ENGINE_VERSION, seed: 1, quarterLen: 60,
    home: { name: 'H', abbr: 'H', color: '#3b6fd8', color2: '#16224a', roster: [25, 381, 6, 445, 382] },
    away: { name: 'G', abbr: 'G', color: '#e3350d', color2: '#3d0a03', roster: [94, 130, 149, 248, 150] } });

  it('judges once, stays open to the late upload, replaces the verdict with it, and changes no result', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const t = await testDb();
    const [host, guest] = [await t.user('Host'), await t.user('Guest')];
    const [hk, gk] = [await matchKey(), await matchKey()];
    const [{ id }] = await t.sql(`insert into public.pokejam_matches(queue, host, guest, host_mmr, guest_mmr, status, host_key, guest_key, seed, quarter_len)
      values ('ranked', $1, $2, 1000, 1000, 'active', $3, $4, 777, 60) returning id`, [host.id, guest.id, hk.publicKey, gk.publicKey]);
    const mid = id as string;
    await t.sql(`insert into public.pokejam_ranked_picks(match_id, user_id, preset_id) values ($1, $2, 'A'), ($1, $3, 'B')`, [mid, host.id, guest.id]);
    const admin = dbClient(t);
    const deps: WorkerDeps = { ...queueDeps(admin), judge: judgeDeps(admin) };
    const verdict = async () => (await t.sql('select status, ticks, last_frame_guest, shadow from public.pokejam_match_verdicts where match_id = $1', [mid]))[0];
    const state = async () => (await t.sql('select state, rejudge from public.pokejam_judge_jobs where match_id = $1', [mid]))[0];

    // The host's upload holds the guest's first 30 frames; the guest's own holds 60.
    const signed = async (n: number) => [await signTicks(hk.privateKey, mid, 0, MIN_DELAY, Array(60).fill(z)), await signTicks(gk.privateKey, mid, 1, MIN_DELAY, Array(n).fill(z))];
    const evidence = async (n: number): Promise<Evidence> => ({ setup: setup(mid), keys: [hk.publicKey, gk.publicKey], inputs: await signed(n), applied: [] });

    await t.as('authenticated', host.id)('select public.pokejam_report_result($1, true)', [mid]);
    await host.call('pokejam_submit_evidence', [mid, await pack(await evidence(30))]);
    expect(await runWorker(deps)).toEqual([]); // waiting for the other upload
    await t.sql(`update public.pokejam_judge_jobs set ready_at = now() where match_id = $1`, [mid]);

    expect(await runWorker(deps)).toEqual([{ match_id: mid, result: 'recorded', status: 'incomplete' }]);
    expect(await verdict()).toEqual({ status: 'incomplete', ticks: MIN_DELAY + 30, last_frame_guest: MIN_DELAY + 30, shadow: true });
    expect(await state()).toEqual({ state: 'done', rejudge: false });
    expect(await runWorker(deps)).toEqual([]);

    await guest.call('pokejam_submit_evidence', [mid, await pack(await evidence(60))]);
    expect(await state()).toEqual({ state: 'pending', rejudge: true });
    expect(await runWorker(deps)).toEqual([{ match_id: mid, result: 'recorded', status: 'incomplete' }]);
    expect(await verdict()).toEqual({ status: 'incomplete', ticks: MIN_DELAY + 60, last_frame_guest: MIN_DELAY + 60, shadow: true });
    expect(await state()).toEqual({ state: 'done', rejudge: false });

    expect((await t.sql('select status, winner from public.pokejam_matches where id = $1', [mid]))[0]).toEqual({ status: 'active', winner: null });
  });

  it('a job whose verdict already exists (a moderator got there first) is closed without judging again', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { deps, finished, applied } = fakes([{ match_id: 'seen', rejudge: false }]);
    deps.judge.hasVerdict = async () => true;
    expect(await runWorker(deps)).toEqual([{ match_id: 'seen', result: 'skipped', reason: 'already judged' }]);
    expect(finished).toEqual([['seen', true]]);
    expect(applied).toEqual(['seen']); // a moderator's verdict still decides a disputed match
  });

  it('with no uploads the match waits for a late one, and a failed apply is retried through the lease', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const empty = fakes([{ match_id: 'none', rejudge: false }]);
    expect(await runWorker(empty.deps)).toEqual([{ match_id: 'none', result: 'skipped', reason: 'no evidence' }]);
    expect(empty.applied).toEqual([]);
    expect(empty.finished).toEqual([['none', true]]);
    const failing = fakes([{ match_id: 'seen', rejudge: false }]);
    failing.deps.judge.hasVerdict = async () => true;
    failing.deps.apply = async () => { throw new Error('database down'); };
    expect(await runWorker(failing.deps)).toEqual([{ match_id: 'seen', result: 'error', reason: 'database down' }]);
    expect(failing.finished).toEqual([]);
  });
});
