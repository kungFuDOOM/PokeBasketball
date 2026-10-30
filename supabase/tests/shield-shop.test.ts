// Rank Shield shop (migration 20261118): the checkout check, the idempotent credit, refund/dispute revokes, and who may call what.
import { describe, expect, it, vi } from 'vitest';
import { testDb, type User } from './testDb';

vi.setConfig({ testTimeout: 60_000 });

type Row = Record<string, unknown>;
type R = { status: string; credited: number; removed: number; short: number };

async function shop() {
  const t = await testDb();
  await t.sql('select public.pokejam_ranked_season()'); // open the season first, so purchases made after it count toward it
  await t.sql(`update public.pokejam_shield_products set active = true, stripe_price_id = 'price_test_' || units`);
  const check = async (u: { id: string }, sku: string, anon = false) =>
    (await t.service('select public.pokejam_shield_checkout_check($1, $2, $3) as r', [u.id, sku, anon]))[0].r as Row;
  let n = 0;
  const credit = async (u: { id: string }, sku = 'shield_3', o: { session?: string; event?: string; pi?: string } = {}) => {
    const k = ++n;
    return (await t.service('select public.pokejam_shield_credit_purchase($1, $2, $3, $4, $5, $6, $7) as r',
      [o.session ?? `cs_${k}`, u.id, sku, 999, o.pi ?? `pi_${k}`, 199, o.event ?? `evt_${k}`]))[0].r as R;
  };
  const revoke = async (pi: string, reason: 'refund' | 'dispute', event: string) =>
    (await t.service('select public.pokejam_shield_revoke($1, $2, $3) as r', [pi, reason, event]))[0].r as R;
  const held = async (u: { id: string }) => Number((await t.sql('select count from public.pokejam_shield_inventory where user_id = $1', [u.id]))[0]?.count ?? 0);
  const setHeld = (u: { id: string }, count: number) => t.sql(
    `insert into public.pokejam_shield_inventory(user_id, count) values ($1, $2) on conflict (user_id) do update set count = excluded.count`, [u.id, count]);
  const purchase = async (session: string) => (await t.sql('select * from public.pokejam_shield_purchases where session_id = $1', [session]))[0] as Row;
  return { t, check, credit, revoke, held, setHeld, purchase };
}
const code = (r: Row) => (r.ok ? 'ok' : r.code);

describe('checkout check', () => {
  it('passes a signed-in user and returns the price id and units from the database', async () => {
    const s = await shop();
    const a = await s.t.user('A');
    expect(await s.check(a, 'shield_7')).toMatchObject({ ok: true, sku: 'shield_7', units: 7, price_cents: 399, stripe_price_id: 'price_test_7' });
  });

  it('refuses guests, unknown skus, inactive skus and a user with no profile', async () => {
    const s = await shop();
    const a = await s.t.user('A');
    const g = await s.t.user('G', true);
    expect(code(await s.check(g, 'shield_3', true))).toBe('guest');
    expect(code(await s.check({ id: crypto.randomUUID() }, 'shield_3'))).toBe('guest');
    expect(code(await s.check(a, 'shield_99'))).toBe('unknown_sku');
    expect(code(await s.check(a, "shield_3' or 1=1"))).toBe('unknown_sku');
    await s.t.sql(`update public.pokejam_shield_products set active = false where sku = 'shield_14'`);
    expect(code(await s.check(a, 'shield_14'))).toBe('inactive');
  });

  it('holds at most 14: held + units must fit', async () => {
    const s = await shop();
    const a = await s.t.user('A');
    await s.setHeld(a, 11);
    expect(code(await s.check(a, 'shield_3'))).toBe('ok');
    await s.setHeld(a, 12);
    expect(code(await s.check(a, 'shield_3'))).toBe('hold_cap');
    await s.setHeld(a, 8);
    expect(code(await s.check(a, 'shield_7'))).toBe('hold_cap');
    await s.setHeld(a, 7);
    expect(code(await s.check(a, 'shield_7'))).toBe('ok');
  });

  it('caps purchases at 42 per season, counting checkouts still pending', async () => {
    const s = await shop();
    const a = await s.t.user('A');
    for (let i = 0; i < 3; i++) await s.t.sql(`insert into public.pokejam_shield_purchases(session_id, user_id, sku, units, status) values ($1, $2, 'shield_14', 14, 'paid')`, [`old_${i}`, a.id]);
    expect(code(await s.check(a, 'shield_3'))).toBe('season_cap'); // 42 bought
    // a refunded purchase frees its units
    await s.t.sql(`update public.pokejam_shield_purchases set status = 'refunded' where session_id = 'old_0'`);
    expect(code(await s.check(a, 'shield_14'))).toBe('ok'); // 28 + 14 = 42, and this one is now pending
    expect(code(await s.check(a, 'shield_3'))).toBe('season_cap'); // 28 + 14 pending + 3 > 42
    expect((await s.t.user('B')).id).not.toBe(a.id);
    const shopInfo = await a.call<Row>('pokejam_shield_shop');
    expect(shopInfo.purchases_left).toBe(14);
  });

  it('allows 5 checkouts per user per hour and the 6th is rate limited', async () => {
    const s = await shop();
    const a = await s.t.user('A');
    const b = await s.t.user('B');
    for (let i = 0; i < 5; i++) expect(code(await s.check(a, 'shield_3'))).toBe('ok');
    expect(code(await s.check(a, 'shield_3'))).toBe('rate_limited');
    expect(code(await s.check(b, 'shield_3'))).toBe('ok'); // per user
    await s.t.sql(`update public.pokejam_shield_checkouts set created_at = now() - interval '2 hours' where user_id = $1`, [a.id]);
    expect(code(await s.check(a, 'shield_3'))).toBe('ok');
  });

  it('is not callable by players or guests, only by the service role', async () => {
    const s = await shop();
    const a = await s.t.user('A');
    await expect(a.call('pokejam_shield_checkout_check', [a.id, 'shield_3', false])).rejects.toThrow();
    await expect(a.call('pokejam_shield_credit_purchase', ['cs_x', a.id, 'shield_14', 14, 'pi_x', 699, 'evt_x'])).rejects.toThrow();
    await expect(a.call('pokejam_shield_revoke', ['pi_x', 'refund', 'evt_y'])).rejects.toThrow();
    expect(await s.held(a)).toBe(0);
  });
});

describe('credit', () => {
  it('credits the product units once and writes the purchase and ledger rows', async () => {
    const s = await shop();
    const a = await s.t.user('A');
    expect(await s.credit(a, 'shield_7', { session: 'cs_a', event: 'evt_a' })).toMatchObject({ status: 'credited', credited: 7, short: 0 });
    expect(await s.held(a)).toBe(7); // the caller's 999 units were ignored
    expect(await s.purchase('cs_a')).toMatchObject({ units: 7, credited_units: 7, status: 'paid', needs_refund: false });
    expect(await s.t.sql(`select delta from public.pokejam_shield_ledger where user_id = $1 and reason = 'purchase' and ref = 'cs_a'`, [a.id])).toEqual([{ delta: 7 }]);
  });

  it('the same event replayed credits once, and a different event for the same session credits once', async () => {
    const s = await shop();
    const a = await s.t.user('A');
    await s.credit(a, 'shield_3', { session: 'cs_a', event: 'evt_1', pi: 'pi_a' });
    expect((await s.credit(a, 'shield_3', { session: 'cs_a', event: 'evt_1', pi: 'pi_a' })).status).toBe('duplicate_event');
    expect((await s.credit(a, 'shield_3', { session: 'cs_a', event: 'evt_2', pi: 'pi_a' })).status).toBe('duplicate_session');
    expect(await s.held(a)).toBe(3);
    expect(await s.t.sql('select count(*)::int as n from public.pokejam_shield_ledger where user_id = $1', [a.id])).toEqual([{ n: 1 }]);
  });

  it('credits up to the cap of 14 and records the shortfall for a manual refund', async () => {
    const s = await shop();
    const a = await s.t.user('A');
    await s.setHeld(a, 12);
    expect(await s.credit(a, 'shield_7', { session: 'cs_a' })).toMatchObject({ status: 'credited', credited: 2, short: 5 });
    expect(await s.held(a)).toBe(14);
    expect(await s.purchase('cs_a')).toMatchObject({ credited_units: 2, credit_short: 5, needs_refund: true });
    expect(await s.credit(a, 'shield_3', { session: 'cs_b' })).toMatchObject({ credited: 0, short: 3 });
    expect(await s.held(a)).toBe(14);
  });

  it('marks the pending checkout done so it stops counting toward the season cap', async () => {
    const s = await shop();
    const a = await s.t.user('A');
    await s.check(a, 'shield_7');
    await s.credit(a, 'shield_7');
    expect(await s.t.sql('select done from public.pokejam_shield_checkouts where user_id = $1', [a.id])).toEqual([{ done: true }]);
  });

  it('rolls everything back on an error, so the retry credits (unknown sku, missing user)', async () => {
    const s = await shop();
    const a = await s.t.user('A');
    await expect(s.credit(a, 'shield_99', { session: 'cs_a', event: 'evt_a' })).rejects.toThrow(/unknown sku/);
    await expect(s.credit({ id: crypto.randomUUID() }, 'shield_3', { session: 'cs_b', event: 'evt_b' })).rejects.toThrow();
    expect(await s.t.sql(`select count(*)::int as n from public.pokejam_stripe_events`)).toEqual([{ n: 0 }]);
    expect((await s.credit(a, 'shield_3', { session: 'cs_a', event: 'evt_a' })).status).toBe('credited');
  });

  it('the shop info lists active products without Stripe ids', async () => {
    const s = await shop();
    const a = await s.t.user('A');
    await s.t.sql(`update public.pokejam_shield_products set active = false where sku = 'shield_14'`);
    await s.credit(a, 'shield_3');
    const info = await a.call<Row>('pokejam_shield_shop');
    expect(info).toMatchObject({ held: 3, cap: 14, purchases_left: 39, blocked: false });
    expect(info.products).toEqual([{ sku: 'shield_3', units: 3, price_cents: 199, usdc_amount: 1990000 }, { sku: 'shield_7', units: 7, price_cents: 399, usdc_amount: 3990000 }]);
  });
});

describe('revoke', () => {
  it('a refund removes the credited shields once; a replay and a second event change nothing', async () => {
    const s = await shop();
    const a = await s.t.user('A');
    await s.credit(a, 'shield_7', { session: 'cs_a', pi: 'pi_a' });
    expect(await s.revoke('pi_a', 'refund', 'evt_r1')).toMatchObject({ status: 'revoked', removed: 7, short: 0 });
    expect(await s.held(a)).toBe(0);
    expect((await s.revoke('pi_a', 'refund', 'evt_r1')).status).toBe('duplicate_event');
    expect((await s.revoke('pi_a', 'refund', 'evt_r2')).status).toBe('flagged');
    expect(await s.held(a)).toBe(0);
    expect(await s.purchase('cs_a')).toMatchObject({ status: 'refunded', clawback_short: 0 });
    expect(await s.t.sql(`select delta from public.pokejam_shield_ledger where user_id = $1 and reason = 'refund'`, [a.id])).toEqual([{ delta: -7 }]);
    // a refund does not block buying
    expect(code(await s.check(a, 'shield_3'))).toBe('ok');
  });

  it('shields already used can not be recovered: clawback_short is stored and the count never goes below 0', async () => {
    const s = await shop();
    const a = await s.t.user('A');
    await s.credit(a, 'shield_7', { pi: 'pi_a', session: 'cs_a' });
    await s.setHeld(a, 3); // 4 were used
    expect(await s.revoke('pi_a', 'refund', 'evt_r')).toMatchObject({ status: 'revoked', removed: 3, short: 4 });
    expect(await s.held(a)).toBe(0);
    expect(await s.purchase('cs_a')).toMatchObject({ clawback_short: 4 });
    await s.credit(a, 'shield_3', { pi: 'pi_b', session: 'cs_b' });
    await s.setHeld(a, 0);
    expect(await s.revoke('pi_b', 'dispute', 'evt_d')).toMatchObject({ removed: 0, short: 3 });
    expect(await s.held(a)).toBe(0);
  });

  it('a dispute removes the shields, flags the user and blocks further checkouts', async () => {
    const s = await shop();
    const a = await s.t.user('A');
    await s.credit(a, 'shield_3', { pi: 'pi_a', session: 'cs_a' });
    expect(code(await s.check(a, 'shield_3'))).toBe('ok');
    expect(await s.revoke('pi_a', 'dispute', 'evt_d')).toMatchObject({ status: 'revoked', removed: 3 });
    expect(await s.held(a)).toBe(0);
    expect(await s.purchase('cs_a')).toMatchObject({ status: 'disputed' });
    expect(code(await s.check(a, 'shield_3'))).toBe('blocked');
    expect((await a.call<Row>('pokejam_shield_shop')).blocked).toBe(true);
    expect((await s.revoke('pi_a', 'dispute', 'evt_d')).status).toBe('duplicate_event');
  });

  it('a dispute after a refund blocks the user but takes nothing twice', async () => {
    const s = await shop();
    const a = await s.t.user('A');
    await s.credit(a, 'shield_3', { pi: 'pi_a', session: 'cs_a' });
    await s.revoke('pi_a', 'refund', 'evt_r');
    await s.credit(a, 'shield_3', { pi: 'pi_b', session: 'cs_b' });
    expect((await s.revoke('pi_a', 'dispute', 'evt_d')).status).toBe('flagged');
    expect(await s.held(a)).toBe(3); // the second purchase is untouched
    expect(await s.purchase('cs_a')).toMatchObject({ status: 'disputed' });
    expect(code(await s.check(a, 'shield_3'))).toBe('blocked');
  });

  it('an unknown payment intent records nothing, so the webhook can answer 500 and Stripe retries', async () => {
    const s = await shop();
    expect((await s.revoke('pi_nope', 'refund', 'evt_x')).status).toBe('unknown_purchase');
    expect(await s.t.sql(`select count(*)::int as n from public.pokejam_stripe_events`)).toEqual([{ n: 0 }]);
    await expect(s.t.service(`select public.pokejam_shield_revoke('pi_x', 'chargeback', 'e')`)).rejects.toThrow(/bad reason/);
  });
});

describe('access', () => {
  it('players can not read the checkout log, the event log or the flags, nor write purchases', async () => {
    const s = await shop();
    const a = await s.t.user('A');
    await s.credit(a, 'shield_3');
    for (const table of ['pokejam_shield_checkouts', 'pokejam_stripe_events', 'pokejam_shield_flags']) {
      await expect(a.sql(`select * from public.${table}`)).rejects.toThrow();
    }
    await expect(a.sql(`insert into public.pokejam_shield_purchases(session_id, user_id, sku, units) values ('x', $1, 'shield_14', 14)`, [a.id])).rejects.toThrow();
    await expect(a.sql(`update public.pokejam_shield_inventory set count = 14 where user_id = $1`, [a.id])).rejects.toThrow();
    // they see their own purchases only
    const b: User = await s.t.user('B');
    expect((await a.sql('select * from public.pokejam_shield_purchases')).length).toBe(1);
    expect((await b.sql('select * from public.pokejam_shield_purchases')).length).toBe(0);
  });
});
