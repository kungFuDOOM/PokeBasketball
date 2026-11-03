// Ranked stats for the moderation page (migration 20261206): non-admins get an error, admins get the right counts.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { ALL_TIER_NAMES } from '../../src/ranked/rank';
import { testDb, type Db } from './testDb';

vi.setConfig({ testTimeout: 60_000 });

const WALLET = '5njibWvkiFg4LSyzq4ySFhyCsFEF4YhTqRLJo8Z9q16p';
const ONES = '11111111111111111111111111111111';

async function rankedMatch(t: Db, season: number, host: string, guest: string, reason: string, daysAgo: number) {
  const [m] = await t.sql(
    `insert into public.pokejam_matches(queue, host, guest, status, host_mmr, guest_mmr, winner, created_at, finished_at)
     values ('ranked', $1, $2, $3, 1000, 1000, $4, now() - make_interval(days => $5), now() - make_interval(days => $5))
     returning id`,
    [host, guest, reason === 'void' ? 'void' : 'done', reason === 'void' ? null : host, daysAgo],
  );
  await t.sql(
    `insert into public.pokejam_ranked_matches(match_id, season_id, host_id, guest_id, winner, reason, result, created_at)
     values ($1, $2, $3, $4, $5, $6, '{}', now() - make_interval(days => $7))`,
    [m.id, season, host, guest, reason === 'void' ? null : host, reason, daysAgo],
  );
  return m.id as string;
}

describe('pokejam_admin_ranked_stats', () => {
  it('refuses anyone who is not a moderator, and does not hand out the address helper', async () => {
    const t = await testDb();
    const a = await t.user('A');
    await expect(a.call('pokejam_admin_ranked_stats')).rejects.toThrow(/moderators only/);
    await expect(a.call('pokejam_admin_ranked_players')).rejects.toThrow(/moderators only/);
    await expect(t.as('anon', null)('select public.pokejam_admin_ranked_stats()')).rejects.toThrow(/permission denied/);
    await expect(t.as('anon', null)('select public.pokejam_admin_ranked_players(10)')).rejects.toThrow(/permission denied/);
    await expect(a.sql('select public.pokejam_admin_solana_addr($1::jsonb)', ['{}'])).rejects.toThrow(/permission denied/);
    await expect(t.as('anon', null)('select public.pokejam_admin_solana_addr($1::jsonb)', ['{}'])).rejects.toThrow(/permission denied/);
  });

  it('counts matches, players, profiles, shields, ranks and the player list', async () => {
    const t = await testDb();
    const mod = await t.user('Mod', false, 'Moddy');
    const a = await t.user('A', false, 'Alpha');
    const b = await t.user('B', false, 'Bravo');
    const c = await t.user('C', false, null);
    await t.sql(`update public.pokejam_profiles set trainer_name = '<b>x</b>' where id = $1`, [c.id]);
    const d = await t.user('D', false, 'Delta');
    const e = await t.user('E', false, 'Echo');
    await t.sql('insert into public.pokejam_admins(user_id) values ($1)', [mod.id]);

    const empty = await mod.call<Record<string, unknown>>('pokejam_admin_ranked_stats');
    expect(empty.season).toBeNull();
    expect(empty.previous_season).toBeNull();
    expect(empty.top).toEqual([]);
    expect(empty.shields_held).toBe(0);
    expect(empty.d1).toMatchObject({ matches: 0, players: 0, new_profiles: 0, shields_used: 0, shield_packs: 0 });
    expect((empty.days as unknown[])).toHaveLength(30);
    expect((empty.ranks as { tier: string }[]).map((r) => r.tier)).toEqual([...ALL_TIER_NAMES]);
    expect(await mod.call('pokejam_admin_ranked_players')).toEqual({ season_number: null, season_status: null, players: [] });
    // Reading stats must not open a season.
    expect(Number((await t.sql('select count(*)::int as n from public.pokejam_seasons'))[0].n)).toBe(0);

    await mod.call('pokejam_ranked_open_season', [6]);
    const season = Number((await t.sql(`select id from public.pokejam_seasons where status = 'active'`))[0].id);
    const profile = async (id: string, row: { status: string; div: number; points: number; wins: number; losses: number; played: number; days: number; last: boolean }) => {
      await t.sql(
        `insert into public.pokejam_ranked_profiles(user_id, season_id, status, div_idx, points, peak_idx, placements_played, wins, losses, updated_at, last_game_at)
         values ($1, $2, $3, $4, $5, $4, $6, $7, $8, now() - make_interval(days => $9), case when $10 then now() - make_interval(days => $9) else null end)`,
        [id, season, row.status, row.div, row.points, row.played, row.wins, row.losses, row.days, row.last],
      );
    };
    await profile(a.id, { status: 'ranked', div: 7, points: 40, wins: 3, losses: 1, played: 5, days: 0, last: true });
    await profile(b.id, { status: 'ranked', div: 24, points: 200, wins: 10, losses: 2, played: 5, days: 0, last: true });
    await profile(c.id, { status: 'placing', div: 0, points: 0, wins: 0, losses: 0, played: 2, days: 10, last: false });
    await profile(d.id, { status: 'ranked', div: 15, points: 10, wins: 4, losses: 1, played: 5, days: 10, last: true });

    await rankedMatch(t, season, a.id, b.id, 'score', 0);
    const forfeited = await rankedMatch(t, season, a.id, b.id, 'forfeit', 0);
    await rankedMatch(t, season, a.id, d.id, 'leave', 3);
    await rankedMatch(t, season, d.id, a.id, 'score', 10);
    await rankedMatch(t, season, a.id, e.id, 'void', 40);

    await t.sql(`insert into public.pokejam_shield_inventory(user_id, count) values ($1, 2), ($2, 5)`, [a.id, b.id]);
    await t.sql(
      `insert into public.pokejam_shield_ledger(user_id, delta, reason, ref, created_at) values
        ($1, -1, 'use', 'u1', now()),
        ($1, -1, 'use', 'u2', now() - make_interval(days => 8)),
        ($1, -1, 'use', 'u3', now() - make_interval(days => 40)),
        ($1, 1, 'weekly', 'w1', now())`,
      [a.id],
    );
    await t.sql(
      `insert into public.pokejam_shield_purchases(session_id, user_id, sku, units, status, created_at) values
        ('paid-now', $1, 'shield_3', 3, 'paid', now()),
        ('refunded', $1, 'shield_7', 7, 'refunded', now()),
        ('disputed', $1, 'shield_7', 7, 'disputed', now() - make_interval(days => 1)),
        ('paid-20', $1, 'shield_14', 14, 'paid', now() - make_interval(days => 20)),
        ('paid-40', $1, 'shield_3', 3, 'paid', now() - make_interval(days => 40))`,
      [a.id],
    );
    await t.sql(`insert into public.pokejam_bans(user_id, until, reason) values ($1, now() + interval '2 days', 'test')`, [b.id]);
    await t.sql(
      `insert into public.pokejam_judge_flags(match_id, user_id, reason) values
        ($1, $2, 'bad_upload'), ($1, $2, 'false_report'), ($1, $3, 'report_mismatch')`,
      [forfeited, a.id, b.id],
    );
    await t.sql(`create table auth.identities (
      id uuid primary key default gen_random_uuid(), user_id uuid not null, provider text not null, identity_data jsonb not null)`);
    await t.sql(
      `insert into auth.identities(user_id, provider, identity_data) values
        ($1, 'web3', $2::jsonb),
        ($3, 'web3', $4::jsonb),
        ($5, 'web3', $6::jsonb),
        ($7, 'google', $8::jsonb)`,
      [
        a.id, JSON.stringify({ custom_claims: { address: WALLET, chain: 'solana' } }),
        d.id, JSON.stringify({ sub: `web3:solana:${ONES}` }),
        b.id, JSON.stringify({ custom_claims: { address: WALLET, chain: 'ethereum' } }),
        c.id, JSON.stringify({ address: WALLET, chain: 'solana', email: 'c@example.com' }),
      ],
    );

    const addr = async (blob: unknown) => (await t.sql('select public.pokejam_admin_solana_addr($1::jsonb) as a', [JSON.stringify(blob)]))[0].a;
    expect(await addr({ custom_claims: { address: WALLET, chain: 'solana' } })).toBe(WALLET);
    expect(await addr({ custom_claims: { address: WALLET, chain: 'ethereum' } })).toBeNull();
    expect(await addr({ custom_claims: { address: 'short', chain: 'solana' }, sub: `web3:solana:${ONES}` })).toBe(ONES);
    expect(await addr({ sub: 'web3:solana:not-an-address' })).toBeNull();

    const s = await mod.call<{
      d1: Record<string, number>; d7: Record<string, number>; d30: Record<string, number>;
      days: { day: string; matches: number; forfeits: number }[];
      ranks: { tier: string; players: number }[];
      season: { number: number; status: string; length_weeks: number; ranked: number; placing: number };
      previous_season: unknown; top: { name: string; rating: number; div_idx: number }[];
      shields_held: number; generated_at: string;
    }>('pokejam_admin_ranked_stats');
    expect(s.d1).toMatchObject({ matches: 2, players: 2, new_profiles: 1, forfeits: 1, leaves: 0, voids: 0, shields_used: 1, shield_packs: 1, shield_units: 3 });
    expect(s.d7).toMatchObject({ matches: 3, players: 3, new_profiles: 1, forfeits: 1, leaves: 1, voids: 0, shields_used: 1, shield_packs: 1, shield_units: 3 });
    expect(s.d30).toMatchObject({ matches: 4, players: 3, new_profiles: 3, forfeits: 1, leaves: 1, voids: 0, shields_used: 2, shield_packs: 2, shield_units: 17 });
    expect(s.shields_held).toBe(7);
    expect(s.ranks.map((r) => r.tier)).toEqual([...ALL_TIER_NAMES]);
    expect(Object.fromEntries(s.ranks.map((r) => [r.tier, r.players]))).toMatchObject({ Bronze: 0, Gold: 1, Prism: 1, 'Pokémon Master': 0, Zenith: 1 });
    expect(s.season).toMatchObject({ number: 1, status: 'active', length_weeks: 6, ranked: 3, placing: 1 });
    expect(s.previous_season).toBeNull();
    expect(s.top.map((p) => [p.name, p.rating, p.div_idx])).toEqual([['Bravo', 2600, 24], ['Delta', 1510, 15], ['Alpha', 740, 7]]);
    expect(s.days).toHaveLength(30);
    const today = String((await t.sql(`select (now() at time zone 'America/Los_Angeles')::date::text as d`))[0].d);
    expect(s.days.find((d) => String(d.day).slice(0, 10) === today)).toMatchObject({ matches: 2, forfeits: 1 });
    expect(typeof s.generated_at).toBe('string');

    const list = await mod.call<{ season_number: number; season_status: string; players: Record<string, unknown>[] }>('pokejam_admin_ranked_players');
    expect(list.season_number).toBe(1);
    expect(list.season_status).toBe('active');
    expect(list.players.map((p) => p.name)).toEqual(['Bravo', 'Delta', 'Alpha', '<b>x</b>']);
    const byName = Object.fromEntries(list.players.map((p) => [p.name, p]));
    expect(byName.Bravo).toMatchObject({ rating: 2600, wins: 10, losses: 2, matches: 12, shields: 5, flags: 1, wallet: null, status: 'ranked', div_idx: 24 });
    expect(byName.Bravo.banned_until).toEqual(expect.any(String));
    expect(byName.Alpha).toMatchObject({ rating: 740, wins: 3, losses: 1, matches: 4, shields: 2, flags: 2, wallet: WALLET, div_idx: 7 });
    expect(byName.Alpha.banned_until).toBeNull();
    expect(byName.Delta).toMatchObject({ wallet: ONES, div_idx: 15, shields: 0, flags: 0 });
    expect(byName['<b>x</b>']).toMatchObject({ status: 'placing', wallet: null, shields: 0, flags: 0, matches: 0, div_idx: 0, placements_played: 2 });
    expect(byName['<b>x</b>'].last_game_at).toBeNull();

    const topOnly = await mod.call<{ players: { name: string }[] }>('pokejam_admin_ranked_players', [1]);
    expect(topOnly.players.map((p) => p.name)).toEqual(['Bravo']);
    const clamped = await mod.call<{ players: unknown[] }>('pokejam_admin_ranked_players', [0]);
    expect(clamped.players).toHaveLength(1);

    await t.db.exec(readFileSync(new URL('../migrations/20261206_pokejam_admin_ranked_stats.sql', import.meta.url), 'utf8'));
    expect(await mod.call('pokejam_admin_ranked_stats')).toMatchObject({ d1: { matches: 2, players: 2 }, shields_held: 7 });
  });
});
