// Migration 20261115: pokejam_match_ranks gives both players' public rank to the match's players only.
import { describe, expect, it, vi } from 'vitest';
import { testDb } from './testDb';

vi.setConfig({ testTimeout: 60_000 });

describe('pokejam_match_ranks', () => {
  it('returns each side as ranked / placing / unranked, to participants only, with nothing private', async () => {
    const t = await testDb();
    const [a, b, c] = [await t.user('A', false, 'Player_One'), await t.user('B', false, 'Player_Two'), await t.user('C', false, 'Outsider')];
    expect(await a.call('pokejam_find_match', ['ranked'])).toBeNull();
    const mid = (await b.call<string | null>('pokejam_find_match', ['ranked']))!;
    const m = (await t.sql('select host, guest from public.pokejam_matches where id = $1', [mid]))[0] as { host: string; guest: string };

    const sid = (await t.sql(`select id from public.pokejam_seasons where status = 'active'`))[0].id as number;
    for (const u of [m.host, m.guest]) await t.sql('select public.pokejam_ranked_profile_lock($1, $2)', [u, sid]);
    await t.sql(`update public.pokejam_ranked_profiles set status = 'ranked', placements_played = 5, div_idx = 7, points = 40 where user_id = $1`, [m.host]);
    await t.sql(`update public.pokejam_ranked_profiles set status = 'placing', placements_played = 2 where user_id = $1`, [m.guest]);
    const both = await a.call<Record<string, Record<string, unknown>>>('pokejam_match_ranks', [mid]);
    expect(Object.keys(both).sort()).toEqual(['guest', 'host']);
    expect(both.host).toEqual({ status: 'ranked', placements_played: 5, placements_total: 5, div_idx: 7, tier: 'Gold', division: 2 });
    expect(both.guest).toEqual({ status: 'placing', placements_played: 2, placements_total: 5 });

    await t.sql('delete from public.pokejam_ranked_profiles where user_id = $1', [m.guest]);
    expect((await b.call<Record<string, Record<string, unknown>>>('pokejam_match_ranks', [mid])).guest).toEqual({ status: 'unranked' });

    await expect(c.call('pokejam_match_ranks', [mid])).rejects.toThrow(/not in this match/);
    await expect(a.call('pokejam_match_rank_of', [m.host, 1])).rejects.toThrow(/permission denied/);
  });
});
