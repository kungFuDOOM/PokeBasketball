// Cheat-check tags on the moderation page (migration 20261123): pokejam_admin_reports returns, per reported player,
// one `checks` entry per distinct match among their open reports, with uploads and the stored verdict if any.
import { describe, expect, it, vi } from 'vitest';
import { type Db, type User, testDb } from './testDb';

vi.setConfig({ testTimeout: 30_000 });

/** A finished match hosted by `reported`, won by them, reported by `reporter`. */
async function reportedMatch(t: Db, reported: User, reporter: User, queue: 'social' | 'ranked', evidence = false) {
  const [{ id }] = await t.sql(
    `insert into public.pokejam_matches(queue, host, guest, host_mmr, guest_mmr, status, winner, finished_at)
     values ($1, $2, $3, 1000, 1000, 'done', $2, now()) returning id`, [queue, reported.id, reporter.id]);
  if (evidence) await t.sql(`insert into public.pokejam_match_evidence(match_id, user_id, evidence) values ($1, $2, 'gz1:x')`, [id, reporter.id]);
  expect(await reporter.call('pokejam_report_player', [id, 'cheating', null])).toBe(true);
  return id as string;
}

async function withMod(t: Db) {
  const mod = await t.user('Mod');
  await t.sql("insert into public.pokejam_admins(user_id, note) values ($1, 'kungFuDOOM')", [mod.id]);
  return mod;
}

type Check = { match_id: string; queue: string; has_evidence: boolean; status: string | null; agrees: boolean | null; cheater_is_reported: boolean | null };
type Row = { user_id: string; reports: number; checks: Check[] };

describe('pokejam_admin_reports checks', () => {
  it('lists each reported match with its uploads and verdict', async () => {
    const t = await testDb();
    const mod = await withMod(t);
    const sus = await t.user('Sus');
    const [a, b, c] = [await t.user('A'), await t.user('B'), await t.user('C')];
    const social = await reportedMatch(t, sus, a, 'social');
    const pending = await reportedMatch(t, sus, b, 'ranked', true);
    const judged = await reportedMatch(t, sus, c, 'ranked', true);
    // the host (sus) signed two versions of a frame
    await t.service('select public.pokejam_record_verdict($1, $2, $3, $4, $5, $6, $7, $8)', [judged, 'forfeit', 1, 0, 0, 0, 812, 'x']);

    const row = (await mod.call<Row[]>('pokejam_admin_reports', [7])).find((r) => r.user_id === sus.id)!;
    expect(row.reports).toBe(3);
    expect(row.checks).toHaveLength(3);
    const by = Object.fromEntries(row.checks.map((ch) => [ch.match_id, ch]));
    expect(by[social]).toEqual({ match_id: social, queue: 'social', has_evidence: false, status: null, agrees: null, cheater_is_reported: null });
    expect(by[pending]).toEqual({ match_id: pending, queue: 'ranked', has_evidence: true, status: null, agrees: null, cheater_is_reported: null });
    expect(by[judged]).toEqual({ match_id: judged, queue: 'ranked', has_evidence: true, status: 'forfeit', agrees: false, cheater_is_reported: true });
  });

  it("an opponent's forfeit is not the reported player's; a clean final agrees", async () => {
    const t = await testDb();
    const mod = await withMod(t);
    const sus = await t.user('Sus');
    const [a, b] = [await t.user('A'), await t.user('B')];
    const theirs = await reportedMatch(t, sus, a, 'ranked', true);
    const clean = await reportedMatch(t, sus, b, 'ranked', true);
    await t.service('select public.pokejam_record_verdict($1, $2, $3, $4, $5, $6, $7, $8)', [theirs, 'forfeit', 0, 1, 0, 0, 90, 'x']);
    await t.service('select public.pokejam_record_verdict($1, $2, $3, $4, $5, $6, $7, $8)', [clean, 'final', 0, null, 3, 1, 5000, 'ok']);

    const by = Object.fromEntries((await mod.call<Row[]>('pokejam_admin_reports', [7]))[0].checks.map((ch) => [ch.match_id, ch]));
    expect(by[theirs]).toMatchObject({ status: 'forfeit', cheater_is_reported: false });
    expect(by[clean]).toMatchObject({ status: 'final', agrees: true });
  });

  it('only counts open reports, one entry per match', async () => {
    const t = await testDb();
    const mod = await withMod(t);
    const sus = await t.user('Sus');
    const a = await t.user('A');
    await reportedMatch(t, sus, a, 'social');
    await mod.call('pokejam_admin_dismiss', [sus.id]);
    const open = await reportedMatch(t, sus, a, 'ranked');
    const rows = await mod.call<Row[]>('pokejam_admin_reports', [7]);
    expect(rows[0].checks.map((ch) => ch.match_id)).toEqual([open]);
  });

  it('still refuses anyone who is not a moderator', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A'), await t.user('B')];
    await reportedMatch(t, b, a, 'social');
    await expect(a.call('pokejam_admin_reports', [7])).rejects.toThrow(/moderators only/);
    await expect(t.as('anon', null)('select public.pokejam_admin_reports(7)')).rejects.toThrow(/permission denied/);
  });
});
