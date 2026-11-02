// Migration 20261114: usernames (rules, uniqueness, guests, cooldown, moderator rename, Ranked requirement) and the
// client/server filter sync.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { checkUsername, FILTER, mildRegex } from '../../src/multiplayer/ranked/username';
import { withSeed } from '../../scripts/gen-name-filter-sql.mjs';
import data from '../../src/multiplayer/ranked/nameFilterData.json';
import { testDb, type Db } from './testDb';

vi.setConfig({ testTimeout: 60_000 });

const set = (u: { call: <T>(fn: string, a?: unknown[]) => Promise<T> }, name: string) => u.call<{ username: string }>('pokejam_set_username', [name]);
const MIGRATION = new URL('../migrations/20261114_pokejam_profiles.sql', import.meta.url);
const makeAdmin = async (t: Db) => {
  const mod = await t.user('Mod', false, null);
  await t.sql('insert into public.pokejam_admins(user_id) values ($1)', [mod.id]);
  return mod;
};

describe('pokejam_set_username', () => {
  it('sets a valid name and reads it back', async () => {
    const t = await testDb();
    const a = await t.user('A', false, null);
    expect(await a.call('pokejam_my_username')).toEqual({ username: null, next_change_at: null });
    expect(await set(a, 'Ash_K99')).toEqual({ username: 'Ash_K99' });
    expect(await a.call<{ username: string }>('pokejam_my_username')).toMatchObject({ username: 'Ash_K99' });
    const rows = await a.sql('select user_id, username from public.pokejam_usernames');
    expect(rows).toHaveLength(1);
  });

  it('rejects guests and signed-out callers', async () => {
    const t = await testDb();
    const g = await t.user('G', true);
    await expect(set(g, 'GuestName')).rejects.toThrow(/username:signin/);
    const anon = t.as('anon', null);
    await expect(anon(`select public.pokejam_set_username('Nobody') as r`)).rejects.toThrow();
    expect((await t.sql('select count(*)::int as n from public.pokejam_usernames'))[0].n).toBe(0);
  });

  it('enforces length, charset, reserved, impersonation and profanity', async () => {
    const t = await testDb();
    const a = await t.user('A', false, null);
    const cases: [string, string][] = [['ab', 'length'], ['a'.repeat(17), 'length'], ['bad name', 'charset'], ['<img>', 'charset'], ['admin', 'reserved'],
      ['Null', 'reserved'], ['Admin_Joe', 'impersonation'], ['m0d_squad', 'impersonation'], ['sh1t_lord', 'profanity'], ['Sex', 'profanity']];
    for (const [name, code] of cases) await expect(set(a, name), name).rejects.toThrow(new RegExp(`username:${code}`));
    expect((await a.call<{ username: string | null }>('pokejam_my_username')).username).toBeNull();
    await set(a, 'Scunthorpe'); // the allowlist
  });

  it('is unique ignoring case', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A', false, null), await t.user('B', false, null)];
    await set(a, 'CoolGuy');
    await expect(set(b, 'coolguy')).rejects.toThrow(/username:taken/);
    await expect(set(b, 'COOLGUY')).rejects.toThrow(/username:taken/);
    await expect(t.sql(`insert into public.pokejam_usernames(user_id, username) values ($1, 'cOOLgUY')`, [b.id])).rejects.toThrow();
    await set(b, 'CoolGuy2');
  });

  it('only changes the caller\'s own name', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A', false, null), await t.user('B', false, null)];
    await set(a, 'Alpha_1');
    await set(b, 'Bravo_1');
    expect((await t.sql('select username from public.pokejam_usernames where user_id = $1', [a.id]))[0].username).toBe('Alpha_1');
    // there is no way to name another user: a direct write is refused for players
    await expect(b.sql(`update public.pokejam_usernames set username = 'Hacked_1' where user_id = $1`, [a.id])).rejects.toThrow();
    await expect(b.sql(`update public.pokejam_usernames set username = 'Hacked_1'`)).rejects.toThrow();
    await expect(b.sql(`insert into public.pokejam_usernames(user_id, username) values ($1, 'Hacked_2')`, [b.id])).rejects.toThrow();
    await expect(b.sql(`delete from public.pokejam_usernames`)).rejects.toThrow();
    expect((await t.sql('select username from public.pokejam_usernames where user_id = $1', [a.id]))[0].username).toBe('Alpha_1');
  });

  it('first pick is free, then one change per 30 days', async () => {
    const t = await testDb();
    const a = await t.user('A', false, null);
    await set(a, 'First_Pick');
    await expect(set(a, 'Second_Pick')).rejects.toThrow(/username:cooldown:30/);
    expect(await set(a, 'First_Pick')).toEqual({ username: 'First_Pick' }); // same name: no change, no error
    const my = await a.call<{ next_change_at: string }>('pokejam_my_username');
    expect(my.next_change_at).toBeTruthy();
    await t.sql(`update public.pokejam_usernames set changed_at = now() - interval '31 days' where user_id = $1`, [a.id]);
    expect(await set(a, 'Second_Pick')).toEqual({ username: 'Second_Pick' });
    await expect(set(a, 'Third_Pick')).rejects.toThrow(/username:cooldown/);
  });

  it('RLS: players read usernames but not private columns, and cannot write', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A', false, null), await t.user('B', false, null)];
    await set(a, 'Visible_A');
    const rows = await b.sql('select user_id, username from public.pokejam_usernames');
    expect(rows).toEqual([{ user_id: a.id, username: 'Visible_A' }]);
    await expect(b.sql('select changed_at from public.pokejam_usernames')).rejects.toThrow();
    await expect(b.sql('select * from public.pokejam_name_blocklist')).rejects.toThrow();
  });
});

describe('pokejam_admin_force_rename', () => {
  it('lets a moderator rename or reset, flags it and logs it', async () => {
    const t = await testDb();
    const [mod, a] = [await makeAdmin(t), await t.user('A', false, null)];
    await set(a, 'Offensive1');
    expect(await mod.call('pokejam_admin_force_rename', [a.id, 'Renamed_1'])).toEqual({ username: 'Renamed_1' });
    const row = (await t.sql('select username, flagged, changed_at from public.pokejam_usernames where user_id = $1', [a.id]))[0];
    expect(row).toMatchObject({ username: 'Renamed_1', flagged: true });
    await expect(set(a, 'Swap_Back')).rejects.toThrow(/cooldown/); // can't bounce straight back
    await mod.call('pokejam_admin_force_rename', [a.id, null]);
    expect((await t.sql('select username from public.pokejam_usernames where user_id = $1', [a.id]))[0].username).toBeNull();
    await set(a, 'Fresh_Pick'); // a reset is a free pick
    const log = await t.sql(`select detail from public.pokejam_admin_log where action = 'force rename' order by id`);
    expect(log.map((r) => r.detail)).toEqual(['Offensive1 -> Renamed_1', 'Renamed_1 -> (reset)']);
  });

  it('validates the new name and refuses non-moderators', async () => {
    const t = await testDb();
    const [mod, a, b] = [await makeAdmin(t), await t.user('A', false, null), await t.user('B', false, null)];
    await set(b, 'Taken_Name');
    await expect(mod.call('pokejam_admin_force_rename', [a.id, 'admin'])).rejects.toThrow(/username:reserved/);
    await expect(mod.call('pokejam_admin_force_rename', [a.id, 'taken_name'])).rejects.toThrow(/username:taken/);
    await expect(a.call('pokejam_admin_force_rename', [b.id, 'Renamed_2'])).rejects.toThrow(/moderators only/);
    await expect(b.call('pokejam_admin_force_rename', [b.id, 'Renamed_3'])).rejects.toThrow(/moderators only/);
    expect((await t.sql('select username from public.pokejam_usernames where user_id = $1', [b.id]))[0].username).toBe('Taken_Name');
  });
});

describe('Ranked requires a username', () => {
  it('refuses the queue without one, allows it after picking, still refuses guests first', async () => {
    const t = await testDb();
    const a = await t.user('A', false, null);
    await expect(a.call('pokejam_find_match', ['ranked'])).rejects.toThrow(/username:required/);
    expect((await t.sql('select count(*)::int as n from public.pokejam_queue where user_id = $1', [a.id]))[0].n).toBe(0);
    await set(a, 'Ranked_Ace');
    expect(await a.call('pokejam_find_match', ['ranked'])).toBeNull();
    const g = await t.user('G', true);
    await expect(g.call('pokejam_find_match', ['ranked'])).rejects.toThrow(/signed-in account/);
    // Social does not need a username
    const s = await t.user('S', false, null);
    expect(await s.call('pokejam_find_match', ['social'])).toBeNull();
  });

  it('shows both usernames of a match to its players only, never emails', async () => {
    const t = await testDb();
    const [a, b, c] = [await t.user('A', false, 'Player_One'), await t.user('B', false, 'Player_Two'), await t.user('C', false, 'Outsider')];
    expect(await a.call('pokejam_find_match', ['ranked'])).toBeNull();
    const mid = (await b.call<string | null>('pokejam_find_match', ['ranked']))!;
    const names = await a.call<Record<string, string>>('pokejam_match_usernames', [mid]);
    expect(Object.keys(names).sort()).toEqual(['guest', 'host']);
    expect([names.host, names.guest].sort()).toEqual(['Player_One', 'Player_Two']);
    await expect(c.call('pokejam_match_usernames', [mid])).rejects.toThrow(/not in this match/);
  });
});

describe('client and server filters agree', () => {
  it('the migration seed is generated from the data file', () => {
    const sql = readFileSync(MIGRATION, 'utf8');
    expect(withSeed(sql, data)).toBe(sql);
  });

  it('the seeded table equals the client lists', async () => {
    const t = await testDb();
    const rows = await t.sql('select kind, term from public.pokejam_name_blocklist order by kind, term');
    const by = (k: string) => rows.filter((r) => r.kind === k).map((r) => r.term as string).sort();
    expect(by('severe')).toEqual(FILTER.severe);
    expect(by('mild')).toEqual(FILTER.mild);
    expect(by('allow')).toEqual(FILTER.allow);
    expect(by('reserved')).toEqual(FILTER.reserved);
    expect(by('impersonation')).toEqual(FILTER.impersonation);
    expect(by('impersonation_allow')).toEqual(FILTER.impersonationAllow);
  });

  it('the mild regex matches on both sides', async () => {
    const t = await testDb();
    for (const term of FILTER.mild) {
      expect((await t.sql('select public.pokejam_name_mild_rx($1) as rx', [term]))[0].rx).toBe(mildRegex(term).source);
    }
  });

  it('give the same verdict on a corpus of names', async () => {
    const t = await testDb();
    const names = ['Ash_Ketchum9', 'ab', 'bad name', 'admin', 'Admin_Joe', 'm0d_squad', 'Modern_Art', 'Moody_Blue', 'xXshitXx', 'FUCK_you', 'fuuuck', 'sh1t_lord', 'Sex',
      'Ass', 'Asss', 'ass_man', 'Assassin', 'Analyst', 'Kung_Fu', 'Scunthorpe', 'Penistone', 'Nigeria', 'Dickens', 'Big_Dick', 'p0rn', 'PokeJam_Fan', 'kungfudoom_fan',
      'Null', 'trainer', 'Player', '___', '1234', 'a1b', 'l1l1l1', 'Sup_port', 'Official', 'Stafford', 'Mood', ...data.severe.slice(0, 20), ...data.mild.slice(0, 20),
      ...data.severe.slice(0, 10).map((s) => `x_${s}_1`), ...data.reserved];
    for (const n of names) {
      const server = (await t.sql('select public.pokejam_name_check($1) as r', [n]))[0].r ?? null;
      expect(server, n).toBe(checkUsername(n));
    }
  });
});
