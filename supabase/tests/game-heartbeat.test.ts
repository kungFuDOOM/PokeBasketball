// The in-game heartbeat (migration 20261106): a Social game that both players abandoned is called off in minutes, and
// older clients that never beat keep the 60-minute rule. Stale queue rows are removed.
import { describe, expect, it, vi } from 'vitest';
import { quickPair, testDb, type Db, type User } from './testDb';

vi.setConfig({ testTimeout: 30_000 });

const statusOf = async (t: Db, mid: string) => (await t.sql('select status from public.pokejam_matches where id = $1', [mid]))[0].status;
const cleanup = async (t: Db) => (await t.service('select public.pokejam_cleanup_matches() as n'))[0].n;
/** Sets a player's last heartbeat to `seconds` ago (null: never). */
const beat = (t: Db, mid: string, col: 'host_alive' | 'guest_alive', seconds: number | null) =>
  t.sql(`update public.pokejam_matches set ${col} = ${seconds === null ? 'null' : `now() - make_interval(secs => ${seconds})`} where id = $1`, [mid]);
async function pair(t: Db): Promise<{ mid: string; a: User; b: User }> {
  const [a, b] = [await t.user('A'), await t.user('B')];
  return { mid: await quickPair(t, a, b), a, b };
}

describe('pokejam_match_alive', () => {
  it('records the caller\'s heartbeat on their own side and returns the status', async () => {
    const t = await testDb();
    const { mid, a, b } = await pair(t);
    const info = await a.call<Record<string, string>>('pokejam_match_info', [mid]);
    const [host, guest] = info.host === a.id ? [a, b] : [b, a];
    expect(await host.call('pokejam_match_alive', [mid])).toBe('active');
    let [row] = await t.sql('select host_alive, guest_alive from public.pokejam_matches where id = $1', [mid]);
    expect(row.host_alive).not.toBeNull();
    expect(row.guest_alive).toBeNull();
    await guest.call('pokejam_match_alive', [mid]);
    [row] = await t.sql('select host_alive, guest_alive from public.pokejam_matches where id = $1', [mid]);
    expect(row.guest_alive).not.toBeNull();
  });

  it('writes at most every 10 seconds per player', async () => {
    const t = await testDb();
    const { mid, a } = await pair(t);
    await a.call('pokejam_match_alive', [mid]);
    const read = async () => (await t.sql('select coalesce(host_alive, guest_alive) as at from public.pokejam_matches where id = $1', [mid]))[0].at as Date;
    const first = await read();
    await a.call('pokejam_match_alive', [mid]);
    expect((await read()).getTime()).toBe(first.getTime());
  });

  it('says null for a stranger, never writes for one, and reports a void match', async () => {
    const t = await testDb();
    const { mid, a } = await pair(t);
    const stranger = await t.user('C');
    expect(await stranger.call('pokejam_match_alive', [mid])).toBeNull();
    expect((await t.sql('select host_alive, guest_alive from public.pokejam_matches where id = $1', [mid]))[0]).toEqual({ host_alive: null, guest_alive: null });
    await a.call('pokejam_leave_match', [mid]);
    expect(await a.call('pokejam_match_alive', [mid])).toBe('void');
    expect((await t.sql('select host_alive, guest_alive from public.pokejam_matches where id = $1', [mid]))[0]).toEqual({ host_alive: null, guest_alive: null });
  });

  it('is for signed-in players only', async () => {
    const t = await testDb();
    const { mid } = await pair(t);
    await expect(t.as('anon', null)('select public.pokejam_match_alive($1)', [mid])).rejects.toThrow(/permission denied/);
    await expect(t.as('authenticated', null)('select public.pokejam_match_alive($1)', [mid])).rejects.toThrow(/not signed in/);
  });
});

describe('abandoned games are called off', () => {
  it('both players beat, then both stopped for over 3 minutes: void; the same match 2 minutes quiet is kept', async () => {
    const t = await testDb();
    const { mid } = await pair(t);
    await beat(t, mid, 'host_alive', 120);
    await beat(t, mid, 'guest_alive', 130);
    expect(await cleanup(t)).toBe(0);
    await beat(t, mid, 'host_alive', 185);
    await beat(t, mid, 'guest_alive', 200);
    expect(await cleanup(t)).toBe(1);
    expect(await statusOf(t, mid)).toBe('void');
    expect((await t.sql('select finished_at from public.pokejam_matches where id = $1', [mid]))[0].finished_at).not.toBeNull();
  });

  it('either player still beating keeps the match', async () => {
    const t = await testDb();
    const { mid } = await pair(t);
    await beat(t, mid, 'host_alive', 600);
    await beat(t, mid, 'guest_alive', 20);
    expect(await cleanup(t)).toBe(0);
    expect(await statusOf(t, mid)).toBe('active');
  });

  it('a player on an older client (never beat) keeps the 60-minute rule, however quiet the other is', async () => {
    const t = await testDb();
    const { mid } = await pair(t);
    await beat(t, mid, 'host_alive', 3600);
    expect(await cleanup(t)).toBe(0);
    const old = await pair(t); // nobody beats: an old build
    await t.sql("update public.pokejam_matches set created_at = now() - interval '30 minutes' where id = $1", [old.mid]);
    expect(await cleanup(t)).toBe(0);
    await t.sql("update public.pokejam_matches set created_at = now() - interval '61 minutes' where id = $1", [old.mid]);
    expect(await cleanup(t)).toBe(1);
  });

  it('never touches a finished match, a Ranked match, or a room that is still waiting', async () => {
    const t = await testDb();
    const done = (await pair(t)).mid;
    await t.sql("update public.pokejam_matches set status = 'done', finished_at = now() where id = $1", [done]);
    const [c, d] = [await t.user(), await t.user()];
    await c.call('pokejam_find_match', ['ranked']);
    const ranked = (await d.call<string>('pokejam_find_match', ['ranked']))!;
    await t.sql("update public.pokejam_matches set host_alive = now() - interval '1 hour', guest_alive = now() - interval '1 hour' where id in ($1, $2)", [done, ranked]);
    expect(await cleanup(t)).toBe(0);
    expect(await statusOf(t, done)).toBe('done');
    expect(await statusOf(t, ranked)).toBe('active');
  });

  it('close a tab mid-game: the leave voids it at once, and the remaining player\'s next heartbeat sees it', async () => {
    const t = await testDb();
    const { mid, a, b } = await pair(t);
    await a.call('pokejam_match_alive', [mid]);
    await b.call('pokejam_match_alive', [mid]);
    await a.call('pokejam_leave_match', [mid]); // the pagehide beacon
    expect(await b.call('pokejam_match_alive', [mid])).toBe('void');
  });
});

describe('stale queue rows', () => {
  it('rows not refreshed for 2 minutes are removed, live ones stay', async () => {
    const t = await testDb();
    const [gone, live] = [await t.user('Gone'), await t.user('Live')];
    await gone.call('pokejam_find_match', ['social']);
    await live.call('pokejam_find_match', ['ranked']);
    await t.sql("update public.pokejam_queue set last_seen = now() - interval '121 seconds' where user_id = $1", [gone.id]);
    await cleanup(t);
    const rows = await t.sql('select user_id from public.pokejam_queue');
    expect(rows.map((r) => r.user_id)).toEqual([live.id]);
  });

  it('the 20261103 rules still hold: unopened-draft and waiting-room voiding go on working', async () => {
    const t = await testDb();
    const host = await t.user();
    const code = await host.call<string>('pokejam_create_room', [120]);
    await t.sql("update public.pokejam_matches set created_at = now() - interval '31 minutes' where room_code = $1", [code]);
    expect(await cleanup(t)).toBe(1);
  });

  it('players cannot run the cleanup', async () => {
    const t = await testDb();
    const someone = await t.user();
    await expect(someone.call('pokejam_cleanup_matches')).rejects.toThrow(/permission denied/);
  });
});
