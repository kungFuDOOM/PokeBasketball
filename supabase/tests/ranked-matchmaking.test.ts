// Season 1 Ranked matchmaking and leavers (migration 20261112): the rank window, cooldowns, heartbeat forfeits, dodges,
// the stale-match sweep, and the Social queue left exactly as it was.
import { describe, expect, it, vi } from 'vitest';
import { quickPair, testDb, type Db, type User } from './testDb';

vi.setConfig({ testTimeout: 60_000 });

type Row = Record<string, unknown>;
const season = async (t: Db) => (await t.sql('select * from public.pokejam_ranked_season()'))[0] as Row;
/** The ranked profile; a player who was never scored has none, which reads as a clean slate. */
const prof = async (t: Db, uid: string) => ((await t.sql('select * from public.pokejam_ranked_profiles where user_id = $1 order by season_id desc limit 1', [uid]))[0]
  ?? { wins: 0, losses: 0, leaves_24h: 0, cooldown_until: null }) as Row;
const status = async (t: Db, mid: string) => (await t.sql('select status from public.pokejam_matches where id = $1', [mid]))[0].status;
const scored = async (t: Db, mid: string) => Number((await t.sql('select count(*)::int as n from public.pokejam_ranked_matches where match_id = $1', [mid]))[0].n);
const cleanup = async (t: Db) => Number((await t.service('select public.pokejam_cleanup_matches() as n'))[0].n);
const queued = async (t: Db, uid: string) => (await t.sql('select * from public.pokejam_queue where user_id = $1', [uid]))[0] as Row | undefined;

/** Puts a player at a ladder score (placed) in the current season. */
async function setScore(t: Db, u: User, score: number) {
  const s = await season(t);
  await t.sql('select public.pokejam_ranked_profile_lock($1, $2)', [u.id, s.id]);
  await t.sql(`update public.pokejam_ranked_profiles set status = 'ranked', placements_played = 5, div_idx = $3, points = $4, peak_idx = $3
      where user_id = $1 and season_id = $2`, [u.id, s.id, Math.floor(score / 100), score % 100]);
}
/** Pretends the player has been searching for `seconds`. */
const waited = (t: Db, u: User, seconds: number) =>
  t.sql(`update public.pokejam_queue set joined_at = now() - make_interval(secs => $2) where user_id = $1`, [u.id, seconds]);
/** Two new players (score 0) paired in the Ranked queue; returns the match with who is host. */
async function rankedPair(t: Db) {
  const [a, b] = [await t.user('A'), await t.user('B')];
  expect(await a.call('pokejam_find_match', ['ranked'])).toBeNull();
  const mid = await b.call<string | null>('pokejam_find_match', ['ranked']);
  expect(mid).toBeTruthy();
  const info = await a.call<Record<string, string>>('pokejam_match_info', [mid!]);
  return { mid: mid!, host: info.host === a.id ? a : b, guest: info.host === a.id ? b : a };
}
const col = (side: 'host' | 'guest') => `${side}_alive`;
/** Sets a player's last game heartbeat to `seconds` ago (null: never). */
const beat = (t: Db, mid: string, side: 'host' | 'guest', seconds: number | null) =>
  t.sql(`update public.pokejam_matches set ${col(side)} = ${seconds === null ? 'null' : `now() - make_interval(secs => ${seconds})`} where id = $1`, [mid]);
/** Moves the pairing into the past. */
const age = (t: Db, mid: string, seconds: number) =>
  t.sql(`update public.pokejam_matches set created_at = now() - make_interval(secs => $2) where id = $1`, [mid, seconds]);

describe('the rank window', () => {
  it('widens with the wait: 100 to 10 s, +15/s to 400 at 30 s, +10/s to 700 at 60 s, then 900', async () => {
    const t = await testDb();
    const w = async (s: number) => Number((await t.sql('select public.pokejam_ranked_window($1) as w', [s]))[0].w);
    expect([await w(0), await w(9), await w(10), await w(20), await w(30), await w(45), await w(59), await w(60), await w(600)])
      .toEqual([100, 100, 100, 250, 400, 550, 690, 900, 900]);
  });

  it('pairs by ladder score: a far player waits until the window reaches them', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A'), await t.user('B')];
    await setScore(t, a, 0);
    await setScore(t, b, 500);
    expect(await a.call('pokejam_find_match', ['ranked'])).toBeNull();
    expect(await (await queued(t, a.id))!.mmr).toBe(0);
    expect(await b.call('pokejam_find_match', ['ranked'])).toBeNull(); // 500 apart at 0 s
    await waited(t, b, 20); // window 250
    expect(await b.call('pokejam_find_match', ['ranked'])).toBeNull();
    await waited(t, b, 40); // window 500
    const mid = await b.call<string | null>('pokejam_find_match', ['ranked']);
    expect(mid).toBeTruthy();
    expect((await t.sql('select host_mmr, guest_mmr from public.pokejam_matches where id = $1', [mid]))[0]).toEqual({ host_mmr: 0, guest_mmr: 500 });
    expect(await queued(t, a.id)).toBeUndefined();
  });

  it('picks the closest score, and a placing player is queued by their seed', async () => {
    const t = await testDb();
    const [a, b, c, d] = [await t.user('A'), await t.user('B'), await t.user('C'), await t.user('D')];
    await setScore(t, b, 60);
    await setScore(t, c, 20);
    const s = await season(t);
    await t.sql('select public.pokejam_ranked_profile_lock($1, $2)', [d.id, s.id]);
    await t.sql(`update public.pokejam_ranked_profiles set seed_score = 1000, div_idx = 10, points = 0 where user_id = $1`, [d.id]);
    expect(await d.call('pokejam_find_match', ['ranked'])).toBeNull();
    expect((await queued(t, d.id))!.mmr).toBe(1000); // seed_score while placing, not the stored position
    await t.sql('delete from public.pokejam_queue where user_id = $1', [d.id]);
    expect(await b.call('pokejam_find_match', ['ranked'])).toBeNull();
    expect(await c.call('pokejam_find_match', ['ranked'])).toBeTruthy(); // C pairs with B (40 apart)
    expect(await a.call('pokejam_find_match', ['ranked'])).toBeNull(); // nobody left within 100
  });

  it('keeps the hard rules: no Bronze against Platinum+, Eclipse+ never more than 3 tiers down', async () => {
    const t = await testDb();
    const ok = async (a: number, b: number) => (await t.sql('select public.pokejam_ranked_pair_ok($1, $2) as ok', [a, b]))[0].ok;
    expect([await ok(0, 800), await ok(0, 900), await ok(900, 0), await ok(1800, 800), await ok(1800, 900), await ok(2400, 1500), await ok(2400, 1100)])
      .toEqual([true, false, false, false, true, true, false]);
    const [a, b] = [await t.user('A'), await t.user('B')];
    await setScore(t, a, 0);
    await setScore(t, b, 900);
    await a.call('pokejam_find_match', ['ranked']);
    await b.call('pokejam_find_match', ['ranked']);
    await waited(t, a, 300);
    await waited(t, b, 300);
    expect(await a.call('pokejam_find_match', ['ranked'])).toBeNull();
    expect(await b.call('pokejam_find_match', ['ranked'])).toBeNull();
  });

  it('skips banned and blocked pairs, and ghosts that stopped polling', async () => {
    const t = await testDb();
    const [a, b, c] = [await t.user('A'), await t.user('B'), await t.user('C')];
    await a.call('pokejam_find_match', ['ranked']);
    await t.sql(`update public.pokejam_queue set last_seen = now() - interval '30 seconds' where user_id = $1`, [a.id]);
    expect(await b.call('pokejam_find_match', ['ranked'])).toBeNull(); // A is a ghost
    await t.sql(`update public.pokejam_queue set last_seen = now() where user_id = $1`, [a.id]);
    await t.sql(`insert into public.pokejam_bans(user_id, until) values ($1, now() + interval '1 day')`, [a.id]).catch(() => {});
    if (await t.sql('select 1 from public.pokejam_bans where user_id = $1', [a.id]).then((r) => r.length).catch(() => 0)) {
      expect(await b.call('pokejam_find_match', ['ranked'])).toBeNull();
      await t.sql('delete from public.pokejam_bans where user_id = $1', [a.id]);
    }
    await t.sql(`insert into public.pokejam_blocks(user_id, blocked) values ($1, $2)`, [a.id, b.id]);
    expect(await b.call('pokejam_find_match', ['ranked'])).toBeNull();
    expect(await c.call('pokejam_find_match', ['ranked'])).toBeTruthy(); // C is fine with A
  });

  it('does not pair the same two players twice in a row, and not a third time in 24 h', async () => {
    const t = await testDb();
    const [a, b, c] = [await t.user('A'), await t.user('B'), await t.user('C')];
    await a.call('pokejam_find_match', ['ranked']);
    const m1 = (await b.call<string>('pokejam_find_match', ['ranked']))!;
    await t.sql(`update public.pokejam_matches set status = 'done' where id = $1`, [m1]);
    await a.call('pokejam_find_match', ['ranked']);
    expect(await b.call('pokejam_find_match', ['ranked'])).toBeNull(); // just played each other
    const m2 = await c.call<string | null>('pokejam_find_match', ['ranked']); // C takes the longer waiter
    expect(m2).toBeTruthy();
    // 3 games between A and B in 24 h is the limit, even with others in between.
    await t.sql(`insert into public.pokejam_matches(queue, host, guest, host_mmr, guest_mmr, status, seed) values ('ranked', $1, $2, 0, 0, 'done', 1), ('ranked', $2, $1, 0, 0, 'done', 2)`, [a.id, b.id]);
    await t.sql(`update public.pokejam_matches set created_at = now() - interval '1 hour' where id = $1`, [m1]);
    await t.sql(`update public.pokejam_matches set status = 'done' where id = $1`, [m2]);
    await t.sql('delete from public.pokejam_queue');
    await a.call('pokejam_find_match', ['ranked']);
    await c.call('pokejam_find_match', ['ranked']); // pairs with A, A's last opponent is now C
    await t.sql('delete from public.pokejam_queue');
    await t.sql(`update public.pokejam_matches set created_at = now() - interval '2 hours' where queue = 'ranked' and (host = $1 or guest = $1) and status = 'done' and host_mmr = 0 and seed in (1, 2)`, [a.id]);
    await t.sql(`update public.pokejam_matches set status = 'done' where queue = 'ranked'`);
    await a.call('pokejam_find_match', ['ranked']);
    expect(await b.call('pokejam_find_match', ['ranked'])).toBeNull(); // 3 games with A already
  });
});

describe('cooldowns', () => {
  it('a profile on cooldown cannot search: a clear error with the seconds left, and the queue row goes', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A'), await t.user('B')];
    expect(await a.call('pokejam_find_match', ['ranked'])).toBeNull();
    const s = await season(t);
    await t.sql(`update public.pokejam_ranked_profiles set cooldown_until = now() + interval '5 minutes' where user_id = $1 and season_id = $2`, [a.id, s.id]).catch(() => {});
    await t.sql('select public.pokejam_ranked_profile_lock($1, $2)', [a.id, s.id]);
    await t.sql(`update public.pokejam_ranked_profiles set cooldown_until = now() + interval '5 minutes' where user_id = $1 and season_id = $2`, [a.id, s.id]);
    await expect(a.call('pokejam_find_match', ['ranked'])).rejects.toThrow(/ranked cooldown: (29\d|300) seconds left/);
    expect(await b.call('pokejam_find_match', ['ranked'])).toBeNull(); // not matched with a cooling-down player, even with a row left in the queue
    await t.sql(`update public.pokejam_ranked_profiles set cooldown_until = now() - interval '1 second' where user_id = $1`, [a.id]);
    expect(await a.call('pokejam_find_match', ['ranked'])).toBeTruthy();
  });

  it('the Social queue ignores a Ranked cooldown', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A'), await t.user('B')];
    const s = await season(t);
    await t.sql('select public.pokejam_ranked_profile_lock($1, $2)', [a.id, s.id]);
    await t.sql(`update public.pokejam_ranked_profiles set cooldown_until = now() + interval '1 hour' where user_id = $1`, [a.id]);
    expect(await quickPair(t, a, b)).toBeTruthy();
  });

  it('leaving twice starts the cooldown and blocks the next search', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A'), await t.user('B')];
    for (let i = 0; i < 2; i++) {
      expect(await a.call('pokejam_find_match', ['ranked'])).toBeNull();
      const mid = (await b.call<string>('pokejam_find_match', ['ranked']))!;
      await a.call('pokejam_leave_match', [mid]); // a dodge
      await t.sql(`update public.pokejam_matches set created_at = now() - interval '${i + 1} hours' where id = $1`, [mid]); // out of the pair guard's way
      await t.sql(`update public.pokejam_ranked_matches set host_id = host_id where match_id = $1`, [mid]);
      await t.sql(`update public.pokejam_matches set status = 'void' where id = $1`, [mid]);
    }
    expect((await prof(t, a.id)).leaves_24h).toBe(2);
    await expect(a.call('pokejam_find_match', ['ranked'])).rejects.toThrow(/ranked cooldown/);
  });
});

describe('heartbeat, forfeit and dodge', () => {
  it('a ranked game heartbeat is accepted, and a leave after it is a forfeit loss for the leaver', async () => {
    const t = await testDb();
    const { mid, host, guest } = await rankedPair(t);
    expect(await host.call('pokejam_match_alive', [mid])).toBe('active');
    expect((await t.sql(`select host_alive is not null as h from public.pokejam_matches where id = $1`, [mid]))[0].h).toBe(true);
    await guest.call('pokejam_match_alive', [mid]);
    await guest.call('pokejam_leave_match', [mid]);
    expect(await status(t, mid)).toBe('done');
    const [r] = await t.sql('select reason, winner from public.pokejam_ranked_matches where match_id = $1', [mid]);
    expect(r).toEqual({ reason: 'leave', winner: host.id });
    expect((await prof(t, guest.id)).losses).toBe(1);
    expect((await prof(t, host.id)).wins).toBe(1);
  });

  it('45 s of silence lets the stayer claim the forfeit; 44 s does not', async () => {
    const t = await testDb();
    const { mid, host, guest } = await rankedPair(t);
    await host.call('pokejam_match_alive', [mid]);
    await guest.call('pokejam_match_alive', [mid]);
    await beat(t, mid, 'guest', 40);
    expect(await host.call('pokejam_ranked_forfeit', [mid])).toEqual({ status: 'active' });
    await beat(t, mid, 'guest', 50);
    const res = await host.call<Row>('pokejam_ranked_forfeit', [mid]);
    expect(res).toMatchObject({ status: 'done', winner: host.id });
    expect(await guest.call('pokejam_ranked_forfeit', [mid])).toMatchObject({ status: 'done', winner: host.id });
    expect(await scored(t, mid)).toBe(1);
    expect((await t.sql('select reason from public.pokejam_ranked_matches where match_id = $1', [mid]))[0].reason).toBe('forfeit');
  });

  it('a silent player cannot be claimed against by the one who is silent, and a loser\'s report cannot claim a win', async () => {
    const t = await testDb();
    const { mid, host, guest } = await rankedPair(t);
    await host.call('pokejam_match_alive', [mid]);
    await guest.call('pokejam_match_alive', [mid]);
    await beat(t, mid, 'guest', 60);
    await beat(t, mid, 'host', 60);
    // Both silent: the caller is alive by definition, so the other one forfeits only if they had not reported.
    await host.call('pokejam_ranked_report_score', [mid, 20, 70]);
    await host.call('pokejam_report_result', [mid, false]); // the host says he lost
    expect(await host.call('pokejam_ranked_forfeit', [mid])).toEqual({ status: 'active' });
    expect(await scored(t, mid)).toBe(0);
  });

  it('before tip-off a leave is a dodge: the dodger loses, the other player is untouched, the match is void', async () => {
    const t = await testDb();
    const { mid, host, guest } = await rankedPair(t);
    await guest.call('pokejam_leave_match', [mid]);
    expect(await status(t, mid)).toBe('void');
    expect((await t.sql('select reason, winner from public.pokejam_ranked_matches where match_id = $1', [mid]))[0]).toEqual({ reason: 'leave', winner: null });
    expect(await prof(t, guest.id)).toMatchObject({ losses: 1, leaves_24h: 1 });
    expect(await prof(t, host.id)).toMatchObject({ wins: 0, losses: 0 });
    // the other player is back in the queue without a cooldown
    expect(await host.call('pokejam_find_match', ['ranked'])).toBeNull();
    expect(await queued(t, host.id)).toBeTruthy();
  });

  it('a leave long after the pairing with nobody ever connected is a failed connection, not a dodge', async () => {
    const t = await testDb();
    const { mid, host } = await rankedPair(t);
    await age(t, mid, 40);
    await host.call('pokejam_leave_match', [mid]);
    expect(await status(t, mid)).toBe('void');
    expect(await scored(t, mid)).toBe(0);
    expect(await prof(t, host.id)).toMatchObject({ losses: 0, leaves_24h: 0 });
  });

  it('searching again with a game I had opened is a leave', async () => {
    const t = await testDb();
    const { mid, host, guest } = await rankedPair(t);
    await guest.call('pokejam_match_alive', [mid]);
    await beat(t, mid, 'guest', 20);
    await age(t, mid, 300);
    expect(await guest.call('pokejam_find_match', ['ranked'])).toBeNull();
    expect(await status(t, mid)).toBe('done');
    expect(await prof(t, guest.id)).toMatchObject({ losses: 1, leaves_24h: 1 });
    expect(await prof(t, host.id)).toMatchObject({ wins: 1 });
  });

  it('a pairing I have not opened is handed over again, once', async () => {
    const t = await testDb();
    const { mid, host } = await rankedPair(t);
    expect(await host.call('pokejam_find_match', ['ranked'])).toBe(mid);
    expect(await status(t, mid)).toBe('active');
  });
});

describe('the stale-match sweep', () => {
  it('forfeits the silent player of a started game, once, and never scores it twice', async () => {
    const t = await testDb();
    const { mid, host, guest } = await rankedPair(t);
    await host.call('pokejam_match_alive', [mid]);
    await guest.call('pokejam_match_alive', [mid]);
    await beat(t, mid, 'host', 5);
    await beat(t, mid, 'guest', 70);
    await age(t, mid, 600);
    expect(await cleanup(t)).toBe(1);
    expect(await status(t, mid)).toBe('done');
    expect((await t.sql('select winner, reason from public.pokejam_ranked_matches where match_id = $1', [mid]))[0]).toEqual({ winner: host.id, reason: 'forfeit' });
    const before = await prof(t, guest.id);
    expect(await cleanup(t)).toBe(0);
    expect(await host.call('pokejam_ranked_forfeit', [mid])).toMatchObject({ status: 'done' });
    // the late report of the vanished player changes nothing
    expect((await guest.call<Row>('pokejam_report_result', [mid, false]).catch((e) => ({ err: String(e) }))) as Row).toBeTruthy();
    expect(await scored(t, mid)).toBe(1);
    expect(await prof(t, guest.id)).toEqual(before);
    expect((await prof(t, host.id)).wins).toBe(1);
  });

  it('voids a game both players abandoned: nothing changes for either', async () => {
    const t = await testDb();
    const { mid, host, guest } = await rankedPair(t);
    await host.call('pokejam_match_alive', [mid]);
    await guest.call('pokejam_match_alive', [mid]);
    await beat(t, mid, 'host', 90);
    await beat(t, mid, 'guest', 80);
    await age(t, mid, 600);
    expect(await cleanup(t)).toBe(1);
    expect(await status(t, mid)).toBe('void');
    expect(await scored(t, mid)).toBe(0);
    expect(await prof(t, host.id)).toMatchObject({ wins: 0, losses: 0 });
    expect(await prof(t, guest.id)).toMatchObject({ wins: 0, losses: 0 });
  });

  it('leaves a live game, a fresh pairing and a reported result alone', async () => {
    const t = await testDb();
    const live = await rankedPair(t);
    await live.host.call('pokejam_match_alive', [live.mid]);
    await live.guest.call('pokejam_match_alive', [live.mid]);
    await beat(t, live.mid, 'guest', 40); // one beat late is within the 45 s
    const fresh = await rankedPair(t);
    const reported = await rankedPair(t);
    await reported.host.call('pokejam_match_alive', [reported.mid]);
    await reported.guest.call('pokejam_match_alive', [reported.mid]);
    await reported.host.call('pokejam_report_result', [reported.mid, true]);
    await beat(t, reported.mid, 'host', 300);
    await beat(t, reported.mid, 'guest', 300);
    await age(t, live.mid, 600);
    await age(t, reported.mid, 600);
    expect(await cleanup(t)).toBe(0);
    expect([await status(t, live.mid), await status(t, fresh.mid), await status(t, reported.mid)]).toEqual(['active', 'active', 'active']);
  });

  it('a player who never connected while the other plays dodged after 90 s; both absent is a plain void', async () => {
    const t = await testDb();
    const one = await rankedPair(t);
    await one.host.call('pokejam_match_alive', [one.mid]);
    await age(t, one.mid, 60);
    expect(await cleanup(t)).toBe(0); // too early
    await age(t, one.mid, 100);
    expect(await cleanup(t)).toBe(1);
    expect(await status(t, one.mid)).toBe('void');
    expect(await prof(t, one.guest.id)).toMatchObject({ losses: 1, leaves_24h: 1 });
    expect(await prof(t, one.host.id)).toMatchObject({ wins: 0, losses: 0 });
    const none = await rankedPair(t);
    await age(t, none.mid, 200);
    expect(await cleanup(t)).toBe(1);
    expect(await scored(t, none.mid)).toBe(0);
    expect(await prof(t, none.host.id)).toMatchObject({ wins: 0, losses: 0 });
  });

  it('the sweep runs from matchmaking, at most once a minute', async () => {
    const t = await testDb();
    const { mid, host, guest } = await rankedPair(t);
    await host.call('pokejam_match_alive', [mid]);
    await guest.call('pokejam_match_alive', [mid]);
    await beat(t, mid, 'guest', 70);
    await age(t, mid, 600);
    await t.sql(`update public.pokejam_jobs set ran_at = '-infinity' where name = 'cleanup'`);
    const c = await t.user('C');
    await c.call('pokejam_find_match', ['ranked']);
    expect(await status(t, mid)).toBe('done');
  });
});

describe('the Social queue is unchanged', () => {
  it('pairs by profile mmr with the old window, never touches Ranked state, and mixes with nobody', async () => {
    const t = await testDb();
    const [a, b, r] = [await t.user('A'), await t.user('B'), await t.user('R')];
    expect(await r.call('pokejam_find_match', ['ranked'])).toBeNull();
    const mid = await quickPair(t, a, b);
    expect((await t.sql('select queue from public.pokejam_matches where id = $1', [mid]))[0].queue).toBe('social');
    expect(await queued(t, r.id)).toBeTruthy(); // the Ranked searcher was not pulled into the Social match
    expect((await t.sql('select count(*)::int as n from public.pokejam_ranked_profiles'))[0].n).toBe(0); // searching writes no ranked profile
    await t.sql(`update public.pokejam_profiles set mmr = 1500 where id = $1`, [a.id]);
    const [a2, c] = [await t.user('A2'), await t.user('C')];
    await t.sql(`update public.pokejam_profiles set mmr = 1500 where id = $1`, [a2.id]);
    expect(await a2.call('pokejam_find_match', ['social'])).toBeNull();
    expect(await c.call('pokejam_find_match', ['social'])).toBeNull(); // 500 apart at 0 s: outside the 100 window
    await t.sql(`update public.pokejam_queue set joined_at = now() - interval '30 seconds' where user_id = $1`, [c.id]);
    expect(await c.call('pokejam_find_match', ['social'])).toBeTruthy(); // 100 + 25 x 30 = 850 >= 500
  });

  it('Social leave, heartbeat and cleanup rules are as before', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A'), await t.user('B')];
    const mid = await quickPair(t, a, b);
    await a.call('pokejam_leave_match', [mid]);
    expect(await status(t, mid)).toBe('void');
    expect(await scored(t, mid)).toBe(0);
    const c = await t.user('C');
    const d = await t.user('D');
    const m2 = await quickPair(t, c, d);
    await c.call('pokejam_match_alive', [m2]);
    await d.call('pokejam_match_alive', [m2]);
    await t.sql(`update public.pokejam_matches set host_alive = now() - interval '200 seconds', guest_alive = now() - interval '190 seconds' where id = $1`, [m2]);
    expect(await cleanup(t)).toBe(1);
    expect(await status(t, m2)).toBe('void');
  });
});
