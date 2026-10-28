// A new search never hands back a match the player already opened and left (migration 20261107).
import { describe, expect, it, vi } from 'vitest';
import { quickPair, testDb, type Db, type User } from './testDb';

vi.setConfig({ testTimeout: 30_000 });

const statusOf = async (t: Db, mid: string) => (await t.sql('select status from public.pokejam_matches where id = $1', [mid]))[0].status;
const queueRows = async (t: Db) => Number((await t.sql('select count(*)::int as n from public.pokejam_queue'))[0].n);
/** Both players open the draft, as the clients do right after pairing. */
async function openDraft(a: User, b: User, mid: string) {
  await a.call('pokejam_draft_state', [mid]);
  await b.call('pokejam_draft_state', [mid]);
}
/** Pretends a player's last sign of life was `seconds` ago. */
const age = (t: Db, mid: string, seconds: number) =>
  t.sql(`update public.pokejam_drafts set host_seen = now() - make_interval(secs => $2), guest_seen = now() - make_interval(secs => $2),
         created_at = now() - make_interval(secs => $2) where match_id = $1`, [mid, seconds]);

describe('pokejam_find_match after an abandoned match', () => {
  it('gives a fresh match with a fresh opponent, never the dead one, and voids the dead one', async () => {
    const t = await testDb();
    const [a, b, c, d] = [await t.user('A'), await t.user('B'), await t.user('C'), await t.user('D')];
    const dead = await quickPair(t, a, b);
    await openDraft(a, b, dead);
    await age(t, dead, 30); // A's tab dies; B is still there
    expect(await a.call('pokejam_find_match', ['social'])).toBeNull(); // not the dead match
    expect(await statusOf(t, dead)).toBe('void'); // B will see "Opponent left"
    expect(await c.call('pokejam_find_match', ['social'])).toBeTruthy(); // C pairs with A
    const fresh = await a.call<string>('pokejam_find_match', ['social']);
    expect(fresh).toBeTruthy();
    expect(fresh).not.toBe(dead);
    const info = await a.call<Record<string, string>>('pokejam_match_info', [fresh]);
    expect([info.host, info.guest].sort()).toEqual([a.id, c.id].sort());
    expect(await queueRows(t)).toBe(0);
    expect(await d.call('pokejam_find_match', ['social'])).toBeNull(); // D is untouched and just waits
  });

  it('voids the dead match even when the requeue comes while the pairing is the only active one', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A'), await t.user('B')];
    const dead = await quickPair(t, a, b);
    await openDraft(a, b, dead);
    await age(t, dead, 60);
    // B (still alive) searches too: he left the game as well, so he is not handed it either.
    expect(await b.call('pokejam_find_match', ['social'])).toBeNull();
    expect(await a.call<string>('pokejam_find_match', ['social'])).not.toBe(dead);
    expect(await statusOf(t, dead)).toBe('void');
  });

  it('counts a game heartbeat as the player\'s sign of life', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A'), await t.user('B')];
    const dead = await quickPair(t, a, b);
    await openDraft(a, b, dead);
    await age(t, dead, 120);
    await a.call('pokejam_match_alive', [dead]);
    await a.call('pokejam_find_match', ['social']);
    expect(await statusOf(t, dead)).toBe('active'); // beat just now: inside the 10 s margin
    await t.sql('update public.pokejam_matches set host_alive = now() - interval \'1 minute\', guest_alive = now() - interval \'1 minute\' where id = $1', [dead]);
    await a.call('pokejam_find_match', ['social']);
    expect(await statusOf(t, dead)).toBe('void');
  });

  it('keeps the margin: a player who opened the match seconds ago does not void it, nor get it back', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A'), await t.user('B')];
    const mid = await quickPair(t, a, b);
    await openDraft(a, b, mid);
    expect(await a.call('pokejam_find_match', ['social'])).toBeNull(); // a late retried poll
    expect(await statusOf(t, mid)).toBe('active');
  });

  it('still hands a fresh pairing to the player who was waiting in the queue', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A'), await t.user('B')];
    expect(await a.call('pokejam_find_match', ['social'])).toBeNull();
    const mid = await b.call<string>('pokejam_find_match', ['social']);
    expect(await a.call('pokejam_find_match', ['social'])).toBe(mid);
    expect(await a.call('pokejam_find_match', ['social'])).toBe(mid); // a retried poll gets it again
    expect(await queueRows(t)).toBe(0);
    expect(await statusOf(t, mid)).toBe('active');
  });

  it('leaves other players\' matches alone, including old-client ones with no heartbeat or draft', async () => {
    const t = await testDb();
    const [a, b, c, d, e, f] = [await t.user('A'), await t.user('B'), await t.user('C'), await t.user('D'), await t.user('E'), await t.user('F')];
    const live = await quickPair(t, c, d); // draft opened, heartbeat columns null (older client)
    await openDraft(c, d, live);
    await age(t, live, 600);
    const old = await quickPair(t, e, f); // never opened: no draft row at all
    const dead = await quickPair(t, a, b);
    await openDraft(a, b, dead);
    await age(t, dead, 30);
    await a.call('pokejam_find_match', ['social']);
    expect(await statusOf(t, dead)).toBe('void');
    expect(await statusOf(t, live)).toBe('active');
    expect(await statusOf(t, old)).toBe('active');
    expect(await queueRows(t)).toBe(1); // only A, searching
    await a.call('pokejam_leave_queue');
    expect(await queueRows(t)).toBe(0);
  });

  it('does not touch a finished match and leaves Ranked matches alone', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A'), await t.user('B')];
    expect(await a.call('pokejam_find_match', ['ranked'])).toBeNull();
    const rk = await b.call<string>('pokejam_find_match', ['ranked']);
    expect(rk).toBeTruthy();
    await a.call('pokejam_find_match', ['social']);
    expect(await statusOf(t, rk)).toBe('active');
  });
});
