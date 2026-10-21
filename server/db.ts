// SQLite storage (bun:sqlite). Money lives in an append-only ledger of integer USDC base units: a
// player's balance is the sum of their rows, and UNIQUE(kind, ref) makes every credit and debit
// idempotent, so a retried request or a re-scanned deposit can never pay twice.

import { Database } from 'bun:sqlite';

export type Db = Database;

const SCHEMA = `
create table if not exists users (
  wallet text primary key,
  team_name text not null default 'Pallet Town',
  adult integer,
  region text,
  created_at integer not null
);
create table if not exists nonces (
  nonce text primary key,
  wallet text not null,
  message text not null,
  expires_at integer not null,
  used integer not null default 0
);
create table if not exists sessions (
  token text primary key,
  wallet text not null,
  expires_at integer not null
);
create table if not exists ledger (
  id integer primary key autoincrement,
  wallet text not null,
  delta integer not null,
  kind text not null,
  ref text not null,
  note text,
  created_at integer not null,
  unique (kind, ref)
);
create index if not exists ledger_wallet on ledger (wallet);
create table if not exists deposits (
  signature text primary key,
  wallet text,
  sender text,
  amount integer not null,
  slot integer,
  created_at integer not null
);
create table if not exists battles (
  id text primary key,
  tier text not null,
  quarter_len integer not null,
  state text not null,
  host text not null,
  guest text,
  host_name text not null,
  guest_name text,
  server_seed text not null,
  commit_hash text not null,
  host_seed text not null,
  guest_seed text,
  seed integer,
  winner integer,
  score_h integer,
  score_g integer,
  forfeit integer not null default 0,
  void_reason text,
  cc_memo text,
  cc_pull text,
  proof text,
  created_at integer not null,
  accepted_at integer,
  finished_at integer
);
create index if not exists battles_state on battles (state);
-- One row per battle's pull. buying (paid, not opened) -> held (card in the house wallet, game on) ->
-- pending (winner known) -> sending -> sent. A voided battle's card stays with the house: house -> bought_back.
create table if not exists prizes (
  id text primary key,
  battle_id text not null unique,
  wallet text,
  tier text not null,
  state text not null,
  memo text,
  rarity text,
  nft_address text,
  pull text,
  transfer_sig text,
  attempts integer not null default 0,
  last_error text,
  next_try_at integer not null default 0,
  created_at integer not null,
  updated_at integer not null
);
create table if not exists withdrawals (
  id text primary key,
  wallet text not null,
  amount integer not null,
  address text not null,
  state text not null,
  signature text,
  note text,
  created_at integer not null,
  updated_at integer not null
);
create table if not exists kv (
  key text primary key,
  value text not null
);
`;

export function openDb(path: string): Db {
  const db = new Database(path, { create: true });
  db.exec('pragma journal_mode = wal; pragma foreign_keys = on; pragma busy_timeout = 5000;');
  db.exec(SCHEMA);
  return db;
}

export const now = () => Date.now();

export function balanceOf(db: Db, wallet: string): number {
  const r = db.query('select coalesce(sum(delta), 0) as b from ledger where wallet = ?').get(wallet) as { b: number };
  return r.b;
}

export class InsufficientFunds extends Error {}

/**
 * Adds one ledger row. Returns false (and changes nothing) if a row with the same kind and ref exists.
 * A negative delta that would take the balance below zero throws InsufficientFunds.
 */
export function post(db: Db, wallet: string, delta: number, kind: string, ref: string, note: string | null = null): boolean {
  if (!Number.isSafeInteger(delta)) throw new Error('ledger amounts are integers');
  return db.transaction(() => {
    const exists = db.query('select 1 from ledger where kind = ? and ref = ?').get(kind, ref);
    if (exists) return false;
    if (delta < 0 && balanceOf(db, wallet) + delta < 0) throw new InsufficientFunds('Not enough balance');
    db.query('insert into ledger (wallet, delta, kind, ref, note, created_at) values (?, ?, ?, ?, ?, ?)').run(wallet, delta, kind, ref, note, now());
    return true;
  })();
}

export function kvGet(db: Db, key: string): string | null {
  const r = db.query('select value from kv where key = ?').get(key) as { value: string } | null;
  return r?.value ?? null;
}

export function kvSet(db: Db, key: string, value: string) {
  db.query('insert into kv (key, value) values (?, ?) on conflict(key) do update set value = excluded.value').run(key, value);
}
