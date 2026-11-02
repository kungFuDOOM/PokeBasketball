// The judge queue, in shadow mode (migrations 20261129, 20261130): which matches get a job, when it is ready, leases and
// retries, the late-upload window, and the moderators' panel.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { pickBoth, quickPair, testDb, type Db, type User } from './testDb';

vi.setConfig({ testTimeout: 60_000 });

type Job = { match_id: string; reason: string; state: string; attempts: number; rejudge: boolean; ready_in: number; lease_in: number | null; window_in: number | null };

const job = async (t: Db, mid: string) => (await t.sql(`select match_id, reason, state, attempts, rejudge, round(extract(epoch from ready_at - now()))::int as ready_in,
  round(extract(epoch from locked_until - now()))::int as lease_in, round(extract(epoch from rejudge_until - now()))::int as window_in
  from public.pokejam_judge_jobs where match_id = $1`, [mid]))[0] as Job | undefined;
const claim = async (t: Db, n = 1) => (await t.service('select match_id, attempts, rejudge from public.pokejam_judge_claim($1)', [n])) as { match_id: string; attempts: number; rejudge: boolean }[];
const finish = async (t: Db, mid: string, ok = true) => (await t.service('select public.pokejam_judge_finish($1, $2) as r', [mid, ok]))[0].r;
const makeReady = (t: Db, mid: string) => t.sql(`update public.pokejam_judge_jobs set ready_at = now() - interval '1 second' where match_id = $1`, [mid]);
const upload = (u: User, mid: string) => u.call('pokejam_submit_evidence', [mid, `gz1:${u.id}`]);
const verdict = (t: Db, mid: string, status: string, side: 0 | 1 | null = 0) => t.service(`select public.pokejam_record_verdict($1, $2, $3, null, 1, 0, 100, '')`, [mid, status, side]);

async function ranked(t: Db) {
  const [a, b] = [await t.user('A'), await t.user('B')];
  expect(await a.call('pokejam_find_match', ['ranked'])).toBeNull();
  const mid = (await b.call<string>('pokejam_find_match', ['ranked']));
  await pickBoth(t, mid);
  const [m] = await t.sql('select host from public.pokejam_matches where id = $1', [mid]);
  return { mid, host: m.host === a.id ? a : b, guest: m.host === a.id ? b : a };
}
/** A job the worker can take: a first report and one upload, past the wait. */
async function readyJob(t: Db) {
  const p = await ranked(t);
  await p.host.call('pokejam_report_result', [p.mid, true]);
  await upload(p.host, p.mid);
  await makeReady(t, p.mid);
  return p;
}

describe('what gets a job', () => {
  it('the first report makes one job, ready 90 s later; the second report restarts the wait, still one job', async () => {
    const t = await testDb();
    const p = await ranked(t);
    expect(await job(t, p.mid)).toBeUndefined();
    await p.host.call('pokejam_report_result', [p.mid, true]);
    expect(await job(t, p.mid)).toMatchObject({ reason: 'report', state: 'pending', attempts: 0 });
    expect((await job(t, p.mid))!.ready_in).toBeGreaterThan(85);
    await t.sql(`update public.pokejam_judge_jobs set ready_at = now() + interval '5 seconds' where match_id = $1`, [p.mid]);
    await p.guest.call('pokejam_report_result', [p.mid, true]);
    expect((await job(t, p.mid))!.ready_in).toBeGreaterThan(85);
    expect(await t.sql('select 1 from public.pokejam_judge_jobs')).toHaveLength(1);
  });

  it('disagreeing reports are marked, and the job survives the void', async () => {
    const t = await testDb();
    const p = await ranked(t);
    await p.host.call('pokejam_report_result', [p.mid, true]);
    await p.guest.call('pokejam_report_result', [p.mid, false]);
    expect((await t.sql('select status from public.pokejam_matches where id = $1', [p.mid]))[0].status).toBe('void');
    expect(await job(t, p.mid)).toMatchObject({ reason: 'disagree', state: 'pending' });
  });

  it('a match that ends with no report (forfeit, leave) gets a job', async () => {
    const t = await testDb();
    const p = await ranked(t);
    await t.sql(`update public.pokejam_matches set status = 'done', winner = host, finished_at = now() where id = $1`, [p.mid]);
    expect(await job(t, p.mid)).toMatchObject({ reason: 'one_sided', state: 'pending' });
    expect((await job(t, p.mid))!.ready_in).toBeGreaterThan(85);
  });

  it('a job already running or done is not disturbed by a later report', async () => {
    const t = await testDb();
    const p = await readyJob(t);
    await claim(t);
    await p.guest.call('pokejam_report_result', [p.mid, false]);
    expect(await job(t, p.mid)).toMatchObject({ reason: 'report', state: 'running', attempts: 1 });
  });

  it('Social is never queued, and other updates to a Ranked match make no job', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A'), await t.user('B')];
    const social = await quickPair(t, a, b);
    await t.sql(`update public.pokejam_matches set host_report = true, guest_report = true, status = 'done', winner = host where id = $1`, [social]);
    const p = await ranked(t);
    await t.sql(`update public.pokejam_matches set host_key = $2, status = status where id = $1`, [p.mid, 'a'.repeat(64)]);
    expect(await t.sql('select 1 from public.pokejam_judge_jobs')).toEqual([]);
  });
});

describe('when a job is ready', () => {
  it('both uploads in: ready at once, whichever came first', async () => {
    const t = await testDb();
    const before = await ranked(t); // uploads before the report
    await upload(before.host, before.mid);
    await upload(before.guest, before.mid);
    await before.host.call('pokejam_report_result', [before.mid, true]);
    expect((await job(t, before.mid))!.ready_in).toBeLessThanOrEqual(0);

    const after = await ranked(t); // the report before the uploads
    await after.host.call('pokejam_report_result', [after.mid, true]);
    await upload(after.host, after.mid);
    expect((await job(t, after.mid))!.ready_in).toBeGreaterThan(85);
    expect(await claim(t)).toEqual([expect.objectContaining({ match_id: before.mid })]);
    await upload(after.guest, after.mid);
    expect((await job(t, after.mid))!.ready_in).toBeLessThanOrEqual(0);
    expect(await claim(t)).toEqual([expect.objectContaining({ match_id: after.mid })]);
  });

  it('a duplicate upload changes nothing', async () => {
    const t = await testDb();
    const p = await ranked(t);
    await p.host.call('pokejam_report_result', [p.mid, true]);
    await upload(p.host, p.mid);
    expect(await upload(p.host, p.mid)).toBe(false);
    expect((await job(t, p.mid))!.ready_in).toBeGreaterThan(85);
  });
});

describe('claiming', () => {
  it('only when ready, and only the number asked for, oldest first', async () => {
    const t = await testDb();
    const [p1, p2] = [await ranked(t), await ranked(t)];
    await p1.host.call('pokejam_report_result', [p1.mid, true]);
    await upload(p1.host, p1.mid);
    expect(await claim(t)).toEqual([]);
    await p2.host.call('pokejam_report_result', [p2.mid, true]);
    await upload(p2.host, p2.mid);
    await t.sql(`update public.pokejam_judge_jobs set ready_at = now() - interval '1 minute' where match_id = $1`, [p2.mid]);
    await makeReady(t, p1.mid);
    expect((await claim(t)).map((j) => j.match_id)).toEqual([p2.mid]);
    expect((await claim(t)).map((j) => j.match_id)).toEqual([p1.mid]);
    expect(await claim(t)).toEqual([]);
  });

  it('leases for 2 minutes, then a dead run\'s job is claimed again, up to 5 attempts, then failed', async () => {
    const t = await testDb();
    const { mid } = await readyJob(t);
    expect(await claim(t)).toEqual([expect.objectContaining({ match_id: mid, attempts: 1 })]);
    const j = (await job(t, mid))!;
    expect(j.state).toBe('running');
    expect(j.lease_in).toBeGreaterThan(115);
    expect(await claim(t)).toEqual([]); // still leased
    for (const attempts of [2, 3, 4, 5]) {
      await t.sql(`update public.pokejam_judge_jobs set locked_until = now() - interval '1 second' where match_id = $1`, [mid]);
      expect(await claim(t)).toEqual([expect.objectContaining({ attempts })]);
    }
    await t.sql(`update public.pokejam_judge_jobs set locked_until = now() - interval '1 second' where match_id = $1`, [mid]);
    expect(await claim(t)).toEqual([]);
    expect(await job(t, mid)).toMatchObject({ state: 'failed', attempts: 5 });
  });

  it('a job with no uploads closes without using a run, stays open to a late one, and does not hold up the next', async () => {
    const t = await testDb();
    const none = await ranked(t);
    await none.host.call('pokejam_report_result', [none.mid, true]);
    await t.sql(`update public.pokejam_judge_jobs set ready_at = now() - interval '1 hour' where match_id = $1`, [none.mid]);
    const real = await readyJob(t);
    expect((await claim(t)).map((j) => j.match_id)).toEqual([real.mid]);
    const closed = (await job(t, none.mid))!;
    expect(closed).toMatchObject({ state: 'done', attempts: 0 });
    expect(closed.window_in).toBeGreaterThan(590);
    await upload(none.host, none.mid);
    expect(await claim(t)).toEqual([expect.objectContaining({ match_id: none.mid, rejudge: true })]);
  });

  it('skips rows another worker holds', () => {
    // PGlite has one connection, so a second worker can't be run here.
    expect(readFileSync(new URL('../migrations/20261129_pokejam_judge_jobs.sql', import.meta.url), 'utf8')).toMatch(/for update skip locked/);
  });

  it('claim and finish are the service role\'s only; players can\'t read the table', async () => {
    const t = await testDb();
    const a = await t.user('A');
    await expect(a.call('pokejam_judge_claim', [1])).rejects.toThrow(/permission denied/);
    await expect(a.call('pokejam_judge_finish', [crypto.randomUUID(), true])).rejects.toThrow(/permission denied/);
    await expect(t.as('anon', null)('select * from public.pokejam_judge_claim(1)')).rejects.toThrow(/permission denied/);
    await expect(a.sql('select * from public.pokejam_judge_jobs')).rejects.toThrow(/permission denied/);
    await expect(a.sql('select public.pokejam_judge_enqueue()')).rejects.toThrow(/permission denied|trigger/);
  });
});

describe('finishing', () => {
  it('a final verdict is done for good: a late upload does not reopen it', async () => {
    const t = await testDb();
    const p = await readyJob(t);
    await claim(t);
    await verdict(t, p.mid, 'final');
    expect(await finish(t, p.mid)).toBe('done');
    expect((await job(t, p.mid))!.window_in).toBeNull();
    await upload(p.guest, p.mid);
    expect(await job(t, p.mid)).toMatchObject({ state: 'done', rejudge: false });
  });

  it('an incomplete verdict is judged again on a late upload, within 10 minutes', async () => {
    const t = await testDb();
    const p = await readyJob(t);
    await claim(t);
    await verdict(t, p.mid, 'incomplete', null);
    expect(await finish(t, p.mid)).toBe('done');
    expect((await job(t, p.mid))!.window_in).toBeGreaterThan(590);
    await upload(p.guest, p.mid);
    expect(await job(t, p.mid)).toMatchObject({ state: 'pending', rejudge: true, attempts: 0, window_in: null });
    expect((await job(t, p.mid))!.ready_in).toBeLessThanOrEqual(0);
    expect(await claim(t)).toEqual([expect.objectContaining({ match_id: p.mid, attempts: 1, rejudge: true })]);
    await verdict(t, p.mid, 'final');
    expect(await finish(t, p.mid)).toBe('done');
    expect(await job(t, p.mid)).toMatchObject({ rejudge: false, window_in: null });
  });

  it('after the window a late upload is ignored', async () => {
    const t = await testDb();
    const p = await readyJob(t);
    await claim(t);
    await verdict(t, p.mid, 'incomplete', null);
    await finish(t, p.mid);
    await t.sql(`update public.pokejam_judge_jobs set rejudge_until = now() - interval '1 second' where match_id = $1`, [p.mid]);
    await upload(p.guest, p.mid);
    expect(await job(t, p.mid)).toMatchObject({ state: 'done', rejudge: false });
  });

  it('an upload that arrives during the run, too late for it to read, is not lost', async () => {
    const t = await testDb();
    const p = await readyJob(t);
    await claim(t);
    await t.sql(`update public.pokejam_judge_jobs set claimed_at = now() - interval '5 seconds' where match_id = $1`, [p.mid]);
    await upload(p.guest, p.mid);
    await verdict(t, p.mid, 'incomplete', null);
    expect(await finish(t, p.mid)).toBe('pending');
    expect(await job(t, p.mid)).toMatchObject({ rejudge: true, attempts: 0 });
    expect(await claim(t)).toEqual([expect.objectContaining({ match_id: p.mid, rejudge: true })]);
    await verdict(t, p.mid, 'incomplete', null);
    expect(await finish(t, p.mid)).toBe('done'); // read this time: no loop
  });

  it('a failed run goes back in the queue after a minute, and fails for good on the last attempt', async () => {
    const t = await testDb();
    const { mid } = await readyJob(t);
    await claim(t);
    expect(await finish(t, mid, false)).toBe('pending');
    expect((await job(t, mid))!.ready_in).toBeGreaterThan(55);
    expect(await claim(t)).toEqual([]);
    await t.sql(`update public.pokejam_judge_jobs set ready_at = now(), attempts = 4 where match_id = $1`, [mid]);
    expect(await claim(t)).toEqual([expect.objectContaining({ attempts: 5 })]);
    expect(await finish(t, mid, false)).toBe('failed');
  });

  it('a job that is not running is left alone; no such job is null', async () => {
    const t = await testDb();
    const p = await ranked(t);
    await p.host.call('pokejam_report_result', [p.mid, true]);
    expect(await finish(t, p.mid)).toBe('pending');
    expect(await finish(t, crypto.randomUUID())).toBeNull();
  });
});

describe('shadow mode', () => {
  it('a verdict against the reported winner changes nothing about the match or anyone\'s rating', async () => {
    const t = await testDb();
    const p = await ranked(t);
    await p.host.call('pokejam_ranked_report_score', [p.mid, 70, 20]);
    await p.guest.call('pokejam_ranked_report_score', [p.mid, 70, 20]);
    await p.host.call('pokejam_report_result', [p.mid, true]);
    await p.guest.call('pokejam_report_result', [p.mid, true]);
    const state = async () => ({
      match: await t.sql('select * from public.pokejam_matches where id = $1', [p.mid]),
      ratings: await t.sql('select * from public.pokejam_ranked_profiles order by user_id'),
    });
    const before = await state();
    await upload(p.host, p.mid);
    await upload(p.guest, p.mid);
    expect(await claim(t)).toHaveLength(1);
    await verdict(t, p.mid, 'final', 1);
    await finish(t, p.mid);
    expect(await state()).toEqual(before);
    expect((await t.sql('select agrees, shadow from public.pokejam_match_verdicts where match_id = $1', [p.mid]))[0]).toEqual({ agrees: false, shadow: true });
  });
});

describe('pokejam_admin_judge_shadow', () => {
  type Row = Record<string, unknown> & { browser_engine: string };
  type Out = { rows: Row[]; backlog: Record<string, number | null> };
  const stats = (mid: string, u: User, cols: string, vals: string) => u.sql(`insert into public.pokejam_match_net_stats(match_id, user_id${cols}) values ('${mid}', '${u.id}'${vals})`);

  async function mod(t: Db) {
    const m = await t.user('Mod');
    await t.sql('insert into public.pokejam_admins(user_id) values ($1)', [m.id]);
    return m;
  }

  it('refuses anyone who is not a moderator', async () => {
    const t = await testDb();
    const a = await t.user('A');
    await expect(a.call('pokejam_admin_judge_shadow', [7])).rejects.toThrow(/moderators only/);
    await expect(t.as('anon', null)('select public.pokejam_admin_judge_shadow(7)')).rejects.toThrow(/permission denied/);
  });

  it('is empty, without dividing by zero, when there is nothing', async () => {
    const t = await testDb();
    const m = await mod(t);
    expect(await m.call('pokejam_admin_judge_shadow', [null])).toEqual({ rows: [], backlog: { pending: 0, running: 0, failed: 0, oldest_ready_s: null, unjudged: 0 } });
  });

  it('splits by the host\'s engine, reads no stats as unknown, and counts each status', async () => {
    const t = await testDb();
    const m = await mod(t);
    const done = async (hostWon: boolean, status: string, side: 0 | 1 | null) => {
      const p = await ranked(t);
      await p.host.call('pokejam_report_result', [p.mid, hostWon]);
      await p.guest.call('pokejam_report_result', [p.mid, hostWon]);
      await verdict(t, p.mid, status, side);
      return p;
    };
    const agree = await done(true, 'final', 0);
    const differ = await done(true, 'final', 1);
    const noStats = await done(true, 'final', 0);
    const invalid = await done(true, 'invalid', null);
    const older = await done(true, 'incomplete', null);
    await stats(agree.mid, agree.host, ', browser_engine', `, 'gecko'`);
    await stats(agree.mid, agree.guest, ', browser_engine', `, 'blink'`); // the guest's engine doesn't count
    await stats(differ.mid, differ.host, ', browser_engine, resyncs', `, 'gecko', 2`);
    await stats(invalid.mid, invalid.host, ', browser_engine', `, 'gecko'`);
    await stats(older.mid, older.host, '', ''); // an older client: the default 'unknown'
    void noStats;

    const { rows } = await m.call<Out>('pokejam_admin_judge_shadow', [7]);
    expect(rows.map((r) => r.browser_engine)).toEqual(['gecko', 'unknown']);
    expect(rows[0]).toMatchObject({ n: 3, final_n: 2, agree_n: 1, disagree_n: 1, agree_rate: 0.5, resync_matches: 1, resync_disagree_n: 1, invalid_n: 1, incomplete_n: 0, forfeit_n: 0 });
    expect(rows[1]).toMatchObject({ n: 2, final_n: 1, agree_n: 1, disagree_n: 0, agree_rate: 1, resync_matches: 0, resync_disagree_n: 0, invalid_n: 0, incomplete_n: 1 });
  });

  it('compares with the match as it stands now, leaves void matches out, and skips Social and old verdicts', async () => {
    const t = await testDb();
    const m = await mod(t);
    const early = await ranked(t); // judged before the match settled, so the stored `agrees` is null
    await verdict(t, early.mid, 'final', 0);
    await early.host.call('pokejam_report_result', [early.mid, true]);
    await early.guest.call('pokejam_report_result', [early.mid, true]);
    const voided = await ranked(t);
    await voided.host.call('pokejam_report_result', [voided.mid, true]);
    await voided.guest.call('pokejam_report_result', [voided.mid, false]);
    await verdict(t, voided.mid, 'final', 0);
    const old = await ranked(t);
    await verdict(t, old.mid, 'final', 0);
    await t.sql(`update public.pokejam_match_verdicts set judged_at = now() - interval '10 days' where match_id = $1`, [old.mid]);
    const [a, b] = [await t.user('A'), await t.user('B')];
    await verdict(t, await quickPair(t, a, b), 'final', 0);

    const { rows } = await m.call<Out>('pokejam_admin_judge_shadow', [7]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ browser_engine: 'unknown', n: 2, final_n: 2, agree_n: 1, disagree_n: 0, agree_rate: 1 });
  });

  it('shows the backlog', async () => {
    const t = await testDb();
    const m = await mod(t);
    const waiting = await readyJob(t);
    await t.sql(`update public.pokejam_judge_jobs set ready_at = now() - interval '5 minutes' where match_id = $1`, [waiting.mid]);
    const none = await ranked(t);
    await none.host.call('pokejam_report_result', [none.mid, true]);
    await makeReady(t, none.mid);
    const running = await readyJob(t);
    await t.sql(`update public.pokejam_judge_jobs set state = 'running', locked_until = now() + interval '1 minute' where match_id = $1`, [running.mid]);
    await t.sql(`update public.pokejam_judge_jobs set state = 'done' where match_id = $1`, [none.mid]);
    const { backlog } = await m.call<Out>('pokejam_admin_judge_shadow', [7]);
    expect(backlog).toMatchObject({ pending: 1, running: 1, failed: 0, unjudged: 1 });
    expect(backlog.oldest_ready_s).toBeGreaterThanOrEqual(299);
  });
});

describe('the cron migration', () => {
  const source = readFileSync(new URL('../migrations/20261130_pokejam_judge_cron.sql', import.meta.url), 'utf8');
  const command = /\$cron\$([\s\S]+?)\$cron\$/.exec(source)![1];

  it('holds no key or project address', () => {
    expect(source).not.toMatch(/eyJ|sb_secret|[a-z0-9]{20}\.supabase\.co/);
  });

  it('without pg_cron and pg_net it only says what to do (and the job it would schedule posts only when a job is ready)', async () => {
    const t = await testDb(); // testDb has run the migration with neither extension
    await t.db.exec(`
      create schema vault; create table vault.decrypted_secrets (name text, decrypted_secret text);
      insert into vault.decrypted_secrets values ('pokejam_functions_url', 'https://f.test/functions/v1'), ('pokejam_service_key', 'the-key');
      create schema net; create table net.posts (url text, headers jsonb, body jsonb, timeout int);
      create function net.http_post(url text, headers jsonb, body jsonb, timeout_milliseconds int) returns bigint language plpgsql as $$
        begin insert into net.posts values (url, headers, body, timeout_milliseconds); return 1; end $$;`);
    const posts = () => t.sql('select url, headers from net.posts');
    await t.db.exec(command);
    expect(await posts()).toEqual([]); // nothing to do

    const p = await readyJob(t);
    await t.db.exec(command);
    expect(await posts()).toEqual([{ url: 'https://f.test/functions/v1/pokejam-judge-worker', headers: { 'content-type': 'application/json', authorization: 'Bearer the-key' } }]);

    await claim(t); // leased: not due again until the lease runs out
    await t.db.exec(command);
    expect(await posts()).toHaveLength(1);
    await t.sql(`update public.pokejam_judge_jobs set locked_until = now() - interval '1 second' where match_id = $1`, [p.mid]);
    await t.db.exec(command);
    expect(await posts()).toHaveLength(2);
  });
});
