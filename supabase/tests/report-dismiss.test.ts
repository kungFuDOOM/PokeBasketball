// Dismiss on the moderation page (migration 20261121): clears a player's open reports without deleting them, and
// dismissed reports no longer count in the Reported list or toward the 5-reporter auto-ban.
import { describe, expect, it, vi } from 'vitest';
import { type Db, type User, testDb } from './testDb';

vi.setConfig({ testTimeout: 30_000 });

/** A new room match between the reported player and a reporter, reported once. */
async function report(t: Db, reported: User, reporter: User, reason = 'name') {
  const code = await reported.call<string>('pokejam_create_room', [120]);
  const mid = await reporter.call<string>('pokejam_join_room', [code]);
  expect(await reporter.call('pokejam_report_player', [mid, reason, null])).toBe(true);
  // a player can only host one open room, so close this one before the next
  await t.sql(`update public.pokejam_matches set status = 'done', finished_at = now() where id = $1`, [mid]);
  return mid;
}

async function withMod(t: Db) {
  const mod = await t.user('Mod');
  await t.sql("insert into public.pokejam_admins(user_id, note) values ($1, 'kungFuDOOM')", [mod.id]);
  return mod;
}

type Row = { user_id: string; reporters: number; reports: number; reasons: Record<string, number>; latest: unknown[] };

describe('pokejam_admin_dismiss', () => {
  it('refuses anyone who is not a moderator', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A'), await t.user('B')];
    await report(t, b, a);
    await expect(a.call('pokejam_admin_dismiss', [b.id])).rejects.toThrow(/moderators only/);
    await expect(t.as('anon', null)('select public.pokejam_admin_dismiss($1)', [b.id])).rejects.toThrow(/permission denied/);
    expect((await t.sql('select dismissed_at from public.pokejam_reports'))[0].dismissed_at).toBeNull();
  });

  it('removes the player from the list, logs it, keeps the rows, and a new report brings them back', async () => {
    const t = await testDb();
    const mod = await withMod(t);
    const troll = await t.user('Trolly');
    const other = await t.user('Other');
    const [v1, v2] = [await t.user('V1'), await t.user('V2')];
    await report(t, troll, v1, 'cheating');
    await report(t, troll, v2);
    await report(t, other, v1);
    expect((await mod.call<Row[]>('pokejam_admin_reports', [7])).map((r) => r.user_id).sort()).toEqual([troll.id, other.id].sort());

    expect(await mod.call('pokejam_admin_dismiss', [troll.id])).toBe(2);
    expect((await mod.call<Row[]>('pokejam_admin_reports', [7])).map((r) => r.user_id)).toEqual([other.id]);

    const log = await mod.call<{ action: string; detail: string; target: string }[]>('pokejam_admin_history', [10]);
    expect(log[0]).toMatchObject({ action: 'dismiss reports', detail: '2', target: 'Trolly' });

    const rows = await t.sql('select reported, dismissed_at, dismissed_by from public.pokejam_reports order by id');
    expect(rows).toHaveLength(3);
    for (const r of rows.filter((r) => r.reported === troll.id)) {
      expect(r.dismissed_at).toBeInstanceOf(Date);
      expect(r.dismissed_by).toBe(mod.id);
    }
    expect(rows.find((r) => r.reported === other.id)).toMatchObject({ dismissed_at: null, dismissed_by: null });

    // nothing open left: a second dismiss clears 0
    expect(await mod.call('pokejam_admin_dismiss', [troll.id])).toBe(0);

    // the same reporter on a new match: back with only the open report counted
    await report(t, troll, v1);
    const back = (await mod.call<Row[]>('pokejam_admin_reports', [7])).find((r) => r.user_id === troll.id)!;
    expect(back).toMatchObject({ reporters: 1, reports: 1, reasons: { name: 1 } });
    expect(back.latest).toHaveLength(1);
  });

  it('dismissed reports do not count toward the auto-ban; five open reporters still ban', async () => {
    const t = await testDb();
    const mod = await withMod(t);
    const troll = await t.user('Troll');
    for (let i = 0; i < 4; i++) await report(t, troll, await t.user(`Victim ${i}`));
    expect(await mod.call('pokejam_admin_dismiss', [troll.id])).toBe(4);
    await report(t, troll, await t.user('Victim 4'));
    expect(await t.sql('select * from public.pokejam_bans where user_id = $1', [troll.id])).toEqual([]);

    for (let i = 5; i < 8; i++) await report(t, troll, await t.user(`Victim ${i}`));
    expect(await t.sql('select * from public.pokejam_bans where user_id = $1', [troll.id])).toEqual([]);
    await report(t, troll, await t.user('Victim 8')); // 5th open reporter
    expect((await t.sql('select auto from public.pokejam_bans where user_id = $1', [troll.id]))[0].auto).toBe(true);
  });
});
