// Where the payout worker keeps prizes: the pokejam_pack_* SQL functions in the migration. Every write is
// one function call, so each step is atomic in Postgres. The same store runs over supabase-js in the Edge
// Function (`sb.rpc(name, args)`) and over a local Postgres in the tests.

import type { Pull } from './collector-crypt.ts';
import type { PackTier } from './tiers.ts';

export type PrizeState = 'pending' | 'sending' | 'revealed' | 'sent' | 'cashed' | 'refunded' | 'failed';

export interface PrizeRow {
  id: string;
  battle_id: string;
  user_id: string;
  wallet: string;
  tier: PackTier;
  price_micro: number;
  prefer_cash: boolean;
  state: PrizeState;
  memo: string | null;
  nft_address: string | null;
  attempts: number;
  /** The opened pull, once there is one. */
  pull: Pull | null;
  /** The winner's pick at the reveal, if they've made one. */
  choice: 'keep' | 'sell' | null;
  /** When the reveal's wait ends (ms since the epoch), once the card has been revealed. */
  choose_by: number | null;
}

/** Calls one SQL function by name with named arguments and returns its rows (empty for void). */
export type RpcCall = (fn: string, args: Record<string, unknown>) => Promise<unknown>;

export interface PrizeStore {
  /** Atomically move up to `limit` due prizes to 'sending' and return them. */
  claim(limit: number, maxAttempts: number): Promise<PrizeRow[]>;
  /** After a restart: put prizes stuck in 'sending' back in the queue, or park them if a purchase may be half done. */
  recover(maxAttempts: number): Promise<void>;
  paid(id: string, memo: string): Promise<void>;
  pulled(id: string, pull: Pull & { verifyUrl: string; vrfUrl: string }): Promise<void>;
  /** The card is open: wait up to `waitSeconds` for the winner to keep it or sell it back. */
  revealed(id: string, waitSeconds: number, sellEstimate: number | null): Promise<void>;
  sent(id: string, signature: string): Promise<void>;
  cashed(id: string, amount: number, note: string): Promise<void>;
  refunded(id: string, why: string): Promise<void>;
  failed(id: string, attempts: number, error: string, retryInSeconds: number): Promise<void>;
}

const rows = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v as Record<string, unknown>[] : v ? [v as Record<string, unknown>] : []);
const toRow = (r: Record<string, unknown>): PrizeRow => ({
  id: String(r.id), battle_id: String(r.battle_id), user_id: String(r.user_id), wallet: String(r.wallet),
  tier: r.tier as PackTier, price_micro: Number(r.price_micro), prefer_cash: !!r.prefer_cash, state: r.state as PrizeState,
  memo: (r.memo as string) ?? null, nft_address: (r.nft_address as string) ?? null, attempts: Number(r.attempts),
  pull: r.pull && typeof r.pull === 'object' ? r.pull as Pull : typeof r.pull === 'string' ? JSON.parse(r.pull) as Pull : null,
  choice: r.choice === 'keep' || r.choice === 'sell' ? r.choice : null,
  choose_by: r.choose_by ? new Date(r.choose_by as string | Date).getTime() : null,
});

export function sqlStore(call: RpcCall): PrizeStore {
  return {
    claim: async (limit, maxAttempts) => rows(await call('pokejam_pack_claim_prizes', { p_limit: limit, p_max_attempts: maxAttempts })).map(toRow),
    recover: async (maxAttempts) => { await call('pokejam_pack_recover_prizes', { p_max_attempts: maxAttempts }); },
    paid: async (id, memo) => { await call('pokejam_pack_prize_paid', { p_id: id, p_memo: memo }); },
    pulled: async (id, pull) => {
      await call('pokejam_pack_prize_pulled', { p_id: id, p_memo: pull.memo, p_nft: pull.nftAddress, p_rarity: pull.rarity, p_pull: pull });
    },
    revealed: async (id, waitSeconds, sellEstimate) => {
      await call('pokejam_pack_prize_revealed', { p_id: id, p_wait_seconds: Math.round(waitSeconds), p_sell_estimate: sellEstimate });
    },
    sent: async (id, signature) => { await call('pokejam_pack_prize_sent', { p_id: id, p_sig: signature }); },
    cashed: async (id, amount, note) => { await call('pokejam_pack_prize_cashed', { p_id: id, p_amount: amount, p_note: note }); },
    refunded: async (id, why) => { await call('pokejam_pack_prize_refunded', { p_id: id, p_why: why }); },
    failed: async (id, attempts, error, retryInSeconds) => {
      await call('pokejam_pack_prize_failed', { p_id: id, p_attempts: attempts, p_error: error.slice(0, 1000), p_retry_seconds: retryInSeconds });
    },
  };
}
