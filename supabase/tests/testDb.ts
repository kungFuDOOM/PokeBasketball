// A real Postgres (PGlite) running every Social migration in order, with stand-ins for Supabase's auth, extensions
// and Realtime schemas. Shared by the server tests.
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { expect } from 'vitest';

const MIGRATIONS = ['20261021_pokejam_online.sql', '20261022_pokejam_social.sql', '20261025_pokejam_social_guard.sql', '20261026_pokejam_launch.sql',
  '20261027_pokejam_human_check.sql', '20261028_pokejam_match_evidence.sql', '20261029_pokejam_evidence_retention.sql', '20261030_pokejam_error_reports.sql',
  '20261031_pokejam_moderation.sql', '20261101_pokejam_social_draft.sql', '20261102_pokejam_mons_sync.sql', '20261103_pokejam_match_cleanup.sql',
  '20261104_pokejam_queue_heartbeat.sql', '20261105_pokejam_draft_presence.sql', '20261106_pokejam_game_heartbeat.sql', '20261107_pokejam_requeue_stale.sql', '20261108_pokejam_net_stats.sql', '20261109_pokejam_admin_stats.sql',
  '20261110_pokejam_offline_stats.sql', '20261111_pokejam_ranked.sql',
  '20261112_pokejam_ranked_matchmaking.sql', '20261113_pokejam_ranked_signin.sql', '20261114_pokejam_profiles.sql',
  '20261115_pokejam_match_ranks.sql', '20261117_pokejam_rank_shield.sql', '20261118_pokejam_shield_shop.sql',
  '20261119_pokejam_shield_usdc.sql']
  .map((f) => readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'));

// Auto usernames are Tr1, Tr2, ...: digits only after the prefix, so they can never spell a blocked word.
let nameSeq = 0;

export async function testDb() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create schema auth;
    create table auth.users (id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb $$;
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
  const as = (role: string, uid: string | null, topic?: string, anonymous = false) => async (q: string, params: unknown[] = []) => db.transaction(async (tx) => {
    await tx.exec(`set local role ${role}`);
    if (uid) await tx.query(`select set_config('request.jwt.claim.sub', $1, true)`, [uid]);
    if (anonymous) await tx.query(`select set_config('request.jwt.claims', '{"is_anonymous": true}', true)`);
    if (topic) await tx.query(`select set_config('realtime.topic', $1, true)`, [topic]);
    return (await tx.query(q, params)).rows as Record<string, unknown>[];
  });
  /**
   * `anonymous`: a guest session (JWT is_anonymous = true), as Supabase issues for signInAnonymously.
   * `username`: a signed-in user gets a random valid username so Ranked works; pass null for none, or a string to choose.
   */
  const user = async (name = 'Trainer', anonymous = false, username?: string | null) => {
    const id = crypto.randomUUID();
    await db.query('insert into auth.users(id) values ($1)', [id]);
    const sql = as('authenticated', id, undefined, anonymous);
    await sql('select public.pokejam_ensure_profile($1)', [name]);
    const pick = username === undefined ? (anonymous ? null : `Tr${++nameSeq}`) : username;
    if (pick) await sql('select public.pokejam_set_username($1)', [pick]);
    const call = async <T = unknown>(fn: string, args: unknown[] = []) =>
      (await sql(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args))[0].r as T;
    return { id, call, sql };
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
