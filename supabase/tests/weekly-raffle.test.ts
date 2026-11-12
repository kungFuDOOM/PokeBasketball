// Weekly challenges and the card raffle (migration 20261210). Counts come from match rows and server-recorded
// events, the entry maths matches src/raffle/entries.ts, and the draw is a seeded weighted pick.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { DRAW_ALGORITHM, RAFFLE_DEFAULTS, pickWinner, raffleTicket, scoreRaffle, type RaffleCounts } from '../../src/raffle/entries';
import { testDb, type Db, type User } from './testDb';

vi.setConfig({ testTimeout: 60_000 });

const WALLET = '5njibWvkiFg4LSyzq4ySFhyCsFEF4YhTqRLJo8Z9q16p';

const counts = (o: Partial<RaffleCounts> = {}): RaffleCounts => ({
  offline: 0, online: 0, onlineWins: 0, socialMatches: 0, shares: 0, rankSteps: 0, zenith: false, ...o,
});

async function weekOf(t: Db, ago: string) {
  const [row] = await t.sql(`select public.pokejam_raffle_week_start(now() - ${ago})::text as w`);
  return row.w as string;
}

/** Puts a finished match, and optionally a rank-climb row, inside the given Monday. */
async function played(t: Db, week: string, host: string, guest: string, o: { queue?: string; winner?: string | null; status?: string; at?: string; climb?: boolean } = {}) {
  const at = o.at ?? `($1::date::timestamp at time zone 'America/Los_Angeles') + interval '1 day'`;
  const [m] = await t.sql(
    `insert into public.pokejam_matches(queue, host, guest, status, host_mmr, guest_mmr, winner, finished_at)
     values ($2, $3, $4, $5, 1000, 1000, $6, ${at}) returning id`,
    [week, o.queue ?? 'ranked', host, guest, o.status ?? 'done', o.winner === undefined ? host : o.winner],
  );
  if (o.climb) {
    const [s] = await t.sql('select * from public.pokejam_ranked_season()');
    await t.sql(
      `insert into public.pokejam_ranked_matches(match_id, season_id, host_id, guest_id, winner, reason, host_event, result, created_at)
       values ($2, $3, $4, $5, $4, 'score', 'promoted', '{}', ${at})`,
      [week, m.id, s.id, host, guest],
    );
  }
  return m.id as string;
}

async function qualify(t: Db, week: string, user: User, opp: User, extraOnline = 0) {
  for (let i = 0; i < 3; i++) await t.sql(
    `insert into public.pokejam_raffle_events(user_id, kind, mode, created_at) values ($2, 'offline', 'quick', ($1::date::timestamp at time zone 'America/Los_Angeles') + interval '2 hours')`,
    [week, user.id],
  );
  await t.sql(
    `insert into public.pokejam_raffle_events(user_id, kind, created_at) values ($2, 'share', ($1::date::timestamp at time zone 'America/Los_Angeles') + interval '3 hours')`,
    [week, user.id],
  );
  await played(t, week, user.id, opp.id, { climb: true, winner: user.id });
  await played(t, week, user.id, opp.id, { queue: 'social', winner: user.id });
  await played(t, week, opp.id, user.id, { winner: opp.id });
  for (let i = 0; i < extraOnline; i++) await played(t, week, user.id, opp.id, { winner: i % 2 === 0 ? user.id : opp.id });
}

describe('config and entry maths match the TypeScript', () => {
  it('the stored defaults are the documented amounts, and a wild value is clamped', async () => {
    const t = await testDb();
    const cfg = (await t.sql('select public.pokejam_raffle_cfg() as c'))[0].c as Record<string, unknown>;
    expect(cfg).toMatchObject({
      offline_games: 3, online_games: 3, social: 1, rank_steps: 1, pjam_per_entry: 1_000_000,
      pjam_mint: RAFFLE_DEFAULTS.pjamMint, grind_online_per_entry: 10, grind_wins_per_entry: 3, bonus_cap: 5,
    });
    await t.sql(`update public.pokejam_config set value = '{"offline_games": 0, "online_games": 500, "pjam_mint": "nope", "bonus_cap": 0}' where key = 'raffle'`);
    const clamped = (await t.sql('select public.pokejam_raffle_cfg() as c'))[0].c as { offline_games: number; online_games: number; pjam_mint: string; bonus_cap: number };
    expect(clamped.offline_games).toBe(3);
    expect(clamped.online_games).toBe(3);
    expect(clamped.pjam_mint).toBe(RAFFLE_DEFAULTS.pjamMint);
    expect(clamped.bonus_cap).toBe(0);
  });

  it('score and ticket agree with the client maths, including a high bit in the seed', async () => {
    const t = await testDb();
    const cases: { c: RaffleCounts; whole: bigint }[] = [
      { c: counts({ offline: 3, online: 3, shares: 1, rankSteps: 1 }), whole: 0n },
      { c: counts({ offline: 2, online: 3, shares: 1, rankSteps: 1 }), whole: 5_000_000n },
      { c: counts({ offline: 3, online: 13, onlineWins: 3, shares: 1, rankSteps: 1 }), whole: 0n },
      { c: counts({ offline: 3, online: 53, onlineWins: 15, socialMatches: 1, rankSteps: 0, zenith: true }), whole: 5_000_000n },
      { c: counts({ offline: 3, online: 3, shares: 1, rankSteps: 1 }), whole: 999_999n },
      { c: counts(), whole: 1_000_000n },
      { c: counts(), whole: 999_999n },
    ];
    for (const x of cases) {
      const [row] = await t.sql(
        `select public.pokejam_raffle_score($1,$2,$3,$4,$5,$6,$7,$8, public.pokejam_raffle_cfg()) as s`,
        [x.c.offline, x.c.online, x.c.onlineWins, x.c.socialMatches, x.c.shares, x.c.rankSteps, x.c.zenith, x.whole.toString()],
      );
      const s = row.s as { base: boolean; grind: number; holder: number; bonus: number; total: number };
      const ts = scoreRaffle(x.c, RAFFLE_DEFAULTS, x.whole);
      expect(s).toMatchObject({ base: ts.base, grind: ts.grind, holder: ts.holder, bonus: ts.bonus, total: ts.total });
    }
    const high = new Uint8Array(32);
    high[0] = 0xff;
    const hex = Buffer.from(high).toString('hex');
    const [ticket] = await t.sql(`select public.pokejam_raffle_ticket(decode($1, 'hex'), 6) as n`, [hex]);
    expect(BigInt(ticket.n as string | number)).toBe(raffleTicket(high, 6n));
  });

  it('the week starts on Monday Pacific and ends the next Monday', async () => {
    const t = await testDb();
    const [row] = await t.sql(`select extract(isodow from public.pokejam_raffle_week_start())::int as d,
      public.pokejam_raffle_is_monday(public.pokejam_raffle_week_start()) as ok,
      public.pokejam_raffle_is_monday(public.pokejam_raffle_week_start() + 1) as wed`);
    expect(row.d).toBe(1);
    expect(row.ok).toBe(true);
    expect(row.wed).toBe(false);
  });
});

describe('progress is counted on the server', () => {
  it('counts finished matches, a share, a played offline game and a rank climb, and ignores voids', async () => {
    const t = await testDb();
    const a = await t.user('A');
    const b = await t.user('B');
    const week = await weekOf(t, `interval '0 days'`);
    expect(await a.call('pokejam_raffle_note_offline', ['quick'])).toBe(true);
    expect(await a.call('pokejam_raffle_note_offline', ['quick'])).toBe(false);
    expect(await a.call('pokejam_raffle_note_share')).toBe(true);
    expect(await a.call('pokejam_raffle_note_share')).toBe(false);
    await played(t, week, a.id, b.id, { climb: true, winner: a.id });
    await played(t, week, a.id, b.id, { queue: 'social', winner: a.id });
    await played(t, week, b.id, a.id, { winner: b.id });
    await played(t, week, a.id, b.id, { status: 'void', winner: null });
    const me = await a.call<Record<string, unknown>>('pokejam_raffle_me');
    const c = me.counts as { offline: number; online: number; online_wins: number; social_matches: number; shares: number; rank_steps: number };
    expect(c).toMatchObject({ offline: 1, online: 3, online_wins: 2, social_matches: 1, shares: 1, rank_steps: 1 });
    expect((me.score as { base: boolean }).base).toBe(false);
    await t.sql(`insert into public.pokejam_raffle_events(user_id, kind, mode) values ($1, 'offline', 'franchise')`, [a.id]);
    await t.sql(`insert into public.pokejam_raffle_events(user_id, kind, mode) values ($1, 'offline', 'quick')`, [a.id]);
    const done = await a.call<{ score: { base: boolean; total: number } }>('pokejam_raffle_me');
    expect(done.score.base).toBe(true);
    expect(done.score.total).toBe(1);
  });

  it('a guest cannot record progress, and a player cannot write the table or another account', async () => {
    const t = await testDb();
    const g = await t.user('G', true);
    const a = await t.user('A');
    const b = await t.user('B');
    await expect(g.call('pokejam_raffle_note_offline', ['quick'])).rejects.toThrow(/Sign in/);
    await expect(g.call('pokejam_raffle_note_share')).rejects.toThrow(/Sign in/);
    await expect(a.sql(`insert into public.pokejam_raffle_events(user_id, kind, mode) values ('${b.id}', 'offline', 'quick')`)).rejects.toThrow(/permission denied/);
    expect(await a.call('pokejam_raffle_note_offline', ['quick'])).toBe(true);
    const mine = (await t.sql('select user_id from public.pokejam_raffle_events'))[0].user_id;
    expect(mine).toBe(a.id);
    const guest = await g.call<{ signed_in: boolean }>('pokejam_raffle_me');
    expect(guest.signed_in).toBe(false);
  });

  it('a match before the week or exactly at the next Monday does not count, and Zenith finishes the rank challenge', async () => {
    const t = await testDb();
    const a = await t.user('A');
    const b = await t.user('B');
    const week = await weekOf(t, `interval '0 days'`);
    await played(t, week, a.id, b.id, { at: `($1::date::timestamp at time zone 'America/Los_Angeles')` });
    await played(t, week, a.id, b.id, { at: `((($1::date + 7)::timestamp) at time zone 'America/Los_Angeles')` });
    const c = (await a.call<{ counts: { online: number } }>('pokejam_raffle_me')).counts;
    expect(c.online).toBe(1);
    const [s] = await t.sql('select * from public.pokejam_ranked_season()');
    await t.sql('select public.pokejam_ranked_profile_lock($1, $2)', [a.id, s.id]);
    await t.sql(`update public.pokejam_ranked_profiles set status = 'ranked', placements_played = 5, div_idx = 24, points = 10 where user_id = $1`, [a.id]);
    const zen = await a.call<{ counts: { zenith: boolean }; score: { rank: { done: boolean; zenith: boolean } } }>('pokejam_raffle_me');
    expect(zen.counts.zenith).toBe(true);
    expect(zen.score.rank.done).toBe(true);
  });
});

describe('the draw', () => {
  it('refuses an open week, weights the closed week by entries, and does not draw twice', async () => {
    const t = await testDb();
    const a = await t.user('A');
    const b = await t.user('B');
    const opp = await t.user('O');
    const mod = await t.user('Mod');
    await t.sql('insert into public.pokejam_admins(user_id) values ($1)', [mod.id]);
    const current = await weekOf(t, `interval '0 days'`);
    const open = (await t.service(`select public.pokejam_raffle_commit_draw($1::date, '{}'::jsonb, $2) as r`, [current, mod.id]))[0].r as { ok: boolean; code: string };
    expect(open).toMatchObject({ ok: false, code: 'open' });

    const week = await weekOf(t, `interval '7 days'`);
    await qualify(t, week, a, opp, 10);
    await qualify(t, week, b, opp, 0);
    await t.service(`select public.pokejam_link_wallet($1, $2, 'nonceNonce123456')`, [a.id, WALLET]);
    const balances = { [a.id]: '2000000', [b.id]: '0' };
    const seed = Buffer.alloc(32);
    seed[7] = 4;
    const first = (await t.service(
      `select public.pokejam_raffle_commit_draw($1::date, $2::jsonb, $3, decode($4, 'hex')) as r`,
      [week, JSON.stringify(balances), mod.id, seed.toString('hex')],
    ))[0].r as { ok: boolean; already: boolean; draw: { winner_id: string; total_entries: number; seed: string; snapshot: { algorithm: string; entrants: { user_id: string; entries: number; holder: number; grind: number }[] } } };
    expect(first.ok).toBe(true);
    expect(first.already).toBe(false);
    const snap = first.draw.snapshot;
    expect(snap.algorithm).toBe(DRAW_ALGORITHM);
    const byId = Object.fromEntries(snap.entrants.map((e) => [e.user_id, e]));
    expect(byId[a.id]).toMatchObject({ holder: 2, grind: 1, entries: 4 });
    expect(byId[b.id]).toMatchObject({ holder: 0, grind: 0, entries: 1 });
    expect(first.draw.total_entries).toBe(5);
    expect(first.draw.winner_id).toBe(pickWinner(snap.entrants.map((e) => ({ id: e.user_id, entries: e.entries })), seed));
    expect(first.draw.seed).toBe(seed.toString('hex'));

    const again = (await t.service(
      `select public.pokejam_raffle_commit_draw($1::date, '{"x":"999999999999"}'::jsonb, $2) as r`,
      [week, mod.id],
    ))[0].r as { already: boolean; draw: { winner_id: string; total_entries: number } };
    expect(again.already).toBe(true);
    expect(again.draw.winner_id).toBe(first.draw.winner_id);
    expect(again.draw.total_entries).toBe(5);

    const view = await mod.call<{ entrants: { user_id: string }[]; draw: { winner_id: string }; open: boolean }>('pokejam_admin_raffle', ['previous']);
    expect(view.open).toBe(false);
    expect(view.draw.winner_id).toBe(first.draw.winner_id);
    expect(view.entrants.map((e) => e.user_id).sort()).toEqual([a.id, b.id].sort());
    await expect(a.call('pokejam_admin_raffle', ['previous'])).rejects.toThrow(/moderators only/);
    await expect(a.sql('select * from public.pokejam_raffle_draws')).rejects.toThrow(/permission denied/);

    const me = await a.call<{ last_draw: { won: boolean; entries: number; total: number } | null }>('pokejam_raffle_me');
    expect(me.last_draw).toMatchObject({ entries: 4, total: 5, won: first.draw.winner_id === a.id });
    const log = await t.sql(`select action, target from public.pokejam_admin_log where action = 'raffle-draw'`);
    expect(log).toHaveLength(1);
    expect(log[0].target).toBe(first.draw.winner_id);
    const older = await weekOf(t, `interval '14 days'`);
    const empty = (await t.service(`select public.pokejam_raffle_commit_draw($1::date, '{}'::jsonb, null, null) as r`, [older]))[0].r as { ok: boolean; draw: { total_entries: number; seed: string; winner_id: string | null } };
    expect(empty.ok).toBe(true);
    expect(empty.draw.total_entries).toBe(0);
    expect(empty.draw.winner_id).toBeNull();
    expect(empty.draw.seed).toMatch(/^[0-9a-f]{64}$/);
  });

  it('caps holder plus grind at 5 bonus entries and leaves a guest out', async () => {
    const t = await testDb();
    const a = await t.user('A');
    const g = await t.user('G');
    const opp = await t.user('O');
    const week = await weekOf(t, `interval '7 days'`);
    await qualify(t, week, a, opp, 50);
    await qualify(t, week, g, opp, 0);
    await t.sql('update auth.users set is_anonymous = true where id = $1', [g.id]);
    const entrants = (await t.sql(`select public.pokejam_raffle_entrants($1::date, $2::jsonb) as e`, [week, JSON.stringify({ [a.id]: '9000000' })]))[0].e as { user_id: string; entries: number; holder: number; grind: number }[];
    expect(entrants.map((e) => e.user_id)).toEqual([a.id]);
    expect(entrants[0]).toMatchObject({ holder: 9, grind: 5, entries: 6 });
  });

  it('prep tells the edge function the mint and the wallets, and not an open week', async () => {
    const t = await testDb();
    const a = await t.user('A');
    const opp = await t.user('O');
    await t.service(`select public.pokejam_link_wallet($1, $2, 'nonceNonce123456')`, [a.id, WALLET]);
    const week = await weekOf(t, `interval '7 days'`);
    await qualify(t, week, a, opp, 0);
    const current = await weekOf(t, `interval '0 days'`);
    const open = (await t.service(`select public.pokejam_raffle_draw_prep($1::date) as r`, [current]))[0].r as { code: string };
    expect(open.code).toBe('open');
    const prep = (await t.service(`select public.pokejam_raffle_draw_prep($1::date) as r`, [week]))[0].r as { ok: boolean; mint: string; qualifiers: { user_id: string; wallet: string }[] };
    expect(prep.ok).toBe(true);
    expect(prep.mint).toBe(RAFFLE_DEFAULTS.pjamMint);
    expect(prep.qualifiers).toEqual([{ user_id: a.id, wallet: WALLET }]);
    await expect(a.sql(`select public.pokejam_raffle_draw_prep('${week}')`)).rejects.toThrow(/permission denied/);
  });
});

describe('holders qualify without challenges (migration 20261214)', () => {
  const phantom = async (t: Db, u: User, addr: string) => {
    await t.sql(`insert into auth.identities(user_id, provider, identity_data) values ($1, 'web3', $2::jsonb)`, [u.id, JSON.stringify({ custom_claims: { address: addr, chain: 'solana' } })]);
  };
  const entrantsFor = async (t: Db, week: string, balances: Record<string, string>) =>
    (await t.sql(`select public.pokejam_raffle_entrants($1::date, $2::jsonb) as e`, [week, JSON.stringify(balances)]))[0].e as { user_id: string; entries: number; holder: number; grind: number }[];

  it('1M+ PJAM with zero challenges qualifies, and the holder bonus still applies', async () => {
    const t = await testDb();
    const h = await t.user('H');
    await t.service(`select public.pokejam_link_wallet($1, $2, 'nonceNonce123456')`, [h.id, WALLET]);
    const week = await weekOf(t, `interval '7 days'`);
    const e = await entrantsFor(t, week, { [h.id]: '1000000' });
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ user_id: h.id, holder: 1, grind: 0, entries: 2 });
  });

  it('999,999 PJAM with zero challenges does not qualify', async () => {
    const t = await testDb();
    const h = await t.user('H');
    await t.service(`select public.pokejam_link_wallet($1, $2, 'nonceNonce123456')`, [h.id, WALLET]);
    const week = await weekOf(t, `interval '7 days'`);
    expect(await entrantsFor(t, week, { [h.id]: '999999' })).toEqual([]);
  });

  it('a non-holder who finishes every challenge still qualifies, and keeps the grind bonus', async () => {
    const t = await testDb();
    const a = await t.user('A');
    const opp = await t.user('O');
    const week = await weekOf(t, `interval '7 days'`);
    await qualify(t, week, a, opp, 10);
    const e = await entrantsFor(t, week, {});
    expect(e.map((x) => x.user_id)).toEqual([a.id]);
    expect(e[0]).toMatchObject({ holder: 0, grind: 1, entries: 2 });
  });

  it('counts a Phantom (web3) sign-in wallet, and prep hands its address to the balance reader', async () => {
    const t = await testDb();
    const p = await t.user('P');
    await phantom(t, p, WALLET);
    const week = await weekOf(t, `interval '7 days'`);
    const prep = (await t.service(`select public.pokejam_raffle_draw_prep($1::date) as r`, [week]))[0].r as { qualifiers: { user_id: string; wallet: string; wallets: string[] }[] };
    expect(prep.qualifiers).toEqual([{ user_id: p.id, wallet: WALLET, wallets: [WALLET] }]);
    const e = await entrantsFor(t, week, { [p.id]: '3000000' });
    expect(e[0]).toMatchObject({ user_id: p.id, holder: 3, entries: 4 });
    const me = await p.call<{ wallet: string | null }>('pokejam_raffle_me');
    expect(me.wallet).toBe(WALLET);
  });

  it('a guest holder is still left out', async () => {
    const t = await testDb();
    const g = await t.user('G', true);
    await phantom(t, g, WALLET);
    const week = await weekOf(t, `interval '7 days'`);
    expect(await entrantsFor(t, week, { [g.id]: '5000000' })).toEqual([]);
  });
});

describe('the migration', () => {
  it('is additive, locks the functions down, and does not schedule a minute cron', () => {
    const sql = readFileSync(new URL('../migrations/20261210_pokejam_weekly_raffle.sql', import.meta.url), 'utf8');
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(/set search_path = public/);
    expect(sql).toMatch(/revoke all on public\.pokejam_raffle_events/);
    expect(sql).toMatch(/pokejam_linked_wallet/);
    expect(sql).toMatch(/GQe9QiBBV4G6bRUCxx2JgKrzT7G7RD17FJquBWgVpump/);
    expect(sql).not.toMatch(/cron\.schedule/);
    expect(sql).not.toMatch(/create policy/i);
  });
});
