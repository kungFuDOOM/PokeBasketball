// The judge decides disputed Ranked matches (migration 20261201): what sends a match to `judging`, what each verdict does,
// that nothing happens with the flag off, the timeout, and the places that had to learn the new status.
import { describe, expect, it, vi } from 'vitest';
import { pickBoth, testDb, type Db, type User } from './testDb';

vi.setConfig({ testTimeout: 60_000 });

type Row = Record<string, unknown>;
const flagOn = (t: Db, on = true) => t.sql(`update public.pokejam_config set value = $1::jsonb where key = 'judge_authoritative'`, [String(on)]);
const row = async (t: Db, mid: string) => (await t.sql('select * from public.pokejam_matches where id = $1', [mid]))[0];
const flags = async (t: Db, mid: string) => (await t.sql('select user_id, reason from public.pokejam_judge_flags where match_id = $1 order by id', [mid])) as { user_id: string | null; reason: string }[];
const rated = async (t: Db, mid: string) => (await t.sql('select winner, reason, margin_share from public.pokejam_ranked_matches where match_id = $1', [mid]))[0];
const apply = async (t: Db, mid: string) => (await t.service('select public.pokejam_judge_apply($1) as r', [mid]))[0].r as Row;
const sweep = async (t: Db) => (await t.service('select public.pokejam_judge_sweep() as r'))[0].r as number;
const job = async (t: Db, mid: string) => (await t.sql('select * from public.pokejam_judge_jobs where match_id = $1', [mid]))[0];
const verdict = (t: Db, mid: string, status: string, o: { win?: 0 | 1 | null; cheat?: 0 | 1 | null; score?: [number, number]; last?: [number, number]; fault?: string | null } = {}) =>
  t.service(`select public.pokejam_record_verdict(p_match => $1, p_status => $2, p_winner_side => $3, p_cheater_side => $4, p_score_host => $5, p_score_guest => $6,
    p_ticks => 100, p_notes => 'test', p_last_host => $7, p_last_guest => $8, p_fault_user => $9)`,
  [mid, status, o.win ?? null, o.cheat ?? null, o.score?.[0] ?? 0, o.score?.[1] ?? 0, o.last?.[0] ?? 0, o.last?.[1] ?? 0, o.fault ?? null]);

async function ranked(t: Db) {
  const [a, b] = [await t.user('A'), await t.user('B')];
  expect(await a.call('pokejam_find_match', ['ranked'])).toBeNull();
  const mid = await b.call<string>('pokejam_find_match', ['ranked']);
  await pickBoth(t, mid);
  const m = await row(t, mid);
  const [host, guest] = m.host === a.id ? [a, b] : [b, a];
  await host.call('pokejam_match_alive', [mid]);
  await guest.call('pokejam_match_alive', [mid]);
  return { mid, host, guest };
}
const report = (u: User, mid: string, hostWon: boolean, resyncs?: number) =>
  u.call<Row>('pokejam_report_result', resyncs === undefined ? [mid, hostWon] : [mid, hostWon, resyncs]);
/** A match waiting for the judge: the two players reported different winners. */
async function disputed(t: Db) {
  await flagOn(t);
  const p = await ranked(t);
  await report(p.host, p.mid, true);
  expect((await report(p.guest, p.mid, false)).status).toBe('judging');
  return p;
}

describe('with the flag off (the default) nothing changes', () => {
  it('disagreeing reports void, resyncs are kept but trigger nothing, and a desync call is refused', async () => {
    const t = await testDb();
    expect((await t.sql(`select value from public.pokejam_config where key = 'judge_authoritative'`))[0].value).toBe(false);
    const p = await ranked(t);
    expect((await p.guest.call<Row>('pokejam_ranked_desync', [p.mid])).status).toBe('active');
    await report(p.host, p.mid, true, 2);
    expect((await report(p.guest, p.mid, false)).status).toBe('void');
    expect(await row(t, p.mid)).toMatchObject({ status: 'void', host_resyncs: 2 });
    const q = await ranked(t);
    await report(q.host, q.mid, true, 5);
    expect((await report(q.guest, q.mid, true)).status).toBe('done');
    await t.sql(`update public.pokejam_judge_jobs set created_at = now() - interval '1 hour'`);
    expect(await sweep(t)).toBe(0);
  });

  it('the host-only 120 s rule still works as it did', async () => {
    const t = await testDb();
    const p = await ranked(t);
    await report(p.host, p.mid, true);
    await t.sql(`update public.pokejam_matches set host_reported_at = now() - interval '121 seconds' where id = $1`, [p.mid]);
    expect((await report(p.host, p.mid, true)).status).toBe('done');
  });

  it('a verdict changes nothing and stays a shadow one; applying to an active match does nothing', async () => {
    const t = await testDb();
    const p = await ranked(t);
    await verdict(t, p.mid, 'final', { win: 1, score: [1, 2] });
    expect(await apply(t, p.mid)).toMatchObject({ status: 'active', applied: false });
    expect((await t.sql('select shadow from public.pokejam_match_verdicts where match_id = $1', [p.mid]))[0].shadow).toBe(true);
  });
});

describe('what goes to the judge', () => {
  it('disagreeing reports, with a job ready at once when both uploads are in', async () => {
    const t = await testDb();
    const p = await disputed(t);
    const m = await row(t, p.mid);
    expect(m.status).toBe('judging');
    expect(m.judging_since).toBeTruthy();
    expect(await rated(t, p.mid)).toBeUndefined();
    expect(await job(t, p.mid)).toMatchObject({ reason: 'disagree', state: 'pending' });
  });

  it('agreeing reports with no resyncs still settle straight away', async () => {
    const t = await testDb();
    await flagOn(t);
    const p = await ranked(t);
    await report(p.host, p.mid, true);
    expect((await report(p.guest, p.mid, true)).status).toBe('done');
  });

  it('either player reporting a resync, and the other can still report afterwards', async () => {
    const t = await testDb();
    await flagOn(t);
    const p = await ranked(t);
    expect((await report(p.guest, p.mid, true, 1)).status).toBe('judging');
    expect((await job(t, p.mid)).reason).toBe('resync');
    expect((await report(p.host, p.mid, true)).status).toBe('judging');
    expect(await row(t, p.mid)).toMatchObject({ status: 'judging', host_report: true, guest_report: true, guest_resyncs: 1 });
    // A report already made can't be changed once the match is being judged.
    await report(p.host, p.mid, false, 9);
    expect(await row(t, p.mid)).toMatchObject({ host_report: true, host_resyncs: 9 });
  });

  it('an absurd or negative resync count is clamped', async () => {
    const t = await testDb();
    await flagOn(t);
    const p = await ranked(t);
    await report(p.host, p.mid, true, -5);
    expect((await row(t, p.mid)).host_resyncs).toBe(0);
    await report(p.guest, p.mid, true, 999999);
    expect((await row(t, p.mid)).guest_resyncs).toBe(1000);
  });

  it('old clients keep working with the two-argument call', async () => {
    const t = await testDb();
    const p = await ranked(t);
    expect((await p.host.sql('select public.pokejam_report_result(p_match => $1, p_host_won => $2) as r', [p.mid, true]))[0].r).toMatchObject({ status: 'pending' });
  });

  it('one report for 120 s: from the sweep, not before, for the guest too, and a finished shadow job runs again', async () => {
    const t = await testDb();
    await flagOn(t);
    const p = await ranked(t);
    await report(p.guest, p.mid, true);
    expect(await sweep(t)).toBe(0);
    expect((await row(t, p.mid)).status).toBe('active');
    await t.sql(`update public.pokejam_judge_jobs set created_at = now() - interval '121 seconds', state = 'done', attempts = 3 where match_id = $1`, [p.mid]);
    expect(await sweep(t)).toBe(1);
    expect((await row(t, p.mid)).status).toBe('judging');
    expect(await job(t, p.mid)).toMatchObject({ reason: 'one_sided', state: 'pending', rejudge: true, attempts: 0 });
  });

  it('the host re-reporting after 120 s can no longer settle on its own word', async () => {
    const t = await testDb();
    await flagOn(t);
    const p = await ranked(t);
    await report(p.host, p.mid, true);
    await t.sql(`update public.pokejam_matches set host_reported_at = now() - interval '121 seconds' where id = $1`, [p.mid]);
    expect((await report(p.host, p.mid, true)).status).toBe('pending');
  });

  it('a guest desync; a host, a silent guest, a stranger and a finished match are refused', async () => {
    const t = await testDb();
    await flagOn(t);
    const p = await ranked(t);
    expect((await p.host.call<Row>('pokejam_ranked_desync', [p.mid])).status).toBe('active');
    const stranger = await t.user('S');
    await expect(stranger.call('pokejam_ranked_desync', [p.mid])).rejects.toThrow(/not in this match/);
    await t.sql(`update public.pokejam_matches set guest_alive = now() - interval '46 seconds' where id = $1`, [p.mid]);
    expect((await p.guest.call<Row>('pokejam_ranked_desync', [p.mid])).status).toBe('active');
    await t.sql(`update public.pokejam_matches set guest_alive = now() where id = $1`, [p.mid]);
    expect((await p.guest.call<Row>('pokejam_ranked_desync', [p.mid])).status).toBe('judging');
    expect(await row(t, p.mid)).toMatchObject({ status: 'judging', desync_by: p.guest.id });
    expect((await job(t, p.mid)).reason).toBe('desync');
    expect((await p.guest.call<Row>('pokejam_ranked_desync', [p.mid])).status).toBe('judging');
  });
});

describe('what each verdict does', () => {
  it('final: the replay decides winner and margin, whoever claimed what; the wrong report is flagged; twice is once', async () => {
    const t = await testDb();
    const p = await disputed(t);
    await verdict(t, p.mid, 'final', { win: 1, score: [10, 30] });
    expect(await apply(t, p.mid)).toMatchObject({ status: 'done', winner: p.guest.id, applied: true });
    expect(await row(t, p.mid)).toMatchObject({ status: 'done', winner: p.guest.id });
    expect(await rated(t, p.mid)).toMatchObject({ winner: p.guest.id, reason: 'score' });
    expect(Number((await rated(t, p.mid)).margin_share)).toBeCloseTo(0.5);
    expect(await flags(t, p.mid)).toEqual([{ user_id: p.host.id, reason: 'report_mismatch' }]);
    expect((await t.sql('select shadow from public.pokejam_match_verdicts where match_id = $1', [p.mid]))[0].shadow).toBe(false);
    const profile = async () => (await t.sql('select user_id, placements_played from public.pokejam_ranked_profiles order by user_id'));
    const before = await profile();
    expect(await apply(t, p.mid)).toMatchObject({ status: 'done', applied: false });
    expect(await profile()).toEqual(before);
    expect(await flags(t, p.mid)).toHaveLength(1);
  });

  it('final: reports agreed but were wrong, after a resync: only the host is flagged', async () => {
    const t = await testDb();
    await flagOn(t);
    const p = await ranked(t);
    await report(p.host, p.mid, true);
    expect((await report(p.guest, p.mid, true, 1)).status).toBe('judging');
    await verdict(t, p.mid, 'final', { win: 1, score: [10, 30] });
    await apply(t, p.mid);
    expect((await row(t, p.mid)).winner).toBe(p.guest.id);
    expect(await flags(t, p.mid)).toEqual([{ user_id: p.host.id, reason: 'report_mismatch' }]);
  });

  it('final: reports agreed and were right, after a resync: nobody is flagged', async () => {
    const t = await testDb();
    await flagOn(t);
    const p = await ranked(t);
    await report(p.host, p.mid, true);
    await report(p.guest, p.mid, true, 1);
    await verdict(t, p.mid, 'final', { win: 0, score: [30, 10] });
    await apply(t, p.mid);
    expect((await row(t, p.mid)).winner).toBe(p.host.id);
    expect(await flags(t, p.mid)).toEqual([]);
  });

  it('forfeit: the cheater loses with reason forfeit and is flagged', async () => {
    const t = await testDb();
    const p = await disputed(t);
    await verdict(t, p.mid, 'forfeit', { win: 1, cheat: 0 });
    await apply(t, p.mid);
    expect(await row(t, p.mid)).toMatchObject({ status: 'done', winner: p.guest.id });
    expect(await rated(t, p.mid)).toMatchObject({ winner: p.guest.id, reason: 'forfeit' });
    expect(await flags(t, p.mid)).toEqual([{ user_id: p.host.id, reason: 'equivocation' }]);
  });

  describe('invalid', () => {
    it('a fake upload never helps its sender: the sender loses, even when a void would have saved them', async () => {
      const t = await testDb();
      const p = await disputed(t);
      await verdict(t, p.mid, 'invalid', { fault: p.guest.id });
      await apply(t, p.mid);
      expect(await row(t, p.mid)).toMatchObject({ status: 'done', winner: p.host.id });
      expect(await rated(t, p.mid)).toMatchObject({ winner: p.host.id, reason: 'forfeit' });
      expect(await flags(t, p.mid)).toEqual([{ user_id: p.guest.id, reason: 'bad_upload' }]);
    });

    it('a sender whose fake upload was ignored, on a final verdict: the replay decides and they are flagged', async () => {
      const t = await testDb();
      const p = await disputed(t);
      await verdict(t, p.mid, 'final', { win: 0, score: [30, 10], fault: p.guest.id });
      await apply(t, p.mid);
      expect((await row(t, p.mid)).winner).toBe(p.host.id);
      expect(await flags(t, p.mid)).toEqual(expect.arrayContaining([{ user_id: p.guest.id, reason: 'bad_upload' }, { user_id: p.guest.id, reason: 'report_mismatch' }]));
    });

    it('nobody at fault, reports disagree: void, flagged for moderators', async () => {
      const t = await testDb();
      const p = await disputed(t);
      await verdict(t, p.mid, 'invalid');
      await apply(t, p.mid);
      expect((await row(t, p.mid)).status).toBe('void');
      expect(await rated(t, p.mid)).toBeUndefined();
      expect(await flags(t, p.mid)).toEqual([{ user_id: null, reason: 'invalid_verdict' }]);
    });

    it('nobody at fault, reports agree: the reports count, flagged for moderators', async () => {
      const t = await testDb();
      await flagOn(t);
      const p = await ranked(t);
      await report(p.host, p.mid, false);
      await report(p.guest, p.mid, false, 1);
      await verdict(t, p.mid, 'invalid');
      await apply(t, p.mid);
      expect(await row(t, p.mid)).toMatchObject({ status: 'done', winner: p.guest.id });
      expect(await rated(t, p.mid)).toMatchObject({ winner: p.guest.id, reason: 'score' });
      expect(await flags(t, p.mid)).toEqual([{ user_id: null, reason: 'invalid_verdict' }]);
    });
  });

  describe('incomplete', () => {
    const desynced = async (t: Db) => {
      await flagOn(t);
      const p = await ranked(t);
      await p.guest.call('pokejam_ranked_desync', [p.mid]);
      return p;
    };
    const quiet = (t: Db, mid: string, who: 'host' | 'guest', s: number) =>
      t.sql(`update public.pokejam_matches set ${who}_alive = judging_since - make_interval(secs => $2) where id = $1`, [mid, s]);

    it('both still here: void, and the player who stopped the game is noted', async () => {
      const t = await testDb();
      const p = await desynced(t);
      await verdict(t, p.mid, 'incomplete', { last: [100, 100] });
      await apply(t, p.mid);
      expect((await row(t, p.mid)).status).toBe('void');
      expect(await flags(t, p.mid)).toEqual([{ user_id: p.guest.id, reason: 'desync_void' }]);
    });

    it('a player who went quiet before judging began gets a leave', async () => {
      const t = await testDb();
      const p = await desynced(t);
      await quiet(t, p.mid, 'host', 46);
      await verdict(t, p.mid, 'incomplete');
      await apply(t, p.mid);
      expect(await row(t, p.mid)).toMatchObject({ status: 'done', winner: p.guest.id });
      expect(await rated(t, p.mid)).toMatchObject({ winner: p.guest.id, reason: 'leave' });
    });

    it('closing the tab while waiting for the verdict is not leaving', async () => {
      const t = await testDb();
      const p = await desynced(t);
      await t.sql(`update public.pokejam_matches set judging_since = now() - interval '5 minutes', host_alive = now() - interval '5 minutes', guest_alive = now() - interval '5 minutes' where id = $1`, [p.mid]);
      await verdict(t, p.mid, 'incomplete', { last: [100, 100] });
      await apply(t, p.mid);
      expect((await row(t, p.mid)).status).toBe('void');
    });

    it('both quiet: void', async () => {
      const t = await testDb();
      const p = await desynced(t);
      await quiet(t, p.mid, 'host', 60);
      await quiet(t, p.mid, 'guest', 60);
      await verdict(t, p.mid, 'incomplete');
      await apply(t, p.mid);
      expect((await row(t, p.mid)).status).toBe('void');
    });

    it('the only reporter loses: a report says the game reached the buzzer, and no log does', async () => {
      const t = await testDb();
      await flagOn(t);
      const p = await ranked(t);
      expect((await report(p.host, p.mid, true, 1)).status).toBe('judging');
      await verdict(t, p.mid, 'incomplete');
      await apply(t, p.mid);
      expect(await row(t, p.mid)).toMatchObject({ status: 'done', winner: p.guest.id });
      expect(await rated(t, p.mid)).toMatchObject({ reason: 'leave' });
      expect(await flags(t, p.mid)).toEqual([{ user_id: p.host.id, reason: 'false_report' }]);
    });

    it('both reported: void (a replay that runs out after a real buzzer points at the engines, not a player)', async () => {
      const t = await testDb();
      const p = await disputed(t);
      await verdict(t, p.mid, 'incomplete', { last: [100, 10] });
      await apply(t, p.mid);
      expect((await row(t, p.mid)).status).toBe('void');
    });

    it('a sender whose fake upload was ignored loses, not whoever the frames point at', async () => {
      const t = await testDb();
      const p = await desynced(t);
      await verdict(t, p.mid, 'incomplete', { fault: p.guest.id, last: [10, 100] });
      await apply(t, p.mid);
      expect((await row(t, p.mid)).winner).toBe(p.host.id);
      expect(await flags(t, p.mid)).toEqual([{ user_id: p.guest.id, reason: 'bad_upload' }]);
    });

    describe('signed frames that stop first', () => {
      const gone = async (t: Db) => {
        const p = await desynced(t);
        await t.sql(`update public.pokejam_matches set judging_since = now() - interval '2 minutes', host_alive = now() - interval '2 minutes' - interval '10 seconds', guest_alive = now() - interval '2 minutes' where id = $1`, [p.mid]);
        return p;
      };

      it('are enough only against a player who is gone and uploaded nothing', async () => {
        const t = await testDb();
        const p = await gone(t);
        await verdict(t, p.mid, 'incomplete', { last: [100, 108] });
        await apply(t, p.mid);
        expect(await row(t, p.mid)).toMatchObject({ status: 'done', winner: p.guest.id });
        expect(await rated(t, p.mid)).toMatchObject({ reason: 'leave' });
      });

      it('fewer than the input delay behind proves nothing', async () => {
        const t = await testDb();
        const p = await gone(t);
        await verdict(t, p.mid, 'incomplete', { last: [100, 107] });
        await apply(t, p.mid);
        expect((await row(t, p.mid)).status).toBe('void');
      });

      it('can\'t frame a player who uploaded: a cheater can sign extra frames and hold back the other player\'s', async () => {
        const t = await testDb();
        const p = await gone(t);
        await p.host.call('pokejam_submit_evidence', [p.mid, 'gz1:x']);
        await verdict(t, p.mid, 'incomplete', { last: [100, 500] });
        await apply(t, p.mid);
        expect((await row(t, p.mid)).status).toBe('void');
      });

      it('can\'t frame a player who is still here', async () => {
        const t = await testDb();
        const p = await desynced(t);
        await verdict(t, p.mid, 'incomplete', { last: [100, 500] });
        await apply(t, p.mid);
        expect((await row(t, p.mid)).status).toBe('void');
      });
    });
  });
});

describe('when the judge doesn\'t answer', () => {
  const late = (t: Db, mid: string) => t.sql(`update public.pokejam_matches set judging_since = now() - interval '901 seconds' where id = $1`, [mid]);

  it('after the timeout, disagreeing reports void; before it, the match waits', async () => {
    const t = await testDb();
    const p = await disputed(t);
    expect(await sweep(t)).toBe(0);
    expect((await row(t, p.mid)).status).toBe('judging');
    await late(t, p.mid);
    expect(await sweep(t)).toBe(1);
    expect((await row(t, p.mid)).status).toBe('void');
    expect(await flags(t, p.mid)).toEqual([{ user_id: null, reason: 'no_verdict' }]);
  });

  it('after the timeout, agreeing reports count', async () => {
    const t = await testDb();
    await flagOn(t);
    const p = await ranked(t);
    await report(p.host, p.mid, true);
    await report(p.guest, p.mid, true, 1);
    await late(t, p.mid);
    await sweep(t);
    expect(await row(t, p.mid)).toMatchObject({ status: 'done', winner: p.host.id });
    expect(await rated(t, p.mid)).toMatchObject({ winner: p.host.id, reason: 'score' });
  });

  it('after the timeout, one report counts for nothing', async () => {
    const t = await testDb();
    await flagOn(t);
    const p = await ranked(t);
    await report(p.host, p.mid, true, 1);
    await late(t, p.mid);
    await sweep(t);
    expect((await row(t, p.mid)).status).toBe('void');
  });

  it('the timeout comes from pokejam_config, and the 5-minute cleanup runs the sweep too', async () => {
    const t = await testDb();
    const p = await disputed(t);
    await t.sql(`update public.pokejam_config set value = '0' where key = 'judge_timeout_s'`);
    await t.service('select public.pokejam_cleanup_matches()');
    expect((await row(t, p.mid)).status).toBe('void');
  });

  it('a verdict the worker never got to apply is applied by the sweep once the job has ended', async () => {
    const t = await testDb();
    const p = await disputed(t);
    await verdict(t, p.mid, 'final', { win: 0, score: [30, 10] });
    expect(await sweep(t)).toBe(0); // the job is still to run
    await t.sql(`update public.pokejam_judge_jobs set state = 'done' where match_id = $1`, [p.mid]);
    expect(await sweep(t)).toBe(1);
    expect(await row(t, p.mid)).toMatchObject({ status: 'done', winner: p.host.id });
  });

  it('the kill switch: flag off settles what is waiting by the old rules, verdict or not', async () => {
    const t = await testDb();
    const p = await disputed(t);
    await verdict(t, p.mid, 'final', { win: 1, score: [10, 30] });
    await flagOn(t, false);
    await sweep(t);
    expect((await row(t, p.mid)).status).toBe('void');
    expect(await rated(t, p.mid)).toBeUndefined();
    expect((await t.sql('select shadow from public.pokejam_match_verdicts where match_id = $1', [p.mid]))[0].shadow).toBe(true);
  });
});

describe('other code that meets a judging match', () => {
  it('a forfeit claim says judging, a leave is a no-op, and the heartbeat still lands', async () => {
    const t = await testDb();
    const p = await disputed(t);
    expect((await p.host.call<Row>('pokejam_ranked_forfeit', [p.mid])).status).toBe('judging');
    await p.host.call('pokejam_leave_match', [p.mid]);
    expect((await row(t, p.mid)).status).toBe('judging');
    expect(await rated(t, p.mid)).toBeUndefined();
    await t.sql(`update public.pokejam_matches set host_alive = now() - interval '1 minute' where id = $1`, [p.mid]);
    expect(await p.host.call('pokejam_match_alive', [p.mid])).toBe('judging');
    expect(Date.now() - new Date((await row(t, p.mid)).host_alive as string).getTime()).toBeLessThan(30_000);
    expect((await p.host.call<Row>('pokejam_match_status', [p.mid])).status).toBe('judging');
  });

  it('the sweep of silent players leaves it alone', async () => {
    const t = await testDb();
    const p = await disputed(t);
    await t.sql(`update public.pokejam_matches set created_at = now() - interval '10 minutes', host_alive = now() - interval '10 minutes', guest_alive = now() - interval '10 minutes' where id = $1`, [p.mid]);
    await t.service('select public.pokejam_cleanup_matches()');
    expect((await row(t, p.mid)).status).toBe('judging');
  });

  it('it still counts as played: a rematch is not offered straight away, and three in a day is the limit', async () => {
    const t = await testDb();
    const p = await disputed(t);
    await t.sql(`update public.pokejam_matches set host_alive = now(), guest_alive = now() where id = $1`, [p.mid]);
    expect(await p.host.call('pokejam_find_match', ['ranked'])).toBeNull();
    expect(await p.guest.call('pokejam_find_match', ['ranked'])).toBeNull(); // last_opp
    expect(await t.sql(`select 1 from public.pokejam_matches where queue = 'ranked'`)).toHaveLength(1);
  });

  it('a player being judged can search for the next game, and the verdict lands on the right match', async () => {
    const t = await testDb();
    const p = await disputed(t);
    const other = await t.user('C');
    expect(await p.guest.call('pokejam_find_match', ['ranked'])).toBeNull();
    const next = await other.call<string | null>('pokejam_find_match', ['ranked']);
    expect(next).toBeTruthy();
    expect((await row(t, p.mid)).status).toBe('judging');
    await verdict(t, p.mid, 'final', { win: 1, score: [10, 30] });
    await apply(t, p.mid);
    expect((await row(t, p.mid)).winner).toBe(p.guest.id);
    expect((await row(t, next!)).status).toBe('active');
  });

  it('the Rank Shield stays locked, so one can\'t be armed after seeing "checking the result"', async () => {
    const t = await testDb();
    const p = await disputed(t);
    const [s] = await t.sql('select o_armed, o_locked from public.pokejam_shield_arm_state($1)', [p.host.id]);
    expect(s).toEqual({ o_armed: false, o_locked: true });
  });

  it('Social never goes to the judge', async () => {
    const t = await testDb();
    await flagOn(t);
    const [a, b] = [await t.user('A'), await t.user('B')];
    expect(await a.call('pokejam_find_match', ['social'])).toBeNull();
    const mid = await b.call<string>('pokejam_find_match', ['social']);
    await a.call('pokejam_report_result', [mid, true, 5]);
    const r = await b.call<Row>('pokejam_report_result', [mid, false, 5]);
    expect(r.status).toBe('void');
    expect(await job(t, mid)).toBeUndefined();
  });
});

describe('who can call what', () => {
  it('players can\'t apply, sweep, flag or read flags; moderators can read them', async () => {
    const t = await testDb();
    const p = await disputed(t);
    await verdict(t, p.mid, 'final', { win: 1, score: [10, 30] });
    await apply(t, p.mid);
    for (const q of [`select public.pokejam_judge_apply('${p.mid}')`, 'select public.pokejam_judge_sweep()', `select public.pokejam_judge_flag('${p.mid}', null, 'no_verdict')`,
      `select public.pokejam_judge_begin('${p.mid}', 'desync')`, 'select * from public.pokejam_judge_flags', `select public.pokejam_ranked_apply('${p.mid}')`]) {
      await expect(p.host.sql(q)).rejects.toThrow(/permission denied/);
    }
    await expect(p.host.call('pokejam_admin_judge_flags')).rejects.toThrow();
    const mod = await t.user('Mod');
    await t.sql(`insert into public.pokejam_admins(user_id, note) values ($1, 'test')`, [mod.id]);
    const list = await mod.call<Row[]>('pokejam_admin_judge_flags', [7]);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ reason: 'report_mismatch', user_id: p.host.id, match_id: p.mid, reviewed: false });
    expect(list[0].username).toBeTruthy();
  });
});
