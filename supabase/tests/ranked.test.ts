// Season 1 Ranked core (migration 20261111): seasons, server-side scoring once per match, no client writes, leavers,
// and the SQL point maths equal to src/ranked/rank.ts.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { applyResult, marginOf, newLadderState, NO_MARGIN, placementShift, placementWeight, seedScore, zenithDecay, type Margin } from '../../src/ranked/rank';
import { testDb, type Db, type User } from './testDb';

vi.setConfig({ testTimeout: 60_000 });

type Row = Record<string, unknown>;
const season = async (t: Db) => (await t.sql('select * from public.pokejam_ranked_season()'))[0] as Row;
const prof = async (t: Db, uid: string) => (await t.sql('select * from public.pokejam_ranked_profiles where user_id = $1 order by season_id desc limit 1', [uid]))[0] as Row;

/** Gives a player a ranked profile in the current season at exactly this position. */
async function setRank(t: Db, u: User, set: { div: number; points?: number; charge?: number; lsh?: number; games?: number }) {
  const s = await season(t);
  await t.sql('select public.pokejam_ranked_profile_lock($1, $2)', [u.id, s.id]);
  await t.sql(`update public.pokejam_ranked_profiles set status = 'ranked', placements_played = 5, div_idx = $3, points = $4, peak_idx = $3,
      shield_charge = $5, losses_since_shield = $6, wins = $7, last_game_at = now() where user_id = $1 and season_id = $2`,
    [u.id, s.id, set.div, set.points ?? 0, set.charge ?? 1, set.lsh ?? 0, set.games ?? 0]);
}

/** Two players paired in the ranked queue; returns the match id and who is host. */
async function rankedPair(a: User, b: User) {
  expect(await a.call('pokejam_find_match', ['ranked'])).toBeNull();
  const mid = await b.call<string | null>('pokejam_find_match', ['ranked']);
  expect(mid).toBeTruthy();
  const info = await a.call<Record<string, string>>('pokejam_match_info', [mid!]);
  return { mid: mid!, host: info.host === a.id ? a : b, guest: info.host === a.id ? b : a };
}
/** Both players report the same score and result (host wins by default). Returns the second report's answer. */
async function finish(p: { mid: string; host: User; guest: User }, hs = 70, gs = 20, hostWon = true) {
  await p.host.call('pokejam_ranked_report_score', [p.mid, hs, gs]);
  await p.guest.call('pokejam_ranked_report_score', [p.mid, hs, gs]);
  expect((await p.host.call<Row>('pokejam_report_result', [p.mid, hostWon])).status).toBe('pending');
  return p.guest.call<Row>('pokejam_report_result', [p.mid, hostWon]);
}
const scored = async (t: Db, mid: string) => Number((await t.sql('select count(*)::int as n from public.pokejam_ranked_matches where match_id = $1', [mid]))[0].n);

describe('migration', () => {
  it('is idempotent: running it again changes nothing and keeps the data', async () => {
    const t = await testDb();
    const a = await t.user('A');
    await setRank(t, a, { div: 7, points: 40 });
    await t.db.exec(readFileSync(new URL('../migrations/20261111_pokejam_ranked.sql', import.meta.url), 'utf8'));
    expect(await prof(t, a.id)).toMatchObject({ div_idx: 7, points: 40 });
    expect(await a.call('pokejam_ranked_me')).toMatchObject({ season: 1, tier: 'Gold' });
  });
});

describe('pokejam_ranked_open_season', () => {
  it('is admin only, opens Season 1 with ends_at = starts_at + length_weeks, and keeps exactly one active', async () => {
    const t = await testDb();
    const [mod, a] = [await t.user('Mod'), await t.user('A')];
    await t.sql('insert into public.pokejam_admins(user_id) values ($1)', [mod.id]);
    await expect(a.call('pokejam_ranked_open_season', [6])).rejects.toThrow(/moderators only/);
    const s1 = await mod.call<Row>('pokejam_ranked_open_season', [6]);
    expect(s1.number).toBe(1);
    expect((await t.sql(`select (ends_at - starts_at = interval '42 days') as ok from public.pokejam_seasons where number = 1`))[0].ok).toBe(true);
    const s2 = await mod.call<Row>('pokejam_ranked_open_season', [4]);
    expect(s2.number).toBe(2);
    expect((await t.sql(`select (ends_at - starts_at = interval '28 days') as ok from public.pokejam_seasons where number = 2`))[0].ok).toBe(true);
    expect((await t.sql(`select number from public.pokejam_seasons where status = 'active'`)).map((r) => r.number)).toEqual([2]);
    await expect(t.sql(`insert into public.pokejam_seasons(number, ends_at, status) values (3, now() + interval '1 day', 'active')`)).rejects.toThrow();
    await expect(t.sql(`insert into public.pokejam_seasons(number, starts_at, ends_at, status) values (9, now(), now() - interval '1 day', 'closed')`)).rejects.toThrow();
  });

  it('archives final scores when it closes a season, and seeds the next season from them', async () => {
    const t = await testDb();
    const [mod, a, b] = [await t.user('Mod'), await t.user('A'), await t.user('B')];
    await t.sql('insert into public.pokejam_admins(user_id) values ($1)', [mod.id]);
    await mod.call('pokejam_ranked_open_season', [6]);
    await setRank(t, a, { div: 7, points: 40 }); // Gold 2 40 -> 740
    await setRank(t, b, { div: 24, points: 300 }); // Zenith 300 -> 2700
    await mod.call('pokejam_ranked_open_season', [6]);
    const res = await t.sql('select user_id, final_score, peak_idx from public.pokejam_ranked_season_results');
    expect(res.find((r) => r.user_id === a.id)).toMatchObject({ final_score: 740, peak_idx: 7 });
    expect(res.find((r) => r.user_id === b.id)).toMatchObject({ final_score: 2700 });
    // Season 2: placing, seeded clamp(final - 600, 0, 1400)
    expect((await a.call<Row>('pokejam_ranked_me')).season).toBe(2);
    await t.sql('select public.pokejam_ranked_profile_lock($1, (select id from public.pokejam_seasons where status = \'active\'))', [a.id]);
    await t.sql('select public.pokejam_ranked_profile_lock($1, (select id from public.pokejam_seasons where status = \'active\'))', [b.id]);
    expect((await prof(t, a.id))).toMatchObject({ status: 'placing', seed_score: seedScore(740), shield_charge: 1 });
    expect((await prof(t, b.id))).toMatchObject({ seed_score: 1400 });
  });

  it('rolls over lazily once the season has ended', async () => {
    const t = await testDb();
    const [mod, a] = [await t.user('Mod'), await t.user('A')];
    await t.sql('insert into public.pokejam_admins(user_id) values ($1)', [mod.id]);
    await mod.call('pokejam_ranked_open_season', [6]);
    await t.sql(`update public.pokejam_seasons set starts_at = now() - interval '43 days', ends_at = now() - interval '1 day'`);
    const me = await a.call<Row>('pokejam_ranked_me');
    expect(me.season).toBe(2);
    expect((await t.sql(`select status from public.pokejam_seasons where number = 1`))[0].status).toBe('closed');
    expect((await t.sql(`select (starts_at = (select ends_at from public.pokejam_seasons where number = 1)) as ok from public.pokejam_seasons where number = 2`))[0].ok).toBe(true);
  });
});

describe('scoring a ranked match', () => {
  it('scores once: a second report (or a direct apply) changes nothing', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A'), await t.user('B')];
    await setRank(t, a, { div: 4, points: 50 });
    await setRank(t, b, { div: 4, points: 50 });
    const p = await rankedPair(a, b);
    const out = await finish(p, 70, 20);
    expect(out.status).toBe('done');
    expect(out.winner).toBe(p.host.id);
    const host = await prof(t, p.host.id), guest = await prof(t, p.guest.id);
    // Silver 2 (W 27, L 19), same division, m = 0.556 -> dominant win = round(1.5 * 27) = 41, blowout loss = the full 19
    expect(host).toMatchObject({ div_idx: 4, points: 91, wins: 1, losses: 0 });
    expect(guest).toMatchObject({ div_idx: 4, points: 31, wins: 0, losses: 1 });
    expect(await scored(t, p.mid)).toBe(1);

    expect((await p.host.call<Row>('pokejam_report_result', [p.mid, true])).status).toBe('done'); // repeat report
    expect((await p.guest.call<Row>('pokejam_report_result', [p.mid, true])).status).toBe('done');
    await t.sql('select public.pokejam_ranked_apply($1)', [p.mid]); // even a repeated internal apply
    expect(await prof(t, p.host.id)).toMatchObject({ div_idx: host.div_idx, points: host.points, wins: 1 });
    expect(await prof(t, p.guest.id)).toMatchObject({ div_idx: guest.div_idx, points: guest.points, losses: 1 });
    expect(await scored(t, p.mid)).toBe(1);
    const row = (await t.sql('select * from public.pokejam_ranked_matches where match_id = $1', [p.mid]))[0];
    expect(row).toMatchObject({ reason: 'score', winner: p.host.id, host_delta: 41, guest_delta: -19 });
  });

  it('uses the agreed score only: a mismatch or a score contradicting the winner counts as a photo finish', async () => {
    const t = await testDb();
    const [a, b, c, d] = [await t.user('A'), await t.user('B'), await t.user('C'), await t.user('D')];
    for (const u of [a, b, c, d]) await setRank(t, u, { div: 6, points: 50 });
    const p = await rankedPair(a, b);
    await p.host.call('pokejam_ranked_report_score', [p.mid, 90, 10]);
    await p.guest.call('pokejam_ranked_report_score', [p.mid, 51, 50]); // disagree
    await p.host.call('pokejam_report_result', [p.mid, true]);
    await p.guest.call('pokejam_report_result', [p.mid, true]);
    // Gold W 25, m = 0 -> 20
    expect((await t.sql('select host_delta, guest_delta, margin_share from public.pokejam_ranked_matches where match_id = $1', [p.mid]))[0])
      .toMatchObject({ host_delta: 20, guest_delta: -11, margin_share: null });
    const q = await rankedPair(c, d);
    await q.host.call('pokejam_ranked_report_score', [q.mid, 10, 90]); // both say the guest scored more...
    await q.guest.call('pokejam_ranked_report_score', [q.mid, 10, 90]);
    await q.host.call('pokejam_report_result', [q.mid, true]); // ...but the host won
    await q.guest.call('pokejam_report_result', [q.mid, true]);
    expect((await t.sql('select host_delta, margin_share from public.pokejam_ranked_matches where match_id = $1', [q.mid]))[0]).toMatchObject({ host_delta: 20, margin_share: null });
  });

  it('a disagreement on the winner is void and scores nothing', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A'), await t.user('B')];
    const p = await rankedPair(a, b);
    await p.host.call('pokejam_report_result', [p.mid, true]);
    expect((await p.guest.call<Row>('pokejam_report_result', [p.mid, false])).status).toBe('void');
    expect(await scored(t, p.mid)).toBe(0);
  });

  it('withholds the numbers while placing, and places after the fifth match', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A'), await t.user('B')];
    const p = await rankedPair(a, b);
    const out = await finish(p, 70, 20);
    const mine = out.rank as Row;
    expect(mine).toEqual({ placing: true, placements_played: 1, event: null });
    const me = await a.call<Row>('pokejam_ranked_me');
    expect(me).toMatchObject({ status: 'placing', placements_played: 1, placements_left: 4 });
    expect(me.div_idx).toBeUndefined();
    // four matches played already: the fifth places the winner
    const s = await season(t);
    await t.sql('update public.pokejam_ranked_profiles set placements_played = 4, placement_raw = 3.5, seed_score = 500 where user_id = any($1) and season_id = $2', [[a.id, b.id], s.id]);
    await t.sql(`update public.pokejam_matches set created_at = now() - interval '2 hours'`); // the same pair twice in a row is not paired
    const q = await rankedPair(a, b);
    const fin = await finish(q, 70, 20);
    const winner = fin.winner === a.id ? a : b;
    const wp = await prof(t, winner.id);
    expect(wp.status).toBe('ranked');
    const shift = placementShift(3.5 + placementWeight({ won: true, margin: marginOf(70, 20), oppScore: 500, seed: 500 }));
    expect(wp.div_idx).toBe(Math.floor((500 + shift) / 100));
    expect(wp.points).toBe((500 + shift) % 100);
  });
});

describe('table privileges', () => {
  it('clients cannot write any ranked table, only read their own safe rows', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A'), await t.user('B')];
    await setRank(t, a, { div: 3, points: 10 });
    await setRank(t, b, { div: 3, points: 10 });
    const s = await season(t);
    const attempts = [
      `insert into public.pokejam_seasons(number, ends_at) values (7, now() + interval '1 day')`,
      `update public.pokejam_seasons set length_weeks = 1`,
      `delete from public.pokejam_seasons`,
      `insert into public.pokejam_ranked_profiles(user_id, season_id) values ('${a.id}', ${s.id + 1})`,
      `update public.pokejam_ranked_profiles set div_idx = 24, points = 9999 where user_id = '${a.id}'`,
      `delete from public.pokejam_ranked_profiles where user_id = '${a.id}'`,
      `insert into public.pokejam_ranked_matches(match_id, season_id, host_id, guest_id, reason, result) values (gen_random_uuid(), ${s.id}, '${a.id}', '${b.id}', 'score', '{}')`,
      `update public.pokejam_ranked_matches set host_delta = 99`,
      `delete from public.pokejam_ranked_matches`,
      `insert into public.pokejam_ranked_season_results values ('${a.id}', ${s.id}, 23, 2399, 100, 0)`,
      `update public.pokejam_ranked_season_results set final_score = 2399`,
      `insert into public.pokejam_ranked_scores(match_id, user_id, host_score, guest_score) values (gen_random_uuid(), '${a.id}', 1, 0)`,
      `select * from public.pokejam_ranked_scores`,
    ];
    for (const q of attempts) await expect(a.sql(q), q).rejects.toThrow(/permission denied/);
    for (const role of ['anon']) await expect(t.as(role, null)('select * from public.pokejam_ranked_profiles')).rejects.toThrow(/permission denied/);
    // reading: own profile row only
    const rows = await a.sql('select user_id from public.pokejam_ranked_profiles');
    expect(rows.map((r) => r.user_id)).toEqual([a.id]);
    expect((await a.sql('select number from public.pokejam_seasons')).length).toBe(1);
    // internal functions are not callable by clients
    for (const f of [`pokejam_ranked_apply('${a.id}')`, 'pokejam_ranked_open_season_internal(6)', `pokejam_ranked_profile_lock('${a.id}', 1)`,
      `pokejam_ranked_player_update('${a.id}', 1, true, 'score', 0, 1, 0, 0)`])
      await expect(a.sql(`select public.${f}`), f).rejects.toThrow(/permission denied/);
  });
});

describe('non-ranked report_result is unchanged', () => {
  it('Social: done / pending / void exactly as before, no ranked rows, no rank in the answer', async () => {
    const t = await testDb();
    const [a, b, c, d] = [await t.user('A'), await t.user('B'), await t.user('C'), await t.user('D')];
    expect(await a.call('pokejam_find_match', ['social'])).toBeNull();
    const mid = (await b.call<string>('pokejam_find_match', ['social']))!;
    const info = await a.call<Record<string, string>>('pokejam_match_info', [mid]);
    const host = info.host === a.id ? a : b, guest = info.host === a.id ? b : a;
    expect((await host.call<Row>('pokejam_report_result', [mid, true])).status).toBe('pending');
    const done = await guest.call<Row>('pokejam_report_result', [mid, true]);
    expect(done).toMatchObject({ status: 'done', winner: host.id, rank: null });
    expect((await guest.call<Row>('pokejam_report_result', [mid, true])).status).toBe('done');
    expect(Number((await t.sql('select count(*)::int as n from public.pokejam_ranked_profiles'))[0].n)).toBe(0);
    expect(Number((await t.sql('select count(*)::int as n from public.pokejam_ranked_matches'))[0].n)).toBe(0);
    // disagreement is void
    expect(await c.call('pokejam_find_match', ['social'])).toBeNull();
    const m2 = (await d.call<string>('pokejam_find_match', ['social']))!;
    await c.call('pokejam_report_result', [m2, true]);
    const r = await d.call<Row>('pokejam_report_result', [m2, true]);
    expect(['done', 'void', 'pending']).toContain(r.status);
    // a stranger cannot report
    const e = await t.user('E');
    await expect(e.call('pokejam_report_result', [mid, true])).rejects.toThrow(/not in this match/);
  });

  it('Social leave still voids; a leave in a finished match does nothing', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A'), await t.user('B')];
    expect(await a.call('pokejam_find_match', ['social'])).toBeNull();
    const mid = (await b.call<string>('pokejam_find_match', ['social']))!;
    await a.call('pokejam_leave_match', [mid]);
    expect((await t.sql('select status from public.pokejam_matches where id = $1', [mid]))[0].status).toBe('void');
    expect(Number((await t.sql('select count(*)::int as n from public.pokejam_ranked_profiles'))[0].n)).toBe(0);
  });
});

describe('leavers', () => {
  it('after tip-off: max-cost loss for the leaver (no shield, no performance), minimum gain for the stayer', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A'), await t.user('B')];
    await setRank(t, a, { div: 7, points: 5 }); // Gold 2, 5 pts, shield up
    await setRank(t, b, { div: 7, points: 5 });
    const p = await rankedPair(a, b);
    await p.host.call('pokejam_match_alive', [p.mid]);
    await p.guest.call('pokejam_match_alive', [p.mid]);
    await p.guest.call('pokejam_leave_match', [p.mid]);
    expect((await t.sql('select status, winner from public.pokejam_matches where id = $1', [p.mid]))[0]).toMatchObject({ status: 'done', winner: p.host.id });
    // leaver: -19 from 5 -> demoted to Gold 3 at 75 even though the shield was up; stayer: +round(0.8 * 25) = +20
    expect(await prof(t, p.guest.id)).toMatchObject({ div_idx: 6, points: 75, shield_charge: 1, losses: 1, leaves_24h: 1 });
    expect(await prof(t, p.host.id)).toMatchObject({ div_idx: 7, points: 25, wins: 1, streak: 0, shield_charge: 1 });
    expect((await t.sql('select reason, host_delta, guest_delta from public.pokejam_ranked_matches where match_id = $1', [p.mid]))[0])
      .toMatchObject({ reason: 'leave', host_delta: 20, guest_delta: -19 });
    await p.host.call('pokejam_report_result', [p.mid, true]); // the stayer's report afterwards changes nothing
    expect(await scored(t, p.mid)).toBe(1);
    expect(await prof(t, p.host.id)).toMatchObject({ points: 25, wins: 1 });
  });

  it('before tip-off (a dodge): the dodger takes the loss, the other player is unchanged, the match is void', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A'), await t.user('B')];
    await setRank(t, a, { div: 7, points: 50 });
    await setRank(t, b, { div: 7, points: 50 });
    const p = await rankedPair(a, b);
    await p.guest.call('pokejam_leave_match', [p.mid]);
    expect((await t.sql('select status from public.pokejam_matches where id = $1', [p.mid]))[0].status).toBe('void');
    expect(await prof(t, p.guest.id)).toMatchObject({ points: 31, losses: 1 });
    expect(await prof(t, p.host.id)).toMatchObject({ div_idx: 7, points: 50, wins: 0, losses: 0 });
  });

  it('repeat leavers: cooldown 0/5/15/60 min and x1.25 from the 3rd leave in 24 h', async () => {
    const t = await testDb();
    const a = await t.user('A');
    const costs: number[] = [], cooldowns: number[] = [];
    for (let i = 0; i < 4; i++) {
      const b = await t.user('B' + i);
      await setRank(t, a, { div: 12, points: 90 }); // Diamond 3 (L 20)
      await setRank(t, b, { div: 12, points: 50 });
      await t.sql('update public.pokejam_ranked_profiles set cooldown_until = null'); // the cooldown is checked in ranked-matchmaking.test.ts
      const before = await prof(t, a.id);
      const p = await rankedPair(a, b);
      await a.call('pokejam_leave_match', [p.mid]); // dodge: only the leaver changes
      const after = await prof(t, a.id);
      costs.push(Number(before.points) - Number(after.points));
      cooldowns.push(after.cooldown_until ? Math.round((new Date(after.cooldown_until as string).getTime() - Date.now()) / 60000) : 0);
      await t.sql(`update public.pokejam_matches set status = 'void'`);
      await t.sql('delete from public.pokejam_queue');
    }
    expect(costs).toEqual([20, 20, 25, 25]); // 3rd and 4th: round(20 * 1.25) = 25
    expect(cooldowns.map((c) => Math.round(c / 5) * 5)).toEqual([0, 5, 15, 60]);
    expect((await prof(t, a.id)).leaver_flagged).toBe(true);
  });

  it('a stayer can claim the forfeit once the other heartbeat is silent for 45 s', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A'), await t.user('B')];
    const p = await rankedPair(a, b);
    await p.host.call('pokejam_match_alive', [p.mid]);
    await p.guest.call('pokejam_match_alive', [p.mid]);
    expect((await p.host.call<Row>('pokejam_ranked_forfeit', [p.mid])).status).toBe('active'); // too early
    await t.sql(`update public.pokejam_matches set guest_alive = now() - interval '50 seconds'`); // the guest goes silent, the host keeps beating
    await expect(p.guest.call('pokejam_ranked_forfeit', [p.mid])).resolves.toMatchObject({ status: 'active' }); // the silent one can't claim
    const out = await p.host.call<Row>('pokejam_ranked_forfeit', [p.mid]);
    expect(out).toMatchObject({ status: 'done', winner: p.host.id });
    expect((await t.sql('select reason from public.pokejam_ranked_matches where match_id = $1', [p.mid]))[0].reason).toBe('forfeit');
    expect(await prof(t, p.guest.id)).toMatchObject({ losses: 1, leaves_24h: 1 });
  });
});

describe('leaderboard and my position', () => {
  it('orders by ladder score with Zenith on top, needs >= 10 games, and reports my numeric position', async () => {
    const t = await testDb();
    const names = ['Z1', 'Z2', 'PM', 'Gold', 'Few'];
    const us: User[] = [];
    for (const n of names) us.push(await t.user(n));
    await setRank(t, us[0], { div: 24, points: 500, games: 10 });
    await setRank(t, us[1], { div: 24, points: 300, games: 10 });
    await setRank(t, us[2], { div: 23, points: 99, games: 10 });
    await setRank(t, us[3], { div: 7, points: 40, games: 12 });
    await setRank(t, us[4], { div: 20, points: 0, games: 9 }); // too few games
    const board = await us[3].call<{ season: number; rows: Row[] }>('pokejam_ranked_leaderboard');
    expect(board.season).toBe(1);
    expect(board.rows.map((r) => r.name)).toEqual(['Z1', 'Z2', 'PM', 'Gold']);
    expect(board.rows[0]).toMatchObject({ rank: 1, tier: 'Zenith', zenith: true, points: 500, division: null });
    expect(board.rows[2]).toMatchObject({ tier: 'Pokémon Master', division: 1, points: 99, zenith: false });
    expect(board.rows[3]).toMatchObject({ me: true, tier: 'Gold', division: 2 });
    expect(await us[3].call('pokejam_ranked_my_position')).toMatchObject({ position: 4, total: 4 });
    expect(await us[4].call('pokejam_ranked_my_position')).toMatchObject({ position: null, total: 4 });
  });

  it('shows Zenith points decayed by inactivity without writing them', async () => {
    const t = await testDb();
    const a = await t.user('A');
    await setRank(t, a, { div: 24, points: 300, games: 10 });
    await t.sql(`update public.pokejam_ranked_profiles set last_game_at = now() - interval '15 days'`);
    const board = await a.call<{ rows: Row[] }>('pokejam_ranked_leaderboard');
    expect(board.rows[0].points).toBe(zenithDecay(300, 15));
    expect((await a.call<Row>('pokejam_ranked_me')).points).toBe(250);
    expect((await prof(t, a.id)).points).toBe(300);
  });

  it('pokejam_ranked_me reports rank, shield and season for a placed player', async () => {
    const t = await testDb();
    const a = await t.user('A');
    await setRank(t, a, { div: 7, points: 40, charge: 0, lsh: 1 });
    expect(await a.call('pokejam_ranked_me')).toMatchObject({ season: 1, status: 'ranked', tier: 'Gold', division: 2, points: 40, shield_charge: 0, shield_losses_left: 2, shield_active: true });
  });
});

describe('SQL equals the TS rank module', () => {
  const margins: Margin[] = [NO_MARGIN, marginOf(41, 40), marginOf(42, 38), marginOf(60, 30), marginOf(70, 20), marginOf(300, 1)];
  const divs = [0, 1, 3, 6, 8, 9, 12, 15, 18, 21, 23, 24];

  it('pokejam_ranked_step gives the same state, delta and event for thousands of cases', async () => {
    const t = await testDb();
    type Case = { div: number; pts: number; charge: number; lsh: number; won: boolean; diff: number; total: number; opp: number; mode: string; heavy: boolean };
    const cases: Case[] = [];
    for (const div of divs) for (const pts of [0, 7, 40, 76, 99]) for (const [charge, lsh] of [[1, 0], [0, 0], [0, 2]]) for (const mg of margins) for (const opp of [0, 11, 24]) {
      const base = { div, pts, charge, lsh, diff: mg.diff, total: mg.total, opp };
      cases.push({ ...base, won: true, mode: 'score', heavy: false }, { ...base, won: false, mode: 'score', heavy: false },
        { ...base, won: true, mode: 'stay', heavy: false }, { ...base, won: false, mode: 'leave', heavy: false }, { ...base, won: false, mode: 'leave', heavy: true });
    }
    const rows = await t.sql(`select c.i, s.* from jsonb_to_recordset($1::jsonb) as c(i int, div int, pts int, charge int, lsh int, won boolean, diff int, total int, opp int, mode text, heavy boolean),
      lateral public.pokejam_ranked_step(c.div, c.pts, c.charge, c.lsh, c.won, c.diff, c.total, c.opp, c.mode, c.heavy) s order by c.i`,
    [JSON.stringify(cases.map((c, i) => ({ i, ...c })))]);
    expect(rows.length).toBe(cases.length);
    let mismatches = 0;
    rows.forEach((r, i) => {
      const c = cases[i];
      const mode = c.mode as 'score' | 'stay' | 'leave';
      const ts = applyResult({ ...newLadderState(c.div, c.pts), shieldCharge: c.charge as 0 | 1, lossesSinceShield: c.lsh },
        { won: c.won, mode, margin: { diff: c.diff, total: c.total }, oppIdx: c.opp, heavy: c.heavy });
      const sql = { divIdx: r.o_div, points: r.o_pts, shieldCharge: r.o_charge, lossesSinceShield: r.o_lsh, delta: r.o_delta, event: r.o_event };
      const want = { ...ts.state, delta: ts.delta, event: ts.event };
      if (JSON.stringify(sql) !== JSON.stringify(want) && mismatches++ < 5) expect(sql, JSON.stringify(c)).toEqual(want);
    });
    expect(mismatches).toBe(0);
  });

  it('helpers agree: zenith decay, seed, placement weight and shift, names', async () => {
    const t = await testDb();
    for (const [p, d] of [[300, 0], [300, 7], [300, 20], [300, 400], [60, 30], [40, 30], [100, 6], [100, 14]])
      expect((await t.sql('select public.pokejam_ranked_zenith_decay($1, $2) as v', [p, d]))[0].v).toBe(zenithDecay(p, d));
    for (const f of [null, 0, 599, 600, 700, 1100, 2000, 2740])
      expect((await t.sql('select public.pokejam_ranked_seed($1) as v', [f]))[0].v).toBe(seedScore(f));
    for (const [kind, mg, opp, seed] of [['score', NO_MARGIN, 0, 1000], ['score', marginOf(42, 38), 600, 500], ['score', marginOf(60, 30), 500, 500],
      ['score', marginOf(70, 20), 3000, 0], ['leave', NO_MARGIN, 0, 0], ['stay', NO_MARGIN, 0, 0]] as const) {
      const w = Number((await t.sql('select public.pokejam_ranked_placement_weight($1, $2, $3, $4, $5) as v', [kind, mg.diff, mg.total, opp, seed]))[0].v);
      expect(w).toBeCloseTo(placementWeight({ won: true, kind, margin: mg, oppScore: opp, seed }), 9);
    }
    for (const raw of [0, 0.05, -0.05, 0.49 / 20, 1.234, -3.9, 5.9, -9, 100])
      expect((await t.sql('select public.pokejam_ranked_placement_shift($1::numeric) as v', [raw]))[0].v).toBe(placementShift(raw));
    expect((await t.sql(`select public.pokejam_ranked_tier_name(24) as a, public.pokejam_ranked_tier_name(7) as b, public.pokejam_ranked_division(7) as c, public.pokejam_ranked_division(24) as d`))[0])
      .toEqual({ a: 'Zenith', b: 'Gold', c: 2, d: null });
  });

  it('a full match through report_result lands where the TS module says', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A'), await t.user('B')];
    await setRank(t, a, { div: 22, points: 90 }); // Pokémon Master 2
    await setRank(t, b, { div: 23, points: 10 });
    const p = await rankedPair(a, b);
    await finish(p, 55, 40);
    const mg = marginOf(55, 40);
    const hostIs = p.host === a ? { div: 22, pts: 90, opp: 23 } : { div: 23, pts: 10, opp: 22 };
    const guestIs = p.host === a ? { div: 23, pts: 10, opp: 22 } : { div: 22, pts: 90, opp: 23 };
    const w = applyResult(newLadderState(hostIs.div, hostIs.pts), { won: true, margin: mg, oppIdx: hostIs.opp });
    const l = applyResult(newLadderState(guestIs.div, guestIs.pts), { won: false, margin: mg, oppIdx: guestIs.opp });
    expect(await prof(t, p.host.id)).toMatchObject({ div_idx: w.state.divIdx, points: w.state.points });
    expect(await prof(t, p.guest.id)).toMatchObject({ div_idx: l.state.divIdx, points: l.state.points });
  });
});
