// Pack Battles (20261212_pokejam_pack_battles.sql) on a real Postgres (PGlite) running every migration in order,
// with stand-ins for Supabase's auth, extensions and Realtime schemas: entries paid from the ledger, pairing, refunds,
// settling a judged battle into a prize (or refunds), and who may call what.
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });

const DIR = new URL('../migrations/', import.meta.url);
const MIGRATIONS = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort().map((f) => readFileSync(new URL(f, DIR), 'utf8'));
const WALLET = '9wqysMYY4DTcbPjSZpGQU3pF29YUw9w6A1a8XDKVhezh';
const STARTER = 'pokemon_25';

async function testDb() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create schema extensions;
    create function extensions.gen_random_bytes(n int) returns bytea language sql volatile as $$
      select decode(string_agg(lpad(to_hex((random() * 255)::int), 2, '0'), ''), 'hex') from generate_series(1, n) $$;
    create schema realtime;
    create table realtime.messages (id serial primary key, topic text not null, extension text not null default 'broadcast', payload jsonb);
    create function realtime.topic() returns text language sql stable as $$ select current_setting('realtime.topic', true) $$;
    alter table realtime.messages enable row level security;
    grant usage on schema realtime to authenticated;
    grant select, insert on realtime.messages to authenticated;
    grant usage on sequence realtime.messages_id_seq to authenticated;
    grant usage on schema auth, extensions to anon, authenticated, service_role;
    grant execute on function extensions.gen_random_bytes(int) to public;
    grant usage on schema public to anon, authenticated, service_role;
  `);
  for (const m of MIGRATIONS) await db.exec(m);
  const as = (role: string, uid: string | null) => async (q: string, params: unknown[] = []) => db.transaction(async (tx) => {
    await tx.exec(`set local role ${role}`);
    if (uid) await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid]);
    return (await tx.query(q, params)).rows as Record<string, unknown>[];
  });
  const fn = (role: string, uid: string | null) => async <T = unknown>(name: string, args: unknown[] = []) =>
    (await as(role, uid)(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args))[0].r as T;
  const sql = async (q: string, p: unknown[] = []) => (await db.query(q, p)).rows as Record<string, unknown>[];
  const service = fn('service_role', null);
  const user = async (name = 'Trainer') => {
    const id = crypto.randomUUID();
    await db.query('insert into auth.users(id) values ($1)', [id]);
    await as('authenticated', id)('select public.pokejam_ensure_profile($1)', [name]);
    const call = fn('authenticated', id);
    const balance = async () => Number(await call<number>('pokejam_pack_balance'));
    const fund = (micro: number, ref = crypto.randomUUID()) => service('pokejam_pack_post', [id, micro, 'test', ref, null]);
    return { id, call, sql: as('authenticated', id), balance, fund };
  };
  // Collector Crypt's machines as the machines function would save them: all three selling at their tier price.
  await service('pokejam_pack_upsert_machines', [JSON.stringify([
    { code: 'pokemon_25', price_micro: 25_000_000, available: true, odds: { common: 0.75, epic: 0.25 }, buyback: 0.85 },
    { code: 'pokemon_50', price_micro: 50_000_000, available: true },
    { code: 'pokemon_100', price_micro: 100_000_000, available: true },
  ])]);
  return { db, sql, service, user };
}
type Db = Awaited<ReturnType<typeof testDb>>;
type Player = Awaited<ReturnType<Db['user']>>;

const ENTRY = 13_125_000; // $12.50 half of the $25 pot + $0.625 half of the 5% fee
const find = (p: Player, tier = STARTER, cash = false) => p.call<string | null>('pokejam_pack_find', [tier, WALLET, cash]);

/** Two funded players paired on the Starter tier. */
async function pair(t: Db, opts: { hostCash?: boolean } = {}) {
  const [a, b] = [await t.user('Ash'), await t.user('Misty')];
  await a.fund(100_000_000);
  await b.fund(100_000_000);
  expect(await find(a, STARTER, opts.hostCash ?? false)).toBeNull();
  const mid = await find(b);
  expect(mid).toBeTruthy();
  return { a, b, mid: mid! };
}

describe('entering a Pack Battle', () => {
  it('takes the entry from the balance at once, and refuses an entry the balance cannot cover', async () => {
    const t = await testDb();
    const a = await t.user();
    await expect(find(a)).rejects.toThrow(/insufficient balance: 0 available, 13125000 needed/);
    expect(await t.sql('select * from public.pokejam_pack_entries')).toEqual([]); // the refused entry left nothing behind
    await a.fund(20_000_000);
    expect(await find(a)).toBeNull();
    expect(await a.balance()).toBe(20_000_000 - ENTRY);
    expect(await find(a)).toBeNull(); // polling again doesn't pay again
    expect(await a.balance()).toBe(20_000_000 - ENTRY);
    await expect(find(a, 'pokemon_50')).rejects.toThrow(/already searching for another pack/);
  });

  it('pairs two players on the same tier into a pack match with a server seed, and holds both entries in the battle', async () => {
    const t = await testDb();
    const { a, b, mid } = await pair(t);
    expect(await find(a)).toBe(mid); // the host's next poll finds the match the guest made
    const m = (await t.sql('select queue, host, guest, seed, quarter_len, status from public.pokejam_matches where id = $1', [mid]))[0];
    expect(m).toMatchObject({ queue: 'pack', host: a.id, guest: b.id, quarter_len: 120, status: 'active' });
    expect(m.seed).not.toBeNull();
    const battle = (await t.sql('select * from public.pokejam_pack_battles where match_id = $1', [mid]))[0];
    expect(battle).toMatchObject({ tier: STARTER, pot: 25_000_000, fee: 1_250_000, state: 'playing' });
    expect(await a.call<Record<string, unknown>>('pokejam_match_info', [mid])).toMatchObject({ queue: 'pack', host_name: 'Ash', guest_name: 'Misty' });
    // Each player sees the battle; nobody else does.
    expect(await a.call<Record<string, unknown>>('pokejam_pack_battle', [mid])).toMatchObject({ state: 'playing', pot: 25_000_000 });
    const c = await t.user('Brock');
    expect(await c.call('pokejam_pack_battle', [mid])).toBeNull();
    expect(await c.sql('select * from public.pokejam_pack_battles')).toEqual([]);
    expect(await c.sql('select * from public.pokejam_pack_entries')).toEqual([]);
  });

  it('never pairs different tiers or blocked players', async () => {
    const t = await testDb();
    const [a, b, c] = [await t.user('A'), await t.user('B'), await t.user('C')];
    for (const p of [a, b, c]) await p.fund(200_000_000);
    expect(await find(a, 'pokemon_25')).toBeNull();
    expect(await find(b, 'pokemon_50')).toBeNull();
    const mid = await find(c, 'pokemon_25');
    expect(mid).toBeTruthy();
    expect((await t.sql('select host from public.pokejam_matches where id = $1', [mid]))[0].host).toBe(a.id);
    // B blocks D: they never meet.
    const d = await t.user('D');
    await d.fund(100_000_000);
    await t.sql('insert into public.pokejam_blocks(user_id, blocked) values ($1, $2)', [b.id, d.id]);
    expect(await find(d, 'pokemon_50')).toBeNull();
  });

  it('cancelling refunds the entry in full, and so does stopping polling', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A'), await t.user('B')];
    await a.fund(50_000_000);
    await b.fund(50_000_000);
    await find(a);
    await a.call('pokejam_pack_leave');
    expect(await a.balance()).toBe(50_000_000);
    await a.call('pokejam_pack_leave'); // nothing to refund twice
    expect(await a.balance()).toBe(50_000_000);
    await find(b);
    await t.sql("update public.pokejam_pack_entries set polled_at = now() - interval '1 minute' where user_id = $1", [b.id]);
    expect(await t.service('pokejam_pack_sweep', [20])).toBe(1);
    expect(await b.balance()).toBe(50_000_000);
    // A stale entry is never paired either: A's new search finds nobody.
    expect(await find(a)).toBeNull();
  });

  it('a paused pack, or paused Pack Battles, takes no new entries', async () => {
    const t = await testDb();
    const a = await t.user();
    await a.fund(100_000_000);
    await t.service('pokejam_pack_upsert_machines', [JSON.stringify([{ code: 'pokemon_25', price_micro: 30_000_000, available: true }])]);
    await expect(find(a)).rejects.toThrow(/paused/);
    await t.service('pokejam_pack_upsert_machines', [JSON.stringify([{ code: 'pokemon_25', price_micro: 25_000_000, available: false, why: 'out of epic cards' }])]);
    await expect(find(a)).rejects.toThrow(/paused right now: out of epic cards/);
    await t.service('pokejam_pack_upsert_machines', [JSON.stringify([{ code: 'pokemon_25', price_micro: 25_000_000, available: true }])]);
    await t.sql("update public.pokejam_config set value = 'true' where key = 'pack_payouts_paused'");
    await expect(find(a)).rejects.toThrow(/Pack Battles are paused/);
    expect(await a.balance()).toBe(100_000_000);
  });
});

describe('settling a judged battle', () => {
  it('a win queues the winner\'s pack for the payout worker, once, with their wallet and prize setting', async () => {
    const t = await testDb();
    const { a, b, mid } = await pair(t, { hostCash: true });
    const r = await t.service<Record<string, unknown>>('pokejam_pack_settle', [mid, 'host', 'final', '41-38 after 30000 ticks.']);
    expect(r.state).toBe('won');
    const prize = (await t.sql('select * from public.pokejam_pack_prizes'))[0];
    expect(prize).toMatchObject({ battle_id: mid, user_id: a.id, wallet: WALLET, tier: STARTER, price_micro: 25_000_000, prefer_cash: true, state: 'pending' });
    // Settling again changes nothing.
    await t.service('pokejam_pack_settle', [mid, 'guest', 'final', 'x']);
    expect(await t.sql('select count(*)::int as n from public.pokejam_pack_prizes')).toEqual([{ n: 1 }]);
    expect((await t.sql('select status, winner from public.pokejam_matches where id = $1', [mid]))[0]).toEqual({ status: 'done', winner: a.id });
    expect(await a.call<Record<string, unknown>>('pokejam_pack_battle', [mid])).toMatchObject({ state: 'won', won: true, prize: { state: 'pending', tier: STARTER } });
    expect(await b.call<Record<string, unknown>>('pokejam_pack_battle', [mid])).toMatchObject({ state: 'won', won: false, prize: null });
    // The loser's entry stays spent; the winner's balance is unchanged (their prize is the pack).
    expect(await a.balance()).toBe(100_000_000 - ENTRY);
    expect(await b.balance()).toBe(100_000_000 - ENTRY);
    // The lobby lists the prize for the winner only.
    expect((await a.call<{ prizes: unknown[] }>('pokejam_pack_lobby')).prizes).toHaveLength(1);
    expect((await b.call<{ prizes: unknown[] }>('pokejam_pack_lobby')).prizes).toHaveLength(0);
  });

  it('no winner refunds both players in full, fee included, exactly once', async () => {
    const t = await testDb();
    const { a, b, mid } = await pair(t);
    await t.service('pokejam_pack_settle', [mid, 'void', 'incomplete', 'stopped at tick 900']);
    await t.service('pokejam_pack_settle', [mid, 'void', 'incomplete', 'again']);
    expect(await a.balance()).toBe(100_000_000);
    expect(await b.balance()).toBe(100_000_000);
    expect(await t.sql('select count(*)::int as n from public.pokejam_pack_prizes')).toEqual([{ n: 0 }]);
    expect((await t.sql('select status from public.pokejam_matches where id = $1', [mid]))[0].status).toBe('void');
  });

  it('unjudgeable evidence holds the battle for a person: nothing moves, and health flags it', async () => {
    const t = await testDb();
    const { a, b, mid } = await pair(t);
    await t.service('pokejam_pack_settle', [mid, 'review', 'invalid', 'a frame nobody signed']);
    expect(await a.balance()).toBe(100_000_000 - ENTRY);
    expect(await b.balance()).toBe(100_000_000 - ENTRY);
    const h = await t.service<Record<string, number>>('pokejam_pack_health', [8]);
    expect(Number(h.parked)).toBe(1);
    // What the house holds for this battle still counts as owed.
    expect(Number(h.unbought_pots)).toBe(26_250_000);
  });

  it('a battle is due to judge once both players upload, or one did 3 minutes ago, or an hour passes', async () => {
    const t = await testDb();
    const { a, b, mid } = await pair(t);
    const due = () => t.service<{ match_id: string; uploads: string[]; host_uploaded: boolean; guest_uploaded: boolean }[]>('pokejam_pack_due_battles', [5]);
    expect(await due()).toEqual([]);
    expect(await a.call('pokejam_submit_evidence', [mid, 'gz1:host'])).toBe(true);
    expect(await due()).toEqual([]);
    await t.sql("update public.pokejam_match_evidence set created_at = now() - interval '4 minutes'");
    // Only the host uploaded: the judge is told so (a player who never uploads, in a game that stopped early, forfeits).
    expect(await due()).toMatchObject([{ match_id: mid, host_uploaded: true, guest_uploaded: false }]);
    await t.sql("update public.pokejam_match_evidence set created_at = now()");
    expect(await b.call('pokejam_submit_evidence', [mid, 'gz1:guest'])).toBe(true);
    const [d] = await due();
    expect(d).toMatchObject({ match_id: mid, host: a.id, guest: b.id, host_name: 'Ash', guest_name: 'Misty', tier: STARTER, host_uploaded: true, guest_uploaded: true });
    expect([...d.uploads].sort()).toEqual(['gz1:guest', 'gz1:host']);
    await t.service('pokejam_pack_settle', [mid, 'void', 'tie', '']);
    expect(await due()).toEqual([]);
  });

  it('keeps Pack Battles uploads (with their connection logs) 90 days, and while a person is still looking', async () => {
    const t = await testDb();
    const { a, mid } = await pair(t);
    expect(await a.call('pokejam_submit_evidence', [mid, 'gz1:host'])).toBe(true);
    await t.service('pokejam_pack_settle', [mid, 'review', 'disconnect', 'both stayed']);
    const old = (days: number) => t.sql(`update public.pokejam_match_evidence set created_at = now() - interval '${days} days'`);
    const left = async () => Number((await t.sql('select count(*) as n from public.pokejam_match_evidence'))[0].n);
    await old(40);
    expect(await t.service('pokejam_prune_evidence', [30])).toBe(0);
    await old(100);
    await t.sql(`update public.pokejam_pack_battles set created_at = now() - interval '100 days'`);
    expect(await t.service('pokejam_prune_evidence', [30])).toBe(0); // still held for a person
    await t.sql(`update public.pokejam_pack_battles set state = 'void'`);
    expect(await left()).toBe(1);
    expect(await t.service('pokejam_prune_evidence', [30])).toBe(1);
    expect(await left()).toBe(0);
  });

  it('health counts waiting entries and battles in play as owed', async () => {
    const t = await testDb();
    const { a } = await pair(t);
    const c = await t.user('C');
    await c.fund(20_000_000);
    await find(c, 'pokemon_100').catch(() => {}); // can't afford Bronze: nothing held
    await find(c);
    const h = await t.service<Record<string, number>>('pokejam_pack_health', [8]);
    expect(Number(h.unbought_pots)).toBe(26_250_000 + ENTRY);
    expect(Number(h.balances)).toBe(2 * (100_000_000 - ENTRY) + 20_000_000 - ENTRY);
    expect(a).toBeTruthy();
  });
});

describe('test credits and permissions', () => {
  it('test credits are off until the test site turns them on, then $100 a day', async () => {
    const t = await testDb();
    const a = await t.user();
    await expect(a.call('pokejam_pack_test_credit')).rejects.toThrow(/Test credits are off/);
    await t.sql("update public.pokejam_config set value = 'true' where key = 'pack_test_credits'");
    expect(Number(await a.call('pokejam_pack_test_credit'))).toBe(100_000_000);
    await expect(a.call('pokejam_pack_test_credit')).rejects.toThrow(/already took today/);
    const lobby = await a.call<{ balance: number; test_credits: boolean; tiers: { code: string; available: boolean; cost: { stake: number; fee: number } }[] }>('pokejam_pack_lobby');
    expect(Number(lobby.balance)).toBe(100_000_000);
    expect(lobby.test_credits).toBe(true);
    expect(lobby.tiers.map((x) => [x.code, x.available, x.cost.stake + x.cost.fee])).toEqual([
      ['pokemon_25', true, 13_125_000], ['pokemon_50', true, 26_250_000], ['pokemon_100', true, 52_500_000]]);
  });

  it('players cannot settle, sweep, see the due list, or post to the ledger', async () => {
    const t = await testDb();
    const { a, mid } = await pair(t);
    await expect(a.call('pokejam_pack_settle', [mid, 'host', 'final', ''])).rejects.toThrow(/permission denied/);
    await expect(a.call('pokejam_pack_due_battles', [5])).rejects.toThrow(/permission denied/);
    await expect(a.call('pokejam_pack_sweep', [5])).rejects.toThrow(/permission denied/);
    await expect(a.call('pokejam_pack_post', [a.id, 5, 'x', 'y', null])).rejects.toThrow(/permission denied/);
    await expect(a.sql("update public.pokejam_pack_battles set state = 'won'")).rejects.toThrow(/permission denied/);
    await expect(a.sql("insert into public.pokejam_pack_entries(user_id, tier, wallet, stake, fee, mmr) values ($1, 'pokemon_25', $2, 1, 0, 1000)", [a.id, WALLET])).rejects.toThrow(/permission denied/);
  });
});
