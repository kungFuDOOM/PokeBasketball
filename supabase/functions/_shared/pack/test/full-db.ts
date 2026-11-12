// A real Postgres (PGlite) running every migration in order, with stand-ins for Supabase's auth, extensions and
// Realtime schemas: what the deposit and withdrawal code needs (Pack Battles entries, profiles, rate limits).
// helpers.ts's testDb runs only the payouts migrations.

import { readFileSync, readdirSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { RpcCall } from '../store.ts';

const DIR = new URL('../../../../migrations/', import.meta.url);

export async function fullDb() {
  const migrations = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort().map((f) => readFileSync(new URL(f, DIR), 'utf8'));
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
    grant usage on schema auth, extensions to anon, authenticated, service_role;
    grant execute on function extensions.gen_random_bytes(int) to public;
    grant usage on schema public to anon, authenticated, service_role;
  `);
  for (const m of migrations) await db.exec(m);
  /** sb.rpc as the service role: a scalar function's value, or a set-returning function's rows. */
  const call: RpcCall = async (fn, args) => db.transaction(async (tx) => {
    await tx.exec('set local role service_role');
    const keys = Object.keys(args);
    const isJson = (v: unknown) => v !== null && typeof v === 'object';
    const r = await tx.query(`select * from public.${fn}(${keys.map((k, i) => `${k} => $${i + 1}${isJson(args[k]) ? '::jsonb' : ''}`).join(', ')})`,
      keys.map((k) => { const v = args[k]; return v !== null && typeof v === 'object' ? JSON.stringify(v) : v; }));
    const rows = r.rows as Record<string, unknown>[];
    return r.fields.length === 1 && r.fields[0].name === fn ? rows[0]?.[fn] ?? null : rows;
  });
  const sql = async (q: string, p: unknown[] = []) => (await db.query(q, p)).rows as Record<string, unknown>[];
  /** A signed-in player with a profile, and SQL run as them. */
  const player = async (name = 'Trainer') => {
    const id = crypto.randomUUID();
    await db.query('insert into auth.users(id) values ($1)', [id]);
    const as = (q: string, p: unknown[] = []) => db.transaction(async (tx) => {
      await tx.exec('set local role authenticated');
      await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [id]);
      return (await tx.query(q, p)).rows as Record<string, unknown>[];
    });
    await as('select public.pokejam_ensure_profile($1)', [name]);
    const balance = async () => Number((await as('select public.pokejam_pack_balance() as b'))[0].b);
    return { id, as, balance };
  };
  return { db, call, sql, player };
}
