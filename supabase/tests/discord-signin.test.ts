// Discord sign-in: a young account can only start a few ranked matches, and linking a wallet keeps the same user and rank.
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { testDb, type Db } from './testDb';

vi.setConfig({ testTimeout: 60_000 });

const WALLET = '5njibWvkiFg4LSyzq4ySFhyCsFEF4YhTqRLJo8Z9q16p';
const OTHER = '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV';
const NONCE = 'nonceNonce123456';

const young = (t: Db, id: string) => t.sql(`update auth.users set created_at = now() where id = $1`, [id]);
const matches = async (t: Db, host: string, guest: string, n: number) => {
  for (let i = 0; i < n; i++) {
    await t.sql(`insert into public.pokejam_matches(queue, host, guest, host_mmr, guest_mmr, seed, quarter_len, status) values ('ranked', $1, $2, 1000, 1000, 1, 120, 'done')`, [host, guest]);
  }
};

describe('new accounts', () => {
  it('lets a day-old account queue, and stops a brand-new one after 10 ranked matches', async () => {
    const t = await testDb();
    const a = await t.user('A');
    const b = await t.user('B');
    const c = await t.user('C');
    await young(t, b.id);
    await matches(t, a.id, c.id, 10);
    await matches(t, b.id, c.id, 10);
    await t.sql(`update public.pokejam_matches set created_at = now() - interval '1 hour', status = 'done'`);
    await t.sql(`insert into public.pokejam_queue(user_id, queue, mmr) values ($1, 'ranked', 1000)`, [a.id]);
    await expect(t.sql(`insert into public.pokejam_queue(user_id, queue, mmr) values ($1, 'ranked', 1000)`, [b.id])).rejects.toThrow(/first day/);
    await t.sql(`delete from public.pokejam_matches where host = $1`, [b.id]);
    await matches(t, b.id, c.id, 9);
    await t.sql(`update public.pokejam_matches set created_at = now() - interval '1 hour', status = 'done' where host = $1`, [b.id]);
    await t.sql(`insert into public.pokejam_queue(user_id, queue, mmr) values ($1, 'ranked', 1000)`, [b.id]);
    await t.sql(`delete from public.pokejam_queue where user_id = $1`, [b.id]);
    await matches(t, b.id, c.id, 1);
    await expect(b.call('pokejam_find_match', ['ranked'])).rejects.toThrow(/first day/);
  });
  it('still refuses a guest, and a ban is still per user id', async () => {
    const t = await testDb();
    const g = await t.user('G', true);
    await expect(g.call('pokejam_find_match', ['ranked'])).rejects.toThrow(/signed-in account/);
    const a = await t.user('A');
    await t.sql(`insert into public.pokejam_bans(user_id, until, reason) values ($1, now() + interval '1 day', 'test')`, [a.id]);
    await expect(a.call('pokejam_find_match', ['ranked'])).rejects.toThrow(/suspended/);
  });
});

describe('linking a wallet keeps the account', () => {
  it('stores the wallet on the same user and leaves rank and shields where they were', async () => {
    const t = await testDb();
    await t.sql('select public.pokejam_ranked_season()');
    const a = await t.user('A');
    const season = (await t.sql(`select id from public.pokejam_seasons where status = 'active'`))[0].id;
    await t.sql(`insert into public.pokejam_ranked_profiles(user_id, season_id, status, div_idx, points, placements_played, wins)
      values ($1, $2, 'ranked', 7, 40, 5, 4)`, [a.id, season]);
    await t.sql(`insert into public.pokejam_shield_inventory(user_id, count) values ($1, 3)`, [a.id]);
    const before = (await t.sql(`select user_id, status, div_idx, points, placements_played, wins from public.pokejam_ranked_profiles where user_id = $1`, [a.id]))[0];
    await a.call('pokejam_wallet_nonce_open', [NONCE]);
    const linked = (await t.service(`select public.pokejam_link_wallet($1, $2, $3) as r`, [a.id, WALLET, NONCE]))[0].r as { ok: boolean; wallet: string };
    expect(linked).toMatchObject({ ok: true, wallet: WALLET });
    expect((await t.sql(`select user_id, status, div_idx, points, placements_played, wins from public.pokejam_ranked_profiles where user_id = $1`, [a.id]))[0]).toEqual(before);
    expect(Number((await t.sql(`select count from public.pokejam_shield_inventory where user_id = $1`, [a.id]))[0].count)).toBe(3);
    expect(await a.call('pokejam_my_wallet')).toBe(WALLET);
    expect((await t.sql(`select count(*)::int as n from auth.users`))[0].n).toBe(1);
    const again = (await t.service(`select public.pokejam_link_wallet($1, $2, $3) as r`, [a.id, WALLET, 'anotherNonce12345']))[0].r as { ok: boolean };
    expect(again.ok).toBe(true);
  });
  it('refuses a second owner, a replay, and a call from the player directly', async () => {
    const t = await testDb();
    const a = await t.user('A');
    const b = await t.user('B');
    await a.call('pokejam_wallet_nonce_open', [NONCE]);
    expect((await t.service(`select public.pokejam_link_wallet($1, $2, $3) as r`, [a.id, WALLET, NONCE]))[0].r).toMatchObject({ ok: true });
    expect((await t.service(`select public.pokejam_link_wallet($1, $2, $3) as r`, [b.id, WALLET, 'nonceNonce654321']))[0].r).toMatchObject({ ok: false, code: 'taken' });
    expect((await t.service(`select public.pokejam_link_wallet($1, $2, $3) as r`, [b.id, OTHER, NONCE]))[0].r).toMatchObject({ ok: false, code: 'replay' });
    await expect(a.sql(`select public.pokejam_link_wallet($1, $2, $3)`, [a.id, OTHER, 'freshNonce1234567'])).rejects.toThrow(/permission denied/);
    const blocked = (await t.service(`select public.pokejam_shield_usdc_intent($1, false, 'shield_3', null, 'ref', 'memo', 'Receiver11111111111111111111111111111111', 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr', 'devnet') as r`, [b.id]))[0].r as { code: string };
    expect(blocked.code).toBe('no_wallet');
  });
  it('stores the nonce before the wallet, and refuses a link that was never opened', async () => {
    const t = await testDb();
    const a = await t.user('A');
    const g = await t.user('G', true);
    expect(await g.call('pokejam_wallet_nonce_open', [NONCE])).toMatchObject({ ok: false, code: 'guest' });
    expect(await a.call('pokejam_wallet_nonce_open', [NONCE])).toMatchObject({ ok: true, nonce: NONCE });
    const opened = (await t.sql(`select user_id::text, consumed_at from public.pokejam_wallet_nonces where nonce = $1`, [NONCE]))[0];
    expect(opened.user_id).toBe(a.id);
    expect(opened.consumed_at).toBeNull();
    expect(Number((await t.sql(`select count(*)::int as n from public.pokejam_linked_wallets`))[0].n)).toBe(0);
    expect((await t.service(`select public.pokejam_link_wallet($1, $2, $3) as r`, [a.id, WALLET, 'freshNonceUnused1']))[0].r).toMatchObject({ ok: false, code: 'nonce' });
    expect(Number((await t.sql(`select count(*)::int as n from public.pokejam_linked_wallets`))[0].n)).toBe(0);
    expect((await t.service(`select public.pokejam_link_wallet($1, $2, $3) as r`, [a.id, WALLET, NONCE]))[0].r).toMatchObject({ ok: true, wallet: WALLET });
    expect((await t.sql(`select consumed_at from public.pokejam_wallet_nonces where nonce = $1`, [NONCE]))[0].consumed_at).toBeTruthy();
    await expect(a.sql(`insert into public.pokejam_wallet_nonces(nonce, user_id) values ('freshNonce1234567', $1)`, [a.id])).rejects.toThrow(/permission denied/);
    await expect(a.sql(`select public.pokejam_link_wallet($1, $2, $3)`, [a.id, OTHER, 'freshNonce1234567'])).rejects.toThrow(/permission denied/);
  });
  it('the migration is additive: security definer, search_path, and no client policy', () => {
    const sql = readFileSync(new URL('../migrations/20261209_pokejam_discord_signin.sql', import.meta.url), 'utf8');
    expect(sql).toMatch(/security definer/i);
    expect(sql).toMatch(/set search_path = public/);
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).not.toMatch(/auth\.users\.email|raw_user_meta/);
    expect(sql).toMatch(/revoke all on public\.pokejam_linked_wallets/);
  });
});
