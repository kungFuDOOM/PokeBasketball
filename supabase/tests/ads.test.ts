// Billboard ads (20261104_pokejam_ads.sql) on a real Postgres (PGlite) running every migration in order. Two promises
// are tested here from every side: a checked burn always becomes airtime, and nobody can grief the board or put
// something vile on it.
import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 120_000 });

const DIR = new URL('../migrations/', import.meta.url);
const MIGRATIONS = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort().map((f) => readFileSync(new URL(f, DIR), 'utf8'));
const WALLET = '9wqysMYY4DTcbPjSZpGQU3pF29YUw9w6A1a8XDKVhezh';
const OTHER = 'A4ahkivAG4NoZAE8Sy4qv8nn2DU9yoXRQcttuCeGtTJv';
const THIRD = 'BSmgKqfYR6ChrxHn7HkkYbZwbDq5E8ZfUJxcwGCNTP4w';
const FOURTH = 'FrhfJgT4VUjzJ92qQUuy3TLKi9V6xwMsqtgVurkDniUL';
const HOUR = 100_000_000_000n;
const DAY = 1_500_000_000_000n;
const H = 3_600_000;

interface Ad {
  id: string; code: string; state: string; price: string; starts_at: string; ends_at: string; moved: boolean; text: string; theme: string;
  extra_of: string | null; replaces: string | null; replaced_by: string | null; removed_left: number | null; removed_reason: string | null; burned: string;
}

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
  const create = (text = 'BUY MORE POTIONS', plan = 'hour', start: string | null = null, wallet = WALLET, expect: string | null = null) =>
    service<Ad>('pokejam_ad_create', [wallet, text, 'gold', plan, start, expect, null]);
  let n = 0;
  const pay = (ad: Ad, burned: string | bigint = ad.price, sig = `sig${++n}`, burner = WALLET) => service<Ad>('pokejam_ad_pay', [ad.id, sig, String(burned), burner]);
  const verdict = (t: string) => service<string | null>('pokejam_ad_verdict', [t]);
  return { db, sql, service, as, create, pay, verdict };
}
type Db = Awaited<ReturnType<typeof testDb>>;

const ms = (iso: string) => new Date(iso).getTime();
const near = (a: number, b: number, tol = 5000) => Math.abs(a - b) < tol;

describe('what an ad may say', () => {
  let t: Db;
  const verdicts = async (list: string[]) => Object.fromEntries(await Promise.all(list.map(async (x) => [x, await t.verdict(x)])));

  it('blocks explicit words however they are disguised', async () => {
    t = await testDb();
    const disguised = ['FUCK', 'F U C K', 'FU CK', 'F.U.C.K', 'F-U-C-K', 'FUUUUCK', 'FVCK', 'PHUCK', 'FCK THIS', 'KCUF', 'FUCKERS',
      '5H1T', '$H!T COIN', 'SH IT', 'BULL SH1T', 'B1TCH', 'BIATCH', 'A$$', 'KISS MY A S S', 'NICE TITS', 'BOOBS', 'C0CK', 'D1CK',
      'DICKS', 'P0RN', 'XXX', 'ONLYFANS', 'HENTAI', 'S3X', 'SEXY', 'CUM', 'NUDES', 'WTF', 'MILF', 'PUSSY', 'C U N T', 'WH0RE',
      'SLUTS', 'BLOW JOB', 'SUCK MY', 'MOTHER FUCKER', 'ASSHOLE', 'DICKHEAD', 'NSFW', 'HORNY'];
    for (const [x, v] of Object.entries(await verdicts(disguised))) expect([x, v]).toEqual([x, 'offensive']);
  });

  it('blocks slurs and hate, spaced out or run together', async () => {
    for (const [x, v] of Object.entries(await verdicts(['N1GGA', 'NIGGERS', 'N I G G E R', 'NIGG3R', 'F4GG0T', 'KIKE', 'TRANNY',
      'RETARD', 'R3TARD', 'NAZIS', 'HEIL', '1488', '14/88', 'HITLER', 'KKK', 'RAPE', 'KYS', 'KILL YOURSELF', 'KILL UR SELF', 'PEDO', 'CHINK',
      'WETBACK', 'SPIC', 'COONS']))) {
      expect([x, v]).toEqual([x, 'offensive']);
    }
  });

  it('blocks links, giveaway and wallet scams, and posing as staff', async () => {
    const want: Record<string, string> = {
      'PJAM.XYZ': 'link', 'T.ME/PJAM': 'link', 'X.COM/HANDLE': 'link', 'WWW PJAM': 'link', 'PJAM DOT COM': 'link', 'HTTPS PJAM': 'link',
      'DISCORD GG PJAM': 'link', 'GO.PJAM.IO': 'link',
      'FREE SOL': 'scam', 'FREE $SOL': 'scam', 'AIRDROP LIVE': 'scam', 'GIVEAWAY': 'scam', 'CLAIM NOW': 'scam', 'DM ME': 'scam',
      'SEND SOL GET 2X': 'scam', 'ENTER SEED PHRASE': 'scam', 'CONNECT WALLET': 'scam', 'VERIFY WALLET': 'scam', 'FREE PJAM': 'scam',
      'POKEJAM OFFICIAL': 'impersonation', 'OFFICIAL AD': 'impersonation', 'ADMIN HERE': 'impersonation', 'KUNGFUDOOM': 'impersonation',
      'POKEJAM STAFF': 'impersonation', 'MODERATOR': 'impersonation',
    };
    expect(await verdicts(Object.keys(want))).toEqual(want);
  });

  it('only allows what the LED board can show', async () => {
    for (const [x, v] of Object.entries(await verdicts(['EMOJI 🏀', 'ÉCLAIR', '<B>', 'A_B', 'STAR*','ZERO​WIDTH']))) {
      expect([x, v]).toEqual([x, 'chars']);
    }
    expect(await t.verdict('')).toBe('length');
    expect(await t.verdict('   ')).toBe('length');
    expect(await t.verdict('X'.repeat(25))).toBe('length');
    expect(await t.verdict('B'.repeat(24))).toBeNull();
    // Tabs and runs of spaces are just spaces on the board.
    expect(await t.verdict('TAB\tX   Y')).toBeNull();
  });

  it("doesn't block ordinary ads that only look like something worse", async () => {
    const fine = ['PUSH IT', 'WHO RULES', 'OPEN ISSUE', 'THERAPIST', 'SCUNTHORPE', 'COCKTAIL HOUR', 'PEACOCK', 'GRAPE SODA',
      'CLASS ACT', 'ASSASSIN', 'BASS DROP', 'KUNG FU', 'TEAM ROCKET', 'HEROINE', 'ANALYST', 'SUSSEX', 'TITAN', 'HOLD $PJAM',
      '@POKEJAM', '$PJAM TO THE MOON', '100X GEM', 'GG EZ', 'MR. MIME FAN CLUB', 'U.S.A', 'GOTTA BURN EM ALL', '24/7 HOOPS',
      'CATCH EM ALL!', 'PROF. OAK APPROVES', 'BUY MORE POTIONS', 'POKEJAM', 'JOGGING CLUB', 'PREPARE FOR TROUBLE', 'HAPPINESS',
      'DOCUMENTS', 'SHIITAKE', 'DICKENS FAN', 'COCKPIT', 'MATSUSHITA', 'SNIGGER', 'BADMINTON', 'NIGERIA', 'ESSEX', 'SPICY',
      'RACCOON', 'ANALOG', 'CUMULUS', 'THE BASS', 'HELLO WORLD', 'SUPPORT LOCAL', "IT'S A TRAP", 'JOIN @PJAMCLUB', 'DROP IN',
      'CLAIM TO FAME?', 'MODS WELCOME', 'BAG HOLDERS', 'HODL', 'WAGMI', 'LFG', 'GM GM', 'NGMI', 'DEV TEAM', 'TITLE RUN'];
    for (const [x, v] of Object.entries(await verdicts(fine))) expect([x, v]).toEqual([x, null]);
  });
});

describe('booking an ad', () => {
  it('prices the plans, cleans the text and locks the price', async () => {
    const t = await testDb();
    const a = await t.create('  buy   more potions! ');
    expect(a).toMatchObject({ state: 'pending', text: 'BUY MORE POTIONS!', price: String(HOUR) });
    expect(a.code).toMatch(/^[0-9a-f]{12}$/);
    expect((await t.create('A', 'day')).price).toBe(String(DAY));
    expect((await t.create('A', 'week')).price).toBe('7500000000000');
    const board = await t.service<{ prices: Record<string, string>; spots: number }>('pokejam_ad_board');
    expect(board).toMatchObject({ spots: 3, prices: { hour: String(HOUR), day: String(DAY), week: '7500000000000' } });
  });

  it('refuses everything it can before anything is burned', async () => {
    const t = await testDb();
    await expect(t.create('f u c k')).rejects.toThrow(/ad text not allowed \(offensive\)/);
    await expect(t.create('FREE SOL')).rejects.toThrow(/ad text not allowed \(scam\)/);
    await expect(t.create('HI', 'hour', null, 'not-a-wallet')).rejects.toThrow(/wallet/);
    await expect(t.create('HI', 'month')).rejects.toThrow(/unknown plan/);
    await expect(t.create('HI', 'hour', new Date(Date.now() + 61 * 24 * H).toISOString())).rejects.toThrow(/60 days/);
    // The page showed one price and the server has another: refused, so the wallet never shows a surprise amount.
    await expect(t.create('HI', 'hour', null, WALLET, String(HOUR - 1n))).rejects.toThrow(/price changed: 100000000000 now/);
    expect((await t.create('HI', 'hour', null, WALLET, String(HOUR))).state).toBe('pending');
    await t.sql(`insert into public.pokejam_ad_bans(wallet, reason) values ($1, 'abuse')`, [OTHER]);
    await expect(t.create('HI', 'hour', null, OTHER)).rejects.toThrow(/banned/);
    await t.sql(`update public.pokejam_config set value = 'true' where key = 'ads_paused'`);
    await expect(t.create('HI')).rejects.toThrow(/paused/);
  });

  it('limits unpaid bookings per wallet, which hold no space on the board', async () => {
    const t = await testDb();
    for (let i = 0; i < 10; i++) await t.create(`AD ${i}`, 'week');
    await expect(t.create('AD 11')).rejects.toThrow(/too many unpaid/);
    await t.create('OTHER WALLET', 'hour', null, OTHER);
    // Ten unpaid week bookings: the board is still empty, a paid ad starts now.
    const q = await t.service<{ moved: boolean }>('pokejam_ad_quote', ['week', null, THIRD]);
    expect(q.moved).toBe(false);
  });
});

describe('a burn always becomes airtime', () => {
  it('the exact price buys the plan, now; asking again is harmless; a signature pays once', async () => {
    const t = await testDb();
    const a = await t.create();
    const paid = await t.pay(a, a.price, 'SIG1');
    expect(paid).toMatchObject({ state: 'paid', moved: false });
    expect(near(ms(paid.starts_at), Date.now())).toBe(true);
    expect(ms(paid.ends_at) - ms(paid.starts_at)).toBe(H);
    expect(await t.pay(a, a.price, 'SIG1')).toEqual(paid);
    const b = await t.create('OTHER');
    await expect(t.pay(b, b.price, 'SIG1')).rejects.toThrow(/burn already used/);
    const board = await t.service<{ live: { text: string }[]; totals: { burned: string; ads: number } }>('pokejam_ad_board');
    expect(board.live.map((x) => x.text)).toEqual(['BUY MORE POTIONS']);
    expect(board.totals).toMatchObject({ burned: String(HOUR), ads: 1 });
  });

  it('a short or a long burn buys its share of the plan at the locked rate', async () => {
    const t = await testDb();
    const half = await t.pay(await t.create('HALF', 'day'), DAY / 2n);
    expect(ms(half.ends_at) - ms(half.starts_at)).toBe(12 * H);
    const twice = await t.pay(await t.create('TWICE', 'hour', null, OTHER), HOUR * 2n, undefined, OTHER);
    expect(ms(twice.ends_at) - ms(twice.starts_at)).toBe(2 * H);
  });

  it('keeps the price it was booked at, even if prices go up before the burn lands', async () => {
    const t = await testDb();
    const a = await t.create('LOCKED', 'day');
    await t.sql(`update public.pokejam_config set value = '3000000000000' where key = 'ad_price_day'`);
    const paid = await t.pay(a);
    expect(ms(paid.ends_at) - ms(paid.starts_at)).toBe(24 * H);
  });

  it('records dust (under a minute of airtime, only possible by hand) without running it', async () => {
    const t = await testDb();
    const d = await t.pay(await t.create('DUST'), '1');
    expect(d.state).toBe('dust');
    expect((await t.service<{ live: unknown[] }>('pokejam_ad_board')).live).toEqual([]);
  });

  it('a second burn for an ad that is already paid adds its own run straight after', async () => {
    const t = await testDb();
    const a = await t.create('AGAIN');
    const first = await t.pay(a, a.price, 'FIRST');
    const extra = await t.pay(a, a.price, 'SECOND');
    expect(extra).toMatchObject({ state: 'paid', extra_of: a.id, text: 'AGAIN' });
    expect(ms(extra.starts_at)).toBe(ms(first.ends_at));
    expect(ms(extra.ends_at) - ms(extra.starts_at)).toBe(H);
    // And the second signature is idempotent too.
    expect((await t.pay(a, a.price, 'SECOND')).id).toBe(extra.id);
  });

  it('anyone may pay for an ad: the burner is recorded', async () => {
    const t = await testDb();
    const paid = await t.pay(await t.create(), String(HOUR), 'GIFT', OTHER);
    expect(paid.state).toBe('paid');
    expect((await t.sql(`select burner from public.pokejam_ads where id = $1`, [paid.id]))[0].burner).toBe(OTHER);
  });

  it('a burn that lands days late still pays, starting when it lands', async () => {
    const t = await testDb();
    const a = await t.create('LATE');
    await t.sql(`update public.pokejam_ads set created_at = now() - interval '30 days', wants_start = now() - interval '30 days' where id = $1`, [a.id]);
    const paid = await t.pay(a);
    expect(paid.state).toBe('paid');
    expect(near(ms(paid.starts_at), Date.now())).toBe(true);
  });

  it('keeps a future start', async () => {
    const t = await testDb();
    const later = new Date(Date.now() + 5 * H).toISOString();
    const f = await t.pay(await t.create('LATER', 'hour', later));
    expect(f.moved).toBe(false);
    expect(near(ms(f.starts_at), ms(later), 1000)).toBe(true);
  });

  it('moves a burn that lands on a full board to the next opening, never drops it', async () => {
    const t = await testDb();
    const day1 = await t.pay(await t.create('ONE', 'day', null, WALLET), DAY, undefined, WALLET);
    await t.pay(await t.create('TWO', 'day', null, OTHER), DAY, undefined, OTHER);
    const late = await t.create('FOUR', 'hour', null, FOURTH);
    await t.pay(await t.create('THREE', 'week', null, THIRD), '7500000000000', undefined, THIRD);
    const q = await t.service<{ starts_at: string; moved: boolean }>('pokejam_ad_quote', ['hour', null, FOURTH]);
    expect(q.moved).toBe(true);
    const moved = await t.pay(late, late.price, undefined, FOURTH);
    expect(moved).toMatchObject({ state: 'paid', moved: true });
    expect(ms(moved.starts_at)).toBe(ms(day1.ends_at));
    expect(ms(moved.starts_at)).toBe(ms(q.starts_at));
  });

  it('gives each advertiser one spot at a time, so nobody can take the whole board', async () => {
    const t = await testDb();
    const first = await t.pay(await t.create('ONE', 'day'));
    const second = await t.pay(await t.create('TWO', 'day'));
    const third = await t.pay(await t.create('THREE', 'day'));
    expect(ms(second.starts_at)).toBe(ms(first.ends_at));
    expect(ms(third.starts_at)).toBe(ms(second.ends_at));
    expect((await t.service<{ live: unknown[] }>('pokejam_ad_board')).live).toHaveLength(1);
    // Two other advertisers still get on now.
    for (const w of [OTHER, THIRD]) expect((await t.pay(await t.create('MINE', 'hour', null, w), HOUR, undefined, w)).moved).toBe(false);
  });

  it('serialises payments, so two burns can never both take the last spot', async () => {
    const t = await testDb();
    await t.pay(await t.create('A', 'day', null, OTHER), DAY, undefined, OTHER);
    await t.pay(await t.create('B', 'day', null, THIRD), DAY, undefined, THIRD);
    const [x, y] = [await t.create('X', 'day', null, WALLET), await t.create('Y', 'day', null, FOURTH)];
    const [px, py] = await Promise.all([t.pay(x, DAY, undefined, WALLET), t.pay(y, DAY, undefined, FOURTH)]);
    expect([px.moved, py.moved].sort()).toEqual([false, true]);
    expect(await t.service<number>('pokejam_ad_peak', [new Date().toISOString(), new Date(Date.now() + 48 * H).toISOString()])).toBe(3);
  });

  it('lists unpaid bookings for the sweeper, and a wallet its own ads', async () => {
    const t = await testDb();
    const a = await t.create('ONE');
    const b = await t.pay(await t.create('TWO'));
    expect((await t.service<Ad[]>('pokejam_ad_unsettled', [10])).map((x) => x.id)).toEqual([a.id]);
    expect((await t.service<Ad[]>('pokejam_ad_mine', [WALLET])).map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
    expect(await t.service<Ad[]>('pokejam_ad_mine', [OTHER])).toEqual([]);
  });
});

describe('moderation keeps the advertiser whole', () => {
  it('a removed ad frees its spot and keeps the time it had left, which the advertiser can run with new text', async () => {
    const t = await testDb();
    const a = await t.pay(await t.create('MEAN BUT LEGAL', 'day'));
    const removed = await t.service<Ad>('pokejam_ad_remove', [a.id, 'rude', false]);
    expect(removed).toMatchObject({ state: 'removed', removed_reason: 'rude' });
    expect(removed.removed_left).toBeGreaterThan(24 * 3600 - 60);
    expect((await t.service<{ live: unknown[] }>('pokejam_ad_board')).live).toEqual([]);
    await expect(t.service('pokejam_ad_replace', [a.id, 'f u c k', 'fire'])).rejects.toThrow(/not allowed/);
    const n = await t.service<Ad>('pokejam_ad_replace', [a.id, 'nice ad now', 'fire']);
    expect(n).toMatchObject({ state: 'paid', text: 'NICE AD NOW', theme: 'fire', replaces: a.id });
    expect(near(ms(n.ends_at) - ms(n.starts_at), removed.removed_left! * 1000, 2000)).toBe(true);
    await expect(t.service('pokejam_ad_replace', [a.id, 'AGAIN', 'fire'])).rejects.toThrow(/already replaced/);
    // The replacement isn't a new burn.
    expect((await t.service<{ totals: { burned: string; ads: number } }>('pokejam_ad_board')).totals).toMatchObject({ burned: String(DAY), ads: 1 });
  });

  it('a scheduled ad that is removed keeps its whole run', async () => {
    const t = await testDb();
    const a = await t.pay(await t.create('LATER', 'day', new Date(Date.now() + 10 * H).toISOString()));
    expect((await t.service<Ad>('pokejam_ad_remove', [a.id, 'x', false])).removed_left).toBe(24 * 3600);
  });

  it('a ban takes down every ad the wallet has, for good, and refuses it from then on', async () => {
    const t = await testDb();
    const a = await t.pay(await t.create('ONE', 'hour'));
    const b = await t.pay(await t.create('TWO', 'hour'));
    const keep = await t.pay(await t.create('SOMEONE ELSE', 'hour', null, OTHER), HOUR, undefined, OTHER);
    await t.service('pokejam_ad_remove', [a.id, 'abuse', true]);
    const states = await t.sql(`select id, state from public.pokejam_ads where id in ($1, $2, $3)`, [a.id, b.id, keep.id]);
    expect(Object.fromEntries(states.map((r) => [r.id, r.state]))).toEqual({ [a.id]: 'removed', [b.id]: 'removed', [keep.id]: 'paid' });
    await expect(t.service('pokejam_ad_replace', [a.id, 'SORRY', 'gold'])).rejects.toThrow(/banned/);
    await expect(t.create('SORRY')).rejects.toThrow(/banned/);
  });

  it('a burn from a banned wallet, or a second burn for a removed ad, is kept as time, not put back up', async () => {
    const t = await testDb();
    const pend = await t.create('PENDING THEN BANNED', 'hour');
    const live = await t.pay(await t.create('LIVE', 'hour'));
    await t.service('pokejam_ad_remove', [live.id, 'abuse', true]);
    const late = await t.pay(pend);
    expect(late).toMatchObject({ state: 'removed', removed_reason: 'wallet banned' });

    const other = await t.pay(await t.create('BORDERLINE', 'hour', null, OTHER), HOUR, 'O1', OTHER);
    await t.service('pokejam_ad_remove', [other.id, 'rude', false]);
    const extra = await t.pay(other, HOUR, 'O2', OTHER);
    expect(extra).toMatchObject({ state: 'removed', extra_of: other.id, removed_reason: 'rude', removed_left: 3600 });
    expect((await t.service<Ad>('pokejam_ad_replace', [extra.id, 'CLEAN NOW', 'ice'])).state).toBe('paid');
  });

  it("reports flag an ad for moderators but never take it down", async () => {
    const t = await testDb();
    const a = await t.pay(await t.create());
    for (let i = 0; i < 50; i++) await t.service('pokejam_ad_report', [a.id, `ip${i}`, 'offensive']);
    expect(await t.service('pokejam_ad_report', [a.id, 'ip1', 'scam'])).toBe(0);
    expect(await t.service('pokejam_ad_report', [a.id, 'ip50', 'scam'])).toBe(51);
    expect((await t.service<{ live: unknown[] }>('pokejam_ad_board')).live).toHaveLength(1);
    await expect(t.service('pokejam_ad_report', [(await t.create('UNPAID')).id, 'ip', 'scam'])).rejects.toThrow(/no such ad/);
  });
});

describe('rate limits', () => {
  it('allows so many hits per key per window', async () => {
    const t = await testDb();
    for (let i = 0; i < 3; i++) expect(await t.service('pokejam_ad_allow', ['k', 3, 60])).toBe(true);
    expect(await t.service('pokejam_ad_allow', ['k', 3, 60])).toBe(false);
    expect(await t.service('pokejam_ad_allow', ['other', 3, 60])).toBe(true);
    await t.sql(`update public.pokejam_ad_hits set at = now() - interval '2 minutes'`);
    expect(await t.service('pokejam_ad_allow', ['k', 3, 60])).toBe(true);
  });

  it('the devnet faucet gives each wallet one claim a day, and can give it back', async () => {
    const t = await testDb();
    expect(await t.service('pokejam_ad_faucet_claim', [WALLET])).toBe(true);
    expect(await t.service('pokejam_ad_faucet_claim', [WALLET])).toBe(false);
    await t.service('pokejam_ad_faucet_undo', [WALLET]);
    expect(await t.service('pokejam_ad_faucet_claim', [WALLET])).toBe(true);
    await t.sql(`update public.pokejam_ad_faucet set last_at = now() - interval '25 hours'`);
    expect(await t.service('pokejam_ad_faucet_claim', [WALLET])).toBe(true);
  });
});

describe('who may call what', () => {
  it('keeps every ad function and table to the service role', async () => {
    const t = await testDb();
    for (const role of ['anon', 'authenticated']) {
      await expect(t.as(role)('pokejam_ad_board')).rejects.toThrow(/permission denied/);
      await expect(t.as(role)('pokejam_ad_create', [WALLET, 'HI', 'gold', 'hour', null, null, null])).rejects.toThrow(/permission denied/);
      await expect(t.as(role)('pokejam_ad_pay', ['00000000-0000-0000-0000-000000000000', 'x', '1', WALLET])).rejects.toThrow(/permission denied/);
      await expect(t.as(role)('pokejam_ad_remove', ['00000000-0000-0000-0000-000000000000', 'x', true])).rejects.toThrow(/permission denied/);
      for (const table of ['pokejam_ads', 'pokejam_ad_bans', 'pokejam_ad_reports', 'pokejam_ad_hits']) {
        await expect(t.db.transaction(async (tx) => {
          await tx.exec(`set local role ${role}`);
          return tx.query(`select * from public.${table}`);
        })).rejects.toThrow(/permission denied/);
      }
    }
  });

  it('lets moderators, and only moderators, list, remove and ban, with a log', async () => {
    const t = await testDb();
    const [mod, player] = [crypto.randomUUID(), crypto.randomUUID()];
    await t.sql('insert into auth.users(id) values ($1), ($2)', [mod, player]);
    await t.sql('insert into public.pokejam_admins(user_id, note) values ($1, $2)', [mod, 'test']);
    const a = await t.pay(await t.create('REPORT ME'));
    await t.service('pokejam_ad_report', [a.id, 'ip1', 'offensive']);
    await expect(t.as('authenticated', player)('pokejam_admin_ads', [7])).rejects.toThrow(/moderators only/);
    await expect(t.as('authenticated', player)('pokejam_admin_ad_remove', [a.id, 'x', true])).rejects.toThrow(/moderators only/);
    await expect(t.as('anon')('pokejam_admin_ads', [7])).rejects.toThrow(/permission denied/);
    const list = await t.as('authenticated', mod)<(Ad & { reports: number; reasons: Record<string, number> })[]>('pokejam_admin_ads', [7]);
    expect(list[0]).toMatchObject({ id: a.id, reports: 1, reasons: { offensive: 1 } });
    await t.as('authenticated', mod)('pokejam_admin_ad_remove', [a.id, 'reviewed', true]);
    expect(await t.as('authenticated', mod)<{ wallet: string }[]>('pokejam_admin_ad_bans')).toMatchObject([{ wallet: WALLET }]);
    await t.as('authenticated', mod)('pokejam_admin_ad_unban', [WALLET]);
    expect((await t.create('BACK')).state).toBe('pending');
    const log = await t.sql('select action, detail from public.pokejam_admin_log order by id');
    expect(log.map((r) => r.action)).toEqual(['ad ban', 'ad unban']);
  });
});
