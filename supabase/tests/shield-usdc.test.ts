// Rank Shield USDC (migration 20261119): intents, the idempotent credit by signature and by intent, and the caps that Stripe
// and USDC purchases share (14 held, 42 per season), plus who may call what.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { testDb } from './testDb';

vi.setConfig({ testTimeout: 60_000 });

type Row = Record<string, any>;
const WALLET = '5njibWvkiFg4LSyzq4ySFhyCsFEF4YhTqRLJo8Z9q16p';
const MINT = 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr';

async function usdc() {
  const t = await testDb();
  await t.sql('select public.pokejam_ranked_season()');
  await t.sql(`update public.pokejam_shield_products set active = true, stripe_price_id = 'price_test_' || units`);
  let n = 0;
  const intent = async (u: { id: string }, sku = 'shield_3', o: { anon?: boolean; wallet?: string | null } = {}) => {
    const k = ++n;
    return (await t.service('select public.pokejam_shield_usdc_intent($1, $2, $3, $4, $5, $6, $7, $8, $9) as r',
      [u.id, o.anon ?? false, sku, o.wallet === undefined ? WALLET : o.wallet, `ref${k}`, `pj-memo${k}`, 'Receiver11111111111111111111111111111111', MINT, 'devnet']))[0].r as Row;
  };
  const credit = async (intentId: string, u: { id: string }, sig: string) =>
    (await t.service('select public.pokejam_shield_credit_usdc($1, $2, $3) as r', [intentId, u.id, sig]))[0].r as Row;
  const stripe = async (u: { id: string }, sku = 'shield_14') => {
    const k = ++n;
    return (await t.service('select public.pokejam_shield_credit_purchase($1, $2, $3, 0, $4, 699, $5) as r', [`cs_${k}`, u.id, sku, `pi_${k}`, `evt_${k}`]))[0].r as Row;
  };
  const check = async (u: { id: string }, sku: string) => (await t.service('select public.pokejam_shield_checkout_check($1, $2, false) as r', [u.id, sku]))[0].r as Row;
  const held = async (u: { id: string }) => Number((await t.sql('select count from public.pokejam_shield_inventory where user_id = $1', [u.id]))[0]?.count ?? 0);
  const setHeld = (u: { id: string }, count: number) => t.sql(
    `insert into public.pokejam_shield_inventory(user_id, count) values ($1, $2) on conflict (user_id) do update set count = excluded.count`, [u.id, count]);
  return { t, intent, credit, stripe, check, held, setHeld };
}

describe('products', () => {
  it('carry the USDC price in base units (6 decimals) next to the card price', async () => {
    const s = await usdc();
    const rows = await s.t.sql('select sku, price_cents, usdc_amount from public.pokejam_shield_products order by units');
    expect(rows.map((r) => [r.sku, Number(r.price_cents), Number(r.usdc_amount)])).toEqual([['shield_3', 199, 1990000], ['shield_7', 399, 3990000], ['shield_14', 699, 6990000]]);
    await expect(s.t.sql(`update public.pokejam_shield_products set usdc_amount = 1995000 where sku = 'shield_3'`)).rejects.toThrow(); // not whole cents
    const a = await s.t.user('A');
    const shop = await a.call<Row>('pokejam_shield_shop');
    expect(shop.products.map((p: Row) => p.usdc_amount)).toEqual([1990000, 3990000, 6990000]);
  });
});

describe('intent', () => {
  it('stores the price from the database, the wallet, a 15 minute expiry, and records the checkout attempt', async () => {
    const s = await usdc();
    const a = await s.t.user('A');
    const r = await s.intent(a, 'shield_7');
    expect(r).toMatchObject({ ok: true, sku: 'shield_7', units: 7, amount: 3990000 });
    const row = (await s.t.sql('select *, extract(epoch from expires_at - created_at) as secs from public.pokejam_shield_usdc_intents'))[0];
    expect(row).toMatchObject({ user_id: a.id, wallet: WALLET, status: 'pending', amount: 3990000, mint: MINT, cluster: 'devnet' });
    expect(Number(row.secs)).toBe(900);
    expect(await s.t.sql('select 1 from public.pokejam_shield_checkouts where user_id = $1 and not done', [a.id])).toHaveLength(1);
  });
  it('refuses guests, wallet-less users, unknown skus and a bad cluster, and writes nothing', async () => {
    const s = await usdc();
    const a = await s.t.user('A');
    const g = await s.t.user('G', true);
    expect((await s.intent(g, 'shield_3', { anon: true })).code).toBe('guest');
    expect((await s.intent(a, 'shield_3', { wallet: null })).code).toBe('no_wallet');
    expect((await s.intent(a, 'shield_99')).code).toBe('unknown_sku');
    await s.t.sql(`update public.pokejam_shield_products set active = false where sku = 'shield_14'`);
    expect((await s.intent(a, 'shield_14')).code).toBe('inactive');
    await expect(s.t.service('select public.pokejam_shield_usdc_intent($1, false, $2, $3, $4, $5, $6, $7, $8)', [a.id, 'shield_3', WALLET, 'r', 'm', 'x', MINT, 'mainnet'])).rejects.toThrow();
    expect(await s.t.sql('select 1 from public.pokejam_shield_usdc_intents')).toHaveLength(0);
    expect(await s.t.sql('select 1 from public.pokejam_shield_checkouts')).toHaveLength(0);
  });
  it('rate limits at 5 an hour together with Stripe checkouts', async () => {
    const s = await usdc();
    const a = await s.t.user('A');
    for (let i = 0; i < 3; i++) expect((await s.intent(a)).ok).toBe(true);
    for (let i = 0; i < 2; i++) expect((await s.check(a, 'shield_3')).ok).toBe(true);
    expect((await s.intent(a)).code).toBe('rate_limited');
  });
});

describe('credit', () => {
  it('credits the pack once, marks the intent and its checkout done', async () => {
    const s = await usdc();
    const a = await s.t.user('A');
    const i = await s.intent(a, 'shield_7');
    expect(await s.credit(i.intent_id, a, 'sigA')).toMatchObject({ status: 'credited', credited: 7, short: 0, needs_refund: false });
    expect(await s.held(a)).toBe(7);
    expect((await s.t.sql('select status, signature from public.pokejam_shield_usdc_intents'))[0]).toMatchObject({ status: 'credited', signature: 'sigA' });
    expect(await s.t.sql('select 1 from public.pokejam_shield_checkouts where done')).toHaveLength(1);
    expect((await s.t.sql(`select delta, ref from public.pokejam_shield_ledger where reason = 'purchase'`))[0]).toMatchObject({ delta: 7, ref: 'usdc:sigA' });
  });
  it('is idempotent by signature and by intent', async () => {
    const s = await usdc();
    const a = await s.t.user('A');
    const i1 = await s.intent(a);
    const i2 = await s.intent(a);
    await s.credit(i1.intent_id, a, 'sigA');
    expect(await s.credit(i1.intent_id, a, 'sigA')).toMatchObject({ status: 'duplicate', credited: 3 });
    expect(await s.credit(i1.intent_id, a, 'sigB')).toMatchObject({ status: 'intent_done', credited: 0 });
    expect(await s.credit(i2.intent_id, a, 'sigA')).toMatchObject({ status: 'signature_used', credited: 0 });
    expect(await s.held(a)).toBe(3);
    expect(await s.t.sql(`select 1 from public.pokejam_shield_purchases where rail = 'usdc'`)).toHaveLength(1);
    expect(await s.credit(i2.intent_id, a, 'sigC')).toMatchObject({ status: 'credited' });
    expect(await s.held(a)).toBe(6);
  });
  it('treats a signature the same across players, an unknown intent, and another player\'s intent', async () => {
    const s = await usdc();
    const a = await s.t.user('A');
    const b = await s.t.user('B');
    const ia = await s.intent(a);
    const ib = await s.intent(b);
    expect(await s.credit(ia.intent_id, b, 'sigA')).toMatchObject({ status: 'wrong_user' });
    expect(await s.credit(crypto.randomUUID(), a, 'sigA')).toMatchObject({ status: 'no_intent' });
    await s.credit(ia.intent_id, a, 'sigA');
    expect(await s.credit(ib.intent_id, b, 'sigA')).toMatchObject({ status: 'signature_used' });
    expect(await s.held(b)).toBe(0);
  });
  it('credits up to the hold cap and flags the rest for a manual refund', async () => {
    const s = await usdc();
    const a = await s.t.user('A');
    const i = await s.intent(a, 'shield_7');
    await s.setHeld(a, 10);
    expect(await s.credit(i.intent_id, a, 'sigA')).toMatchObject({ status: 'credited', credited: 4, short: 3, needs_refund: true });
    expect(await s.held(a)).toBe(14);
    expect(await s.credit(i.intent_id, a, 'sigA')).toMatchObject({ status: 'duplicate', credited: 4, short: 3, needs_refund: true });
    expect((await s.t.sql('select needs_refund, credit_short, amount_cents from public.pokejam_shield_purchases'))[0]).toMatchObject({ needs_refund: true, credit_short: 3, amount_cents: 399 });
  });
  it('only changes what it should: the Stripe credit still works and is still idempotent', async () => {
    const s = await usdc();
    const a = await s.t.user('A');
    expect(await s.stripe(a, 'shield_3')).toMatchObject({ status: 'credited', credited: 3 });
    expect((await s.t.sql('select rail, usdc_signature from public.pokejam_shield_purchases'))[0]).toMatchObject({ rail: 'stripe', usdc_signature: null });
    expect(await s.held(a)).toBe(3);
  });
});

describe('caps shared by both rails', () => {
  it('14 held: a USDC intent counts what Stripe credited, and a Stripe checkout counts what USDC credited', async () => {
    const s = await usdc();
    const a = await s.t.user('A');
    await s.stripe(a, 'shield_7'); // 7 held
    expect((await s.intent(a, 'shield_7')).ok).toBe(true);
    expect((await s.intent(a, 'shield_14')).code).toBe('hold_cap');
    const b = await s.t.user('B');
    const i = await s.intent(b, 'shield_7');
    await s.credit(i.intent_id, b, 'sigB');
    await s.credit((await s.intent(b, 'shield_7')).intent_id, b, 'sigB2');
    expect(await s.held(b)).toBe(14);
    expect((await s.check(b, 'shield_3')).code).toBe('hold_cap');
    expect((await s.intent(b, 'shield_3')).code).toBe('hold_cap');
  });
  it('42 a season: Stripe purchases, USDC purchases and pending USDC intents all count', async () => {
    const s = await usdc();
    const a = await s.t.user('A');
    for (let i = 0; i < 2; i++) { await s.stripe(a, 'shield_14'); await s.setHeld(a, 0); } // 28 bought by card
    const u = await s.intent(a, 'shield_7');
    await s.credit(u.intent_id, a, 'sig1'); // +7 = 35 (credited, so 7 held)
    await s.setHeld(a, 0);
    expect((await s.intent(a, 'shield_14')).code).toBe('season_cap'); // 35 + 14 > 42
    const pending = await s.intent(a, 'shield_7'); // 35 + 7 = 42: ok, now pending
    expect(pending.ok).toBe(true);
    expect((await s.check(a, 'shield_3')).code).toBe('season_cap'); // Stripe sees the pending USDC intent
    expect((await s.intent(a, 'shield_3')).code).toBe('season_cap');
    const shop = await a.call<Row>('pokejam_shield_shop');
    expect(shop.purchases_left).toBe(7); // only paid purchases are counted for the display
  });
  it('a refunded Stripe purchase frees season room for USDC', async () => {
    const s = await usdc();
    const a = await s.t.user('A');
    for (let i = 0; i < 3; i++) await s.t.sql(`insert into public.pokejam_shield_purchases(session_id, user_id, sku, units, status) values ($1, $2, 'shield_14', 14, 'paid')`, [`old_${i}`, a.id]);
    expect((await s.intent(a, 'shield_3')).code).toBe('season_cap');
    await s.t.sql(`update public.pokejam_shield_purchases set status = 'refunded' where session_id = 'old_0'`);
    expect((await s.intent(a, 'shield_14')).ok).toBe(true);
  });
});

describe('privileges', () => {
  it('lets only the service role create intents and credit; players cannot read or write the tables', async () => {
    const s = await usdc();
    const a = await s.t.user('A');
    const i = await s.intent(a);
    for (const q of [
      [`select public.pokejam_shield_usdc_intent($1, false, 'shield_3', 'w', 'r', 'm', 'x', 'y', 'devnet')`, [a.id]],
      [`select public.pokejam_shield_credit_usdc($1, $2, 'sig')`, [i.intent_id, a.id]],
      [`select public.pokejam_shield_usdc_intent_get($1, $2)`, [i.intent_id, a.id]],
      [`select public.pokejam_shield_grant('s', $1, 'shield_3', null, 1)`, [a.id]],
      [`select * from public.pokejam_shield_usdc_intents`, []],
      [`update public.pokejam_shield_products set usdc_amount = 10000`, []],
    ] as [string, unknown[]][]) {
      await expect(a.sql(q[0], q[1]), q[0]).rejects.toThrow();
    }
    const anon = s.t.as('anon', null);
    await expect(anon(`select public.pokejam_shield_credit_usdc($1, $2, 'sig')`, [i.intent_id, a.id])).rejects.toThrow();
    expect(await s.held(a)).toBe(0);
  });
  it('reads the intent back only for its owner', async () => {
    const s = await usdc();
    const a = await s.t.user('A');
    const b = await s.t.user('B');
    const i = await s.intent(a);
    const mine = (await s.t.service('select public.pokejam_shield_usdc_intent_get($1, $2) as r', [i.intent_id, a.id]))[0].r as Row;
    expect(mine).toMatchObject({ id: i.intent_id, sku: 'shield_3', amount: 1990000, wallet: WALLET, status: 'pending' });
    expect((await s.t.service('select public.pokejam_shield_usdc_intent_get($1, $2) as r', [i.intent_id, b.id]))[0].r).toBeNull();
  });
});

describe('migration', () => {
  it('applies twice without losing data, idempotency or privileges', async () => {
    const s = await usdc();
    const a = await s.t.user('A');
    const i = await s.intent(a);
    await s.credit(i.intent_id, a, 'sigA');
    await s.t.db.exec(readFileSync(new URL('../migrations/20261119_pokejam_shield_usdc.sql', import.meta.url), 'utf8'));
    expect(await s.held(a)).toBe(3);
    expect(await s.credit(i.intent_id, a, 'sigA')).toMatchObject({ status: 'duplicate', credited: 3 });
    expect((await s.t.sql(`select usdc_amount from public.pokejam_shield_products where sku = 'shield_3'`))[0]).toMatchObject({ usdc_amount: 1990000 });
    await expect(a.sql('select * from public.pokejam_shield_usdc_intents')).rejects.toThrow();
  });
});
