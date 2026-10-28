// A real Postgres (PGlite) running every Social migration in order, with stand-ins for Supabase's auth, extensions
// and Realtime schemas. Shared by the server tests.
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { expect } from 'vitest';

const MIGRATIONS = ['20261021_pokejam_online.sql', '20261022_pokejam_social.sql', '20261025_pokejam_social_guard.sql', '20261026_pokejam_launch.sql',
  '20261027_pokejam_human_check.sql', '20261028_pokejam_match_evidence.sql', '20261029_pokejam_evidence_retention.sql', '20261030_pokejam_error_reports.sql',
  '20261031_pokejam_moderation.sql', '20261101_pokejam_social_draft.sql', '20261102_pokejam_mons_sync.sql', '20261103_pokejam_match_cleanup.sql',
  '20261104_pokejam_queue_heartbeat.sql', '20261105_pokejam_draft_presence.sql', '20261106_pokejam_game_heartbeat.sql', '20261107_pokejam_requeue_stale.sql']
  .map((f) => readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'));

export async function testDb() {
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
  const as = (role: string, uid: string | null, topic?: string) => async (q: string, params: unknown[] = []) => db.transaction(async (tx) => {
    await tx.exec(`set local role ${role}`);
    if (uid) await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid]);
    if (topic) await tx.query(`select set_config('realtime.topic', $1, true)`, [topic]);
    return (await tx.query(q, params)).rows as Record<string, unknown>[];
  });
  const user = async (name = 'Trainer') => {
    const id = crypto.randomUUID();
    await db.query('insert into auth.users(id) values ($1)', [id]);
    await as('authenticated', id)('select public.pokejam_ensure_profile($1)', [name]);
    const call = async <T = unknown>(fn: string, args: unknown[] = []) =>
      (await as('authenticated', id)(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args))[0].r as T;
    return { id, call, sql: as('authenticated', id) };
  };
  const service = as('service_role', null);
  const sql = async (q: string, p: unknown[] = []) => (await db.query(q, p)).rows as Record<string, unknown>[];
  return { db, as, user, service, sql };
}

export type Db = Awaited<ReturnType<typeof testDb>>;
export type User = Awaited<ReturnType<Db['user']>>;

/** Two players paired by quick match; returns the match id. */
export async function quickPair(t: Db, a: User, b: User) {
  expect(await a.call('pokejam_find_match', ['social'])).toBeNull();
  const mid = await b.call<string | null>('pokejam_find_match', ['social']);
  expect(mid).toBeTruthy();
  return mid!;
}
