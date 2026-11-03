// Ranked quit bans (migration 20261207): persistent offence count, the 15 min / 1 day / 7 day / 14 day
// ladder, 14-day decay, void and the stayer unpunished, the queue refusal, and an admin clear.
import { describe, expect, it, vi } from 'vitest';
import { pickBoth, testDb, type Db, type User } from './testDb';

vi.setConfig({ testTimeout: 60_000 });

type Row = Record<string, unknown>;
const quit = async (t: Db, id: string) =>
  (await t.sql('select offences, ban_until, last_offence_at from public.pokejam_ranked_quits where user_id = $1', [id]))[0] as Row | undefined;
const secsLeft = (until: unknown) => {
  const t = until instanceof Date ? until.getTime() : typeof until === 'string' ? Date.parse(until) : NaN;
  return Number.isFinite(t) ? (t - Date.now()) / 1000 : 0;
};
const near = (actual: number, want: number) => {
  expect(actual).toBeGreaterThan(want - 30);
  expect(actual).toBeLessThanOrEqual(want + 1);
};

async function pair(t: Db, a: User, b: User) {
  expect(await a.call('pokejam_find_match', ['ranked'])).toBeNull();
  const mid = await b.call<string>('pokejam_find_match', ['ranked']);
  await pickBoth(t, mid);
  return mid;
}

/** A leaves before tip-off (a dodge). The match is moved out of the pairing window. */
async function dodge(t: Db, a: User) {
  const b = await t.user('Opp');
  const mid = await pair(t, a, b);
  await a.call('pokejam_leave_match', [mid]);
  await t.sql(`update public.pokejam_matches set status = 'void', created_at = now() - interval '3 hours' where id = $1`, [mid]);
  await t.sql('delete from public.pokejam_queue');
}

/** Lets the player queue again without erasing offences. */
async function lift(t: Db, id: string) {
  await t.sql(`update public.pokejam_ranked_quits set ban_until = now() - interval '1 second' where user_id = $1`, [id]);
  await t.sql(`update public.pokejam_ranked_profiles set ban_until = null, cooldown_until = null where user_id = $1`, [id]);
}

describe('quit ladder', () => {
  it('warns on the 1st offence, then bans 15 min, 1 day, 7 days, and 14 days from the 5th on', async () => {
    const t = await testDb();
    const a = await t.user('A');
    const want = [0, 15 * 60, 86400, 7 * 86400, 14 * 86400, 14 * 86400];
    for (let i = 0; i < want.length; i++) {
      await dodge(t, a);
      const row = await quit(t, a.id);
      expect(row?.offences).toBe(i + 1);
      near(secsLeft(row?.ban_until), want[i]);
      const me = await a.call<Row>('pokejam_ranked_me');
      expect(me.quit_offences).toBe(i + 1);
      expect(me.quit_recent).toBe(true);
      if (want[i] === 0) expect(me.ban_until).toBeNull();
      else near(secsLeft(me.ban_until), want[i]);
      await lift(t, a.id);
    }
  });

  it('a dodge counts and the player who stayed does not', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A'), await t.user('B')];
    const mid = await pair(t, a, b);
    await a.call('pokejam_leave_match', [mid]);
    expect((await quit(t, a.id))?.offences).toBe(1);
    expect(await quit(t, b.id)).toBeUndefined();
    expect(await b.call('pokejam_find_match', ['ranked'])).toBeNull();
  });

  it('a forfeit after tip-off counts for the leaver only, and the stayer still wins', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A'), await t.user('B')];
    const mid = await pair(t, a, b);
    await a.call('pokejam_match_alive', [mid]);
    await b.call('pokejam_match_alive', [mid]);
    await a.call('pokejam_leave_match', [mid]);
    expect((await t.sql('select status, winner from public.pokejam_matches where id = $1', [mid]))[0].status).toBe('done');
    expect((await quit(t, a.id))?.offences).toBe(1);
    expect(await quit(t, b.id)).toBeUndefined();
  });

  it('silence after tip-off is a forfeit offence for the quiet player', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A'), await t.user('B')];
    const mid = await pair(t, a, b);
    await a.call('pokejam_match_alive', [mid]);
    await b.call('pokejam_match_alive', [mid]);
    const [m] = await t.sql('select host, guest from public.pokejam_matches where id = $1', [mid]);
    const host = m.host === a.id ? a : b;
    const guest = m.host === a.id ? b : a;
    await t.sql(`update public.pokejam_matches set guest_alive = now() - interval '50 seconds' where id = $1`, [mid]);
    expect(await host.call('pokejam_ranked_forfeit', [mid])).toMatchObject({ status: 'done', winner: host.id });
    expect((await quit(t, guest.id))?.offences).toBe(1);
    expect(await quit(t, host.id)).toBeUndefined();
  });

  it('a void (both silent) and a failed connection punish nobody', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A'), await t.user('B')];
    const mid = await pair(t, a, b);
    await a.call('pokejam_match_alive', [mid]);
    await b.call('pokejam_match_alive', [mid]);
    await t.sql(`update public.pokejam_matches set created_at = now() - interval '2 minutes', host_alive = now() - interval '50 seconds', guest_alive = now() - interval '50 seconds' where id = $1`, [mid]);
    await t.service('select public.pokejam_cleanup_matches()');
    expect((await t.sql('select status from public.pokejam_matches where id = $1', [mid]))[0].status).toBe('void');
    expect(await quit(t, a.id)).toBeUndefined();
    expect(await quit(t, b.id)).toBeUndefined();

    const [c, d] = [await t.user('C'), await t.user('D')];
    const late = await pair(t, c, d);
    await t.sql(`update public.pokejam_matches set created_at = now() - interval '2 minutes' where id = $1`, [late]);
    await c.call('pokejam_leave_match', [late]);
    expect((await t.sql('select status from public.pokejam_matches where id = $1', [late]))[0].status).toBe('void');
    expect(await quit(t, c.id)).toBeUndefined();
    expect(await quit(t, d.id)).toBeUndefined();
  });

  it('never showing up is a dodge for that player only', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A'), await t.user('B')];
    const mid = await pair(t, a, b);
    const [m] = await t.sql('select host, guest from public.pokejam_matches where id = $1', [mid]);
    await a.call('pokejam_match_alive', [mid]);
    await t.sql(`update public.pokejam_matches set created_at = now() - interval '2 minutes' where id = $1`, [mid]);
    await t.service('select public.pokejam_cleanup_matches()');
    const quiet = String(m.host === a.id ? m.guest : m.host);
    expect((await quit(t, quiet))?.offences).toBe(1);
    expect(await quit(t, a.id)).toBeUndefined();
  });

  it('a finished game is not an offence, and a cheat forfeit is not a quit', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A'), await t.user('B')];
    const mid = await pair(t, a, b);
    await a.call('pokejam_match_alive', [mid]);
    await b.call('pokejam_match_alive', [mid]);
    await a.call('pokejam_ranked_report_score', [mid, 70, 40]);
    await b.call('pokejam_ranked_report_score', [mid, 70, 40]);
    const [m] = await t.sql('select host from public.pokejam_matches where id = $1', [mid]);
    const hostWon = m.host === a.id;
    await a.call('pokejam_report_result', [mid, hostWon]);
    expect((await b.call<Row>('pokejam_report_result', [mid, hostWon])).status).toBe('done');
    expect(await quit(t, a.id)).toBeUndefined();
    expect(await quit(t, b.id)).toBeUndefined();

    await t.sql(`update public.pokejam_config set value = 'true'::jsonb where key = 'judge_authoritative'`);
    const [c, d] = [await t.user('C'), await t.user('D')];
    const disputed = await pair(t, c, d);
    await c.call('pokejam_match_alive', [disputed]);
    await d.call('pokejam_match_alive', [disputed]);
    await c.call('pokejam_report_result', [disputed, true]);
    expect((await d.call<Row>('pokejam_report_result', [disputed, false])).status).toBe('judging');
    const [row] = await t.sql('select host from public.pokejam_matches where id = $1', [disputed]);
    await t.service(`select public.pokejam_record_verdict(p_match => $1, p_status => 'forfeit', p_winner_side => 1, p_cheater_side => 0,
      p_score_host => 0, p_score_guest => 1, p_ticks => 100, p_notes => 'test', p_last_host => 0, p_last_guest => 0, p_fault_user => null)`, [disputed]);
    await t.service('select public.pokejam_judge_apply($1)', [disputed]);
    expect(await quit(t, String(row.host))).toBeUndefined();
  });
});

describe('decay', () => {
  it('forgives one offence per 14 days without a new one, and the next offence uses the reduced count', async () => {
    const t = await testDb();
    const a = await t.user('A');
    for (let i = 0; i < 3; i++) { await dodge(t, a); await lift(t, a.id); }
    expect((await quit(t, a.id))?.offences).toBe(3);
    await t.sql(`update public.pokejam_ranked_quits set last_offence_at = now() - interval '14 days 1 hour' where user_id = $1`, [a.id]);
    const me = await a.call<Row>('pokejam_ranked_me');
    expect(me.quit_offences).toBe(2);
    expect(me.quit_recent).toBe(false);
    await dodge(t, a);
    expect((await quit(t, a.id))?.offences).toBe(3);
    near(secsLeft((await quit(t, a.id))?.ban_until), 86400);
  });

  it('forgives two offences after 28 days, and a long quiet stretch can return to a warning', async () => {
    const t = await testDb();
    const a = await t.user('A');
    for (let i = 0; i < 4; i++) { await dodge(t, a); await lift(t, a.id); }
    await t.sql(`update public.pokejam_ranked_quits set last_offence_at = now() - interval '28 days 1 hour' where user_id = $1`, [a.id]);
    await dodge(t, a);
    expect((await quit(t, a.id))?.offences).toBe(3);
    near(secsLeft((await quit(t, a.id))?.ban_until), 86400);

    const b = await t.user('B');
    await dodge(t, b);
    await t.sql(`update public.pokejam_ranked_quits set last_offence_at = now() - interval '40 days', ban_until = null where user_id = $1`, [b.id]);
    await t.sql(`update public.pokejam_ranked_profiles set ban_until = null, cooldown_until = null where user_id = $1`, [b.id]);
    await dodge(t, b);
    expect((await quit(t, b.id))?.offences).toBe(1);
    expect((await quit(t, b.id))?.ban_until).toBeNull();
  });
});

describe('queue', () => {
  it('a banned player cannot queue, and is not paired from a row already in the queue', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A'), await t.user('B')];
    await dodge(t, a);
    await dodge(t, a);
    await expect(a.call('pokejam_find_match', ['ranked'])).rejects.toThrow(/ranked cooldown: \d+ seconds left/);
    await t.sql(`update public.pokejam_ranked_profiles set cooldown_until = null, ban_until = null where user_id = $1`, [a.id]);
    await expect(a.call('pokejam_find_match', ['ranked'])).rejects.toThrow(/ranked cooldown/);
    expect(await b.call('pokejam_find_match', ['ranked'])).toBeNull();
    await t.sql(`insert into public.pokejam_queue(user_id, queue, mmr, last_seen) values ($1, 'ranked', 0, now())
      on conflict (user_id) do update set queue = 'ranked', last_seen = now()`, [a.id]);
    expect(await b.call('pokejam_find_match', ['ranked'])).toBeNull();
  });

  it('the ban survives a new season', async () => {
    const t = await testDb();
    const [mod, a] = [await t.user('Mod'), await t.user('A')];
    await t.sql('insert into public.pokejam_admins(user_id) values ($1)', [mod.id]);
    await dodge(t, a);
    await dodge(t, a);
    await mod.call('pokejam_ranked_open_season', [6]);
    await expect(a.call('pokejam_find_match', ['ranked'])).rejects.toThrow(/ranked cooldown/);
  });

  it('a finished ban can queue again', async () => {
    const t = await testDb();
    const a = await t.user('A');
    await dodge(t, a);
    await dodge(t, a);
    await lift(t, a.id);
    expect(await a.call('pokejam_find_match', ['ranked'])).toBeNull();
  });
});

describe('admin clear', () => {
  it('a moderator can lift the ban, a player and anon cannot, and the offence count stays', async () => {
    const t = await testDb();
    const [mod, a, b] = [await t.user('Mod'), await t.user('A'), await t.user('B')];
    await dodge(t, a);
    await dodge(t, a);
    await expect(b.call('pokejam_admin_clear_ranked_ban', [a.id])).rejects.toThrow(/moderators only/);
    await expect(t.as('anon', null)('select public.pokejam_admin_clear_ranked_ban($1)', [a.id])).rejects.toThrow(/permission denied/);
    await expect(a.sql('select * from public.pokejam_ranked_quits')).rejects.toThrow(/permission denied/);
    await expect(a.sql(`select public.pokejam_ranked_quit_strike($1)`, [a.id])).rejects.toThrow(/permission denied/);
    await t.sql('insert into public.pokejam_admins(user_id) values ($1)', [mod.id]);
    const code = await b.call<string>('pokejam_create_room', [120]);
    const mid = await a.call<string>('pokejam_join_room', [code]);
    await b.call('pokejam_report_player', [mid, 'quitting', 'left']);
    const reported = (await mod.call<Row[]>('pokejam_admin_reports', [7])).find((r) => r.user_id === a.id)!;
    expect(reported.quit_offences).toBe(2);
    expect(secsLeft(reported.ranked_ban_until)).toBeGreaterThan(800);
    const ranked = (await mod.call<{ players: Row[] }>('pokejam_admin_ranked_players')).players.find((p) => p.user_id === a.id)!;
    expect(ranked.quit_offences).toBe(2);
    expect(secsLeft(ranked.ranked_ban_until)).toBeGreaterThan(800);
    await mod.call('pokejam_admin_ban', [a.id, 24, 'reports reviewed']);
    const banned = (await mod.call<Row[]>('pokejam_admin_bans')).find((r) => r.user_id === a.id)!;
    expect(banned.quit_offences).toBe(2);
    expect(secsLeft(banned.ranked_ban_until)).toBeGreaterThan(800);
    await mod.call('pokejam_admin_unban', [a.id]);
    await mod.call('pokejam_admin_clear_ranked_ban', [a.id]);
    expect((await quit(t, a.id))?.offences).toBe(2);
    expect((await quit(t, a.id))?.ban_until).toBeNull();
    expect((await t.sql('select ban_until, cooldown_until from public.pokejam_ranked_profiles where user_id = $1', [a.id]))[0])
      .toMatchObject({ ban_until: null, cooldown_until: null });
    expect(await a.call('pokejam_find_match', ['ranked'])).toBeNull();
    const log = await mod.call<{ action: string }[]>('pokejam_admin_history', [10]);
    expect(log.map((l) => l.action)).toContain('clear ranked ban');
  });
});
