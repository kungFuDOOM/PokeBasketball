// The Social launch fixes (migrations 20261103-20261105) on a real Postgres (testDb.ts): the queue heartbeat, leaving
// that cleans up after itself, the draft that knows the match is over and waits for both players, and the cleanup of
// abandoned matches. Old RPC names and arguments are what's called here, so older clients keep working.
import { describe, expect, it, vi } from 'vitest';
import { quickPair, testDb, type Db, type User } from './testDb';

vi.setConfig({ testTimeout: 30_000 });

interface View { picks: unknown[]; done: boolean; turn: number; seconds_left: number; opponent_seen_ago: number | null; status?: string }

const statusOf = async (t: Db, mid: string) => (await t.sql('select status from public.pokejam_matches where id = $1', [mid]))[0].status;
/** Who hosts a match (the player who was waiting in the queue). */
async function sides(a: User, b: User, mid: string) {
  const info = await a.call<Record<string, string>>('pokejam_match_info', [mid]);
  return info.host === a.id ? [a, b] : [b, a];
}

describe('the queue heartbeat (ghost queue, #2)', () => {
  it('a player who stopped polling 15 s ago is not matched; polling again makes them matchable', async () => {
    const t = await testDb();
    const [ghost, b] = [await t.user('Ghost'), await t.user('B')];
    expect(await ghost.call('pokejam_find_match', ['social'])).toBeNull();
    await t.sql("update public.pokejam_queue set last_seen = now() - interval '16 seconds' where user_id = $1", [ghost.id]);
    expect(await b.call('pokejam_find_match', ['social'])).toBeNull(); // not paired with the ghost
    // The ghost comes back and polls (a heartbeat): B is live in the queue, so they are paired at once.
    const mid = await ghost.call<string>('pokejam_find_match', ['social']);
    expect(mid).toBeTruthy();
    expect(await b.call('pokejam_find_match', ['social'])).toBe(mid);
  });

  it('every poll refreshes last_seen, and a long search (over 2 minutes) can still be found', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A'), await t.user('B')];
    await a.call('pokejam_find_match', ['social']);
    await t.sql("update public.pokejam_queue set joined_at = now() - interval '5 minutes', last_seen = now() - interval '1 minute' where user_id = $1", [a.id]);
    await a.call('pokejam_find_match', ['social']);
    const [row] = await t.sql('select extract(epoch from now() - last_seen)::float as ago, extract(epoch from now() - joined_at)::float as waited from public.pokejam_queue where user_id = $1', [a.id]);
    expect(row.ago).toBeLessThan(5);
    expect(row.waited).toBeGreaterThan(200); // still the same search
    expect(await b.call('pokejam_find_match', ['social'])).toBeTruthy();
  });

  it('Ranked uses the same heartbeat and still pairs', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A'), await t.user('B')];
    expect(await a.call('pokejam_find_match', ['ranked'])).toBeNull();
    const mid = await b.call<string>('pokejam_find_match', ['ranked']);
    expect((await a.call<Record<string, string>>('pokejam_match_info', [mid])).queue).toBe('ranked');
  });
});

describe('leaving cleans up (cancel race #1, tab closed #8)', () => {
  it('leave_queue calls off a quick Social match made for me that I never opened', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A'), await t.user('B')];
    const mid = await quickPair(t, a, b); // a was waiting, b's poll made the match; a cancels before its next poll
    await a.call('pokejam_leave_queue');
    expect(await statusOf(t, mid)).toBe('void');
    expect(await a.call('pokejam_find_match', ['social'])).toBeNull(); // and a is not handed the dead match
  });

  it('but not a match I opened, a room, or a Ranked match', async () => {
    const t = await testDb();
    const [a, b, c, d] = [await t.user('A'), await t.user('B'), await t.user('C'), await t.user('D')];
    const opened = await quickPair(t, a, b);
    await a.call('pokejam_draft_state', [opened]);
    await a.call('pokejam_leave_queue');
    expect(await statusOf(t, opened)).toBe('active');

    const code = await c.call<string>('pokejam_create_room', [120]);
    const room = await d.call<string>('pokejam_join_room', [code]);
    await d.call('pokejam_leave_queue');
    expect(await statusOf(t, room)).toBe('active');

    expect(await c.call('pokejam_find_match', ['ranked'])).toBeNull();
    const ranked = await d.call<string>('pokejam_find_match', ['ranked']);
    await c.call('pokejam_leave_queue');
    expect(await statusOf(t, ranked)).toBe('active');
  });

  it('a host who cancels after a friend joined (but before opening the draft) calls the room off', async () => {
    const t = await testDb();
    const [host, guest] = [await t.user('Host'), await t.user('Guest')];
    const code = await host.call<string>('pokejam_create_room', [120]);
    const mid = await guest.call<string>('pokejam_join_room', [code]);
    await guest.call('pokejam_draft_state', [mid]);
    await host.call('pokejam_close_room', [code]);
    expect(await statusOf(t, mid)).toBe('void');
    expect((await guest.call<View>('pokejam_draft_state', [mid])).status).toBe('void');
  });

  it('closing a room whose draft the host already opened changes nothing', async () => {
    const t = await testDb();
    const [host, guest] = [await t.user('Host'), await t.user('Guest')];
    const code = await host.call<string>('pokejam_create_room', [120]);
    const mid = await guest.call<string>('pokejam_join_room', [code]);
    await host.call('pokejam_draft_state', [mid]);
    await host.call('pokejam_close_room', [code]);
    expect(await statusOf(t, mid)).toBe('active');
  });
});

describe('room state for the host (#5, #10)', () => {
  it('open, joined, closed or expired; only the host sees it', async () => {
    const t = await testDb();
    const [host, guest] = [await t.user('Host'), await t.user('Guest')];
    const code = await host.call<string>('pokejam_create_room', [120]);
    expect(await host.call('pokejam_room_state', [code])).toEqual({ match: null, status: 'waiting' });
    expect(await guest.call('pokejam_room_state', [code])).toBeNull();
    const mid = await guest.call<string>('pokejam_join_room', [code]);
    expect(await host.call('pokejam_room_state', [code])).toEqual({ match: mid, status: 'active' });
    await guest.call('pokejam_leave_match', [mid]);
    expect(await host.call('pokejam_room_state', [code])).toEqual({ match: null, status: 'void' });
    // The old poll still answers as before.
    expect(await host.call('pokejam_room_match', [code])).toBeNull();

    const old = await host.call<string>('pokejam_create_room', [120]);
    await t.sql("update public.pokejam_matches set created_at = now() - interval '31 minutes' where room_code = $1", [old]);
    expect(await host.call('pokejam_room_state', [old])).toEqual({ match: null, status: 'expired' });
  });
});

describe('the draft knows the match is over and waits for both players (#5, #6)', () => {
  it('the pick clock stands still until both players have opened the draft, then starts in full', async () => {
    const t = await testDb();
    const [hostU, guestU] = [await t.user('Host'), await t.user('Guest')];
    const code = await hostU.call<string>('pokejam_create_room', [120]);
    const mid = await guestU.call<string>('pokejam_join_room', [code]);
    const v = await guestU.call<View>('pokejam_draft_state', [mid]);
    expect(v.opponent_seen_ago).toBeNull();
    expect(v.status).toBe('active');
    // The host is in another app for a minute: the guest keeps polling, and nobody gets random picks.
    await t.sql("update public.pokejam_drafts set deadline = now() - interval '60 seconds' where match_id = $1", [mid]);
    const later = await guestU.call<View>('pokejam_draft_state', [mid]);
    expect(later.picks).toHaveLength(0);
    expect(later.seconds_left).toBeGreaterThan(12);
    // The host is back: the clock restarts in full.
    const h = await hostU.call<View>('pokejam_draft_state', [mid]);
    expect(h.picks).toHaveLength(0);
    expect(h.seconds_left).toBeGreaterThan(12);
    expect(h.opponent_seen_ago).toBeLessThan(5);
    // From now on, time running out makes picks as before.
    await t.sql("update public.pokejam_drafts set deadline = now() - interval '1 second' where match_id = $1", [mid]);
    expect((await guestU.call<View>('pokejam_draft_state', [mid])).picks).toHaveLength(1);
  });

  it('after the other player left: status void, no auto picks, no seen updates, and picks are refused', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A'), await t.user('B')];
    const mid = await quickPair(t, a, b);
    const [host, guest] = await sides(a, b, mid);
    await host.call('pokejam_draft_state', [mid]);
    await guest.call('pokejam_draft_state', [mid]);
    await guest.call('pokejam_leave_match', [mid]);
    await t.sql("update public.pokejam_drafts set deadline = now() - interval '10 minutes', guest_seen = now() - interval '30 seconds' where match_id = $1", [mid]);
    const v = await host.call<View>('pokejam_draft_state', [mid]);
    expect(v.status).toBe('void');
    expect(v.picks).toHaveLength(0);
    expect(v.done).toBe(false);
    expect(v.opponent_seen_ago).toBeGreaterThan(25); // an older client still sees the opponent gone, and stops
    await expect(host.call('pokejam_draft_pick', [mid, 25])).rejects.toThrow(/match is over/);
    // Nothing for either player to join: the channel policy refuses a voided match.
    expect((await host.call<Record<string, string>>('pokejam_match_status', [mid])).status).toBe('void');
  });

  it('a match called off before anyone opened the draft says so', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A'), await t.user('B')];
    const mid = await quickPair(t, a, b);
    await a.call('pokejam_leave_match', [mid]);
    await expect(b.call('pokejam_draft_state', [mid])).rejects.toThrow(/match is over/);
  });
});

describe('abandoned Social matches are cleaned up (#4)', () => {
  /** Two quick-matched players who both opened the draft. */
  async function drafted(t: Db) {
    const [a, b] = [await t.user(), await t.user()];
    const mid = await quickPair(t, a, b);
    await a.call('pokejam_draft_state', [mid]);
    await b.call('pokejam_draft_state', [mid]);
    return { a, b, mid };
  }
  const age = (t: Db, mid: string, minutes: number) => t.sql(`update public.pokejam_matches set created_at = now() - make_interval(mins => $2) where id = $1`, [mid, minutes]);
  const quiet = (t: Db, mid: string, minutes: number) => t.sql(`update public.pokejam_drafts set created_at = now() - make_interval(mins => $2),
    host_seen = now() - make_interval(mins => $2), guest_seen = now() - make_interval(mins => $2) where match_id = $1`, [mid, minutes]);
  const finishDraft = (t: Db, mid: string) => t.sql('update public.pokejam_drafts set done = true where match_id = $1', [mid]);
  const cleanup = async (t: Db) => (await t.service('select public.pokejam_cleanup_matches() as n'))[0].n;

  it('voids drafts nobody has looked at for 2 minutes, and games still active an hour on; never one in progress', async () => {
    const t = await testDb();
    const stale = (await drafted(t)).mid;
    await quiet(t, stale, 3);
    const live = (await drafted(t)).mid; // drafting right now
    await quiet(t, live, 1);
    const playing = (await drafted(t)).mid; // draft done 40 minutes ago: the game (or its results) is still going
    await finishDraft(t, playing);
    await quiet(t, playing, 40);
    await age(t, playing, 40);
    const forgotten = (await drafted(t)).mid;
    await finishDraft(t, forgotten);
    await age(t, forgotten, 61);

    expect(await cleanup(t)).toBe(2);
    expect(await statusOf(t, stale)).toBe('void');
    expect(await statusOf(t, forgotten)).toBe('void');
    expect(await statusOf(t, live)).toBe('active');
    expect(await statusOf(t, playing)).toBe('active');
    expect((await t.sql('select finished_at from public.pokejam_matches where id = $1', [stale]))[0].finished_at).not.toBeNull();
  });

  it('a match with no draft (an older client) is only voided after the hour; Ranked and finished matches never', async () => {
    const t = await testDb();
    const [a, b, c, d] = [await t.user(), await t.user(), await t.user(), await t.user()];
    const nodraft = await quickPair(t, a, b);
    await age(t, nodraft, 30);
    expect(await c.call('pokejam_find_match', ['ranked'])).toBeNull();
    const ranked = await d.call<string>('pokejam_find_match', ['ranked']);
    await age(t, ranked, 1); // a one-minute-old Ranked pairing (the Ranked sweep, 90 s, is tested in ranked-matchmaking.test.ts)
    const done = (await drafted(t)).mid;
    await t.sql("update public.pokejam_matches set status = 'done', finished_at = now() where id = $1", [done]);
    await age(t, done, 5 * 60);
    expect(await cleanup(t)).toBe(0);
    await age(t, nodraft, 61);
    expect(await cleanup(t)).toBe(1);
    expect(await statusOf(t, nodraft)).toBe('void');
    expect(await statusOf(t, ranked)).toBe('active');
    expect(await statusOf(t, done)).toBe('done');
  });

  it('rooms nobody joined for 30 minutes are closed', async () => {
    const t = await testDb();
    const host = await t.user();
    const code = await host.call<string>('pokejam_create_room', [120]);
    await t.sql("update public.pokejam_matches set created_at = now() - interval '31 minutes' where room_code = $1", [code]);
    expect(await cleanup(t)).toBe(1);
    expect((await t.sql('select status from public.pokejam_matches where room_code = $1', [code]))[0].status).toBe('void');
  });

  it('matchmaking runs it on the way, at most once a minute; players cannot run it directly', async () => {
    const t = await testDb();
    const stale = (await drafted(t)).mid;
    await quiet(t, stale, 3);
    const someone = await t.user();
    const lastRunLongAgo = () => t.sql("update public.pokejam_jobs set ran_at = now() - interval '61 seconds' where name = 'cleanup'");
    await lastRunLongAgo(); // (pairing the players above already ran it once)
    await someone.call('pokejam_find_match', ['social']); // a search runs it
    expect(await statusOf(t, stale)).toBe('void');
    await someone.call('pokejam_leave_queue');

    const next = (await drafted(t)).mid;
    await quiet(t, next, 3);
    await lastRunLongAgo();
    await someone.call<string>('pokejam_create_room', [120]); // making a room runs it too
    expect(await statusOf(t, next)).toBe('void');

    const third = (await drafted(t)).mid;
    await quiet(t, third, 3);
    await someone.call('pokejam_find_match', ['social']); // within the minute: not again
    expect(await statusOf(t, third)).toBe('active');

    await expect(someone.call('pokejam_cleanup_matches')).rejects.toThrow(/permission denied/);
    await expect(someone.call('pokejam_cleanup_maybe')).rejects.toThrow(/permission denied/);
    await expect(someone.sql('select * from public.pokejam_jobs')).rejects.toThrow(/permission denied/);
  });

  it('a voided match cannot report a result (result logic unchanged)', async () => {
    const t = await testDb();
    const { a, mid } = await drafted(t);
    await quiet(t, mid, 3);
    await cleanup(t);
    await expect(a.call('pokejam_report_result', [mid, true])).rejects.toThrow(/not active/);
  });
});
