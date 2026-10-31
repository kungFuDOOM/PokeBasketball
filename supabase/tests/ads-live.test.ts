// Live-site billboard ads (20261125_pokejam_ads_live.sql) on a real Postgres (PGlite) running every migration in order.
// What's promised: the migration is additive (the devnet 20261104 file and its functions are untouched, and devnet and
// mainnet bookings never meet), the live board books by burn exactly like the devnet one, and a USDC payment books
// exactly once per intent and once per signature, never short, never past the text rules.
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 120_000 });

const DIR = new URL('../migrations/', import.meta.url);
const FILES = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort();
const MIGRATIONS = FILES.map((f) => readFileSync(new URL(f, DIR), 'utf8'));
const LIVE_FILE = '20261125_pokejam_ads_live.sql';
const LIVE_SQL = readFileSync(new URL(LIVE_FILE, DIR), 'utf8');
// sha256 of pokejam-test's 20261104_pokejam_ads.sql (commit a67c151), already applied on the shared project.
const DEVNET_SHA256 = 'adf6c2b432673feb800146593f6eeb87567c6a051678521d47a5d3c6a3c04cd0';

const WALLET = '9wqysMYY4DTcbPjSZpGQU3pF29YUw9w6A1a8XDKVhezh';
const OTHER = 'A4ahkivAG4NoZAE8Sy4qv8nn2DU9yoXRQcttuCeGtTJv';
const RECEIVER = 'FPwoDYkHTFef4Fg45o1wzReXiVoYGP6KXEgRyfqqBpyk';
const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const H = 3_600_000;

interface Ad {
  id: string; code: string; state: string; plan: string; hours: number; pay_method: string; price: string; starts_at: string; ends_at: string;
  text: string; theme: string; burn_sig: string | null; usdc_sig: string | null; usdc_paid: string | null; extra_of: string | null; removed_reason: string | null;
}
interface Intent { id: string; plan: string; hours: number; amount: string; text: string; status: string; reference: string; memo: string; signature: string | null; ad_id: string | null; cluster: string; receiver: string; mint: string }
interface PayResult { status: string; ad?: Ad; intent?: Intent }

let refN = 0;
// A distinct base58 string of pubkey length for each intent's reference (base58 has no 0).
const ref = () => String(++refN).replace(/0/g, 'z').padStart(40, 'R');

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
  const as = (role: string, uid: string | null = null) => async <T = unknown>(name: string, args: unknown[] = []) => db.transaction(async (tx) => {
    await tx.exec(`set local role ${role}`);
    if (uid) await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid]);
    return (await tx.query<{ r: T }>(`select public.${name}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args)).rows[0].r;
  });
  const service = as('service_role');
  const sql = async (q: string, p: unknown[] = []) => (await db.query(q, p)).rows as Record<string, unknown>[];
  let n = 0;
  const create = (text = 'BUY MORE POTIONS', plan = 'hour', wallet = WALLET) =>
    service<Ad>('pokejam_live_ad_create', [wallet, text, 'gold', plan, null, null, null]);
  const pay = (ad: Ad, burned: string | bigint = ad.price, sig = `burn${++n}`) => service<Ad>('pokejam_live_ad_pay', [ad.id, sig, String(burned), WALLET]);
  const intent = (text = 'BUY MORE POTIONS', plan = 'week', wallet = WALLET, expect: string | null = null) =>
    service<Intent>('pokejam_live_ad_usdc_intent', [wallet, text, 'fire', plan, null, ref(), `pokejam-ad-usdc:${++n}abcdef`, RECEIVER, USDC, 'mainnet-beta', expect]);
  const usdcPay = (i: Intent, sig = `usdc${++n}`, amount: string = i.amount, payer = WALLET) =>
    service<PayResult>('pokejam_live_ad_usdc_pay', [i.id, sig, amount, payer]);
  return { db, sql, service, as, create, pay, intent, usdcPay };
}

const ms = (iso: string) => new Date(iso).getTime();

describe('the migration is additive', () => {
  it('leaves the applied devnet migration byte-identical to pokejam-test', () => {
    const devnet = readFileSync(new URL('20261104_pokejam_ads.sql', DIR));
    expect(createHash('sha256').update(devnet).digest('hex')).toBe(DEVNET_SHA256);
  });

  it('runs after every earlier migration', () => {
    expect(FILES[FILES.length - 1]).toBe(LIVE_FILE);
  });

  it('drops, alters, truncates and deletes nothing, and redefines none of the devnet functions', () => {
    const code = LIVE_SQL.replace(/--[^\n]*/g, '');
    expect(code).not.toMatch(/\b(drop|truncate)\b/i);
    // The only ALTERs switch on row-level security for its own new tables.
    for (const m of code.matchAll(/\balter\s+\w+\s+[^\n;]*/gi)) expect(m[0]).toMatch(/^alter table public\.pokejam_live_\w+ enable row level security$/);
    expect(code).not.toMatch(/\bdelete\s+from\b/i);
    expect(code).not.toMatch(/\bupdate\s+public\.pokejam_(ads|ad_\w+|config)\b/i);
    // Every function it defines is new: live or admin-live only.
    const defined = [...code.matchAll(/create\s+or\s+replace\s+function\s+public\.(\w+)/gi)].map((m) => m[1]);
    expect(defined.length).toBeGreaterThan(20);
    for (const f of defined) expect(f).toMatch(/^pokejam_(live_ad_|admin_live_ad)/);
    // Its config rows never overwrite an existing key.
    expect(code).toMatch(/on conflict \(key\) do nothing/);
    expect(code).not.toMatch(/on conflict \(key\) do update/);
  });

  it('runs twice without error (safe to re-apply)', async () => {
    const t = await testDb();
    await t.db.exec(LIVE_SQL);
    expect((await t.create()).state).toBe('pending');
  });
});

describe('devnet and mainnet never meet', () => {
  it('keeps live bookings off the devnet board and devnet bookings off the live board', async () => {
    const t = await testDb();
    const live = await t.pay(await t.create('LIVE AD'));
    expect(live.state).toBe('paid');
    const dev = await t.service<{ id: string; price: string }>('pokejam_ad_create', [OTHER, 'TEST AD', 'gold', 'hour', null, null, null]);
    await t.service('pokejam_ad_pay', [dev.id, 'devsig', dev.price, OTHER]);
    const devBoard = await t.service<{ live: { text: string }[]; totals: { ads: number } }>('pokejam_ad_board');
    const liveBoard = await t.service<{ live: { text: string }[]; totals: { ads: number } }>('pokejam_live_ad_board');
    expect(devBoard.live.map((a) => a.text)).toEqual(['TEST AD']);
    expect(liveBoard.live.map((a) => a.text)).toEqual(['LIVE AD']);
    expect(devBoard.totals.ads).toBe(1);
    expect(liveBoard.totals.ads).toBe(1);
    expect(await t.service('pokejam_ad_by_code', [live.code])).toBeNull();
  });

  it('counts live spots apart from devnet spots', async () => {
    const t = await testDb();
    await t.service('pokejam_ad_set_cfg', ['ad_spots', '1']);
    const dev = await t.service<{ id: string; price: string }>('pokejam_ad_create', [OTHER, 'TEST AD', 'gold', 'hour', null, null, null]);
    await t.service('pokejam_ad_pay', [dev.id, 'devsig', dev.price, OTHER]);
    // The devnet board is full (1 spot), the live one isn't.
    const q = await t.service<{ moved: boolean; starts_at: string }>('pokejam_live_ad_quote', ['hour', null, WALLET]);
    expect(q.moved).toBe(false);
  });

  it('reads its settings from live_ keys, so devnet prices and pauses do not reach it', async () => {
    const t = await testDb();
    await t.service('pokejam_ad_set_cfg', ['ad_price_hour', '5']);
    await t.service('pokejam_ad_set_cfg', ['ads_paused', 'true']);
    expect((await t.create()).price).toBe('100000000000');
    await t.service('pokejam_live_ad_set_cfg', ['ad_price_hour', '42000000']);
    expect((await t.create()).price).toBe('42000000');
    expect(String(await t.service('pokejam_ad_price', ['hour']))).toBe('5');
    await t.service('pokejam_live_ad_set_cfg', ['ads_paused', 'true']);
    await expect(t.create()).rejects.toThrow(/paused/);
    expect((await t.sql(`select value #>> '{}' as v from public.pokejam_config where key = 'live_ads_paused'`))[0].v).toBe('true');
  });

  it('keeps the live scan cursor and rate limits apart from devnet', async () => {
    const t = await testDb();
    await t.service('pokejam_ad_set_cfg', ['ad_scan_cursor', 'devsig']);
    expect(await t.service('pokejam_live_ad_cfg', ['ad_scan_cursor', ''])).toBe('');
    for (let i = 0; i < 2; i++) expect(await t.service('pokejam_ad_allow', ['k', 2, 60])).toBe(true);
    expect(await t.service('pokejam_ad_allow', ['k', 2, 60])).toBe(false);
    expect(await t.service('pokejam_live_ad_allow', ['k', 2, 60])).toBe(true);
  });

  it('shares the ban list: a wallet banned on either board is refused on both', async () => {
    const t = await testDb();
    const dev = await t.service<{ id: string; price: string }>('pokejam_ad_create', [WALLET, 'TEST AD', 'gold', 'hour', null, null, null]);
    await t.service('pokejam_ad_pay', [dev.id, 'devsig', dev.price, WALLET]);
    await t.service('pokejam_ad_remove', [dev.id, 'scam', true]);
    await expect(t.create()).rejects.toThrow(/banned/);
    await expect(t.intent()).rejects.toThrow(/banned/);
  });
});

describe('paying by burning $PJAM on the live board', () => {
  it('books, pays and runs like the devnet board', async () => {
    const t = await testDb();
    const a = await t.create('PIKA PIZZA', 'day');
    expect(a).toMatchObject({ state: 'pending', plan: 'day', hours: 24, pay_method: 'burn', price: '1500000000000' });
    const p = await t.pay(a);
    expect(p.state).toBe('paid');
    expect(ms(p.ends_at) - ms(p.starts_at)).toBe(24 * H);
    expect(await t.pay(a, a.price, p.burn_sig!)).toMatchObject({ id: a.id, state: 'paid' });
  });

  it('refuses the month plan (USDC only) and bad text before anything is burned', async () => {
    const t = await testDb();
    await expect(t.create('HI', 'month')).rejects.toThrow(/paid in USDC/);
    await expect(t.create('FREE SOL AIRDROP')).rejects.toThrow(/not allowed \(scam\)/);
  });

  it('a hand-crafted burn naming a USDC-paid ad buys an extra run at the hourly PJAM rate', async () => {
    const t = await testDb();
    const i = await t.intent('USDC AD', 'week');
    const r = await t.usdcPay(i);
    const extra = await t.service<Ad>('pokejam_live_ad_pay', [r.ad!.id, 'craftedburn', '200000000000', WALLET]);
    expect(extra).toMatchObject({ extra_of: r.ad!.id, plan: 'hour', pay_method: 'burn', state: 'paid' });
    expect(ms(extra.ends_at) - ms(extra.starts_at)).toBe(2 * H);
  });
});

describe('paying in USDC', () => {
  it('makes an intent for week ($150) or month ($500), and none for hour or day', async () => {
    const t = await testDb();
    const w = await t.intent('POKE SHOP', 'week');
    expect(w).toMatchObject({ plan: 'week', hours: 168, amount: '150000000', status: 'open', text: 'POKE SHOP', cluster: 'mainnet-beta', receiver: RECEIVER, mint: USDC, signature: null });
    expect((await t.intent('POKE SHOP', 'month')).amount).toBe('500000000');
    await expect(t.intent('POKE SHOP', 'hour')).rejects.toThrow(/burning/);
    await expect(t.intent('POKE SHOP', 'day')).rejects.toThrow(/burning/);
    await expect(t.intent('POKE SHOP', 'year')).rejects.toThrow(/unknown plan/);
    const q = await t.service<{ price: string | null; usdc: string | null; hours: number }>('pokejam_live_ad_quote', ['month', null, WALLET]);
    expect(q).toMatchObject({ price: null, usdc: '500000000', hours: 720 });
    const b = await t.service<{ usdc: Record<string, string> }>('pokejam_live_ad_board');
    expect(b.usdc).toEqual({ week: '150000000', month: '500000000' });
  });

  it('runs the text filter, the ban list, paused sales and the shown price before the intent', async () => {
    const t = await testDb();
    await expect(t.intent('F U C K')).rejects.toThrow(/not allowed \(offensive\)/);
    await expect(t.intent('VISIT SITE.COM')).rejects.toThrow(/not allowed \(link\)/);
    await expect(t.intent('OFFICIAL ADMIN')).rejects.toThrow(/impersonation/);
    await expect(t.intent('HI', 'week', 'not-a-wallet')).rejects.toThrow(/Solana wallet/);
    await expect(t.intent('HI', 'week', WALLET, '100000000')).rejects.toThrow(/price changed/);
    await t.service('pokejam_live_ad_set_cfg', ['ads_paused', 'true']);
    await expect(t.intent('HI')).rejects.toThrow(/paused/);
    expect(await t.sql('select * from public.pokejam_live_ad_usdc_intents')).toHaveLength(0);
  });

  it('refuses bad reference, memo, receiver, mint or cluster', async () => {
    const t = await testDb();
    const call = (o: Partial<Record<'reference' | 'memo' | 'receiver' | 'mint' | 'cluster', string>>) => t.service('pokejam_live_ad_usdc_intent',
      [WALLET, 'HI', 'gold', 'week', null, o.reference ?? ref(), o.memo ?? 'memo-123456', o.receiver ?? RECEIVER, o.mint ?? USDC, o.cluster ?? 'mainnet-beta', null]);
    await expect(call({ reference: '' })).rejects.toThrow(/bad arguments/);
    await expect(call({ memo: 'x' })).rejects.toThrow(/bad arguments/);
    await expect(call({ receiver: '0OIl' })).rejects.toThrow(/bad arguments/);
    await expect(call({ mint: '' })).rejects.toThrow(/bad arguments/);
    await expect(call({ cluster: 'testnet' })).rejects.toThrow(/bad arguments/);
    const r = ref();
    await call({ reference: r, memo: 'memo-aaaaaa' });
    await expect(call({ reference: r })).rejects.toThrow(/unique|duplicate/);
    await expect(call({ memo: 'memo-aaaaaa' })).rejects.toThrow(/unique|duplicate/);
  });

  it('an open intent holds no board space, and caps open intents per wallet', async () => {
    const t = await testDb();
    await t.service('pokejam_live_ad_set_cfg', ['ad_spots', '1']);
    for (let i = 0; i < 10; i++) await t.intent();
    await expect(t.intent()).rejects.toThrow(/too many unpaid/);
    const q = await t.service<{ moved: boolean }>('pokejam_live_ad_quote', ['week', null, OTHER]);
    expect(q.moved).toBe(false);
  });

  it('a confirmed payment books the full plan from the first opening, on the shared live schedule', async () => {
    const t = await testDb();
    await t.service('pokejam_live_ad_set_cfg', ['ad_spots', '1']);
    const burnAd = await t.pay(await t.create('BURN AD', 'day', OTHER));
    const i = await t.intent('USDC AD', 'month');
    const r = await t.usdcPay(i, 'usdcsig1', '500000000');
    expect(r.status).toBe('paid');
    expect(r.ad).toMatchObject({ state: 'paid', plan: 'month', hours: 720, pay_method: 'usdc', price: '500000000', usdc_sig: 'usdcsig1', usdc_paid: '500000000', burn_sig: null });
    expect(ms(r.ad!.ends_at) - ms(r.ad!.starts_at)).toBe(720 * H);
    // One spot: it waits for the burn ad to end.
    expect(r.ad!.starts_at).toBe(burnAd.ends_at);
    expect(r.intent).toMatchObject({ status: 'paid', signature: 'usdcsig1', ad_id: r.ad!.id });
    const b = await t.service<{ totals: { usdc: string; burned: string; ads: number } }>('pokejam_live_ad_board');
    expect(b.totals).toMatchObject({ usdc: '500000000', burned: burnAd.price, ads: 2 });
  });

  it('paying more than asked still books the plan once; paying less books nothing and keeps the intent open', async () => {
    const t = await testDb();
    const i = await t.intent();
    expect(await t.usdcPay(i, 'short1', '149999999')).toEqual({ status: 'short' });
    expect((await t.service<Intent>('pokejam_live_ad_usdc_intent_get', [i.id])).status).toBe('open');
    expect(await t.sql('select * from public.pokejam_live_ads')).toHaveLength(0);
    const r = await t.usdcPay(i, 'over1', '200000000');
    expect(r.status).toBe('paid');
    expect(ms(r.ad!.ends_at) - ms(r.ad!.starts_at)).toBe(168 * H);
  });

  it('is idempotent for the same signature, and a signature pays once', async () => {
    const t = await testDb();
    const i = await t.intent();
    const first = await t.usdcPay(i, 'sigA');
    expect(first.status).toBe('paid');
    const again = await t.usdcPay(i, 'sigA');
    expect(again.status).toBe('duplicate');
    expect(again.ad!.id).toBe(first.ad!.id);
    expect(await t.usdcPay(i, 'sigB')).toEqual({ status: 'intent_done' });
    // The same transaction can't pay another intent, or a burn booking.
    const j = await t.intent('ANOTHER AD', 'week', OTHER);
    expect(await t.usdcPay(j, 'sigA')).toEqual({ status: 'signature_used' });
    const burnBooking = await t.create('BURN AD', 'hour', OTHER);
    await expect(t.pay(burnBooking, burnBooking.price, 'sigA')).rejects.toThrow(/already used/);
    // Nor can a burn's signature pay an intent.
    const paidBurn = await t.pay(burnBooking, burnBooking.price, 'burnX');
    expect(await t.usdcPay(j, paidBurn.burn_sig!)).toEqual({ status: 'signature_used' });
    expect(await t.sql('select * from public.pokejam_live_ads where pay_method = $1', ['usdc'])).toHaveLength(1);
    // And the table itself refuses a reused signature.
    await expect(t.sql(`update public.pokejam_live_ad_usdc_intents set signature = 'sigA' where id = $1`, [j.id])).rejects.toThrow(/unique|duplicate/);
  });

  it('a late payment, after the intent expired, still books', async () => {
    const t = await testDb();
    const i = await t.intent();
    await t.sql(`update public.pokejam_live_ad_usdc_intents set expires_at = now() - interval '1 day', created_at = now() - interval '1 day' where id = $1`, [i.id]);
    expect((await t.usdcPay(i)).status).toBe('paid');
  });

  it("a banned wallet's payment is recorded and stays down", async () => {
    const t = await testDb();
    const i = await t.intent();
    await t.sql(`insert into public.pokejam_ad_bans(wallet, reason) values ($1, 'abuse')`, [WALLET]);
    const r = await t.usdcPay(i);
    expect(r.status).toBe('paid');
    expect(r.ad).toMatchObject({ state: 'removed', removed_reason: 'wallet banned' });
    expect((await t.service<{ live: unknown[] }>('pokejam_live_ad_board')).live).toHaveLength(0);
  });

  it('unknown intents get no_intent', async () => {
    const t = await testDb();
    expect(await t.service('pokejam_live_ad_usdc_pay', ['00000000-0000-0000-0000-000000000000', 'x', '1', WALLET])).toEqual({ status: 'no_intent' });
    expect(await t.service('pokejam_live_ad_usdc_intent_get', ['00000000-0000-0000-0000-000000000000'])).toBeNull();
  });

  it('finds an intent by memo or reference for the recovery sweep, and lists the last day\'s open ones', async () => {
    const t = await testDb();
    const memo = `pokejam-ad-usdc:${'0123456789abcdef'}`;
    const i = await t.service<Intent>('pokejam_live_ad_usdc_intent', [WALLET, 'LOST PAGE', 'fire', 'week', null, ref(), memo, RECEIVER, USDC, 'mainnet-beta', null]);
    const j = await t.intent('STILL OPEN');
    expect(await t.service('pokejam_live_ad_usdc_find', [memo, null])).toMatchObject({ id: i.id, status: 'open' });
    expect(await t.service('pokejam_live_ad_usdc_find', [null, j.reference])).toMatchObject({ id: j.id });
    // Unknown keys, a memo that isn't ours, or nothing at all: null.
    expect(await t.service('pokejam_live_ad_usdc_find', ['pokejam-ad-usdc:ffffffffffffffff', null])).toBeNull();
    expect(await t.service('pokejam_live_ad_usdc_find', [j.memo, null])).toBeNull(); // the test helper's memos aren't 16 hex
    expect(await t.service('pokejam_live_ad_usdc_find', [null, null])).toBeNull();
    const open = await t.service<Intent[]>('pokejam_live_ad_usdc_open', [10]);
    expect(open.map((x) => x.id)).toEqual([j.id, i.id]);
    // Paid, or older than a day: no longer open for the sweep (find still returns a paid one, so the sweep skips it).
    await t.usdcPay(i);
    await t.sql(`update public.pokejam_live_ad_usdc_intents set created_at = now() - interval '2 days' where id = $1`, [j.id]);
    expect(await t.service('pokejam_live_ad_usdc_open', [10])).toEqual([]);
    expect(await t.service('pokejam_live_ad_usdc_find', [memo, null])).toMatchObject({ status: 'paid' });
    // Bounded: at most 50, at least 1.
    expect(await t.service<Intent[]>('pokejam_live_ad_usdc_open', [0])).toHaveLength(0);
    for (let k = 0; k < 3; k++) await t.intent(`AD ${k}`);
    expect(await t.service<Intent[]>('pokejam_live_ad_usdc_open', [0])).toHaveLength(1);
  });

  it('a USDC ad taken down keeps its time to replace, paid the same way', async () => {
    const t = await testDb();
    const r = await t.usdcPay(await t.intent('FIRST TEXT'));
    const down = await t.service<Ad>('pokejam_live_ad_remove', [r.ad!.id, 'typo', false]);
    expect(down.state).toBe('removed');
    const n = await t.service<Ad>('pokejam_live_ad_replace', [r.ad!.id, 'NEW TEXT', 'ice']);
    expect(n).toMatchObject({ state: 'paid', text: 'NEW TEXT', pay_method: 'usdc' });
  });
});

describe('who may call what', () => {
  it('keeps every live ad function and table to the service role', async () => {
    const t = await testDb();
    const Z = '00000000-0000-0000-0000-000000000000';
    for (const role of ['anon', 'authenticated']) {
      const call = t.as(role);
      await expect(call('pokejam_live_ad_board')).rejects.toThrow(/permission denied/);
      await expect(call('pokejam_live_ad_create', [WALLET, 'HI', 'gold', 'hour', null, null, null])).rejects.toThrow(/permission denied/);
      await expect(call('pokejam_live_ad_pay', [Z, 'x', '1', WALLET])).rejects.toThrow(/permission denied/);
      await expect(call('pokejam_live_ad_usdc_intent', [WALLET, 'HI', 'gold', 'week', null, ref(), 'memo-123456', RECEIVER, USDC, 'mainnet-beta', null])).rejects.toThrow(/permission denied/);
      await expect(call('pokejam_live_ad_usdc_pay', [Z, 'x', '1', WALLET])).rejects.toThrow(/permission denied/);
      await expect(call('pokejam_live_ad_usdc_intent_get', [Z])).rejects.toThrow(/permission denied/);
      await expect(call('pokejam_live_ad_usdc_find', ['pokejam-ad-usdc:0123456789abcdef', null])).rejects.toThrow(/permission denied/);
      await expect(call('pokejam_live_ad_usdc_open', [10])).rejects.toThrow(/permission denied/);
      await expect(call('pokejam_live_ad_set_cfg', ['ads_paused', 'false'])).rejects.toThrow(/permission denied/);
      for (const table of ['pokejam_live_ads', 'pokejam_live_ad_reports', 'pokejam_live_ad_usdc_intents']) {
        await expect(t.db.transaction(async (tx) => {
          await tx.exec(`set local role ${role}`);
          return tx.query(`select * from public.${table}`);
        })).rejects.toThrow(/permission denied/);
      }
    }
  });

  it('lets moderators, and only moderators, list and take down live ads, with a log', async () => {
    const t = await testDb();
    const [mod, player] = [crypto.randomUUID(), crypto.randomUUID()];
    await t.sql('insert into auth.users(id) values ($1), ($2)', [mod, player]);
    await t.sql('insert into public.pokejam_admins(user_id, note) values ($1, $2)', [mod, 'test']);
    const a = await t.pay(await t.create('REPORT ME'));
    await t.service('pokejam_live_ad_report', [a.id, 'ip1', 'scam']);
    await expect(t.as('authenticated', player)('pokejam_admin_live_ads', [7])).rejects.toThrow(/moderators only/);
    await expect(t.as('anon')('pokejam_admin_live_ads', [7])).rejects.toThrow(/permission denied/);
    const list = await t.as('authenticated', mod)<(Ad & { reports: number })[]>('pokejam_admin_live_ads', [7]);
    expect(list[0]).toMatchObject({ id: a.id, reports: 1 });
    // The devnet moderators' list doesn't see it.
    expect(await t.as('authenticated', mod)('pokejam_admin_ads', [7])).toEqual([]);
    await t.as('authenticated', mod)('pokejam_admin_live_ad_remove', [a.id, 'reviewed', true]);
    expect(await t.as('authenticated', mod)<{ wallet: string }[]>('pokejam_admin_ad_bans')).toMatchObject([{ wallet: WALLET }]);
    const log = await t.sql('select action from public.pokejam_admin_log order by id');
    expect(log.map((r) => r.action)).toEqual(['live ad ban']);
    // Lift (the admin page's Live board uses the shared unban): the wallet may book on the live board again.
    await expect(t.create()).rejects.toThrow(/banned/);
    await t.as('authenticated', mod)('pokejam_admin_ad_unban', [WALLET]);
    expect((await t.create()).state).toBe('pending');
  });
});
