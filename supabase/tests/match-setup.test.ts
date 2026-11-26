// pokejam_match_setup (migration 20261128): the judge's view of a match, from the server's row. Service role only.
import { describe, expect, it, vi } from 'vitest';
import { type Db, pickBoth, testDb } from './testDb';

vi.setConfig({ testTimeout: 30_000 });

const [HK, GK] = ['ab'.repeat(32), 'cd'.repeat(32)];

const setup = async (t: Db, id: string) => (await t.service('select public.pokejam_match_setup($1) as r', [id]))[0].r as Record<string, unknown> | null;

async function match(t: Db, queue: 'ranked' | 'social', hostUsername?: string | null) {
  const [host, guest] = [await t.user('Host Team', false, hostUsername), await t.user('Guest Team')];
  const [{ id }] = await t.sql(
    `insert into public.pokejam_matches(queue, host, guest, host_mmr, guest_mmr, status, seed, quarter_len, host_key, guest_key)
     values ($1, $2, $3, 1000, 1000, 'active', 555, 120, $4, $5) returning id`, [queue, host.id, guest.id, HK, GK]);
  return { id: id as string, host, guest };
}

describe('pokejam_match_setup', () => {
  it('Ranked: usernames and preset rosters, with the seed and keys from the row', async () => {
    const t = await testDb();
    const { id, host, guest } = await match(t, 'ranked', 'SetupHost');
    await pickBoth(t, id, ['A', 'F']);
    const [{ username }] = await t.sql('select username from public.pokejam_usernames where user_id = $1', [guest.id]);
    expect(await setup(t, id)).toEqual({
      id, queue: 'ranked', status: 'active', host: host.id, guest: guest.id, seed: 555, quarter_len: 120, host_key: HK, guest_key: GK,
      host_name: 'SetupHost', guest_name: username,
      host_roster: [78, 229, 94, 9, 208], guest_roster: [65, 123, 635, 373, 473],
    });
  });

  it('Ranked rosters and names agree with what the players get from pokejam_match_info and pokejam_match_usernames', async () => {
    const t = await testDb();
    const { id, host } = await match(t, 'ranked');
    await pickBoth(t, id, ['B', 'B']);
    const info = await host.call<Record<string, unknown>>('pokejam_match_info', [id]);
    const names = await host.call<Record<string, unknown>>('pokejam_match_usernames', [id]);
    const s = (await setup(t, id))!;
    for (const k of ['host_roster', 'guest_roster', 'seed', 'quarter_len', 'host_key', 'guest_key']) expect(s[k]).toEqual(info[k]);
    expect([s.host_name, s.guest_name]).toEqual([names.host, names.guest]);
  });

  it('Ranked: rosters are null until both have picked; a player with no username reads as Player', async () => {
    const t = await testDb();
    const { id, host } = await match(t, 'ranked', null);
    expect(await setup(t, id)).toMatchObject({ host_name: 'Player', host_roster: null, guest_roster: null });
    // One pick is not enough: rosters stay hidden until both have picked. (A player with no username can't use the RPC.)
    await t.sql(`insert into public.pokejam_ranked_picks(match_id, user_id, preset_id) values ($1, $2, 'A')`, [id, host.id]);
    expect(await setup(t, id)).toMatchObject({ host_roster: null, guest_roster: null });
  });

  it('Social: trainer names, and drafted rosters only once the draft is done', async () => {
    const t = await testDb();
    const { id } = await match(t, 'social');
    expect(await setup(t, id)).toMatchObject({ queue: 'social', host_name: 'Host Team', guest_name: 'Guest Team', host_roster: null, guest_roster: null });
    const pos = ['PG', 'SG', 'SF', 'PF', 'C'];
    const picks = [0, 1].flatMap((side) => pos.map((p, i) => ({ side, dex: 1 + side * 10 + i, pos: p })));
    await t.sql(`insert into public.pokejam_drafts(match_id, first, pool, picks, deadline, done) values ($1, 0, '{}', $2, now(), false)`, [id, JSON.stringify(picks)]);
    expect(await setup(t, id)).toMatchObject({ host_roster: null, guest_roster: null });
    await t.sql('update public.pokejam_drafts set done = true where match_id = $1', [id]);
    expect(await setup(t, id)).toMatchObject({ host_roster: [1, 2, 3, 4, 5], guest_roster: [11, 12, 13, 14, 15] });
  });

  it('players and anon are refused, even for their own match; an unknown match is null', async () => {
    const t = await testDb();
    const { id, host } = await match(t, 'ranked');
    for (const run of [host.sql, t.as('anon', null)]) {
      await expect(run('select public.pokejam_match_setup($1)', [id])).rejects.toThrow(/permission denied/);
    }
    expect(await setup(t, crypto.randomUUID())).toBeNull();
  });
});
