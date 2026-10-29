// The moderators' stats panel (migration 20261109): non-admins get an error, admins get the right counts.
import { describe, expect, it, vi } from 'vitest';
import { quickPair, testDb } from './testDb';

vi.setConfig({ testTimeout: 30_000 });

describe('pokejam_admin_stats', () => {
  it('refuses anyone who is not a moderator', async () => {
    const t = await testDb();
    const a = await t.user('A');
    await expect(a.call('pokejam_admin_stats')).rejects.toThrow(/moderators only/);
    await expect(t.as('anon', null)('select public.pokejam_admin_stats()')).rejects.toThrow(/permission denied/);
  });

  it('counts players, games, live games and the queue', async () => {
    const t = await testDb();
    const [mod, a, b, c, d, e] = [await t.user('Mod'), await t.user('A'), await t.user('B'), await t.user('C'), await t.user('D'), await t.user('E')];
    await t.sql('insert into public.pokejam_admins(user_id) values ($1)', [mod.id]);
    const empty = await mod.call<Record<string, number>>('pokejam_admin_stats');
    expect(empty).toMatchObject({ players_all: 0, games_all: 0, playing_now_matches: 0, profiles_all: 6, queue_now: 0 });

    const m1 = await quickPair(t, a, b); // live: both beat
    const m2 = await quickPair(t, c, d); // old, finished
    await t.sql(`update public.pokejam_matches set host_alive = now(), guest_alive = now() where id = $1`, [m1]);
    await t.sql(`update public.pokejam_matches set status = 'done', finished_at = now(), created_at = now() - interval '3 days' where id = $1`, [m2]);
    await e.call('pokejam_find_match', ['social']); // searching

    const s = await mod.call<Record<string, number | string>>('pokejam_admin_stats');
    expect(s).toMatchObject({
      players_today: 2, players_7d: 4, players_all: 4, profiles_all: 6,
      games_today: 1, games_today_finished: 0, games_all: 2, games_all_finished: 1,
      playing_now_matches: 1, playing_now_players: 2, queue_now: 1,
    });
    expect(typeof s.generated_at).toBe('string');

    // a heartbeat older than 60 s is not "playing now"; one side still beating is
    await t.sql(`update public.pokejam_matches set host_alive = now() - interval '2 minutes', guest_alive = now() - interval '5 seconds' where id = $1`, [m1]);
    expect(await mod.call('pokejam_admin_stats')).toMatchObject({ playing_now_matches: 1, playing_now_players: 1 });
    await t.sql(`update public.pokejam_matches set guest_alive = now() - interval '2 minutes' where id = $1`, [m1]);
    expect(await mod.call('pokejam_admin_stats')).toMatchObject({ playing_now_matches: 0, playing_now_players: 0 });
  });
});
