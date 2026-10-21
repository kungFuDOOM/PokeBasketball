// Prize worker: sends each winner their card, and handles the rare battle whose pull wasn't bought.
//
//   pending -> sending -> sent
// A pending prize normally has its card already (bought and opened before tip-off, sitting in the house
// wallet): the worker transfers it to the winner. If someone forfeited during the draft, nothing was
// bought yet: the worker buys the pull first, then sends it.
//
// Every step is safe to retry. Before sending, deliver() checks on-chain who owns the card: if the winner
// already does, it's done; if the house does, it sends. A purchase is resumed from its saved memo, never
// bought twice. The only case that needs a person: a purchase that crashed after CC may have charged the
// house but before the memo was saved. That prize is parked with a note.

import { PACK_TIERS, type PackSource, type PackTier, type Pull } from '../src/battles/service';
import { MICRO } from '../src/net/protocol';
import { now, type Db } from './db';
import type { Rpc } from './solana';

const MAX_ATTEMPTS = 8;

interface PrizeRow {
  id: string; battle_id: string; wallet: string | null; tier: PackTier; state: string; attempts: number;
  memo: string | null; nft_address: string | null; pull: string | null;
}

type Source = PackSource & { verifyUrl(memo: string): string; vrfUrl(memo: string): string; buyback?(nft: string): Promise<{ memo: string; refundAmount: unknown }> };

export class PayoutWorker {
  private busy = false;

  constructor(
    private db: Db,
    private source: Source | null,
    private opts: { rpc: Rpc | null; houseUsdcAccount: string; pollSeconds: number },
    private log = console,
  ) {}

  /** After a restart: anything mid-step goes back in the queue (every step re-checks before acting). */
  recover() {
    this.db.query("update prizes set state = 'pending', next_try_at = 0, updated_at = ? where state = 'sending' and (nft_address is not null or memo is not null)").run(now());
    const n = this.db.query("update prizes set state = 'failed', attempts = ?, last_error = ?, updated_at = ? where state = 'sending' and nft_address is null and memo is null")
      .run(MAX_ATTEMPTS, 'Interrupted while buying: check Collector Crypt for a pack bought by the house for this battle before retrying', now()).changes;
    if (n) this.log.warn(`payouts: ${n} interrupted purchase(s) need an admin check`);
  }

  async runOnce(): Promise<number> {
    if (this.busy || !this.source) return 0;
    this.busy = true;
    let sent = 0;
    try {
      const due = this.db.query(`select * from prizes where (state = 'pending' or (state = 'failed' and attempts < ?)) and wallet is not null and next_try_at <= ?
        order by created_at limit 10`).all(MAX_ATTEMPTS, now()) as PrizeRow[];
      for (const p of due) if (await this.pay(p)) sent++;
    } finally {
      this.busy = false;
    }
    return sent;
  }

  private async pay(p: PrizeRow): Promise<boolean> {
    const src = this.source!;
    const claimed = this.db.query("update prizes set state = 'sending', updated_at = ? where id = ? and state in ('pending', 'failed')").run(now(), p.id).changes;
    if (!claimed) return false;
    let paidBeforeError = !!p.memo || !!p.nft_address;
    try {
      let nft = p.nft_address;
      if (!nft) {
        // Forfeit during the draft: buy the pull for the winner now.
        if (!p.memo && this.opts.rpc && this.opts.houseUsdcAccount) {
          const have = await this.opts.rpc.tokenBalance(this.opts.houseUsdcAccount);
          const need = PACK_TIERS[p.tier].price * (MICRO / 100);
          if (have < need) throw new Error(`House wallet has ${have / MICRO} USDC, needs ${need / MICRO}`);
        }
        const pull: Pull = await src.buy(p.tier, p.battle_id, {
          resumeMemo: p.memo ?? undefined,
          onPaid: (memo) => {
            paidBeforeError = true;
            this.db.query('update prizes set memo = ?, updated_at = ? where id = ?').run(memo, now(), p.id);
          },
        });
        const stored = JSON.stringify({ ...pull, verifyUrl: src.verifyUrl(pull.memo), vrfUrl: src.vrfUrl(pull.memo) });
        this.db.query('update prizes set memo = ?, nft_address = ?, rarity = ?, pull = ?, updated_at = ? where id = ?').run(pull.memo, pull.nftAddress, pull.rarity, stored, now(), p.id);
        nft = pull.nftAddress;
      }
      const sig = await src.deliver(nft, p.wallet!);
      this.db.query("update prizes set state = 'sent', transfer_sig = ?, last_error = null, updated_at = ? where id = ?").run(sig, now(), p.id);
      this.log.info(`payouts: ${p.id} sent ${nft} to ${p.wallet} (${sig})`);
      return true;
    } catch (e) {
      const attempts = p.attempts + 1;
      const msg = (e as Error).message;
      // Safe to retry: the card exists (delivery re-checks ownership), the memo is saved (resume), or CC
      // refused before taking payment. Unknown: the purchase may have been charged without a memo.
      const refusedBeforePayment = /\/api\/generatePack\b/.test(msg) || /^House wallet has/.test(msg);
      const retryable = paidBeforeError || refusedBeforePayment;
      this.db.query("update prizes set state = 'failed', attempts = ?, last_error = ?, next_try_at = ?, updated_at = ? where id = ?")
        .run(retryable ? attempts : MAX_ATTEMPTS, retryable ? msg : `${msg} (may have been charged: check Collector Crypt before retrying)`,
          now() + Math.min(3600_000, 15_000 * 2 ** attempts), now(), p.id);
      this.log.error(`payouts: ${p.id} failed: ${msg}`);
      return false;
    }
  }

  /** Admin: send a parked prize again (after checking Collector Crypt that a first purchase didn't land). */
  retry(id: string) {
    return this.db.query("update prizes set state = 'pending', attempts = 0, next_try_at = 0, updated_at = ? where id = ? and state = 'failed'").run(now(), id).changes === 1;
  }

  /** Admin: sell a voided battle's card back to Collector Crypt (within 72 hours of the pull). */
  async buyback(id: string) {
    const p = this.db.query("select * from prizes where id = ? and state = 'house'").get(id) as PrizeRow | null;
    if (!p?.nft_address || !this.source?.buyback) return null;
    const r = await this.source.buyback(p.nft_address);
    this.db.query("update prizes set state = 'bought_back', last_error = ?, updated_at = ? where id = ?").run(`sold back: ${JSON.stringify(r)}`, now(), id);
    return r;
  }

  start() {
    const tick = () => this.runOnce().catch((e) => this.log.error('payouts:', (e as Error).message));
    return setInterval(tick, this.opts.pollSeconds * 1000);
  }
}
