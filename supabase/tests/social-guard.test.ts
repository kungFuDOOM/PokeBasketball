// Social anti-griefing (20261025_pokejam_social_guard.sql) on a real Postgres (PGlite) running every Social
// migration in order, with stand-ins for Supabase's auth, extensions and Realtime schemas.
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 30_000 });

const MIGRATIONS = ['20261021_pokejam_online.sql', '20261022_pokejam_social.sql', '20261025_pokejam_social_guard.sql', '20261026_pokejam_launch.sql', '20261027_pokejam_human_check.sql', '20261028_pokejam_match_evidence.sql', '20261029_pokejam_evidence_retention.sql', '20261030_pokejam_error_reports.sql', '20261031_pokejam_moderation.sql', '20261101_pokejam_social_draft.sql']
  .map((f) => readFileSync(new URL(`../migrations/${f}`, import.meta.url), 'utf8'));

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

type Db = Awaited<ReturnType<typeof testDb>>;
const nameOf = async (t: Db, id: string) => (await t.sql('select trainer_name from public.pokejam_profiles where id = $1', [id]))[0].trainer_name;

/** Two players paired by quick match; returns the match id. */
async function quickPair(t: Db, a: Awaited<ReturnType<Db['user']>>, b: Awaited<ReturnType<Db['user']>>) {
  expect(await a.call('pokejam_find_match', ['social'])).toBeNull();
  const mid = await b.call<string | null>('pokejam_find_match', ['social']);
  expect(mid).toBeTruthy();
  return mid!;
}

describe('the server picks the game', () => {
  it('quick match and rooms get a server seed and quarter length that both players read, and nobody else', async () => {
    const t = await testDb();
    const [a, b, c] = [await t.user('Ash'), await t.user('Misty'), await t.user('Brock')];
    const mid = await quickPair(t, a, b);
    const ia = await a.call<Record<string, unknown>>('pokejam_match_info', [mid]);
    const ib = await b.call<Record<string, unknown>>('pokejam_match_info', [mid]);
    expect(ia.seed).toEqual(ib.seed);
    expect(Number(ia.seed)).toBeGreaterThanOrEqual(0);
    expect(Number(ia.seed)).toBeLessThan(2 ** 32);
    expect(ia.quarter_len).toBe(120);
    expect([ia.host_name, ia.guest_name]).toEqual(['Ash', 'Misty']);
    expect(await c.call('pokejam_match_info', [mid])).toBeNull();
    await expect(a.sql('update public.pokejam_matches set seed = 1')).rejects.toThrow(/permission denied/);

    const code = await a.call<string>('pokejam_create_room', [60]);
    const rid = await c.call<string>('pokejam_join_room', [code]);
    const room = await c.call<Record<string, unknown>>('pokejam_match_info', [rid]);
    expect(room.quarter_len).toBe(60);
    expect(room.seed).not.toBeNull();
    // Anything but 1 minute is 2 minutes: the host can't ask for a 5-minute marathon.
    const code2 = await b.call<string>('pokejam_create_room', [300]);
    const rid2 = await a.call<string>('pokejam_join_room', [code2]);
    expect((await a.call<Record<string, unknown>>('pokejam_match_info', [rid2])).quarter_len).toBe(120);
  });
});

describe('trainer names', () => {
  // One database for the name cases: what a new player's profile would keep.
  let shared: Promise<Db> | null = null;
  const kept = async (name: string) => {
    const t = await (shared ??= testDb());
    const u = await t.user(name);
    return nameOf(t, u.id);
  };

  it('keeps ordinary names, accents and all', async () => {
    for (const n of ['Ash Ketchum', 'Poké Fan', 'Raccoon City', 'Grape Juice', 'Nigel', 'Peacock', 'Bass Drop', 'Scunthorpe', 'The Therapist', 'Shiitake', 'Pussycat', "O'Brien-Smith", 'Team_Rocket!'])
      expect(await kept(n), n).toBe(n);
  });

  it('strips invisible, direction-flipping and other unsafe characters, and trims to 20', async () => {
    expect(await kept('Ash​​Ketchum')).toBe('AshKetchum');
    expect(await kept('‮emaN‬ Bob')).toBe('emaN Bob');
    expect(await kept('<script>x</script>')).toBe('scriptxscript');
    expect(await kept('   lots    of   space   ')).toBe('lots of space');
    expect(await kept('A'.repeat(40))).toBe('A'.repeat(20));
    expect(await kept('​​')).toBe('Trainer');
  });

  it('turns slurs, stretched or leetspeak versions, and staff or partner names into "Trainer"', async () => {
    for (const n of ['N1gg3r', 'n i g g a', 'niiiiggggaaa', 'F4ggot', 'xXretardXx', 'Admin', 'admin bob', 'MOD', 'Kungfudoom', 'Collector Crypt',
      'Pokejam Official', 'big rape', 'shithead', 'sh1t', 'f.u.c.k'])
      expect(await kept(n), n).toBe('Trainer');
  });

  it('cleans names already stored, and limits how often a player renames', async () => {
    const t = await testDb();
    const u = await t.user('Ash');
    for (let i = 0; i < 6; i++) await u.call('pokejam_ensure_profile', [`Name ${i}`]);
    expect(await nameOf(t, u.id)).toBe('Name 5');
    await u.call('pokejam_ensure_profile', ['Name 6']); // over the limit: kept as it was
    expect(await nameOf(t, u.id)).toBe('Name 5');
    await u.call('pokejam_ensure_profile', ['Name 5']); // the same name again is free and changes nothing
    expect(await nameOf(t, u.id)).toBe('Name 5');
    await expect(u.sql("update public.pokejam_profiles set trainer_name = 'admin'")).rejects.toThrow(/permission denied/);
  });
});

describe('rate limits', () => {
  it('room codes cannot be guessed: every try counts, wrong ones too', async () => {
    const t = await testDb();
    const [host, guesser] = [await t.user('Host'), await t.user('Guesser')];
    const code = await host.call<string>('pokejam_create_room', [120]);
    for (let i = 0; i < 15; i++) expect(await guesser.call('pokejam_join_room', [`ZZZZ${String(i).padStart(2, '0')}`])).toBeNull();
    await expect(guesser.call('pokejam_join_room', [code])).rejects.toThrow(/too many room codes/);
  });

  it('room spam and matchmaking floods are cut off', async () => {
    const t = await testDb();
    const u = await t.user('Spammer');
    for (let i = 0; i < 10; i++) await u.call('pokejam_create_room', [120]);
    await expect(u.call('pokejam_create_room', [120])).rejects.toThrow(/too many rooms/);
    // Only the newest room stays open: older waiting rooms are closed when a new one is made.
    expect((await t.sql("select count(*)::int as n from public.pokejam_matches where status = 'waiting'"))[0].n).toBe(1);
    for (let i = 0; i < 60; i++) await u.call('pokejam_find_match', ['social']);
    await expect(u.call('pokejam_find_match', ['social'])).rejects.toThrow(/too many matchmaking/);
  });
});

describe('bans', () => {
  it('a banned player is out of the queue and can not search, make or join rooms; only the service role bans', async () => {
    const t = await testDb();
    const [bad, good, other] = [await t.user('Bad'), await t.user('Good'), await t.user('Other')];
    expect(await bad.call('pokejam_find_match', ['social'])).toBeNull();
    const code = await good.call<string>('pokejam_create_room', [120]);
    await expect(bad.call('pokejam_ban', [bad.id, 24, 'x'])).rejects.toThrow(/permission denied/);
    await t.service('select public.pokejam_ban($1, 24, $2)', [bad.id, 'abusive name']);
    expect((await t.sql('select count(*)::int as n from public.pokejam_queue where user_id = $1', [bad.id]))[0].n).toBe(0);
    expect(await other.call('pokejam_find_match', ['social'])).toBeNull(); // not paired with the banned player
    await expect(bad.call('pokejam_find_match', ['social'])).rejects.toThrow(/suspended/);
    await expect(bad.call('pokejam_create_room', [120])).rejects.toThrow(/suspended/);
    await expect(bad.call('pokejam_join_room', [code])).rejects.toThrow(/suspended/);
    await expect(bad.sql('select * from public.pokejam_bans')).rejects.toThrow(/permission denied/);
    await t.service('select public.pokejam_unban($1)', [bad.id]);
    expect(await bad.call('pokejam_join_room', [code])).toBeTruthy();
  });
});

describe('reports and blocks', () => {
  it('only a player in the match can report the other one, once per match', async () => {
    const t = await testDb();
    const [a, b, c] = [await t.user('A'), await t.user('B'), await t.user('C')];
    const mid = await quickPair(t, a, b);
    expect(await a.call('pokejam_report_player', [mid, 'name', 'rude name'])).toBe(true);
    expect(await a.call('pokejam_report_player', [mid, 'cheating', null])).toBe(false);
    await expect(c.call('pokejam_report_player', [mid, 'name', null])).rejects.toThrow(/not in this match/);
    await expect(b.call('pokejam_report_player', [mid, 'whatever', null])).rejects.toThrow(/bad reason/);
    const rows = await t.sql('select reporter, reported, reason, note from public.pokejam_reports');
    expect(rows).toEqual([{ reporter: a.id, reported: b.id, reason: 'name', note: 'rude name' }]);
    await expect(a.sql('select * from public.pokejam_reports')).rejects.toThrow(/permission denied/);
  });

  it('five different opponents reporting a player in a day suspends them for 24 hours', async () => {
    const t = await testDb();
    const troll = await t.user('Troll');
    for (let i = 0; i < 5; i++) {
      const victim = await t.user(`Victim ${i}`);
      const code = await troll.call<string>('pokejam_create_room', [120]);
      const mid = await victim.call<string>('pokejam_join_room', [code]);
      await victim.call('pokejam_report_player', [mid, 'name', null]);
      if (i < 4) expect(await troll.call('pokejam_create_room', [120])).toBeTruthy();
    }
    await expect(troll.call('pokejam_find_match', ['social'])).rejects.toThrow(/suspended/);
    expect((await t.sql('select auto from public.pokejam_bans where user_id = $1', [troll.id]))[0].auto).toBe(true);
  });

  it('a block keeps two players apart in quick match and rooms, either way round', async () => {
    const t = await testDb();
    const [a, b, c] = [await t.user('A'), await t.user('B'), await t.user('C')];
    const mid = await quickPair(t, a, b);
    await b.call('pokejam_block_player', [mid]);
    expect(await b.sql('select blocked from public.pokejam_blocks')).toEqual([{ blocked: a.id }]);
    expect(await a.sql('select * from public.pokejam_blocks')).toEqual([]); // a can't see who blocked them
    // b searches first, then a: never paired. c comes along and gets b.
    await t.sql("update public.pokejam_matches set created_at = now() - interval '10 minutes'");
    expect(await b.call('pokejam_find_match', ['social'])).toBeNull();
    expect(await a.call('pokejam_find_match', ['social'])).toBeNull();
    const withC = await c.call<string>('pokejam_find_match', ['social']);
    const info = await c.call<Record<string, unknown>>('pokejam_match_info', [withC]);
    expect([info.host, info.guest]).toContain(c.id);
    // The blocked player can't join the blocker's room, and can't tell why.
    const code = await b.call<string>('pokejam_create_room', [120]);
    expect(await a.call('pokejam_join_room', [code])).toBeNull();
    await b.call('pokejam_unblock_player', [a.id]);
    expect(await a.call('pokejam_join_room', [code])).toBeTruthy();
  });
});

describe('private match channels', () => {
  it('only the two players can read or send on their match topic; other topics are untouched', async () => {
    const t = await testDb();
    const [a, b, c] = [await t.user('A'), await t.user('B'), await t.user('C')];
    const mid = await quickPair(t, a, b);
    const topic = `pokejam:match:${mid}`;
    const send = (u: { id: string }, tp: string) => t.as('authenticated', u.id, tp)("insert into realtime.messages(topic, payload) values (realtime.topic(), '{}') returning id");
    const read = (u: { id: string }, tp: string) => t.as('authenticated', u.id, tp)('select count(*)::int as n from realtime.messages where topic = realtime.topic()');
    expect(await send(a, topic)).toHaveLength(1);
    expect(await send(b, topic)).toHaveLength(1);
    expect((await read(b, topic))[0].n).toBe(2);
    await expect(send(c, topic)).rejects.toThrow(/row-level security/);
    expect((await read(c, topic))[0].n).toBe(0);
    // A topic that isn't a pokejam match is simply not ours to allow, and never errors.
    await expect(send(c, 'pokejam:match:not-a-uuid')).rejects.toThrow(/row-level security/);
    await expect(send(c, "gauntlet:lobby'; drop table x")).rejects.toThrow(/row-level security/);
    // A finished match's channel is closed.
    await t.sql("update public.pokejam_matches set status = 'done' where id = $1", [mid]);
    await expect(send(a, topic)).rejects.toThrow(/row-level security/);
  });
});

describe('TURN credentials for the direct link', () => {
  it('only the two players in an active match get them, a few times per 10 minutes', async () => {
    const t = await testDb();
    const [a, b, c] = [await t.user('A'), await t.user('B'), await t.user('C')];
    const mid = await quickPair(t, a, b);
    expect(await a.call('pokejam_ice_ok', [mid])).toBe(true);
    expect(await b.call('pokejam_ice_ok', [mid])).toBe(true);
    expect(await c.call('pokejam_ice_ok', [mid])).toBe(false);
    for (let i = 0; i < 5; i++) await a.call('pokejam_ice_ok', [mid]);
    expect(await a.call('pokejam_ice_ok', [mid])).toBe(false); // the 7th in 10 minutes
    await t.sql("update public.pokejam_matches set status = 'done' where id = $1", [mid]);
    expect(await b.call('pokejam_ice_ok', [mid])).toBe(false);
  });
});

describe('the human check before online matches (#20)', () => {
  it('off by default: matchmaking works with no pass', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A'), await t.user('B')];
    expect(await a.call('pokejam_human_status')).toEqual({ required: false, until: null });
    await quickPair(t, a, b);
  });

  it('on: no quick match, room or join without a pass; a pass from the function lets the player in until it runs out', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A'), await t.user('B')];
    const host = await t.user('Host');
    // A room made before the switch, to test joining.
    const code = await host.call<string>('pokejam_create_room', [120]);
    await t.sql("update public.pokejam_config set value = 'true' where key = 'require_human'");
    expect((await a.call<{ required: boolean }>('pokejam_human_status')).required).toBe(true);
    await expect(a.call('pokejam_find_match', ['social'])).rejects.toThrow(/human check needed/);
    await expect(a.call('pokejam_create_room', [120])).rejects.toThrow(/human check needed/);
    await expect(a.call('pokejam_join_room', [code])).rejects.toThrow(/human check needed/);
    // Only the service role (the pokejam-human function) can grant one.
    await expect(a.call('pokejam_grant_human', [a.id, 60])).rejects.toThrow(/permission denied/);
    await expect(a.sql("insert into public.pokejam_human(user_id, until) values ($1, now() + interval '1 day')", [a.id])).rejects.toThrow(/permission denied/);
    await expect(a.sql("update public.pokejam_config set value = 'false'")).rejects.toThrow(/permission denied/);
    await t.service('select public.pokejam_grant_human($1, 20)', [a.id]);
    await t.service('select public.pokejam_grant_human($1, 20)', [b.id]);
    expect((await a.call<{ until: string | null }>('pokejam_human_status')).until).toBeTruthy();
    await quickPair(t, a, b);
    expect(await a.call('pokejam_join_room', [code])).toBeTruthy();
    // Passes run out; and a pass is capped at an hour, whatever is asked for.
    await t.sql("update public.pokejam_human set until = now() - interval '1 second' where user_id = $1", [b.id]);
    await expect(b.call('pokejam_create_room', [120])).rejects.toThrow(/human check needed/);
    const until = (await t.service('select public.pokejam_grant_human($1, 9999) as u', [b.id]))[0].u as Date;
    expect(new Date(until).getTime() - Date.now()).toBeLessThanOrEqual(60 * 60 * 1000 + 5000);
  });
});

describe('signed evidence for the winner check', () => {
  const KEY_A = 'a'.repeat(64);
  const KEY_B = 'b'.repeat(64);

  it('each player registers one key before tip-off; it can never be swapped, and both show in match info', async () => {
    const t = await testDb();
    const [a, b, c] = [await t.user('A'), await t.user('B'), await t.user('C')];
    const mid = await quickPair(t, a, b);
    expect(await a.call('pokejam_register_key', [mid, KEY_A])).toBe(true);
    expect(await a.call('pokejam_register_key', [mid, KEY_A])).toBe(true); // the same key again is fine
    expect(await a.call('pokejam_register_key', [mid, 'c'.repeat(64)])).toBe(false); // a different one is not
    await expect(c.call('pokejam_register_key', [mid, KEY_B])).rejects.toThrow(/not in this match/);
    await expect(b.call('pokejam_register_key', [mid, 'xyz'])).rejects.toThrow(/bad key/);
    expect(await b.call('pokejam_register_key', [mid, KEY_B])).toBe(true);
    const info = await a.call<Record<string, unknown>>('pokejam_match_info', [mid]);
    const hostIsA = info.host === a.id;
    expect([info.host_key, info.guest_key]).toEqual(hostIsA ? [KEY_A, KEY_B] : [KEY_B, KEY_A]);
    await expect(a.sql(`update public.pokejam_matches set host_key = '${'d'.repeat(64)}'`)).rejects.toThrow(/permission denied/);
    // Not after the match is over.
    await t.sql("update public.pokejam_matches set status = 'done' where id = $1", [mid]);
    await expect(a.call('pokejam_register_key', [mid, KEY_A])).rejects.toThrow(/not in this match/);
  });

  /** Two players paired in the Ranked queue: the matches evidence is kept for. */
  const rankedPair = async (t: Db, a: Awaited<ReturnType<Db['user']>>, b: Awaited<ReturnType<Db['user']>>) => {
    expect(await a.call('pokejam_find_match', ['ranked'])).toBeNull();
    return (await b.call<string>('pokejam_find_match', ['ranked']))!;
  };

  it('each player uploads evidence once; nobody else can, and players cannot read it back', async () => {
    const t = await testDb();
    const [a, b, c] = [await t.user('A'), await t.user('B'), await t.user('C')];
    const mid = await rankedPair(t, a, b);
    expect(await a.call('pokejam_submit_evidence', [mid, 'gz1:AAAA'])).toBe(true);
    expect(await a.call('pokejam_submit_evidence', [mid, 'gz1:BBBB'])).toBe(false); // the first upload stands
    expect(await b.call('pokejam_submit_evidence', [mid, 'gz1:CCCC'])).toBe(true);
    await expect(c.call('pokejam_submit_evidence', [mid, 'gz1:DDDD'])).rejects.toThrow(/not in this match/);
    await expect(a.call('pokejam_submit_evidence', [mid, 'plain json'])).rejects.toThrow(/bad evidence/);
    await expect(a.sql('select * from public.pokejam_match_evidence')).rejects.toThrow(/permission denied/);
    const rows = await t.sql('select user_id, evidence from public.pokejam_match_evidence where match_id = $1 order by evidence', [mid]);
    expect(rows.map((r) => r.evidence)).toEqual(['gz1:AAAA', 'gz1:CCCC']);
  });

  it('Social matches keep no evidence: an upload is refused, whatever the client sends', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A'), await t.user('B')];
    const mid = await quickPair(t, a, b);
    expect(await a.call('pokejam_submit_evidence', [mid, 'gz1:AAAA'])).toBe(false);
    expect((await t.sql('select count(*)::int as n from public.pokejam_match_evidence'))[0].n).toBe(0);
  });

  it('old uploads are pruned (service role only); recent ones stay', async () => {
    const t = await testDb();
    const [a, b] = [await t.user('A'), await t.user('B')];
    const mid = await rankedPair(t, a, b);
    await a.call('pokejam_submit_evidence', [mid, 'gz1:OLD']);
    await b.call('pokejam_submit_evidence', [mid, 'gz1:NEW']);
    await t.sql("update public.pokejam_match_evidence set created_at = now() - interval '31 days' where evidence = 'gz1:OLD'");
    await expect(a.call('pokejam_prune_evidence', [30])).rejects.toThrow(/permission denied/);
    expect((await t.service('select public.pokejam_prune_evidence(30) as n'))[0].n).toBe(1);
    expect((await t.sql('select evidence from public.pokejam_match_evidence')).map((r) => r.evidence)).toEqual(['gz1:NEW']);
  });
});

describe('crash reports', () => {
  it('anyone can report, signed in or not; the same crash is one row with a count; nobody can read them back', async () => {
    const t = await testDb();
    const a = await t.user('A');
    const anon = t.as('anon', null);
    const report = (who: typeof anon, msg: string, stack = 'Error\n    at play (game.js:10:5)') =>
      who('select public.pokejam_report_error($1, $2, $3, $4, $5)', [msg, stack, '/quick', 'b1', 'UA']);
    for (let i = 0; i < 5; i++) await report(anon, 'TypeError: boom');
    await report(a.sql, 'TypeError: boom');
    await report(anon, 'TypeError: other');
    await report(anon, 'x'.repeat(5000), 'y'.repeat(9000));
    const rows = await t.sql('select message, count, length(message) as ml, length(stack) as sl from public.pokejam_errors order by count desc');
    expect(rows[0]).toMatchObject({ message: 'TypeError: boom', count: 6 });
    expect(rows).toHaveLength(3);
    expect(Math.max(...rows.map((r) => Number(r.ml)))).toBeLessThanOrEqual(300);
    expect(Math.max(...rows.map((r) => Number(r.sl)))).toBeLessThanOrEqual(2000);
    await expect(anon('select * from public.pokejam_errors')).rejects.toThrow(/permission denied/);
    await expect(a.sql('select * from public.pokejam_error_summary(1)')).rejects.toThrow(/permission denied/);
    expect((await t.service('select * from public.pokejam_error_summary(1)'))[0]).toMatchObject({ message: 'TypeError: boom', count: 6 });
  });

  it('a flood of made-up errors stops at the daily cap', async () => {
    const t = await testDb();
    await t.sql("insert into public.pokejam_errors(fingerprint, message) select md5(g::text), 'x' from generate_series(1, 2000) g");
    await t.as('anon', null)('select public.pokejam_report_error($1)', ['one more']);
    expect((await t.sql('select count(*)::int as n from public.pokejam_errors'))[0].n).toBe(2000);
  });
});

describe('the moderation page', () => {
  it('only listed moderators can see reports or act; players get nothing', async () => {
    const t = await testDb();
    const [mod, a, b] = [await t.user('Mod'), await t.user('A'), await t.user('B')];
    for (const fn of ['pokejam_admin_reports', 'pokejam_admin_bans', 'pokejam_admin_history']) await expect(a.call(fn)).rejects.toThrow(/moderators only/);
    await expect(a.call('pokejam_admin_ban', [b.id, 24, 'x'])).rejects.toThrow(/moderators only/);
    expect(await a.call('pokejam_is_admin')).toBe(false);
    await expect(a.sql('insert into public.pokejam_admins(user_id) values ($1)', [a.id])).rejects.toThrow(/permission denied/);
    await t.sql("insert into public.pokejam_admins(user_id, note) values ($1, 'Mod')", [mod.id]);
    expect(await mod.call('pokejam_is_admin')).toBe(true);
    expect(await mod.call('pokejam_admin_reports')).toEqual([]);
  });

  it('reported players come grouped by how many opponents reported them, and actions are logged', async () => {
    const t = await testDb();
    const mod = await t.user('Mod');
    await t.sql("insert into public.pokejam_admins(user_id, note) values ($1, 'kungFuDOOM')", [mod.id]);
    const troll = await t.user('Trolly');
    for (let i = 0; i < 3; i++) {
      const v = await t.user(`Victim ${i}`);
      const code = await troll.call<string>('pokejam_create_room', [120]);
      const mid = await v.call<string>('pokejam_join_room', [code]);
      await v.call('pokejam_report_player', [mid, i === 0 ? 'cheating' : 'name', `note ${i}`]);
    }
    const rows = await mod.call<{ name: string; reporters: number; reports: number; reasons: Record<string, number>; latest: { note: string; from: string }[]; banned_until: string | null }[]>('pokejam_admin_reports', [7]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'Trolly', reporters: 3, reports: 3, reasons: { name: 2, cheating: 1 }, banned_until: null });
    expect(rows[0].latest.map((l) => l.from).sort()).toEqual(['Victim 0', 'Victim 1', 'Victim 2']);
    await mod.call('pokejam_admin_reset_name', [troll.id]);
    await mod.call('pokejam_admin_ban', [troll.id, 24, 'name and cheating reports']);
    expect((await mod.call<{ name: string }[]>('pokejam_admin_bans')).map((b) => b.name)).toEqual(['Trainer']);
    await expect(troll.call('pokejam_find_match', ['social'])).rejects.toThrow(/suspended/);
    await mod.call('pokejam_admin_unban', [troll.id]);
    expect(await mod.call('pokejam_admin_bans')).toEqual([]);
    const log = await mod.call<{ action: string; by: string; detail: string | null }[]>('pokejam_admin_history', [10]);
    expect(log.map((l) => l.action)).toEqual(['unban', 'ban', 'reset name']);
    expect(log.every((l) => l.by === 'kungFuDOOM')).toBe(true);
    expect(log[2].detail).toBe('Trolly');
  });

  it('a permanent ban is one with no hours', async () => {
    const t = await testDb();
    const [mod, x] = [await t.user('Mod'), await t.user('X')];
    await t.sql('insert into public.pokejam_admins(user_id) values ($1)', [mod.id]);
    await mod.call('pokejam_admin_ban', [x.id, 0, 'permanent']);
    const until = new Date((await mod.call<{ until: string }[]>('pokejam_admin_bans'))[0].until).getTime();
    expect(until - Date.now()).toBeGreaterThan(50 * 365 * 24 * 3600 * 1000);
  });
});

describe('the Social draft (#28)', () => {
  interface Pick { side: number; dex: number; pos: string; auto: boolean }
  interface View { pool: { dex: number; pos: string }[]; first: number; picks: Pick[]; done: boolean; me: number; turn: number; on_turn: number | null; seconds_left: number; opponent_seen_ago: number | null }
  type U = Awaited<ReturnType<Db['user']>>;

  /** A Social match and both players' first look at its draft. */
  async function drafting() {
    const t = await testDb();
    const [a, b] = [await t.user('Ash'), await t.user('Misty')];
    const mid = await quickPair(t, a, b);
    const info = await a.call<Record<string, string>>('pokejam_match_info', [mid]);
    const [host, guest] = info.host === a.id ? [a, b] : [b, a];
    const v = await host.call<View>('pokejam_draft_state', [mid]);
    await guest.call<View>('pokejam_draft_state', [mid]);
    return { t, mid, host, guest, v, by: (side: number) => (side === 0 ? host : guest) };
  }
  /** A legal pick for whoever is on turn: the first pool Pokemon at a position they still need. */
  const legal = (v: View, side: number) => {
    const mine = new Set(v.picks.filter((p) => p.side === side).map((p) => p.pos));
    const taken = new Set(v.picks.map((p) => p.dex));
    return v.pool.find((m) => !taken.has(m.dex) && !mine.has(m.pos))!.dex;
  };
  const expire = (t: Db, mid: string) => t.sql("update public.pokejam_drafts set deadline = now() - interval '1 second' where match_id = $1", [mid]);

  it('the pool is 6 Pokemon per position from the game list, and the first pick is a coin flip', async () => {
    const { v } = await drafting();
    expect(v.pool).toHaveLength(30);
    for (const pos of ['PG', 'SG', 'SF', 'PF', 'C']) expect(v.pool.filter((m) => m.pos === pos)).toHaveLength(6);
    expect([0, 1]).toContain(v.first);
    expect(v.turn).toBe(0);
    expect(v.on_turn).toBe(v.first);
    expect(v.seconds_left).toBeGreaterThan(12);
    const firsts = new Set<number>();
    for (let i = 0; i < 12 && firsts.size < 2; i++) firsts.add((await drafting()).v.first);
    expect(firsts.size).toBe(2);
  });

  it('snake order A B B A A B B A A B, one per position each, and both players end with identical rosters in match info', async () => {
    const { mid, host, guest, v, by } = await drafting();
    const order: number[] = [];
    let view = v;
    for (let i = 0; i < 10; i++) {
      const side = view.on_turn!;
      order.push(side);
      view = await by(side).call<View>('pokejam_draft_pick', [mid, legal(view, side)]);
    }
    const A = v.first;
    const B = 1 - A;
    expect(order).toEqual([A, B, B, A, A, B, B, A, A, B]);
    expect(view.done).toBe(true);
    for (const side of [0, 1]) expect(view.picks.filter((p) => p.side === side).map((p) => p.pos).sort()).toEqual(['C', 'PF', 'PG', 'SF', 'SG']);
    const ih = await host.call<Record<string, number[]>>('pokejam_match_info', [mid]);
    const ig = await guest.call<Record<string, number[]>>('pokejam_match_info', [mid]);
    expect([ih.host_roster, ih.guest_roster]).toEqual([ig.host_roster, ig.guest_roster]);
    expect(ih.host_roster).toEqual(['PG', 'SG', 'SF', 'PF', 'C'].map((pos) => view.picks.find((p) => p.side === 0 && p.pos === pos)!.dex));
    await expect(by(0).call('pokejam_draft_pick', [mid, view.pool[0].dex])).rejects.toThrow(/draft is over/);
  });

  it('refuses a pick out of turn, a Pokemon already taken, a second at one position, or one not in the pool', async () => {
    const { mid, v, by } = await drafting();
    const A = v.first;
    const B = 1 - A;
    await expect(by(B).call('pokejam_draft_pick', [mid, legal(v, B)])).rejects.toThrow(/not your turn/);
    const first = legal(v, A);
    const after = await by(A).call<View>('pokejam_draft_pick', [mid, first]);
    await expect(by(B).call('pokejam_draft_pick', [mid, first])).rejects.toThrow(/already picked/);
    await expect(by(B).call('pokejam_draft_pick', [mid, 99999])).rejects.toThrow(/not in the pool/);
    const v2 = await by(B).call<View>('pokejam_draft_pick', [mid, legal(after, B)]);
    const bPos = v2.picks[1].pos;
    const samePos = v2.pool.find((m) => m.pos === bPos && !v2.picks.some((p) => p.dex === m.dex))!.dex;
    await expect(by(B).call('pokejam_draft_pick', [mid, samePos])).rejects.toThrow(/already have a/);
  });

  it('when time runs out the server makes a random legal pick, and a long absence makes several at once', async () => {
    const { t, mid, v, by } = await drafting();
    const A = v.first;
    await expire(t, mid);
    const v1 = await by(1 - A).call<View>('pokejam_draft_state', [mid]);
    expect(v1.picks).toHaveLength(1);
    expect(v1.picks[0]).toMatchObject({ side: A, auto: true });
    // Everyone gone for a minute: the overdue picks are all made (one per 12 s of absence), each legal.
    await t.sql("update public.pokejam_drafts set deadline = now() - interval '60 seconds' where match_id = $1", [mid]);
    const v2 = await by(A).call<View>('pokejam_draft_state', [mid]);
    expect(v2.picks.length).toBeGreaterThanOrEqual(6);
    for (const side of [0, 1]) {
      const pos = v2.picks.filter((p) => p.side === side).map((p) => p.pos);
      expect(new Set(pos).size).toBe(pos.length);
    }
    expect(new Set(v2.picks.map((p) => p.dex)).size).toBe(v2.picks.length);
    // And a draft left alone long enough finishes with full, legal rosters.
    await t.sql("update public.pokejam_drafts set deadline = now() - interval '10 minutes' where match_id = $1", [mid]);
    const v3 = await by(A).call<View>('pokejam_draft_state', [mid]);
    expect(v3.done).toBe(true);
    expect(v3.picks).toHaveLength(10);
  });

  it('only the two players see the draft; Ranked matches have none; each side can tell when the other went quiet', async () => {
    const { t, mid, host, guest } = await drafting();
    const outsider = await t.user('Gary');
    await expect(outsider.call('pokejam_draft_state', [mid])).rejects.toThrow(/not in this match/);
    await expect(outsider.call('pokejam_draft_pick', [mid, 25])).rejects.toThrow(/not in this match/);
    await expect(host.sql('select * from public.pokejam_drafts')).rejects.toThrow(/permission denied/);
    await t.sql("update public.pokejam_drafts set guest_seen = now() - interval '40 seconds' where match_id = $1", [mid]);
    expect((await host.call<View>('pokejam_draft_state', [mid])).opponent_seen_ago).toBeGreaterThan(30);
    expect((await guest.call<View>('pokejam_draft_state', [mid])).opponent_seen_ago).toBeLessThan(5);
    const [c, d] = [await t.user('C'), await t.user('D')];
    expect(await c.call('pokejam_find_match', ['ranked'])).toBeNull();
    const rid = await d.call<string>('pokejam_find_match', ['ranked']);
    await expect(c.call('pokejam_draft_state', [rid])).rejects.toThrow(/no draft for this match/);
  });
});
