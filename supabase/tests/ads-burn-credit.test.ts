// Burn credit (20261205_pokejam_ads_burn_credit.sql) on a real Postgres (PGlite) running every migration in order.
// What's promised: a burn below the price is never wasted (it becomes credit for the wallet that made it) and never buys
// airtime (no pro-rated or partial slot); credit plus a new burn completes a full booking; and a signature counts once,
// ever, across burns, credit, USDC payments and intents, even when asked for at the same moment.
//
// The function takes the burner the Edge Function has already verified (finalized, mint, decimals, age, signer and owner
// of the account: verify.test.ts and handler.test.ts cover that side), so "wrong wallet" here is about whose credit it is.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { testDb } from './testDb';

vi.setConfig({ testTimeout: 120_000 });

const WALLET = '9wqysMYY4DTcbPjSZpGQU3pF29YUw9w6A1a8XDKVhezh';
const OTHER = 'A4ahkivAG4NoZAE8Sy4qv8nn2DU9yoXRQcttuCeGtTJv';
const RECEIVER = 'FPwoDYkHTFef4Fg45o1wzReXiVoYGP6KXEgRyfqqBpyk';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const HOUR = 100_000_000_000n;
const H = 3_600_000;

interface Ad { id: string; state: string; price: string; starts_at: string | null; ends_at: string | null; burn_sig: string | null; extra_of: string | null }

async function setup() {
  const t = await testDb();
  let n = 0;
  const fn = async <T>(name: string, args: unknown[] = []) =>
    (await t.service(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args))[0].r as T;
  const create = (plan = 'hour', wallet = WALLET) => fn<Ad>('pokejam_live_ad_create', [wallet, 'BUY MORE POTIONS', 'gold', plan, null, null, null]);
  const pay = (ad: Ad, burned: bigint | string, sig = `burn${++n}`) => fn<Ad>('pokejam_live_ad_pay', [ad.id, sig, String(burned), ad.price ? WALLET : WALLET]);
  const credit = (wallet = WALLET) => fn<string>('pokejam_live_ad_credit', [wallet]);
  const board = () => fn<{ live: unknown[] }>('pokejam_live_ad_board');
  let refN = 0;
  const intent = (wallet = WALLET) => fn<{ id: string; amount: string }>('pokejam_live_ad_usdc_intent',
    [wallet, 'USDC AD', 'fire', 'week', null, String(++refN).replace(/0/g, 'z').padStart(40, 'R'), `pokejam-ad-usdc:${++n}abcdef`, RECEIVER, USDC, 'mainnet-beta', null]);
  const usdcPay = (i: { id: string; amount: string }, sig: string) => fn<{ status: string }>('pokejam_live_ad_usdc_pay', [i.id, sig, i.amount, WALLET]);
  return { ...t, fn, create, pay, credit, board, intent, usdcPay };
}

describe('a short burn is kept as credit', () => {
  it('records the credit for the booking wallet, books nothing, and shows in its balance', async () => {
    const t = await setup();
    const week = await t.create('week');
    const r = await t.pay(week, BigInt(week.price) / 168n, 'short1');
    expect(r).toMatchObject({ state: 'dust', starts_at: null, ends_at: null, burn_sig: 'short1' });
    expect(await t.credit()).toBe((BigInt(week.price) / 168n).toString());
    expect(await t.credit(OTHER)).toBe('0');
    expect(await t.sql(`select signature, wallet, amount::text as amount, ad_id, used_for from public.pokejam_live_ad_burn_credit`))
      .toEqual([{ signature: 'short1', wallet: WALLET, amount: (BigInt(week.price) / 168n).toString(), ad_id: week.id, used_for: null }]);
    expect((await t.board()).live).toHaveLength(0);
  });

  it('one base unit short is credit, not an hour', async () => {
    const t = await setup();
    const a = await t.create('hour');
    expect((await t.pay(a, HOUR - 1n)).state).toBe('dust');
    expect(await t.credit()).toBe((HOUR - 1n).toString());
    expect((await t.board()).live).toHaveLength(0);
  });

  it('credit alone books nothing: it needs a burn, and a burn of zero is refused', async () => {
    const t = await setup();
    await t.pay(await t.create('hour'), HOUR / 2n);
    const b = await t.create('hour');
    await expect(t.pay(b, 0n)).rejects.toThrow(/nothing was burned/);
    expect((await t.fn<Ad>('pokejam_live_ad_get', [b.id])).state).toBe('pending');
    expect(await t.credit()).toBe((HOUR / 2n).toString());
  });

  it('a short burn on a paid ad (the extra-run path) is credit, with no extra run', async () => {
    const t = await setup();
    const a = await t.pay(await t.create('day'), '1500000000000');
    const r = await t.pay(a, 5n);
    expect(r).toMatchObject({ id: a.id, state: 'paid' });
    expect(await t.credit()).toBe('5');
    expect(await t.sql(`select id from public.pokejam_live_ads where extra_of is not null`)).toHaveLength(0);
  });
});

describe('a top-up completes a booking', () => {
  it('credit + a new burn at least the price books the full plan, and the credit is used up', async () => {
    const t = await setup();
    await t.pay(await t.create('hour'), 40_000_000_000n, 'a1'); // credit 40k
    const b = await t.create('hour');
    const paid = await t.pay(b, 60_000_000_000n, 'a2'); // the top-up: price - credit
    expect(paid).toMatchObject({ id: b.id, state: 'paid', burn_sig: 'a2' });
    expect(Date.parse(paid.ends_at!) - Date.parse(paid.starts_at!)).toBe(H); // the plan, no more, no less
    expect(await t.credit()).toBe('0');
    expect(await t.sql(`select signature, used_for from public.pokejam_live_ad_burn_credit`)).toEqual([{ signature: 'a1', used_for: b.id }]);
    expect(await t.sql(`select credit_used::text as c from public.pokejam_live_ads where id = $1`, [b.id])).toEqual([{ c: '40000000000' }]);
  });

  it('several short burns add up, oldest first, and only as many as needed', async () => {
    const t = await setup();
    for (let i = 0; i < 4; i++) await t.pay(await t.create('hour'), 10_000_000_000n, `c${i}`);
    expect(await t.credit()).toBe('40000000000');
    const b = await t.create('hour');
    const paid = await t.pay(b, 70_000_000_000n, 'top'); // 70 + 10 + 10 + 10 = 100: three rows, the fourth stays
    expect(paid.state).toBe('paid');
    expect(await t.credit()).toBe('10000000000');
    expect((await t.sql(`select signature from public.pokejam_live_ad_burn_credit where used_for is null`))).toEqual([{ signature: 'c3' }]);
  });

  it('credit and a burn that together fall short book nothing, and the new burn is credit too', async () => {
    const t = await setup();
    await t.pay(await t.create('hour'), 30_000_000_000n, 'p1');
    const b = await t.create('hour');
    expect((await t.pay(b, 30_000_000_000n, 'p2')).state).toBe('dust');
    expect(await t.credit()).toBe('60000000000');
    expect((await t.board()).live).toHaveLength(0);
  });

  it('credit that is not needed stays: a full-price burn never touches it', async () => {
    const t = await setup();
    await t.pay(await t.create('hour'), 5n, 'dust1');
    const paid = await t.pay(await t.create('hour'), HOUR, 'full');
    expect(paid.state).toBe('paid');
    expect(await t.credit()).toBe('5');
  });

  it('overpaying keeps the existing rule: burn + credit above the price runs longer at the plan rate', async () => {
    const t = await setup();
    await t.pay(await t.create('hour'), 50_000_000_000n, 'o1');
    const paid = await t.pay(await t.create('hour'), 99_000_000_000n, 'o2'); // 149k in all for a 100k hour
    expect(Date.parse(paid.ends_at!) - Date.parse(paid.starts_at!)).toBe(Math.floor(H * 1.49));
  });

  it('works for an extra run on a paid ad too, at the current price', async () => {
    const t = await setup();
    const a = await t.pay(await t.create('hour'), HOUR, 'first');
    await t.pay(a, 40_000_000_000n, 'e1');
    const extra = await t.pay(a, 60_000_000_000n, 'e2');
    expect(extra).toMatchObject({ state: 'paid', extra_of: a.id });
    expect(await t.credit()).toBe('0');
  });
});

describe('a signature counts once, ever', () => {
  it('a credited burn cannot be credited again, booked as a burn, or used for another booking', async () => {
    const t = await setup();
    const a = await t.create('hour');
    await t.pay(a, HOUR / 2n, 'once');
    // Asking again for the same booking changes nothing.
    expect(await t.pay(a, HOUR / 2n, 'once')).toMatchObject({ id: a.id, state: 'dust' });
    expect(await t.credit()).toBe((HOUR / 2n).toString());
    // The same signature for another booking is refused, short or full.
    const b = await t.create('hour');
    await expect(t.pay(b, HOUR / 2n, 'once')).rejects.toThrow(/burn already used/);
    await expect(t.pay(b, HOUR, 'once')).rejects.toThrow(/burn already used/);
    expect(await t.credit()).toBe((HOUR / 2n).toString());
  });

  it('a short burn on a paid ad, asked for again, is credited once', async () => {
    const t = await setup();
    const a = await t.pay(await t.create('hour'), HOUR, 'x');
    await t.pay(a, 7n, 'short');
    await t.pay(a, 7n, 'short');
    expect(await t.credit()).toBe('7');
    const other = await t.create('hour', OTHER);
    await expect(t.pay(other, HOUR, 'short')).rejects.toThrow(/burn already used/);
  });

  it('a spent credit signature stays spent: it cannot come back as a burn', async () => {
    const t = await setup();
    await t.pay(await t.create('hour'), HOUR / 2n, 'spent');
    await t.pay(await t.create('hour'), HOUR / 2n, 'topup');
    expect(await t.credit()).toBe('0');
    await expect(t.pay(await t.create('hour'), HOUR, 'spent')).rejects.toThrow(/burn already used/);
    expect(await t.credit()).toBe('0');
  });

  it('a signature used as a USDC payment, or sitting in an intent, cannot be credit or a burn', async () => {
    const t = await setup();
    const i = await t.intent();
    expect((await t.usdcPay(i, 'usdcsig')).status).toBe('paid');
    await expect(t.pay(await t.create('hour'), 5n, 'usdcsig')).rejects.toThrow(/burn already used/);
    await expect(t.pay(await t.create('hour'), HOUR, 'usdcsig')).rejects.toThrow(/burn already used/);
    expect(await t.credit()).toBe('0');
  });

  it('a credited signature cannot be a USDC payment', async () => {
    const t = await setup();
    await t.pay(await t.create('hour'), 5n, 'creditsig');
    expect((await t.usdcPay(await t.intent(), 'creditsig')).status).toBe('signature_used');
    expect(await t.sql(`select id from public.pokejam_live_ads where usdc_sig = 'creditsig'`)).toHaveLength(0);
  });

  it('the same short signature asked for at the same moment is credited once', async () => {
    const t = await setup();
    const a = await t.create('hour');
    const b = await t.create('hour');
    const results = await Promise.allSettled([t.pay(a, 10n, 'race'), t.pay(a, 10n, 'race'), t.pay(b, 10n, 'race')]);
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1);
    expect(await t.credit()).toBe('10');
    expect(await t.sql(`select signature from public.pokejam_live_ad_burn_credit`)).toHaveLength(1);
  });

  it('two top-ups racing for the same credit book once; the credit is spent once', async () => {
    const t = await setup();
    await t.pay(await t.create('hour'), HOUR / 2n, 'seed');
    const a = await t.create('hour');
    const b = await t.create('hour');
    // Each burn alone is half the price: only one of them can have the credit.
    const [x, y] = await Promise.all([t.pay(a, HOUR / 2n, 'r1'), t.pay(b, HOUR / 2n, 'r2')]);
    expect([x.state, y.state].sort()).toEqual(['dust', 'paid']);
    expect(await t.credit()).toBe((HOUR / 2n).toString()); // the loser's burn is credit; the seed was spent
    expect(await t.sql(`select count(*)::int as n from public.pokejam_live_ad_burn_credit where used_for is not null`)).toEqual([{ n: 1 }]);
  });

  it('the database refuses a credit signature twice, whatever calls it', async () => {
    const t = await setup();
    const a = await t.create('hour');
    await t.pay(a, 5n, 'dbsig');
    await expect(t.sql(`insert into public.pokejam_live_ad_burn_credit(signature, wallet, amount) values ('dbsig', $1, 5)`, [WALLET])).rejects.toThrow(/unique|duplicate/);
  });
});

describe('credit belongs to one wallet', () => {
  it("one wallet's credit never helps another wallet's booking", async () => {
    const t = await setup();
    await t.pay(await t.create('hour'), HOUR - 1n, 'mine'); // WALLET: one base unit short of an hour
    const theirs = await t.create('hour', OTHER);
    const r = await t.pay(theirs, 1n, 'theirs'); // would complete it if the credit were shared
    expect(r.state).toBe('dust');
    expect(await t.credit(OTHER)).toBe('1');
    expect(await t.credit()).toBe((HOUR - 1n).toString());
    expect((await t.board()).live).toHaveLength(0);
  });

  it('credit is only ever recorded under the booking wallet, whoever the burner column names', async () => {
    const t = await setup();
    const a = await t.create('hour');
    await t.fn('pokejam_live_ad_pay', [a.id, 'delegated', '5', OTHER]);
    expect(await t.credit()).toBe('5');
    expect(await t.credit(OTHER)).toBe('0');
  });

  it('only the service role can read or spend credit', async () => {
    const t = await setup();
    await t.pay(await t.create('hour'), 5n, 'priv');
    for (const role of ['anon', 'authenticated']) {
      const as = t.as(role, null);
      await expect(as('select public.pokejam_live_ad_credit($1)', [WALLET])).rejects.toThrow(/permission denied/);
      await expect(as('select * from public.pokejam_live_ad_burn_credit')).rejects.toThrow(/permission denied/);
      await expect(as(`update public.pokejam_live_ad_burn_credit set used_for = null`)).rejects.toThrow(/permission denied/);
      await expect(as(`insert into public.pokejam_live_ad_burn_credit(signature, wallet, amount) values ('x', '${WALLET}', 1)`)).rejects.toThrow(/permission denied/);
    }
    const [row] = await t.sql(`select relrowsecurity as rls from pg_class where relname = 'pokejam_live_ad_burn_credit'`);
    expect(row.rls).toBe(true);
  });
});

describe('no pro-rated airtime, and the price lock still applies', () => {
  it('no short burn, however split, ever buys a partial slot', async () => {
    const t = await setup();
    const week = await t.create('week');
    // 1/168th of a week's price, then again and again: still only credit while the sum is below the price.
    const part = BigInt(week.price) / 168n;
    for (let i = 0; i < 10; i++) expect((await t.pay(await t.create('week'), part, `p${i}`)).starts_at).toBeNull();
    expect((await t.board()).live).toHaveLength(0);
    expect(await t.credit()).toBe((part * 10n).toString());
  });

  it('a price rise after the credit applies: the old credit does not buy the new price', async () => {
    const t = await setup();
    await t.pay(await t.create('hour'), 60_000_000_000n, 'old'); // credit 60k at a 100k price
    await t.sql(`update public.pokejam_live_ad_plans set amount = 300000 where method = 'burn' and plan = 'hour'`);
    const b = await t.create('hour'); // locked at 300k now
    expect(b.price).toBe('300000000000');
    expect((await t.pay(b, 100_000_000_000n, 'new')).state).toBe('dust'); // 60k + 100k = 160k < 300k
    expect(await t.credit()).toBe('160000000000');
    const c = await t.create('hour');
    expect((await t.pay(c, 140_000_000_000n, 'more')).state).toBe('paid'); // 160k + 140k = 300k
  });

  it('a booking older than a day pays the higher current price, with credit counting toward it', async () => {
    const t = await setup();
    await t.pay(await t.create('hour'), 50_000_000_000n, 'cr');
    const old = await t.create('hour');
    await t.sql(`update public.pokejam_live_ad_plans set amount = 300000 where method = 'burn' and plan = 'hour'`);
    await t.sql(`update public.pokejam_live_ads set created_at = now() - interval '2 days' where id = $1`, [old.id]);
    expect((await t.pay(old, 100_000_000_000n, 'a')).state).toBe('dust'); // locked 100k would be enough; the current 300k is not
    expect((await t.pay(old, 150_000_000_000n, 'b')).state).toBe('paid'); // 50 + 100 + 150 = 300
  });

  it('a price fall after the credit never undercuts the locked price of a fresh booking', async () => {
    const t = await setup();
    const a = await t.create('hour'); // locked 100k
    await t.sql(`update public.pokejam_live_ad_plans set amount = 10 where method = 'burn' and plan = 'hour'`);
    expect((await t.pay(a, 10_000_000n, 'cheap')).state).toBe('dust');
  });
});

describe('the migration', () => {
  const SQL = readFileSync(new URL('../migrations/20261205_pokejam_ads_burn_credit.sql', import.meta.url), 'utf8');
  const code = SQL.replace(/--[^\n]*/g, '');

  it('is additive: no drop, truncate, delete or data rewrite, and only live functions', () => {
    expect(code).not.toMatch(/\b(drop|truncate)\b/i);
    expect(code).not.toMatch(/\bdelete\s+from\b/i);
    for (const m of code.matchAll(/\balter\s+\w+\s+[^\n;]*/gi)) {
      expect(m[0]).toMatch(/^alter table public\.pokejam_live_ad\w* (enable row level security|add column if not exists credit_used)/);
    }
    for (const m of code.matchAll(/create\s+or\s+replace\s+function\s+public\.(\w+)/gi)) expect(m[1]).toMatch(/^pokejam_live_ad_/);
    expect(code).toMatch(/create table if not exists public\.pokejam_live_ad_burn_credit/);
  });

  it('runs twice without error and keeps credit', async () => {
    const t = await setup();
    await t.pay(await t.create('hour'), 5n, 'keep');
    await t.db.exec(SQL);
    await t.db.exec(SQL);
    expect(await t.credit()).toBe('5');
  });
});
