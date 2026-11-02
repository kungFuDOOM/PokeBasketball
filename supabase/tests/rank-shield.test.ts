// Rank Shield core (migration 20261117): arming rules, consumption only on a loss that costs points, the Demotion Guard
// first, the rolling 24 h cap, the weekly challenge and the hold cap, and no client writes.
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { testDb, type Db, type User } from './testDb';

vi.setConfig({ testTimeout: 60_000 });

type Row = Record<string, unknown>;
const season = async (t: Db) => (await t.sql('select * from public.pokejam_ranked_season()'))[0] as Row;
const prof = async (t: Db, uid: string) => (await t.sql('select * from public.pokejam_ranked_profiles where user_id = $1 order by season_id desc limit 1', [uid]))[0] as Row;

async function setRank(t: Db, u: User, set: { div: number; points?: number; charge?: number; lsh?: number }) {
  const s = await season(t);
  await t.sql('select public.pokejam_ranked_profile_lock($1, $2)', [u.id, s.id]);
  await t.sql(`update public.pokejam_ranked_profiles set status = 'ranked', placements_played = 5, div_idx = $3, points = $4, peak_idx = $3,
      shield_charge = $5, losses_since_shield = $6, last_game_at = now() where user_id = $1 and season_id = $2`,
    [u.id, s.id, set.div, set.points ?? 0, set.charge ?? 1, set.lsh ?? 0]);
}
const give = (t: Db, u: User, count: number, lastUsed: string | null = null) =>
  t.sql(`insert into public.pokejam_shield_inventory(user_id, count, last_used_at) values ($1, $2, ${lastUsed ?? 'null'})
         on conflict (user_id) do update set count = excluded.count, last_used_at = excluded.last_used_at`, [u.id, count]);
const inv = async (t: Db, u: User) => (await t.sql('select * from public.pokejam_shield_inventory where user_id = $1', [u.id]))[0] as Row | undefined;
const armedRows = async (t: Db, u: User) => Number((await t.sql('select count(*)::int as n from public.pokejam_shield_armed where user_id = $1', [u.id]))[0].n);
const ledger = async (t: Db, u: User, reason: string) => t.sql('select * from public.pokejam_shield_ledger where user_id = $1 and reason = $2', [u.id, reason]);

async function rankedPair(a: User, b: User) {
  expect(await a.call('pokejam_find_match', ['ranked'])).toBeNull();
  const mid = await b.call<string | null>('pokejam_find_match', ['ranked']);
  expect(mid).toBeTruthy();
  const info = await a.call<Record<string, string>>('pokejam_match_info', [mid!]);
  return { mid: mid!, host: info.host === a.id ? a : b, guest: info.host === a.id ? b : a };
}
type Pair = Awaited<ReturnType<typeof rankedPair>>;
/** Both report the same score; `winner` wins 70-20. Returns the second report's answer. */
async function finish(p: Pair, winner: User = p.host) {
  const hostWon = winner.id === p.host.id;
  const [hs, gs] = hostWon ? [70, 20] : [20, 70];
  await p.host.call('pokejam_ranked_report_score', [p.mid, hs, gs]);
  await p.guest.call('pokejam_ranked_report_score', [p.mid, hs, gs]);
  await p.host.call('pokejam_report_result', [p.mid, hostWon]);
  return p.guest.call<Row>('pokejam_report_result', [p.mid, hostWon]);
}
/** Pair `a` (armed or not) with a fresh opponent and let `a` lose or win. */
async function play(t: Db, a: User, aWins: boolean) {
  const b = await t.user('Opp');
  const ap = await prof(t, a.id); // same position as a, so the queue pairs them in its first window
  if (ap && ap.status === 'ranked') await setRank(t, b, { div: Number(ap.div_idx), points: Number(ap.points) });
  const p = await rankedPair(a, b);
  const out = await finish(p, aWins ? a : b);
  return { p, b, out };
}

describe('arming', () => {
  it('is refused with no shield, after a use in the last 24 h, while placing, in Zenith, with nothing to lose, and for guests', async () => {
    const t = await testDb();
    const a = await t.user('A');
    await setRank(t, a, { div: 6, points: 50 });
    await expect(a.call('pokejam_shield_arm', [true])).rejects.toThrow(/no Rank Shield/);
    await give(t, a, 2, `now() - interval '2 hours'`);
    await expect(a.call('pokejam_shield_arm', [true])).rejects.toThrow(/last 24 hours/);
    const me = await a.call<Row>('pokejam_shield_me');
    expect(me).toMatchObject({ count: 2, armed: false, arm_block: 'used_today' });
    expect(me.next_use_at).toBeTruthy();
    expect(await a.call<Row>('pokejam_ranked_me')).toMatchObject({ shield_item_count: 2, shield_item_armed: false, shield_item_block: 'used_today' });

    const placing = await t.user('P');
    await give(t, placing, 1);
    await expect(placing.call('pokejam_shield_arm', [true])).rejects.toThrow(/Placement games/);
    expect(await placing.call<Row>('pokejam_shield_me')).toMatchObject({ arm_block: 'placing' });

    const zen = await t.user('Z');
    await setRank(t, zen, { div: 24, points: 100 });
    await give(t, zen, 1);
    await expect(zen.call('pokejam_shield_arm', [true])).rejects.toThrow(/Zenith/);

    const low = await t.user('Low');
    await setRank(t, low, { div: 0, points: 0 });
    await give(t, low, 1);
    await expect(low.call('pokejam_shield_arm', [true])).rejects.toThrow(/Nothing to lose/);
    await t.sql('update public.pokejam_ranked_profiles set points = 1 where user_id = $1', [low.id]);
    expect(await low.call<Row>('pokejam_shield_arm', [true])).toMatchObject({ armed: true });

    const guest = await t.user('G', true);
    await expect(guest.call('pokejam_shield_arm', [true])).rejects.toThrow(/signed-in account/);
    expect(await armedRows(t, a)).toBe(0);
  });

  it('arms and disarms; arming is allowed exactly 24 h after the last use', async () => {
    const t = await testDb();
    const a = await t.user('A');
    await setRank(t, a, { div: 6, points: 50 });
    await give(t, a, 2, `now() - interval '25 hours'`);
    expect(await a.call<Row>('pokejam_shield_arm', [true])).toMatchObject({ armed: true, locked: false, arm_block: null });
    expect(await a.call<Row>('pokejam_shield_arm', [false])).toMatchObject({ armed: false });
    expect(await armedRows(t, a)).toBe(0);
  });

  it('is locked once the match is paired: no toggling, and nobody can arm after seeing the pairing', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A'), await t.user('B')];
    for (const u of [a, b]) { await setRank(t, u, { div: 6, points: 50 }); await give(t, u, 1); }
    await a.call('pokejam_shield_arm', [true]);
    const p = await rankedPair(a, b);
    expect(await a.call<Row>('pokejam_shield_me')).toMatchObject({ armed: true, locked: true });
    await expect(a.call('pokejam_shield_arm', [false])).rejects.toThrow(/locked/);
    await expect(a.call('pokejam_shield_arm', [true])).rejects.toThrow(/locked/);
    await expect(b.call('pokejam_shield_arm', [true])).rejects.toThrow(/locked/); // b had not armed before the pairing
    expect(await armedRows(t, b)).toBe(0);
    // the match ends and nothing is locked any more
    const out = await finish(p, b);
    expect(out.status).toBe('done');
    expect(await a.call<Row>('pokejam_shield_me')).toMatchObject({ locked: false });
  });
});

describe('consuming', () => {
  it('a normal score loss costs nothing and spends the shield; W/L and streak still count; the auto recharge does not advance', async () => {
    const t = await testDb();
    const a = await t.user('A');
    await setRank(t, a, { div: 10, points: 50, charge: 0, lsh: 1 });
    await give(t, a, 3);
    await a.call('pokejam_shield_arm', [true]);
    const { p } = await play(t, a, false);
    const row = (await t.sql('select * from public.pokejam_ranked_matches where match_id = $1', [p.mid]))[0] as Row;
    const side = a.id === p.host.id ? 'host' : 'guest';
    const result = (row.result as Row)[side] as Row;
    expect(result.shield).toMatchObject({ armed: true, used: true });
    expect(Number((result.shield as Row).saved)).toBeGreaterThan(0);
    expect(result).toMatchObject({ delta: 0, before: 1050, after: 1050, event: null });
    expect(row[`${side}_shield_saved`]).toBe((result.shield as Row).saved);
    expect(await prof(t, a.id)).toMatchObject({ div_idx: 10, points: 50, losses: 1, streak: -1, shield_charge: 0, losses_since_shield: 1 });
    expect(await inv(t, a)).toMatchObject({ count: 2 });
    expect((await inv(t, a))!.last_used_at).toBeTruthy();
    expect(await ledger(t, a, 'use')).toHaveLength(1);
    expect(await armedRows(t, a)).toBe(0);
    expect(await a.call<Row>('pokejam_shield_me')).toMatchObject({ count: 2, armed: false, arm_block: 'used_today' });
  });

  it('without a shield the same loss costs points (control) and the winner is not touched', async () => {
    const t = await testDb();
    const a = await t.user('A');
    await setRank(t, a, { div: 10, points: 50 });
    const { b } = await play(t, a, false);
    expect((await prof(t, a.id)).points).toBeLessThan(50);
    expect((await prof(t, b.id)).points).toBeGreaterThan(50);
    expect(await inv(t, b)).toBeUndefined();
  });

  it('a win keeps the shield, clears the arm and reports it was kept', async () => {
    const t = await testDb();
    const a = await t.user('A');
    await setRank(t, a, { div: 10, points: 50 });
    await give(t, a, 1);
    await a.call('pokejam_shield_arm', [true]);
    const { p } = await play(t, a, true);
    const row = (await t.sql('select * from public.pokejam_ranked_matches where match_id = $1', [p.mid]))[0] as Row;
    const side = a.id === p.host.id ? 'host' : 'guest';
    expect(((row.result as Row)[side] as Row).shield).toEqual({ armed: true, used: false, saved: 0 });
    expect(await inv(t, a)).toMatchObject({ count: 1, last_used_at: null });
    expect(await armedRows(t, a)).toBe(0);
    expect(await ledger(t, a, 'use')).toHaveLength(0);
  });

  it('a forfeit leaver is not shielded; the arm is cleared and nothing is spent', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A'), await t.user('B')];
    await setRank(t, a, { div: 10, points: 50 });
    await setRank(t, b, { div: 10, points: 50 });
    await give(t, a, 1);
    await a.call('pokejam_shield_arm', [true]);
    const p = await rankedPair(a, b);
    await a.call('pokejam_match_alive', [p.mid]);
    await b.call('pokejam_match_alive', [p.mid]);
    await a.call('pokejam_leave_match', [p.mid]);
    expect((await prof(t, a.id)).points).toBeLessThan(50);
    expect(await inv(t, a)).toMatchObject({ count: 1 });
    expect(await armedRows(t, a)).toBe(0);
    expect(await ledger(t, a, 'use')).toHaveLength(0);
  });

  it('a dodge is not shielded, and the other player\'s arm is dropped when the voided match never scored', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A'), await t.user('B')];
    for (const u of [a, b]) { await setRank(t, u, { div: 10, points: 50 }); await give(t, u, 1); await u.call('pokejam_shield_arm', [true]); }
    const p = await rankedPair(a, b);
    await a.call('pokejam_leave_match', [p.mid]); // early leave = dodge
    expect((await t.sql('select status from public.pokejam_matches where id = $1', [p.mid]))[0].status).toBe('void');
    expect((await prof(t, a.id)).points).toBeLessThan(50);
    expect(await inv(t, a)).toMatchObject({ count: 1 });
    expect(await armedRows(t, a)).toBe(0);
    expect(await b.call<Row>('pokejam_shield_me')).toMatchObject({ armed: false, locked: false, count: 1 }); // lazily cleared
    expect(await armedRows(t, b)).toBe(0);
    expect((await prof(t, b.id)).points).toBe(50);
  });

  it('a void without scoring (reports disagree) spends nothing and clears the arm', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A'), await t.user('B')];
    for (const u of [a, b]) { await setRank(t, u, { div: 10, points: 50 }); await give(t, u, 1); }
    await a.call('pokejam_shield_arm', [true]);
    const p = await rankedPair(a, b);
    await p.host.call('pokejam_report_result', [p.mid, true]);
    expect((await p.guest.call<Row>('pokejam_report_result', [p.mid, false])).status).toBe('void');
    expect(await inv(t, a)).toMatchObject({ count: 1 });
    expect(await a.call<Row>('pokejam_shield_me')).toMatchObject({ armed: false, locked: false });
    expect(await armedRows(t, a)).toBe(0);
  });

  it('is not spent in placements, in Zenith, or with nothing to lose, even when forced armed', async () => {
    const t = await testDb();
    const cases: [string, { div: number; points?: number } | null][] = [['placing', null], ['zenith', { div: 24, points: 100 }], ['floor', { div: 0, points: 0 }]];
    for (const [, rank] of cases) {
      const a = await t.user('A');
      if (rank) await setRank(t, a, rank);
      await give(t, a, 1);
      await t.sql('insert into public.pokejam_shield_armed(user_id, armed_at) values ($1, now() - interval \'1 minute\')', [a.id]);
      await play(t, a, false);
      expect(await inv(t, a)).toMatchObject({ count: 1, last_used_at: null });
      expect(await armedRows(t, a)).toBe(0);
    }
  });

  it('the Demotion Guard runs first: when it fires the item is kept', async () => {
    const t = await testDb();
    const a = await t.user('A');
    await setRank(t, a, { div: 2, points: 5, charge: 1 });
    await give(t, a, 1);
    await a.call('pokejam_shield_arm', [true]);
    await play(t, a, false);
    expect(await prof(t, a.id)).toMatchObject({ div_idx: 2, points: 0, shield_charge: 0 });
    expect(await inv(t, a)).toMatchObject({ count: 1, last_used_at: null });
  });

  it('the item saves a demotion when the Demotion Guard has no charge', async () => {
    const t = await testDb();
    const a = await t.user('A');
    await setRank(t, a, { div: 2, points: 5, charge: 0, lsh: 0 });
    await give(t, a, 1);
    await a.call('pokejam_shield_arm', [true]);
    await play(t, a, false);
    expect(await prof(t, a.id)).toMatchObject({ div_idx: 2, points: 5, shield_charge: 0, losses_since_shield: 0 });
    expect(await inv(t, a)).toMatchObject({ count: 0 });
  });
});

describe('rolling 24 h cap', () => {
  it('a second use inside 24 h is refused at arming and at scoring; it works again after 24 h', async () => {
    const t = await testDb();
    const a = await t.user('A');
    await setRank(t, a, { div: 10, points: 80 });
    await give(t, a, 3);
    await a.call('pokejam_shield_arm', [true]);
    await play(t, a, false);
    expect(await inv(t, a)).toMatchObject({ count: 2 });
    expect((await prof(t, a.id)).points).toBe(80);
    await expect(a.call('pokejam_shield_arm', [true])).rejects.toThrow(/last 24 hours/);

    // armed by other means (a stale row) the authoritative check at scoring still holds
    await t.sql('insert into public.pokejam_shield_armed(user_id, armed_at) values ($1, now() - interval \'1 minute\')', [a.id]);
    await play(t, a, false);
    expect(await inv(t, a)).toMatchObject({ count: 2 });
    expect((await prof(t, a.id)).points).toBeLessThan(80);

    await t.sql(`update public.pokejam_shield_inventory set last_used_at = now() - interval '24 hours 1 minute' where user_id = $1`, [a.id]);
    await t.sql('update public.pokejam_ranked_profiles set points = 80 where user_id = $1', [a.id]);
    await a.call('pokejam_shield_arm', [true]);
    await play(t, a, false);
    expect(await inv(t, a)).toMatchObject({ count: 1 });
    expect((await prof(t, a.id)).points).toBe(80);
    expect(await ledger(t, a, 'use')).toHaveLength(2);
  });

  it('scoring twice cannot double-spend', async () => {
    const t = await testDb();
    const a = await t.user('A');
    await setRank(t, a, { div: 10, points: 80 });
    await give(t, a, 5);
    await a.call('pokejam_shield_arm', [true]);
    const { p } = await play(t, a, false);
    for (let i = 0; i < 3; i++) await t.sql('select public.pokejam_ranked_apply($1)', [p.mid]);
    await Promise.all([a, p.host, p.guest].map((u) => u.call('pokejam_report_result', [p.mid, p.host.id === a.id])));
    expect(await inv(t, a)).toMatchObject({ count: 4 });
    expect(await ledger(t, a, 'use')).toHaveLength(1);
    expect((await prof(t, a.id)).losses).toBe(1);
  });

  it('two lost matches finishing back to back spend one shield', async () => {
    const t = await testDb();
    const a = await t.user('A');
    await setRank(t, a, { div: 10, points: 90 });
    await give(t, a, 5);
    await a.call('pokejam_shield_arm', [true]);
    const [o1, o2] = [await t.user('O1'), await t.user('O2')];
    for (const o of [o1, o2]) await setRank(t, o, { div: 10, points: 50 });
    await finish(await rankedPair(a, o1), o1);
    expect(await inv(t, a)).toMatchObject({ count: 4 });
    const mid = (await t.sql(`insert into public.pokejam_matches(queue, host, guest, host_mmr, guest_mmr, seed, quarter_len, status, winner)
      values ('ranked', $1, $2, 1000, 1000, 1, 120, 'done', $2) returning id`, [o2.id, a.id]))[0].id as string;
    await t.sql(`insert into public.pokejam_shield_armed(user_id, armed_at) values ($1, now() - interval '1 hour')`, [a.id]);
    await t.sql('select public.pokejam_ranked_apply($1)', [mid]);
    expect(await inv(t, a)).toMatchObject({ count: 4 });
    expect((await prof(t, a.id)).points).toBeLessThan(90);
  });
});

describe('weekly challenge', () => {
  it('counts a scored game and grants one shield exactly once for the week', async () => {
    const t = await testDb();
    const a = await t.user('A');
    await setRank(t, a, { div: 10, points: 50 });
    await play(t, a, true);
    const w = await t.sql('select * from public.pokejam_weekly_progress where user_id = $1', [a.id]);
    expect(w).toHaveLength(1);
    expect(w[0]).toMatchObject({ progress: 1, completed_at: null });
    expect(await a.call<Row>('pokejam_shield_me')).toMatchObject({ weekly: { kind: 'games', goal: 10, progress: 1, done: false } });
    await t.sql('update public.pokejam_weekly_progress set progress = 8 where user_id = $1', [a.id]);
    await play(t, a, false);
    expect(await inv(t, a)).toBeUndefined();
    expect((await a.call<Row>('pokejam_shield_me')).weekly).toMatchObject({ progress: 9, done: false });
    await play(t, a, true);
    expect(await inv(t, a)).toMatchObject({ count: 1 });
    const me = await a.call<Row>('pokejam_shield_me');
    expect(me.weekly).toMatchObject({ progress: 10, done: true });
    await play(t, a, true);
    await play(t, a, false);
    expect(await inv(t, a)).toMatchObject({ count: 1 });
    expect(await ledger(t, a, 'weekly')).toHaveLength(1);
    expect(await t.sql(`select 1 from public.pokejam_shield_ledger where user_id = $1`, [a.id])).toHaveLength(1);
    // the same grant cannot be inserted twice, whatever calls it
    await expect(t.sql(`insert into public.pokejam_shield_ledger(user_id, delta, reason, ref) select user_id, 1, reason, ref from public.pokejam_shield_ledger where user_id = $1`, [a.id])).rejects.toThrow();
  });

  it('a new week starts from zero and can grant again', async () => {
    const t = await testDb();
    const a = await t.user('A');
    await setRank(t, a, { div: 10, points: 50 });
    await t.sql(`insert into public.pokejam_weekly_challenge(week_start, kind, goal) values (public.pokejam_weekly_start(), 'games', 1)`);
    await play(t, a, true);
    expect(await inv(t, a)).toMatchObject({ count: 1 });
    await t.sql(`update public.pokejam_shield_ledger set ref = (public.pokejam_weekly_start() - 7)::text where user_id = $1`, [a.id]);
    await t.sql(`update public.pokejam_weekly_progress set week_start = week_start - 7 where user_id = $1`, [a.id]);
    await play(t, a, true);
    expect(await inv(t, a)).toMatchObject({ count: 2 });
    expect(await ledger(t, a, 'weekly')).toHaveLength(2);
  });

  it('the config row switches the kind: wins only, or distinct days', async () => {
    const t = await testDb();
    const a = await t.user('A');
    await setRank(t, a, { div: 10, points: 50 });
    await t.sql(`insert into public.pokejam_weekly_challenge(week_start, kind, goal) values (public.pokejam_weekly_start(), 'wins', 2)`);
    await play(t, a, false);
    await play(t, a, true);
    expect(await a.call<Row>('pokejam_shield_me')).toMatchObject({ weekly: { kind: 'wins', goal: 2, progress: 1, done: false } });
    await play(t, a, true);
    expect(await inv(t, a)).toMatchObject({ count: 1 });
    const d = await t.user('D');
    await setRank(t, d, { div: 10, points: 50 });
    await t.sql(`update public.pokejam_weekly_challenge set kind = 'days', goal = 2`);
    await play(t, d, true);
    await play(t, d, true);
    expect((await d.call<Row>('pokejam_shield_me')).weekly).toMatchObject({ kind: 'days', progress: 1, done: false });
    expect(await inv(t, d)).toBeUndefined();
  });

  it('does not count a leave, a forfeit or a dodge', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A'), await t.user('B')];
    await setRank(t, a, { div: 10, points: 50 });
    await setRank(t, b, { div: 10, points: 50 });
    const p = await rankedPair(a, b);
    await a.call('pokejam_match_alive', [p.mid]);
    await b.call('pokejam_match_alive', [p.mid]);
    await a.call('pokejam_leave_match', [p.mid]);
    expect(await t.sql('select 1 from public.pokejam_weekly_progress')).toHaveLength(0);
  });

  it('the 4th and later game against the same opponent in a week does not count', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A'), await t.user('B')];
    await setRank(t, a, { div: 10, points: 50 });
    await setRank(t, b, { div: 10, points: 50 });
    for (let i = 0; i < 5; i++) {
      for (const u of [a, b]) await setRank(t, u, { div: 10, points: 50 }); // keep them within the queue window
      const p = await rankedPair(a, b);
      await finish(p, a);
      await t.sql(`update public.pokejam_matches set created_at = now() - interval '30 hours'`); // free the pair for matchmaking
    }
    expect((await t.sql('select progress from public.pokejam_weekly_progress where user_id = $1', [a.id]))[0].progress).toBe(3);
    expect((await t.sql('select progress from public.pokejam_weekly_progress where user_id = $1', [b.id]))[0].progress).toBe(3);
    expect(Number((await t.sql('select count(*)::int as n from public.pokejam_ranked_matches'))[0].n)).toBe(5);
  });

  it('the hold cap of 14 is not exceeded: the grant is lost but the week stays claimed', async () => {
    const t = await testDb();
    const a = await t.user('A');
    await setRank(t, a, { div: 10, points: 50 });
    await give(t, a, 14);
    await t.sql(`insert into public.pokejam_weekly_challenge(week_start, kind, goal) values (public.pokejam_weekly_start(), 'games', 1)`);
    await play(t, a, true);
    expect(await inv(t, a)).toMatchObject({ count: 14 });
    expect(await ledger(t, a, 'weekly')).toMatchObject([{ delta: 0 }]);
    await expect(t.sql('update public.pokejam_shield_inventory set count = 15')).rejects.toThrow();
  });
});

describe('season rollover', () => {
  it('clears arms and keeps the inventory', async () => {
    const t = await testDb();
    const [mod, a] = [await t.user('Mod'), await t.user('A')];
    await t.sql('insert into public.pokejam_admins(user_id) values ($1)', [mod.id]);
    await setRank(t, a, { div: 6, points: 50 });
    await give(t, a, 3);
    await a.call('pokejam_shield_arm', [true]);
    await mod.call('pokejam_ranked_open_season', [6]);
    expect(await armedRows(t, a)).toBe(0);
    expect(await inv(t, a)).toMatchObject({ count: 3 });
    expect(await a.call<Row>('pokejam_shield_me')).toMatchObject({ count: 3, armed: false, arm_block: 'placing' });
  });
});

describe('privileges', () => {
  it('clients can read only their own rows and cannot write or call the internals', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A'), await t.user('B')];
    await give(t, a, 2);
    await give(t, b, 5);
    expect((await a.sql('select count from public.pokejam_shield_inventory')).map((r) => r.count)).toEqual([2]);
    await t.sql(`update public.pokejam_shield_products set active = true where sku = 'shield_3'`);
    expect((await a.sql('select sku from public.pokejam_shield_products')).map((r) => r.sku)).toEqual(['shield_3']);
    expect(await t.sql('select sku, units, price_cents, stripe_price_id from public.pokejam_shield_products order by units'))
      .toEqual([{ sku: 'shield_3', units: 3, price_cents: 199, stripe_price_id: null }, { sku: 'shield_7', units: 7, price_cents: 399, stripe_price_id: null },
        { sku: 'shield_14', units: 14, price_cents: 699, stripe_price_id: null }]);
    for (const q of [
      `update public.pokejam_shield_inventory set count = 14`,
      `insert into public.pokejam_shield_inventory(user_id, count) values ('${b.id}', 1)`,
      `delete from public.pokejam_shield_inventory`,
      `insert into public.pokejam_shield_ledger(user_id, delta, reason, ref) values ('${a.id}', 5, 'admin', 'x')`,
      `insert into public.pokejam_shield_armed(user_id) values ('${a.id}')`,
      `update public.pokejam_shield_products set active = true`,
      `insert into public.pokejam_shield_purchases(session_id, user_id, sku, units) values ('s', '${a.id}', 'shield_3', 3)`,
      `insert into public.pokejam_weekly_progress(user_id, week_start, progress) values ('${a.id}', now(), 10)`,
      `insert into public.pokejam_weekly_challenge(week_start) values (now())`,
      `select * from public.pokejam_stripe_events`,
      `select public.pokejam_shield_consume('${a.id}', gen_random_uuid(), 5)`,
      `select public.pokejam_shield_grant_weekly('${a.id}', current_date)`,
      `select public.pokejam_weekly_progress('${a.id}', gen_random_uuid(), true)`,
      `select public.pokejam_shield_status('${b.id}')`,
    ]) await expect(a.sql(q), q).rejects.toThrow();
    expect((await inv(t, a))!.count).toBe(2);
  });
});

describe('migration', () => {
  it('is idempotent: running it again keeps the data and the products', async () => {
    const t = await testDb();
    const a = await t.user('A');
    await setRank(t, a, { div: 6, points: 50 });
    await give(t, a, 3);
    await t.db.exec(readFileSync(new URL('../migrations/20261117_pokejam_rank_shield.sql', import.meta.url), 'utf8'));
    expect(await inv(t, a)).toMatchObject({ count: 3 });
    expect(await t.sql('select 1 from public.pokejam_shield_products')).toHaveLength(3);
    expect(await a.call<Row>('pokejam_shield_me')).toMatchObject({ count: 3 });
  });
});
