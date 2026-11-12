// Pack Battles money in and out (20261216_pokejam_pack_wallet.sql) on a real Postgres (PGlite) running every
// migration in order: proving a wallet, crediting deposits once, withdrawals (debit first, limits, review, refunds),
// fee revenue, the real-money switch, and who may call what.
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 60_000 });

const DIR = new URL('../migrations/', import.meta.url);
const MIGRATIONS = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort().map((f) => readFileSync(new URL(f, DIR), 'utf8'));
const W1 = '9wqysMYY4DTcbPjSZpGQU3pF29YUw9w6A1a8XDKVhezh';
const W2 = 'A4ahkivAG4NoZAE8Sy4qv8nn2DU9yoXRQcttuCeGtTJv';
const W3 = 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr';
const SIG = (n: number) => `${'5'.repeat(80)}${n}`;

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
  const set = (key: string, value: unknown) => sql('update public.pokejam_config set value = $2 where key = $1', [key, JSON.stringify(value)]);
  const user = async (name = 'Trainer') => {
    const id = crypto.randomUUID();
    await db.query('insert into auth.users(id) values ($1)', [id]);
    await as('authenticated', id)('select public.pokejam_ensure_profile($1)', [name]);
    const call = fn('authenticated', id);
    const balance = async () => Number(await call<number>('pokejam_pack_balance'));
    const fund = (micro: number, ref = crypto.randomUUID()) => service('pokejam_pack_post', [id, micro, 'test', ref, null]);
    /** Prove a wallet the way the Edge Function does once the signature checks out. */
    const link = async (wallet: string) => service<{ wallet: string; withdraw_after: string }>('pokejam_pack_wallet_link',
      [id, wallet, await call<string>('pokejam_pack_wallet_challenge', [wallet])]);
    const lobby = () => call<Record<string, any>>('pokejam_pack_lobby');
    return { id, call, sql: as('authenticated', id), balance, fund, link, lobby };
  };
  await service('pokejam_pack_upsert_machines', [JSON.stringify([
    { code: 'pokemon_25', price_micro: 25_000_000, available: true },
    { code: 'pokemon_50', price_micro: 50_000_000, available: true },
    { code: 'pokemon_100', price_micro: 100_000_000, available: true },
  ])]);
  const deposit = (ref: string, sender: string, amount: number) =>
    service<{ state: string; user: string | null; new: boolean }>('pokejam_pack_record_deposit', [ref, ref.split(':')[0], sender, amount, 1, new Date().toISOString()]);
  return { db, sql, service, set, user, deposit };
}
type Db = Awaited<ReturnType<typeof testDb>>;
type Player = Awaited<ReturnType<Db['user']>>;

/** Skip a player's wallet cooldown, as if it had passed. */
const pastCooldown = (t: Db, p: Player) => t.sql(`update public.pokejam_pack_wallets set withdraw_after = now() - interval '1 second' where user_id = $1`, [p.id]);

describe('proving a wallet', () => {
  it('links the wallet that signed this player\'s one-time message, and only that message', async () => {
    const t = await testDb();
    const a = await t.user('Ash');
    const msg = await a.call<string>('pokejam_pack_wallet_challenge', [W1]);
    expect(msg).toContain(`Wallet: ${W1}`);
    expect(msg).toContain(`Player: ${a.id}`);
    expect(await t.service('pokejam_pack_wallet_challenge_of', [a.id])).toEqual({ wallet: W1, message: msg });
    await expect(t.service('pokejam_pack_wallet_link', [a.id, W1, msg + ' '])).rejects.toThrow(/expired/);
    await expect(t.service('pokejam_pack_wallet_link', [a.id, W2, msg])).rejects.toThrow(/expired/);
    expect(await t.service('pokejam_pack_wallet_link', [a.id, W1, msg])).toMatchObject({ wallet: W1 });
    await expect(t.service('pokejam_pack_wallet_link', [a.id, W1, msg])).rejects.toThrow(/expired/); // one use
    expect((await a.lobby()).wallet).toMatchObject({ address: W1 });
  });

  it('refuses an expired challenge and a wallet another player has proven', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('Ash'), await t.user('Misty')];
    const msg = await a.call<string>('pokejam_pack_wallet_challenge', [W1]);
    await t.sql(`update public.pokejam_pack_wallet_challenges set expires_at = now() - interval '1 second'`);
    await expect(t.service('pokejam_pack_wallet_link', [a.id, W1, msg])).rejects.toThrow(/expired/);
    await a.link(W1);
    await expect(b.call('pokejam_pack_wallet_challenge', [W1])).rejects.toThrow(/already linked to another player/);
    await expect(b.call('pokejam_pack_wallet_challenge', ['not a wallet'])).rejects.toThrow(/not a Solana wallet/);
  });

  it('opens withdrawals at once for a first wallet, and starts a cooldown when the wallet changes', async () => {
    const t = await testDb();
    const a = await t.user();
    await a.fund(50_000_000);
    await a.link(W1);
    expect(await a.call('pokejam_pack_withdraw', [10_000_000])).toMatchObject({ state: 'pending', wallet: W1 });
    const changed = await a.link(W2);
    expect(new Date(changed.withdraw_after).getTime() - Date.now()).toBeGreaterThan(47 * 3600_000);
    await expect(a.call('pokejam_pack_withdraw', [10_000_000])).rejects.toThrow(/wallet changed recently/);
    expect(await t.sql('select old_wallet, new_wallet from public.pokejam_pack_wallet_log where user_id = $1 order by id', [a.id]))
      .toEqual([{ old_wallet: null, new_wallet: W1 }, { old_wallet: W1, new_wallet: W2 }]);
    // The old wallet is free for someone else now; the new one isn't.
    const b = await t.user('Misty');
    await b.link(W1);
    await expect(b.call('pokejam_pack_wallet_challenge', [W2])).rejects.toThrow(/another player/);
  });
});

describe('deposits', () => {
  it('credits a transfer from a proven wallet once, however many times it is seen', async () => {
    const t = await testDb();
    const a = await t.user();
    await a.link(W1);
    expect(await t.deposit(`${SIG(1)}:2`, W1, 20_000_000)).toEqual({ state: 'credited', user: a.id, new: true });
    expect(await t.deposit(`${SIG(1)}:2`, W1, 20_000_000)).toEqual({ state: 'credited', user: a.id, new: false });
    expect(await a.balance()).toBe(20_000_000);
    // Two transfers in one transaction are two deposits.
    await t.deposit(`${SIG(1)}:3`, W1, 5_000_000);
    expect(await a.balance()).toBe(25_000_000);
    // The same transfer can't come back as something else.
    await expect(t.deposit(`${SIG(1)}:2`, W1, 99_000_000)).rejects.toThrow(/different sender or amount/);
    await expect(t.deposit(`${SIG(1)}:2`, W2, 20_000_000)).rejects.toThrow(/different sender or amount/);
    expect(await a.balance()).toBe(25_000_000);
    expect((await a.lobby()).deposits.map((d: { amount: number }) => Number(d.amount)).sort()).toEqual([20_000_000, 5_000_000].sort());
  });

  it('holds a deposit from a wallet nobody proved, for a person to credit once', async () => {
    const t = await testDb();
    const a = await t.user();
    expect(await t.deposit(`${SIG(2)}:0`, W3, 30_000_000)).toMatchObject({ state: 'held', user: null });
    expect(await a.balance()).toBe(0);
    // Linking the wallet afterwards doesn't credit it by itself: a person checks who sent it.
    await a.link(W3);
    expect(await t.deposit(`${SIG(2)}:0`, W3, 30_000_000)).toMatchObject({ state: 'held', new: false });
    expect(await t.service('pokejam_pack_credit_deposit', [`${SIG(2)}:0`, a.id, 'checked on support ticket 12'])).toBe(true);
    expect(await t.service('pokejam_pack_credit_deposit', [`${SIG(2)}:0`, a.id, 'again'])).toBe(false);
    expect(await a.balance()).toBe(30_000_000);
    expect(await t.service<Record<string, number>>('pokejam_pack_health', [3])).toMatchObject({ held_deposits: 0 });
  });

  it('records a deposit under the minimum as dust, without crediting it', async () => {
    const t = await testDb();
    const a = await t.user();
    await a.link(W1);
    expect(await t.deposit(`${SIG(3)}:0`, W1, 999_999)).toMatchObject({ state: 'dust' });
    expect(await a.balance()).toBe(0);
    expect(Number((await t.service<Record<string, number>>('pokejam_pack_health', [3])).held_deposit_amount)).toBe(999_999);
  });

  it('keeps the scan cursor', async () => {
    const t = await testDb();
    expect(await t.service('pokejam_pack_deposit_cursor')).toBeNull();
    await t.service('pokejam_pack_set_deposit_cursor', [SIG(9)]);
    expect(await t.service('pokejam_pack_deposit_cursor')).toBe(SIG(9));
  });
});

describe('withdrawals', () => {
  async function linked(t: Db, balance = 100_000_000) {
    const a = await t.user();
    await a.link(W1);
    if (balance) await a.fund(balance);
    return a;
  }
  const row = async (t: Db, id: string) => (await t.sql('select * from public.pokejam_pack_withdrawals where id = $1', [id]))[0];
  const claim = (t: Db) => t.service<Record<string, unknown>>('pokejam_pack_claim_withdrawals', [5]);

  it('needs a proven wallet and debits the balance before anything is sent', async () => {
    const t = await testDb();
    const a = await t.user();
    await a.fund(50_000_000);
    await expect(a.call('pokejam_pack_withdraw', [10_000_000])).rejects.toThrow(/Link your wallet first/);
    await a.link(W1);
    await expect(a.call('pokejam_pack_withdraw', [4_000_000])).rejects.toThrow(/smallest withdrawal is \$5/);
    await expect(a.call('pokejam_pack_withdraw', [60_000_000])).rejects.toThrow(/insufficient balance/);
    expect(await t.sql('select * from public.pokejam_pack_withdrawals')).toEqual([]); // the refused one left nothing behind
    const w = await a.call<{ id: string; state: string }>('pokejam_pack_withdraw', [20_000_000]);
    expect(w.state).toBe('pending');
    expect(await a.balance()).toBe(30_000_000);
    expect(Number((await t.service<Record<string, number>>('pokejam_pack_health', [3])).unsent_withdrawals)).toBe(20_000_000);
  });

  it('keeps to the daily limit and sends large ones to a person first', async () => {
    const t = await testDb();
    const a = await linked(t, 900_000_000);
    expect(await a.call('pokejam_pack_withdraw', [300_000_000])).toMatchObject({ state: 'review' });
    expect(await a.call('pokejam_pack_withdraw', [200_000_000])).toMatchObject({ state: 'pending' });
    await expect(a.call('pokejam_pack_withdraw', [5_000_000])).rejects.toThrow(/daily withdrawal limit: \$0 left/);
    // Reviewed: one approved, which the worker can now claim; the other rejected and credited back once.
    const [big] = await t.sql(`select id from public.pokejam_pack_withdrawals where state = 'review'`);
    expect(await t.service('pokejam_pack_review_withdrawal', [big.id, false, 'not the usual pattern'])).toBe('refunded');
    expect(await t.service('pokejam_pack_review_withdrawal', [big.id, true, 'changed my mind'])).toBe('refunded');
    expect(await a.balance()).toBe(900_000_000 - 200_000_000);
    // A refunded withdrawal no longer counts toward the limit.
    expect(await a.call('pokejam_pack_withdraw', [250_000_000])).toMatchObject({ state: 'pending' });
  });

  it('records the transaction before it is sent, once, and marks it sent', async () => {
    const t = await testDb();
    const a = await linked(t);
    const { id } = await a.call<{ id: string }>('pokejam_pack_withdraw', [10_000_000]);
    const claimed = await t.sql(`select (public.pokejam_pack_claim_withdrawals(5)).*`);
    expect(claimed.map((r) => r.id)).toEqual([id]);
    expect(await t.sql(`select (public.pokejam_pack_claim_withdrawals(5)).*`)).toEqual([]); // claimed once
    expect(await t.service('pokejam_pack_withdraw_check', [10_000_000])).toBeNull();
    expect(await t.service('pokejam_pack_withdrawal_submitting', [id, SIG(5), 'hash'])).toBe(true);
    expect(await t.service('pokejam_pack_withdrawal_submitting', [id, SIG(6), 'hash'])).toBe(false);
    await expect(t.service('pokejam_pack_withdrawal_refund', [id, 'x'])).rejects.toThrow(/transaction in flight/);
    await t.service('pokejam_pack_withdrawal_sent', [id, SIG(5)]);
    expect(await row(t, id)).toMatchObject({ state: 'sent', txid: SIG(5) });
    await expect(t.service('pokejam_pack_withdrawal_refund', [id, 'x'])).rejects.toThrow(/was sent/);
    expect(Number((await t.service<Record<string, number>>('pokejam_pack_health', [3])).unsent_withdrawals)).toBe(0);
  });

  it('retries a failed send, then credits it back exactly once', async () => {
    const t = await testDb();
    const a = await linked(t);
    const { id } = await a.call<{ id: string }>('pokejam_pack_withdraw', [10_000_000]);
    for (const expected of ['pending', 'pending', 'refunded']) {
      await t.sql(`update public.pokejam_pack_withdrawals set next_try_at = now() where id = $1`, [id]);
      await claim(t);
      expect(await t.service('pokejam_pack_withdrawal_failed', [id, 'RPC refused it', 3])).toBe(expected);
    }
    expect(await t.service('pokejam_pack_withdrawal_failed', [id, 'again', 3])).toBeNull();
    expect(await a.balance()).toBe(100_000_000);
    expect(await t.sql(`select delta from public.pokejam_pack_ledger where kind = 'withdrawal-refund'`)).toEqual([{ delta: 10_000_000 }]);
  });

  it('holds without using an attempt, and recovers a send stuck after a crash', async () => {
    const t = await testDb();
    const a = await linked(t);
    const { id } = await a.call<{ id: string }>('pokejam_pack_withdraw', [10_000_000]);
    await claim(t);
    await t.service('pokejam_pack_withdrawal_held', [id, 'house is short of SOL', 600]);
    expect(await row(t, id)).toMatchObject({ state: 'pending', attempts: 0, last_error: 'house is short of SOL' });
    await t.sql(`update public.pokejam_pack_withdrawals set next_try_at = now() where id = $1`, [id]);
    await claim(t);
    await t.service('pokejam_pack_withdrawal_submitting', [id, SIG(7), 'hash']);
    await t.sql(`update public.pokejam_pack_withdrawals set updated_at = now() - interval '11 minutes' where id = $1`, [id]);
    const again = await t.sql(`select (public.pokejam_pack_claim_withdrawals(5)).*`);
    expect(again).toMatchObject([{ id, txid: SIG(7) }]); // back, with its transaction, to settle from the chain
  });

  it('stops for the kill switches and the house daily cap', async () => {
    const t = await testDb();
    const a = await linked(t);
    await t.set('pack_withdrawals_paused', true);
    await expect(a.call('pokejam_pack_withdraw', [10_000_000])).rejects.toThrow(/Withdrawals are paused/);
    expect(await t.service('pokejam_pack_withdraw_check', [1])).toBe('withdrawals are paused');
    await t.set('pack_withdrawals_paused', false);
    await t.set('pack_payouts_paused', true);
    await expect(a.call('pokejam_pack_withdraw', [10_000_000])).rejects.toThrow(/Withdrawals are paused/);
    await t.set('pack_payouts_paused', false);
    await t.set('pack_withdraw_house_daily_cap', '15000000');
    const { id } = await a.call<{ id: string }>('pokejam_pack_withdraw', [10_000_000]);
    await claim(t);
    await t.service('pokejam_pack_withdrawal_submitting', [id, SIG(8), 'hash']);
    expect(await t.service('pokejam_pack_withdraw_check', [10_000_000])).toMatch(/house daily withdrawal cap/);
    expect(await t.service('pokejam_pack_withdraw_check', [5_000_000])).toBeNull();
  });
});

describe('fees and real money', () => {
  const find = (p: Player, wallet = W1) => p.call<string | null>('pokejam_pack_find', ['pokemon_25', wallet, false]);

  it('books a won battle\'s fee as house revenue, and none for a battle with no winner', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('Ash'), await t.user('Misty')];
    for (const p of [a, b]) await p.fund(100_000_000);
    await find(a);
    const won = (await find(b))!;
    await t.service('pokejam_pack_settle', [won, 'host', 'final', '']);
    await find(a);
    const tie = (await find(b))!;
    await t.service('pokejam_pack_settle', [tie, 'void', 'tie', '']);
    expect(await t.sql('select match_id, fee from public.pokejam_pack_revenue')).toEqual([{ match_id: won, fee: 1_250_000 }]);
    expect(Number((await t.service<Record<string, number>>('pokejam_pack_health', [3])).fee_revenue)).toBe(1_250_000);
  });

  it('with real money: no test credits, and a card only goes to the proven wallet', async () => {
    const t = await testDb();
    const a = await t.user();
    await t.set('pack_test_credits', true);
    expect(Number(await a.call('pokejam_pack_test_credit'))).toBe(100_000_000);
    await t.set('pack_real_money', true);
    expect(await a.lobby()).toMatchObject({ real_money: true, test_credits: false });
    await expect(a.call('pokejam_pack_test_credit')).rejects.toThrow(/Test credits are off/);
    await expect(find(a)).rejects.toThrow(/Link your wallet first/);
    await a.link(W2);
    expect(await find(a, W1)).toBeNull(); // whatever the page sends, the entry uses the proven wallet
    expect(await t.sql('select wallet from public.pokejam_pack_entries where user_id = $1', [a.id])).toEqual([{ wallet: W2 }]);
    expect(await t.service<Record<string, boolean>>('pokejam_pack_health', [3])).toMatchObject({ real_money: true, test_credits: true });
  });
});

describe('who may call what', () => {
  it('keeps every money move on the service role, and every table private', async () => {
    const t = await testDb();
    const a = await t.user();
    await a.link(W1);
    for (const [name, args] of [
      ['pokejam_pack_wallet_link', [a.id, W2, 'x']], ['pokejam_pack_wallet_challenge_of', [a.id]], ['pokejam_pack_wallet_of', [a.id]],
      ['pokejam_pack_record_deposit', [`${SIG(1)}:0`, SIG(1), W1, 5_000_000, 1, null]], ['pokejam_pack_credit_deposit', [`${SIG(1)}:0`, a.id, null]],
      ['pokejam_pack_set_deposit_cursor', [SIG(1)]], ['pokejam_pack_claim_withdrawals', [5]], ['pokejam_pack_withdrawal_sent', [crypto.randomUUID(), SIG(1)]],
      ['pokejam_pack_withdrawal_refund', [crypto.randomUUID(), 'x']], ['pokejam_pack_review_withdrawal', [crypto.randomUUID(), true, null]],
      ['pokejam_pack_withdrawal_failed', [crypto.randomUUID(), 'x', 3]], ['pokejam_pack_health', [3]],
    ] as [string, unknown[]][]) {
      await expect(a.call(name, args), name).rejects.toThrow(/permission denied/);
    }
    for (const table of ['pokejam_pack_wallets', 'pokejam_pack_wallet_challenges', 'pokejam_pack_deposits', 'pokejam_pack_withdrawals', 'pokejam_pack_revenue']) {
      await expect(a.sql(`select * from public.${table}`), table).rejects.toThrow(/permission denied/);
    }
    const anon = async (q: string) => (await t.db.transaction(async (tx) => { await tx.exec('set local role anon'); return tx.query(q); })).rows;
    await expect(anon(`select public.pokejam_pack_withdraw(5000000)`)).rejects.toThrow(/permission denied/);
  });
});
