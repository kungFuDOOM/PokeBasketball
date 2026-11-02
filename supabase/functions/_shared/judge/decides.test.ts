// A disputed Ranked match through the queue on the real judge and a real database: the host's snapshot cheat, and a loser
// faking the engine version on their upload.
import { describe, expect, it, vi } from 'vitest';
import { pack } from '../../../../src/multiplayer/shared/evidence.ts';
import { MIN_DELAY } from '../../../../src/multiplayer/shared/lockstep.ts';
import { judgeSetupFromRow, type ServerMatchRow } from '../../../../src/multiplayer/shared/matchSetup.ts';
import { matchKey, replay, signTicks, type Evidence, type MatchSetup, type SignedInputs } from '../../../../src/multiplayer/shared/winnerCheck.ts';
import type { WireInput } from '../../../../src/game/sync.ts';
import { ENGINE_VERSION } from '../../../../src/game/types.ts';
import { pickBoth, testDb, type Db, type User } from '../../../tests/testDb.ts';
import { judgeDeps, type AdminClient } from './deps.ts';
import { queueDeps, runWorker, type WorkerDeps } from './worker.ts';

vi.setConfig({ testTimeout: 120_000 });

const client = (t: Db): AdminClient => ({
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
});

/** Button-mashing from a seed: enough for real baskets. */
function mash(seed: number, n: number): WireInput[] {
  let s = seed >>> 0;
  const r = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 2 ** 32; };
  const out: WireInput[] = [];
  let f: WireInput = { mx: 0, my: 0, b: 0 };
  for (let i = 0; i < n; i++) {
    if (i % 15 === 0) f = { mx: Math.round((r() * 2 - 1) * 100) / 100, my: Math.round((r() * 2 - 1) * 100) / 100, b: r() < 0.5 ? 2 : r() < 0.5 ? 8 : 0 };
    out.push(f);
  }
  return out;
}

/** Inputs that make a game the guest really wins at the buzzer, under this setup. */
function guestWin(setup: MatchSetup) {
  const n = 60 * 60 * 6;
  for (let seed = 1; seed < 200; seed++) {
    const [h, g] = [mash(seed, n), mash(seed * 7919, n)];
    const ticks: [WireInput | null, WireInput | null][] = Array.from({ length: n + MIN_DELAY }, (_, t) => (t < MIN_DELAY ? [null, null] : [h[t - MIN_DELAY], g[t - MIN_DELAY]]));
    const r = replay(setup, ticks);
    if (r.final && r.score[1] > r.score[0]) return { h: h.slice(0, r.ticks), g: g.slice(0, r.ticks), score: r.score };
  }
  throw new Error('no seed gives the guest a win');
}

async function world() {
  const t = await testDb();
  await t.sql(`update public.pokejam_config set value = 'true' where key = 'judge_authoritative'`);
  const [a, b] = [await t.user('A'), await t.user('B')];
  expect(await a.call('pokejam_find_match', ['ranked'])).toBeNull();
  const mid = await b.call<string>('pokejam_find_match', ['ranked']);
  await pickBoth(t, mid);
  const [hk, gk] = [await matchKey(), await matchKey()];
  await t.sql('update public.pokejam_matches set host_key = $2, guest_key = $3, quarter_len = 60 where id = $1', [mid, hk.publicKey, gk.publicKey]);
  const [m] = await t.sql('select host from public.pokejam_matches where id = $1', [mid]);
  const [host, guest]: User[] = m.host === a.id ? [a, b] : [b, a];
  const [{ r }] = await t.service('select public.pokejam_match_setup($1) as r', [mid]);
  const setup = judgeSetupFromRow(r as ServerMatchRow).setup!;
  const game = guestWin(setup);
  const batches = async (key: CryptoKey, side: 0 | 1, frames: WireInput[]) => {
    const out: SignedInputs[] = [];
    for (let i = 0; i < frames.length; i += 600) out.push(await signTicks(key, mid, side, MIN_DELAY + i, frames.slice(i, i + 600)));
    return out;
  };
  const inputs = [...await batches(hk.privateKey, 0, game.h), ...await batches(gk.privateKey, 1, game.g)];
  const upload = (u: User, engineVersion: unknown = ENGINE_VERSION) => pack({ setup: { ...setup, engineVersion }, keys: [hk.publicKey, gk.publicKey], inputs, applied: [], lockstep: { emptyTicks: MIN_DELAY } } as unknown as Evidence)
    .then((p) => u.call('pokejam_submit_evidence', [mid, p]));
  const admin = client(t);
  const deps: WorkerDeps = { ...queueDeps(admin), judge: judgeDeps(admin) };
  const matchRow = async () => (await t.sql('select status, winner from public.pokejam_matches where id = $1', [mid]))[0];
  return { t, mid, host, guest, upload, deps, matchRow, game };
}

describe('the judge decides, on real uploads', () => {
  it('the snapshot cheat: both reports say the host won, the guest reports a resync, the replay says the guest did', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const w = await world();
    await w.host.call('pokejam_report_result', [w.mid, true, 0]);
    expect((await w.guest.call<{ status: string }>('pokejam_report_result', [w.mid, true, 1])).status).toBe('judging');
    await w.upload(w.host);
    await w.upload(w.guest);
    expect(await runWorker(w.deps)).toEqual([{ match_id: w.mid, result: 'recorded', status: 'final' }]);
    expect(await w.matchRow()).toEqual({ status: 'done', winner: w.guest.id });
    const [rated] = await w.t.sql('select winner, reason, host_delta, guest_delta, margin_share from public.pokejam_ranked_matches where match_id = $1', [w.mid]);
    expect(rated).toMatchObject({ winner: w.guest.id, reason: 'score' });
    expect(Number(rated.margin_share)).toBeCloseTo((w.game.score[1] - w.game.score[0]) / (w.game.score[1] + w.game.score[0]));
    expect(await w.t.sql('select user_id, reason from public.pokejam_judge_flags where match_id = $1', [w.mid])).toEqual([{ user_id: w.host.id, reason: 'report_mismatch' }]);
    expect((await w.t.sql('select state from public.pokejam_judge_jobs where match_id = $1', [w.mid]))[0].state).toBe('done');
  });

  it('a loser faking the engine version next to an honest upload is judged on that upload and flagged', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const w = await world();
    await w.host.call('pokejam_report_result', [w.mid, true]);
    expect((await w.guest.call<{ status: string }>('pokejam_report_result', [w.mid, false])).status).toBe('judging');
    await w.host.call('pokejam_ranked_report_score', [w.mid, 99, 0]);
    await w.upload(w.host, 999);
    await w.upload(w.guest);
    expect(await runWorker(w.deps)).toEqual([{ match_id: w.mid, result: 'recorded', status: 'final' }]);
    expect(await w.matchRow()).toEqual({ status: 'done', winner: w.guest.id });
    const flags = await w.t.sql('select user_id, reason from public.pokejam_judge_flags where match_id = $1 order by id', [w.mid]);
    expect(flags).toEqual([{ user_id: w.host.id, reason: 'bad_upload' }, { user_id: w.host.id, reason: 'report_mismatch' }]);
  });

  it('a loser faking the engine version on the only upload loses instead of voiding the match', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const w = await world();
    await w.host.call('pokejam_report_result', [w.mid, true]);
    await w.guest.call('pokejam_report_result', [w.mid, false]);
    await w.upload(w.host, 999);
    await w.t.sql('update public.pokejam_judge_jobs set ready_at = now() where match_id = $1', [w.mid]);
    expect(await runWorker(w.deps)).toEqual([{ match_id: w.mid, result: 'recorded', status: 'invalid' }]);
    expect(await w.matchRow()).toEqual({ status: 'done', winner: w.guest.id });
    expect((await w.t.sql('select reason from public.pokejam_ranked_matches where match_id = $1', [w.mid]))[0].reason).toBe('forfeit');
  });
});
