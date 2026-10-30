// Pack Battles over the pokejam_pack_* RPCs (migration 20261103_pokejam_pack_battles.sql). Every write is a server
// function: the client never moves money, picks the game or decides the winner.
import type { OnlineMatch, RpcClient, SupabaseMatchService } from '../shared/onlineMatchService';
import { OnlineError } from '../shared/onlineMatchService';

export type PackTier = 'pokemon_25' | 'pokemon_50' | 'pokemon_100';
export const TIER_ORDER: PackTier[] = ['pokemon_25', 'pokemon_50', 'pokemon_100'];

/** How each tier looks. The pot is the price of Collector Crypt's pack; the server holds the real numbers. */
export const TIERS: Record<PackTier, { label: string; short: string; art: string; color: string; color2: string }> = {
  pokemon_25: { label: 'Starter Pack', short: 'STARTER', art: 'art/pack-battle/pack-starter.jpg', color: '#3b6fd8', color2: '#0f1a45' },
  pokemon_50: { label: 'Elite Pack', short: 'ELITE', art: 'art/pack-battle/pack-elite.jpg', color: '#e3350d', color2: '#3d0a03' },
  pokemon_100: { label: 'Bronze Pack', short: 'BRONZE', art: 'art/pack-battle/pack-bronze.jpg', color: '#ffcb05', color2: '#5c3d00' },
};

export interface TierView {
  code: PackTier;
  pot: number;
  cost: { stake: number; fee: number };
  available: boolean;
  why: string | null;
  odds: Record<string, number> | null;
  ev: number | null;
  buyback: number | null;
}

/** A pulled card, as the payout worker saved it. */
export interface Pull { name: string; image: string | null; grade: string | null; rarity: string | null; insuredValue: number | null; verifyUrl?: string }

export interface PrizeView {
  id: string;
  battle_id: string;
  state: 'pending' | 'sending' | 'revealed' | 'sent' | 'cashed' | 'refunded' | 'failed';
  tier: PackTier;
  price_micro: number;
  pull: Pull | null;
  sell_estimate: number | null;
  choose_by: string | null;
  choice: 'keep' | 'sell' | null;
  cash_amount: number | null;
  nft_address: string | null;
  transfer_sig: string | null;
  prefer_cash?: boolean;
}

export interface Lobby {
  balance: number;
  test_credits: boolean;
  paused: boolean;
  tiers: TierView[];
  searching: { tier: PackTier; since: string } | null;
  prizes: PrizeView[];
}

export interface BattleView {
  state: 'playing' | 'won' | 'void' | 'review';
  tier: PackTier;
  pot: number;
  outcome: string | null;
  note: string | null;
  won: boolean;
  prize: PrizeView | null;
}

/** USDC base units → "$12.50" (whole dollars without cents). */
export const usd = (micro: number) => {
  const d = Number(micro) / 1e6;
  return `$${Number.isInteger(d) ? d : d.toFixed(2)}`;
};

/** A Solana address (base58, 32 to 44 characters), as the server checks it. */
export const validWallet = (w: string) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(w.trim());

const POLL_MS = 2000;
const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>((res, rej) => {
  const t = setTimeout(res, ms);
  signal?.addEventListener('abort', () => { clearTimeout(t); rej(new DOMException('aborted', 'AbortError')); }, { once: true });
});

export class PackService {
  constructor(private db: RpcClient, readonly match: SupabaseMatchService,
    /** Runs the human check when the server asks for one; `force` after a refusal. */
    private human: (force: boolean) => Promise<void> = async () => {},
    /** Asks the judge to look now rather than on its next minute (best effort). */
    private nudgeJudge: () => Promise<void> = async () => {}) {}

  private async call<T>(fn: string, args?: Record<string, unknown>): Promise<T> {
    const { data, error } = await this.db.rpc(fn, args);
    if (error) throw new OnlineError(error.message);
    return data as T;
  }

  async lobby(): Promise<Lobby> {
    const l = await this.call<Lobby>('pokejam_pack_lobby');
    return { ...l, balance: Number(l.balance), tiers: l.tiers ?? [], prizes: l.prizes ?? [] };
  }

  /** Devnet test site: $100 of test USDC into my balance (once a day). Returns the new balance. */
  async testCredit(): Promise<number> {
    return Number(await this.call<number>('pokejam_pack_test_credit'));
  }

  /**
   * Enter a tier and wait for an opponent. The entry is paid on the first call (the server refuses if the balance
   * can't cover it); aborting leaves the queue and the entry is refunded.
   */
  async find(tier: PackTier, wallet: string, preferCash: boolean, signal?: AbortSignal): Promise<OnlineMatch> {
    const args = { p_tier: tier, p_wallet: wallet.trim(), p_prefer_cash: preferCash };
    try {
      await this.human(false);
      for (;;) {
        let id: string | null;
        try {
          id = await this.call<string | null>('pokejam_pack_find', args);
        } catch (e) {
          if (!/human check needed/i.test((e as Error).message)) throw e;
          await this.human(true);
          id = await this.call<string | null>('pokejam_pack_find', args);
        }
        if (id) return await this.match.matchInfo(id);
        await sleep(POLL_MS, signal);
      }
    } catch (e) {
      if (signal?.aborted) await this.leave();
      throw e;
    }
  }

  /** Stop searching: the entry comes back to my balance. */
  async leave() {
    await this.call('pokejam_pack_leave').catch(() => {});
  }

  battle(matchId: string): Promise<BattleView | null> {
    return this.call<BattleView | null>('pokejam_pack_battle', { p_match: matchId });
  }

  /** Keep the revealed card or sell it back. False if it isn't waiting for a pick any more. */
  choose(prizeId: string, choice: 'keep' | 'sell'): Promise<boolean> {
    return this.call<boolean>('pokejam_pack_choose_prize', { p_id: prizeId, p_choice: choice });
  }

  nudge(): Promise<void> {
    return this.nudgeJudge().catch(() => {});
  }
}
