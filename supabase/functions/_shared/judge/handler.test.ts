import { describe, expect, it, vi } from 'vitest';
import { pack } from '../../../../src/multiplayer/shared/evidence.ts';
import { matchKey, signTicks, type Evidence, type MatchSetup, type Verdict } from '../../../../src/multiplayer/shared/winnerCheck.ts';
import { ENGINE_VERSION } from '../../../../src/game/types.ts';
import { type Db, testDb } from '../../../tests/testDb.ts';
import { MAX_MATCHES, judgeConfig, judgeHandler, type JudgeDeps } from './handler.ts';

vi.setConfig({ testTimeout: 30_000 });

const setupFor = (matchId: string): MatchSetup => ({
  matchId, engineVersion: ENGINE_VERSION, seed: 2026, quarterLen: 60,
  home: { name: 'Pallet Town', abbr: 'PAL', color: '#3b6fd8', color2: '#16224a', roster: [25, 381, 6, 445, 382] },
  away: { name: 'Indigo Elite', abbr: 'IND', color: '#e3350d', color2: '#3d0a03', roster: [94, 130, 149, 248, 150] },
});

/** The handler's deps against a real Postgres running the migrations, as the Edge Function wires them. */
function dbDeps(t: Db, sessions: Record<string, string>, judge?: JudgeDeps['judge']) {
  const judged: string[] = [];
  const deps: JudgeDeps = {
    async isAdmin(jwt) {
      const uid = sessions[jwt];
      if (!uid) throw new Error('bad jwt');
      return (await t.as('authenticated', uid)('select public.pokejam_is_admin() as r'))[0].r === true;
    },
    async keysOf(id) {
      const [m] = await t.sql('select host_key, guest_key from public.pokejam_matches where id = $1', [id]);
      return (m as { host_key: string | null; guest_key: string | null } | undefined) ?? null;
    },
    async hasVerdict(id) {
      // (Supabase's service role can read every table; the test database's stand-in has no table grants.)
      return (await t.sql('select 1 from public.pokejam_match_verdicts where match_id = $1', [id])).length > 0;
    },
    async uploadsOf(id) {
      return (await t.sql('select evidence from public.pokejam_match_evidence where match_id = $1 order by created_at, user_id', [id]))
        .map((r) => r.evidence as string);
    },
    async record(v) {
      await t.service('select public.pokejam_record_verdict($1, $2, $3, $4, $5, $6, $7, $8)',
        [v.match, v.status, v.winnerSide, v.cheaterSide, v.scoreHost, v.scoreGuest, v.ticks, v.notes]);
    },
    judge: judge && (async (ev) => { judged.push(ev.setup.matchId); return judge(ev); }),
  };
  return { deps, judged };
}

async function world() {
  const t = await testDb();
  const mod = await t.user('Mod');
  const player = await t.user('Player');
  await t.sql("insert into public.pokejam_admins(user_id, note) values ($1, 'kungFuDOOM')", [mod.id]);
  const sessions = { 'mod-jwt': mod.id, 'player-jwt': player.id };
  /** A finished match won by the host, with keys registered and these uploads (made by `make`). */
  const match = async (queue: 'social' | 'ranked', make?: (id: string, keys: { host: CryptoKey; guest: CryptoKey; pub: [string, string] }) => Promise<Evidence[]>) => {
    const [host, guest] = [await t.user('Host'), await t.user('Guest')];
    const [hk, gk] = [await matchKey(), await matchKey()];
    const [{ id }] = await t.sql(
      `insert into public.pokejam_matches(queue, host, guest, host_mmr, guest_mmr, status, winner, finished_at, host_key, guest_key)
       values ($1, $2, $3, 1000, 1000, 'done', $2, now(), $4, $5) returning id`, [queue, host.id, guest.id, hk.publicKey, gk.publicKey]);
    const evs = make ? await make(id as string, { host: hk.privateKey, guest: gk.privateKey, pub: [hk.publicKey, gk.publicKey] }) : [];
    for (const [i, ev] of evs.entries()) {
      await t.sql('insert into public.pokejam_match_evidence(match_id, user_id, evidence) values ($1, $2, $3)', [id, [host.id, guest.id][i], await pack(ev)]);
    }
    return { id: id as string, host, guest };
  };
  return { t, mod, player, sessions, match };
}

const call = (deps: JudgeDeps, body: unknown, jwt = 'mod-jwt') => judgeHandler(
  new Request('https://f.test/pokejam-judge', { method: 'POST', headers: { authorization: `Bearer ${jwt}`, origin: 'https://pokejam.xyz' }, body: JSON.stringify(body) }),
  judgeConfig(() => undefined), deps);

const verdicts = (t: Db) => t.sql('select match_id, status, winner_side, cheater, agrees, score_host, score_guest, ticks, notes from public.pokejam_match_verdicts');

/** Stands in for a full replay: the host wins 3-1 at the buzzer. Checks it's judged under the match row's keys. */
const finalJudge = (pub: () => [string, string]) => async (ev: Evidence): Promise<Verdict> => {
  expect(ev.keys).toEqual(pub());
  return { status: 'final', winner: 0, score: [3, 1], ticks: 7200, hash: 1, notes: [] };
};

describe('pokejam-judge', () => {
  it('only moderators: a player gets 403, no session 401, and nothing is judged', async () => {
    const w = await world();
    const ranked = await w.match('ranked', async (id, k) => [{ setup: setupFor(id), keys: k.pub, inputs: [], applied: [], lockstep: { emptyTicks: 2 } }]);
    const { deps, judged } = dbDeps(w.t, w.sessions, async () => { throw new Error('should not judge'); });
    expect((await call(deps, { match_ids: [ranked.id] }, 'player-jwt')).status).toBe(403);
    expect((await call(deps, { match_ids: [ranked.id] }, 'stranger-jwt')).status).toBe(403);
    expect((await judgeHandler(new Request('https://f.test', { method: 'POST', body: '{}' }), judgeConfig(() => undefined), deps)).status).toBe(401);
    expect((await judgeHandler(new Request('https://f.test', { method: 'GET', headers: { authorization: 'Bearer mod-jwt' } }), judgeConfig(() => undefined), deps)).status).toBe(405);
    expect((await call(deps, { match_ids: ['not-a-match'] })).status).toBe(400);
    expect(judged).toEqual([]);
    expect(await verdicts(w.t)).toEqual([]);
  });

  it('a clean final match is recorded, agreeing with the recorded winner; Social (no uploads) is skipped', async () => {
    const w = await world();
    const social = await w.match('social');
    let pub: [string, string] = ['', ''];
    const ranked = await w.match('ranked', async (id, k) => {
      pub = k.pub;
      // The guest's upload claims keys of its own: the judge must still see the match row's keys.
      return [{ setup: setupFor(id), keys: k.pub, inputs: [], applied: [], lockstep: { emptyTicks: 2 } },
        { setup: setupFor(id), keys: ['ab'.repeat(32), 'cd'.repeat(32)], inputs: [], applied: [], lockstep: { emptyTicks: 2 } }];
    });
    const { deps, judged } = dbDeps(w.t, w.sessions, finalJudge(() => pub));
    const r = await call(deps, { match_ids: [social.id, ranked.id] });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, results: [
      { match_id: social.id, result: 'skipped', reason: 'no evidence' },
      { match_id: ranked.id, result: 'recorded', status: 'final' },
    ] });
    expect(judged).toEqual([ranked.id]);
    expect(await verdicts(w.t)).toEqual([{ match_id: ranked.id, status: 'final', winner_side: 0, cheater: null, agrees: true, score_host: 3, score_guest: 1, ticks: 7200, notes: '' }]);
  });

  it('a host who signed two versions of a frame is recorded as the cheater (the real judge)', async () => {
    const w = await world();
    const z = { mx: 0, my: 0, b: 0 };
    const ranked = await w.match('ranked', async (id, k) => {
      const honest = await signTicks(k.host, id, 0, 0, [z, z, z]);
      const rewrite = await signTicks(k.host, id, 0, 1, [{ mx: 1, my: 0, b: 0 }]);
      const guest = await signTicks(k.guest, id, 1, 0, [z, z, z]);
      return [{ setup: setupFor(id), keys: k.pub, inputs: [honest, guest], applied: [], lockstep: { emptyTicks: 0 } },
        { setup: setupFor(id), keys: k.pub, inputs: [rewrite, guest], applied: [], lockstep: { emptyTicks: 0 } }];
    });
    const { deps } = dbDeps(w.t, w.sessions);
    expect(await (await call(deps, { match_ids: [ranked.id] })).json()).toEqual({ ok: true, results: [{ match_id: ranked.id, result: 'recorded', status: 'forfeit' }] });
    const [v] = await verdicts(w.t);
    expect(v).toMatchObject({ status: 'forfeit', winner_side: 1, cheater: ranked.host.id, agrees: false });
    expect(v.notes).toMatch(/host signed two different versions of frame 2/);
  });

  it('an already-judged match is not re-run, and one bad match does not stop the rest', async () => {
    const w = await world();
    let pub: [string, string] = ['', ''];
    const mk = async (id: string, k: { pub: [string, string] }) => { pub = k.pub; return [{ setup: setupFor(id), keys: k.pub, inputs: [], applied: [], lockstep: { emptyTicks: 2 } }]; };
    const first = await w.match('ranked', mk);
    const { deps, judged } = dbDeps(w.t, w.sessions, finalJudge(() => pub));
    await call(deps, { match_ids: [first.id] });
    expect(judged).toEqual([first.id]);

    const broken = await w.match('ranked');
    await w.t.sql("insert into public.pokejam_match_evidence(match_id, user_id, evidence) values ($1, $2, 'gz1:not gzip')", [broken.id, broken.host.id]);
    const second = await w.match('ranked', mk);
    const res = await (await call(deps, { match_ids: [first.id, broken.id, second.id, first.id] })).json();
    expect(res.results).toMatchObject([
      { match_id: first.id, result: 'skipped', reason: 'already judged' },
      { match_id: broken.id, result: 'error' },
      { match_id: second.id, result: 'recorded', status: 'final' },
    ]);
    expect(judged).toEqual([first.id, second.id]);
    expect((await verdicts(w.t)).map((v) => v.match_id).sort()).toEqual([first.id, second.id].sort());
  });

  it('caps the batch', async () => {
    const w = await world();
    const { deps } = dbDeps(w.t, w.sessions, async () => { throw new Error('no'); });
    const ids = Array.from({ length: MAX_MATCHES + 5 }, () => crypto.randomUUID());
    const res = await (await call(deps, { match_ids: ids })).json();
    expect(res.results).toHaveLength(MAX_MATCHES);
    expect(res.results[0]).toEqual({ match_id: ids[0], result: 'skipped', reason: 'no evidence' });
  });
});
