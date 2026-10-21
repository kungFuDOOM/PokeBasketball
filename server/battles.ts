// Battle lifecycle and escrow.
//
//   open      host posted and paid their half (ledger 'entry'); anyone else can accept
//   ready     guest accepted and paid their half; waiting for both to connect
//   drafting  live snake draft
//   playing   the game is running on the server
//   done      someone won (or forfeited); a prize row is queued for the winner's pull
//   cancelled host cancelled before anyone accepted; host refunded
//   void      it couldn't be played (no-show, server restart, both left); both refunded
//
// Fairness. Four sources go into every game's seed, and no single party controls the result:
//   1. Server seed: picked at create; only sha256(server seed) is published until the game is over.
//   2. Host seed and 3. guest seed: each player's own random value, sent when they post or accept.
//   4. Collector Crypt's VRF output for this battle's own pull. After the draft the house buys and opens
//      the pull; CC's VRF (RFC 9381 ECVRF over the house's payment signature, committed on-chain)
//      picks the card, and its output is unknown to everyone until then, the server included.
// game seed = first 4 bytes of sha256(SEED_RECIPE ':' server ':' host ':' guest ':' battle id ':' VRF output).
// After the game, the server seed, every tick of input and the pull's memo are published; anyone can
// check the VRF with Collector Crypt and replay the game (server/verify.ts).

import { PACK_TIERS, type PackTier } from '../src/battles/service';
import { MICRO, type BattleView, type PlayerRef, type Proof, type PullView } from '../src/net/protocol';
import type { Pull } from '../src/battles/service';
import type { Config } from './config';
import { HttpError } from './auth';
import { InsufficientFunds, balanceOf, now, post, type Db } from './db';
import { hex, randomBytes, randomId, sha256 } from './lib/bytes';

export const QUARTERS = [60, 120, 180];

export const priceOf = (tier: PackTier) => PACK_TIERS[tier].price * (MICRO / 100);
export const entryOf = (tier: PackTier) => priceOf(tier) / 2;

export interface BattleRow {
  id: string; tier: PackTier; quarter_len: number; state: BattleView['state'];
  host: string; guest: string | null; host_name: string; guest_name: string | null;
  server_seed: string; commit_hash: string; host_seed: string; guest_seed: string | null; seed: number | null;
  winner: 0 | 1 | null; score_h: number | null; score_g: number | null; forfeit: number; void_reason: string | null;
  cc_memo: string | null; cc_pull: string | null; proof: string | null; created_at: number; accepted_at: number | null; finished_at: number | null;
}

export function getBattle(db: Db, id: string): BattleRow | null {
  return db.query('select * from battles where id = ?').get(id) as BattleRow | null;
}

export function view(b: BattleRow, viewer?: string | null): BattleView {
  const ref = (wallet: string | null, name: string | null): PlayerRef | null => (wallet ? { wallet, teamName: name ?? 'Challenger' } : null);
  return {
    id: b.id, tier: b.tier, quarterLen: b.quarter_len, state: b.state,
    host: ref(b.host, b.host_name)!, guest: ref(b.guest, b.guest_name),
    winner: b.winner, score: b.score_h === null || b.score_g === null ? null : [b.score_h, b.score_g],
    forfeit: !!b.forfeit, commit: b.commit_hash, createdAt: b.created_at,
    side: viewer ? (viewer === b.host ? 0 : viewer === b.guest ? 1 : null) : null,
    pull: pullView(b.cc_pull),
  };
}

/** A stored pull, without the raw VRF record (that's in the proof). */
export function pullView(json: string | null): PullView | null {
  if (!json) return null;
  const { vrf: _vrf, ...rest } = JSON.parse(json) as PullView & { vrf?: unknown };
  void _vrf;
  return rest;
}

const cleanSeed = (s: unknown) => (typeof s === 'string' && /^[0-9a-f]{16,64}$/i.test(s) ? s.toLowerCase() : hex(randomBytes(16)));

export const SEED_RECIPE = 'pokejam-seed-v2';
export const DRAFT_RECIPE = 'pokejam-draft-v1';

/** Who picks first in the draft (0 host, 1 guest), from the three committed seeds. */
export async function firstPick(serverSeed: string, hostSeed: string, guestSeed: string, battleId: string): Promise<0 | 1> {
  const h = await sha256(`${DRAFT_RECIPE}:${serverSeed}:${hostSeed}:${guestSeed}:${battleId}`);
  return (h[0] & 1) as 0 | 1;
}

/** Game seed from the four sources: the first 4 bytes of sha256, as an unsigned int (big-endian). */
export async function deriveSeed(serverSeed: string, hostSeed: string, guestSeed: string, battleId: string, vrfEntropy: string): Promise<number> {
  const h = await sha256(`${SEED_RECIPE}:${serverSeed}:${hostSeed}:${guestSeed}:${battleId}:${vrfEntropy}`);
  return ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
}

export function blockedReason(db: Db, cfg: Config, wallet: string): string | null {
  const u = db.query('select adult, region from users where wallet = ?').get(wallet) as { adult: number | null; region: string | null } | null;
  if (!u || u.adult === null || !u.region) return 'Confirm your age and state to play paid battles.';
  if (!u.adult) return 'Paid battles are 18+.';
  if (cfg.restrictedRegions.includes(u.region)) return `Paid battles aren't available in ${u.region}.`;
  return null;
}

const teamName = (db: Db, wallet: string) =>
  (db.query('select team_name from users where wallet = ?').get(wallet) as { team_name: string } | null)?.team_name ?? 'Pallet Town';

export async function createBattle(db: Db, cfg: Config, wallet: string, tier: unknown, quarterLen: unknown, clientSeed: unknown): Promise<BattleRow> {
  if (typeof tier !== 'string' || !(tier in PACK_TIERS)) throw new HttpError(400, 'Unknown pack');
  if (typeof quarterLen !== 'number' || !QUARTERS.includes(quarterLen)) throw new HttpError(400, 'Quarter length must be 1, 2 or 3 minutes');
  const why = blockedReason(db, cfg, wallet);
  if (why) throw new HttpError(403, why);
  const open = db.query("select count(*) as n from battles where host = ? and state = 'open'").get(wallet) as { n: number };
  if (open.n >= cfg.maxOpenBattlesPerPlayer) throw new HttpError(429, `You can have ${cfg.maxOpenBattlesPerPlayer} open battles at a time.`);
  const id = randomId(10);
  const serverSeed = hex(randomBytes(32));
  const commit = hex(await sha256(serverSeed));
  try {
    db.transaction(() => {
      db.query(`insert into battles (id, tier, quarter_len, state, host, host_name, server_seed, commit_hash, host_seed, created_at)
        values (?, ?, ?, 'open', ?, ?, ?, ?, ?, ?)`).run(id, tier, quarterLen, wallet, teamName(db, wallet), serverSeed, commit, cleanSeed(clientSeed), now());
      post(db, wallet, -entryOf(tier as PackTier), 'entry', `${id}:0`);
    })();
  } catch (e) {
    if (e instanceof InsufficientFunds) throw new HttpError(402, 'Not enough balance for this battle. Add funds first.');
    throw e;
  }
  return getBattle(db, id)!;
}

export async function acceptBattle(db: Db, cfg: Config, wallet: string, id: string, clientSeed: unknown): Promise<BattleRow> {
  const why = blockedReason(db, cfg, wallet);
  if (why) throw new HttpError(403, why);
  const b = getBattle(db, id);
  if (!b || b.state !== 'open') throw new HttpError(409, 'Someone already took that battle.');
  if (b.host === wallet) throw new HttpError(400, "That's your own battle.");
  const guestSeed = cleanSeed(clientSeed);
  try {
    db.transaction(() => {
      const r = db.query(`update battles set state = 'ready', guest = ?, guest_name = ?, guest_seed = ?, accepted_at = ?
        where id = ? and state = 'open'`).run(wallet, teamName(db, wallet), guestSeed, now(), id);
      if (r.changes !== 1) throw new HttpError(409, 'Someone already took that battle.');
      post(db, wallet, -entryOf(b.tier), 'entry', `${id}:1`);
    })();
  } catch (e) {
    if (e instanceof InsufficientFunds) throw new HttpError(402, 'Not enough balance for this battle. Add funds first.');
    throw e;
  }
  return getBattle(db, id)!;
}

export function cancelBattle(db: Db, wallet: string, id: string): BattleRow {
  const b = getBattle(db, id);
  if (!b || b.host !== wallet) throw new HttpError(404, 'No such battle');
  db.transaction(() => {
    const r = db.query("update battles set state = 'cancelled', finished_at = ? where id = ? and state = 'open'").run(now(), id);
    if (r.changes !== 1) throw new HttpError(409, 'Someone already accepted this battle.');
    post(db, b.host, entryOf(b.tier), 'refund', `${id}:0`);
  })();
  return getBattle(db, id)!;
}

export function setState(db: Db, id: string, state: 'drafting' | 'playing') {
  db.query("update battles set state = ? where id = ? and state in ('ready', 'drafting')").run(state, id);
}

/**
 * Both players get their entry back. If the pull was already bought, the card stays with the house
 * (prize state 'house'); an admin can sell it back to Collector Crypt within 72 hours.
 */
export function voidBattle(db: Db, id: string, reason: string) {
  const b = getBattle(db, id);
  if (!b || !['ready', 'drafting', 'playing'].includes(b.state)) return;
  db.transaction(() => {
    db.query("update battles set state = 'void', void_reason = ?, finished_at = ? where id = ?").run(reason, now(), id);
    post(db, b.host, entryOf(b.tier), 'refund', `${id}:0`);
    if (b.guest) post(db, b.guest, entryOf(b.tier), 'refund', `${id}:1`);
    db.query("update prizes set state = 'house', last_error = ?, updated_at = ? where battle_id = ? and state in ('buying', 'held')").run(`battle voided: ${reason}`, now(), id);
  })();
}

/** The purchase is paid: remember its memo before anything else can fail. */
export function recordPaid(db: Db, id: string, memo: string) {
  const b = getBattle(db, id)!;
  db.transaction(() => {
    db.query('update battles set cc_memo = ? where id = ?').run(memo, id);
    db.query(`insert into prizes (id, battle_id, tier, state, memo, created_at, updated_at) values (?, ?, ?, 'buying', ?, ?, ?)
      on conflict(battle_id) do update set memo = excluded.memo, updated_at = excluded.updated_at`).run(randomId(10), id, b.tier, memo, now(), now());
  })();
}

/** The pull is open and the card is in the house wallet: store it and the seed derived from its VRF output. */
export async function recordPull(db: Db, id: string, pull: Pull, urls: { verifyUrl: string; vrfUrl: string }): Promise<number> {
  const b = getBattle(db, id)!;
  const seed = await deriveSeed(b.server_seed, b.host_seed, b.guest_seed!, b.id, pull.entropy);
  const stored = JSON.stringify({ ...pull, ...urls });
  db.transaction(() => {
    db.query('update battles set cc_memo = ?, cc_pull = ?, seed = ? where id = ?').run(pull.memo, stored, seed, id);
    db.query(`insert into prizes (id, battle_id, tier, state, memo, rarity, nft_address, pull, created_at, updated_at) values (?, ?, ?, 'held', ?, ?, ?, ?, ?, ?)
      on conflict(battle_id) do update set state = 'held', memo = excluded.memo, rarity = excluded.rarity, nft_address = excluded.nft_address, pull = excluded.pull, updated_at = excluded.updated_at`)
      .run(randomId(10), id, b.tier, pull.memo, pull.rarity, pull.nftAddress, stored, now(), now());
  })();
  return seed;
}

/** Record the result and hand the card to the winner (the payout worker sends it). */
export function finishBattle(db: Db, id: string, winner: 0 | 1, score: [number, number], forfeit: boolean, proof: Proof | null) {
  const b = getBattle(db, id);
  if (!b || !['ready', 'drafting', 'playing'].includes(b.state)) return;
  const wallet = winner === 0 ? b.host : b.guest!;
  db.transaction(() => {
    db.query("update battles set state = 'done', winner = ?, score_h = ?, score_g = ?, forfeit = ?, proof = ?, finished_at = ? where id = ?")
      .run(winner, score[0], score[1], forfeit ? 1 : 0, proof ? JSON.stringify(proof) : null, now(), id);
    // A forfeit during the draft happens before the pull is bought: the worker buys it for the winner.
    db.query(`insert into prizes (id, battle_id, wallet, tier, state, created_at, updated_at) values (?, ?, ?, ?, 'pending', ?, ?)
      on conflict(battle_id) do update set wallet = excluded.wallet, state = 'pending', updated_at = excluded.updated_at`)
      .run(randomId(10), id, wallet, b.tier, now(), now());
  })();
}

/** Battles that were mid-draft or mid-game when the server stopped can't be resumed fairly: refund them. */
export function voidInterrupted(db: Db) {
  const rows = db.query("select id from battles where state in ('drafting', 'playing')").all() as { id: string }[];
  for (const r of rows) voidBattle(db, r.id, 'server restarted');
  return rows.length;
}

export const balance = balanceOf;
