// Stored judge verdicts (migration 20261122): only the service role can write them, nobody else can read them,
// judging again overwrites, and a verdict outlives the 30-day evidence prune.
import { describe, expect, it, vi } from 'vitest';
import { type Db, testDb } from './testDb';

vi.setConfig({ testTimeout: 30_000 });

/** A finished ranked match between two new players, won by the host, with one evidence upload. */
async function rankedMatch(t: Db) {
  const [host, guest] = [await t.user('Host'), await t.user('Guest')];
  const [{ id }] = await t.sql(
    `insert into public.pokejam_matches(queue, host, guest, host_mmr, guest_mmr, status, winner, finished_at)
     values ('ranked', $1, $2, 1000, 1000, 'done', $1, now()) returning id`, [host.id, guest.id]);
  await t.sql(`insert into public.pokejam_match_evidence(match_id, user_id, evidence) values ($1, $2, 'gz1:x')`, [id, host.id]);
  return { mid: id as string, host, guest };
}

const record = (t: Db, args: unknown[]) =>
  t.service('select public.pokejam_record_verdict($1, $2, $3, $4, $5, $6, $7, $8) as r', args).then((rows) => rows[0].r as Record<string, unknown>);

describe('pokejam_match_verdicts', () => {
  it('players and anon cannot read, write or record verdicts', async () => {
    const t = await testDb();
    const { mid, host } = await rankedMatch(t);
    await record(t, [mid, 'final', 0, null, 3, 1, 5000, 'ok']);
    for (const run of [host.sql, t.as('anon', null)]) {
      await expect(run('select * from public.pokejam_match_verdicts')).rejects.toThrow(/permission denied/);
      await expect(run(`insert into public.pokejam_match_verdicts(match_id, status) values ($1, 'final')`, [mid])).rejects.toThrow(/permission denied/);
      await expect(run(`update public.pokejam_match_verdicts set agrees = false`)).rejects.toThrow(/permission denied/);
      await expect(run(`delete from public.pokejam_match_verdicts`)).rejects.toThrow(/permission denied/);
      await expect(run('select public.pokejam_record_verdict($1, $2, $3, $4, $5, $6, $7, $8)', [mid, 'invalid', null, null, 0, 0, 0, 'x']))
        .rejects.toThrow(/permission denied/);
    }
    expect(await t.sql('select status, agrees from public.pokejam_match_verdicts')).toEqual([{ status: 'final', agrees: true }]);
  });

  it('the service role upserts, mapping sides to players; a second call overwrites the first', async () => {
    const t = await testDb();
    const { mid, host, guest } = await rankedMatch(t);
    expect(await record(t, [mid, 'final', 0, null, 3, 1, 5000, 'clean'])).toMatchObject({
      match_id: mid, status: 'final', winner_side: 0, cheater: null, agrees: true, score_host: 3, score_guest: 1, ticks: 5000, notes: 'clean',
    });

    // re-judged: the guest won on replay (disagrees with the recorded host win)
    expect(await record(t, [mid, 'final', 1, null, 1, 2, 5000, 'guest won'])).toMatchObject({ winner_side: 1, agrees: false });

    // re-judged: the host equivocated
    await record(t, [mid, 'forfeit', 1, 0, 0, 0, 812, 'host signed two different versions of frame 812']);
    const rows = await t.sql('select * from public.pokejam_match_verdicts');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: 'forfeit', winner_side: 1, cheater: host.id, agrees: false, ticks: 812 });
    expect(rows[0].cheater).not.toBe(guest.id);

    // no winner from the judge: agrees is null
    expect(await record(t, [mid, 'incomplete', null, null, 1, 1, 300, 'stopped'])).toMatchObject({ winner_side: null, cheater: null, agrees: null });

    await expect(record(t, [mid, 'bogus', null, null, 0, 0, 0, ''])).rejects.toThrow(/bad status/);
    await expect(record(t, [mid, 'final', 2, null, 0, 0, 0, ''])).rejects.toThrow(/bad side/);
    await expect(record(t, [crypto.randomUUID(), 'final', 0, null, 0, 0, 0, ''])).rejects.toThrow(/no such match/);
  });

  it('agrees is null when the match has no recorded winner', async () => {
    const t = await testDb();
    const { mid } = await rankedMatch(t);
    await t.sql('update public.pokejam_matches set winner = null where id = $1', [mid]);
    expect(await record(t, [mid, 'final', 0, null, 3, 1, 5000, ''])).toMatchObject({ agrees: null });
  });

  it('a verdict is kept after the evidence is pruned', async () => {
    const t = await testDb();
    const { mid } = await rankedMatch(t);
    await record(t, [mid, 'final', 0, null, 3, 1, 5000, '']);
    await t.sql(`update public.pokejam_match_evidence set created_at = now() - interval '31 days'`);
    expect((await t.service('select public.pokejam_prune_evidence(30) as n'))[0].n).toBe(1);
    expect(await t.sql('select match_id from public.pokejam_match_verdicts')).toEqual([{ match_id: mid }]);
  });
});
