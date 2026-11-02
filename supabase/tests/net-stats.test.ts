// Per-match network stats (migrations 20261108, 20261126): a player writes and reads only their own row, only for their own match.
import { describe, expect, it, vi } from 'vitest';
import { quickPair, testDb, type Db, type User } from './testDb';

vi.setConfig({ testTimeout: 30_000 });

const row = (mid: string, uid: string) =>
  `insert into public.pokejam_match_net_stats(match_id, user_id, rtt_median_ms, relay_protocol, stalls, duration_s, start_delay, final_delay, max_delay, proto_version, client_version)
   values ('${mid}', '${uid}', 180.5, 'udp', 3, 240, 12, 14, 20, 3, 'web-n3')`;

async function pair(t: Db): Promise<{ mid: string; a: User; b: User }> {
  const [a, b] = [await t.user('A'), await t.user('B')];
  return { mid: await quickPair(t, a, b), a, b };
}

describe('pokejam_match_net_stats', () => {
  it('a player can insert their own row for their match and read it back', async () => {
    const t = await testDb();
    const { mid, a } = await pair(t);
    await a.sql(row(mid, a.id));
    const rows = await a.sql('select * from public.pokejam_match_net_stats');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ match_id: mid, user_id: a.id, relay_protocol: 'udp', stalls: 3, used_realtime_fallback: false });
  });

  it('both players of a match each get a row, and each sees only their own', async () => {
    const t = await testDb();
    const { mid, a, b } = await pair(t);
    await a.sql(row(mid, a.id));
    await b.sql(row(mid, b.id));
    expect((await a.sql('select user_id from public.pokejam_match_net_stats')).map((r) => r.user_id)).toEqual([a.id]);
    expect((await b.sql('select user_id from public.pokejam_match_net_stats')).map((r) => r.user_id)).toEqual([b.id]);
  });

  it('rejects a row for a match the player is not in', async () => {
    const t = await testDb();
    const { mid } = await pair(t);
    const stranger = await t.user('C');
    await expect(stranger.sql(row(mid, stranger.id))).rejects.toThrow(/row-level security/);
    expect(await t.sql('select 1 from public.pokejam_match_net_stats')).toHaveLength(0);
  });

  it('rejects a row written in another user\'s name', async () => {
    const t = await testDb();
    const { mid, a, b } = await pair(t);
    await expect(a.sql(row(mid, b.id))).rejects.toThrow(/row-level security/);
    expect(await t.sql('select 1 from public.pokejam_match_net_stats')).toHaveLength(0);
  });

  it('one row per player per match, and a void match still accepts the row', async () => {
    const t = await testDb();
    const { mid, a } = await pair(t);
    await a.call('pokejam_leave_match', [mid]);
    await a.sql(row(mid, a.id));
    await expect(a.sql(row(mid, a.id))).rejects.toThrow(/duplicate key|unique/);
  });

  it('rejects nonsense values and unknown relay protocols', async () => {
    const t = await testDb();
    const { mid, a } = await pair(t);
    const bad = (col: string, v: string) => `insert into public.pokejam_match_net_stats(match_id, user_id, ${col}) values ('${mid}', '${a.id}', ${v})`;
    await expect(a.sql(bad('relay_protocol', "'carrier-pigeon'"))).rejects.toThrow(/check constraint/);
    await expect(a.sql(bad('rtt_median_ms', '-5'))).rejects.toThrow(/check constraint/);
    await expect(a.sql(bad('client_version', `'${'x'.repeat(100)}'`))).rejects.toThrow(/check constraint/);
  });

  it('is for signed-in players only, and rows cannot be changed or deleted', async () => {
    const t = await testDb();
    const { mid, a } = await pair(t);
    await expect(t.as('anon', null)('select * from public.pokejam_match_net_stats')).rejects.toThrow(/permission denied/);
    await a.sql(row(mid, a.id));
    await expect(a.sql('update public.pokejam_match_net_stats set stalls = 0')).rejects.toThrow(/permission denied/);
    await expect(a.sql('delete from public.pokejam_match_net_stats')).rejects.toThrow(/permission denied/);
  });
  it('stores the cost and resync counters, and an old-style row gets the defaults', async () => {
    const t = await testDb();
    const { mid, a, b } = await pair(t);
    await a.sql(`insert into public.pokejam_match_net_stats(match_id, user_id, relay_protocol, sent_realtime, sent_direct, realtime_inputs, received, dropped, resyncs, browser_engine)
      values ('${mid}', '${a.id}', 'udp', 150, 4200, 12, 4100, 9, 2, 'gecko')`);
    await b.sql(row(mid, b.id));
    expect((await a.sql('select * from public.pokejam_match_net_stats'))[0]).toMatchObject(
      { sent_realtime: 150, sent_direct: 4200, realtime_inputs: 12, received: 4100, dropped: 9, resyncs: 2, browser_engine: 'gecko' });
    expect((await b.sql('select * from public.pokejam_match_net_stats'))[0]).toMatchObject(
      { sent_realtime: 0, sent_direct: 0, realtime_inputs: 0, received: 0, dropped: 0, resyncs: 0, browser_engine: 'unknown' });
    await expect(a.sql('update public.pokejam_match_net_stats set resyncs = 0')).rejects.toThrow(/permission denied/);
  });

  it('rejects out-of-range counters and unknown browser engines', async () => {
    const t = await testDb();
    const { mid, a } = await pair(t);
    const bad = (col: string, v: string) => `insert into public.pokejam_match_net_stats(match_id, user_id, ${col}) values ('${mid}', '${a.id}', ${v})`;
    await expect(a.sql(bad('sent_realtime', '-1'))).rejects.toThrow(/check constraint/);
    await expect(a.sql(bad('sent_direct', '10000001'))).rejects.toThrow(/check constraint/);
    await expect(a.sql(bad('resyncs', '100001'))).rejects.toThrow(/check constraint/);
    await expect(a.sql(bad('browser_engine', "'netscape'"))).rejects.toThrow(/check constraint/);
    await a.sql(bad('sent_direct', '10000000'));
  });

  it('the migration can run again', async () => {
    const t = await testDb();
    const { readFileSync } = await import('node:fs');
    await t.db.exec(readFileSync(new URL('../migrations/20261126_pokejam_net_cost_stats.sql', import.meta.url), 'utf8'));
  });
});
