// Phantom relay (migration 20261202): only ciphertext goes in, it comes out once, nobody can browse it, and it's capped.
import { describe, expect, it, vi } from 'vitest';
import { testDb } from './testDb';

vi.setConfig({ testTimeout: 60_000 });

const ID = 'A'.repeat(43);
const box = { k: 'J'.repeat(44), n: 'K'.repeat(33), d: 'M'.repeat(200) };

async function relay() {
  const t = await testDb();
  const anon = t.as('anon', null);
  const put = async (id: unknown, payload: unknown) => (await anon('select public.pokejam_phantom_relay_put($1, $2::jsonb) as r', [id, JSON.stringify(payload)]))[0].r;
  const take = async (id: unknown) => (await anon('select public.pokejam_phantom_relay_take($1) as r', [id]))[0].r;
  const count = async () => Number((await t.sql('select count(*) c from public.pokejam_phantom_relay'))[0].c);
  return { t, anon, put, take, count };
}

describe('phantom relay', () => {
  it('works without a session, once: a second read finds nothing', async () => {
    const r = await relay();
    expect(await r.take(ID)).toBeNull();
    expect(await r.put(ID, box)).toBe(true);
    expect(await r.take(ID)).toEqual(box);
    expect(await r.take(ID)).toBeNull();
    expect(await r.count()).toBe(0);
  });
  it('first writer wins, so a replay cannot replace a waiting answer', async () => {
    const r = await relay();
    expect(await r.put(ID, box)).toBe(true);
    expect(await r.put(ID, { n: 'z', d: 'z' })).toBe(false);
    expect(await r.take(ID)).toEqual(box);
  });
  it('takes an error code alone, or a box without the Phantom key', async () => {
    const r = await relay();
    expect(await r.put('B'.repeat(43), { e: '4001' })).toBe(true);
    expect(await r.put('C'.repeat(43), { n: 'a', d: 'b' })).toBe(true);
  });
  it('refuses anything that is not ciphertext or a code', async () => {
    const r = await relay();
    for (const bad of [
      { n: 'a', d: 'b', session: 'x' }, { signature: 'x' }, { public_key: 'x' }, { n: 'a' }, { d: 'b' }, {}, [], 'text',
      { n: 'not base58 !', d: 'b' }, { n: 'a', d: { nested: 1 } }, { e: 'free text' }, { e: '4001', n: 'a', d: 'b' }, { n: 'a', d: 'b', k: 'O0Il' },
    ]) expect(await r.put(ID, bad)).toBe(false);
    expect(await r.count()).toBe(0);
  });
  it('refuses bad ids and oversized answers', async () => {
    const r = await relay();
    for (const id of ['', 'short', 'A'.repeat(45), 'O'.repeat(43), `${'A'.repeat(42)}'`]) expect(await r.put(id, box)).toBe(false);
    expect(await r.put(ID, { n: 'a', d: 'b'.repeat(5000) })).toBe(false);
  });
  it('an expired answer is not returned, and is purged by the next call', async () => {
    const r = await relay();
    await r.put(ID, box);
    await r.t.sql(`update public.pokejam_phantom_relay set expires_at = now() - interval '1 second'`);
    expect(await r.take(ID)).toBeNull();
    expect(await r.count()).toBe(0);
  });
  it('lasts about five minutes', async () => {
    const r = await relay();
    await r.put(ID, box);
    const left = (await r.t.sql(`select extract(epoch from expires_at - now()) s from public.pokejam_phantom_relay`))[0].s;
    expect(Number(left)).toBeGreaterThan(290);
    expect(Number(left)).toBeLessThanOrEqual(300);
  });
  it('cannot be read or written directly, by a guest or a signed-in player', async () => {
    const r = await relay();
    await r.put(ID, box);
    const u = await r.t.user('A');
    for (const sql of [r.anon, u.sql]) {
      await expect(sql('select * from public.pokejam_phantom_relay')).rejects.toThrow(/permission denied/);
      await expect(sql(`insert into public.pokejam_phantom_relay(id, payload, expires_at) values ('x', '{}', now())`)).rejects.toThrow(/permission denied/);
      await expect(sql('delete from public.pokejam_phantom_relay')).rejects.toThrow(/permission denied/);
    }
  });
  it('caps one client, without storing its IP', async () => {
    const r = await relay();
    const asClient = async (i: number, ip: string) => (await r.t.db.transaction(async (tx) => {
      await tx.exec('set local role anon');
      await tx.query(`select set_config('request.headers', $1, true)`, [JSON.stringify({ 'x-forwarded-for': `${ip}, 10.0.0.1` })]);
      return (await tx.query(`select public.pokejam_phantom_relay_put($1, $2::jsonb) as r`, [`${'D'.repeat(42)}${'123456789ABCDEFGHJKLMNPQRSTUVWXYZ'[i]}`, JSON.stringify(box)])).rows;
    }) as { r: boolean }[])[0].r;
    for (let i = 0; i < 20; i++) expect(await asClient(i, '1.2.3.4')).toBe(true);
    expect(await asClient(20, '1.2.3.4')).toBe(false);
    expect(await asClient(21, '5.6.7.8')).toBe(true);
    const stored = JSON.stringify(await r.t.sql('select * from public.pokejam_phantom_relay'));
    expect(stored).not.toContain('1.2.3.4');
  });
  it('caps the table overall', async () => {
    const r = await relay();
    await r.t.sql(`insert into public.pokejam_phantom_relay(id, payload, expires_at) select 'x' || g, '{}', now() + interval '1 minute' from generate_series(1, 5000) g`);
    expect(await r.put(ID, box)).toBe(false);
  });
});
