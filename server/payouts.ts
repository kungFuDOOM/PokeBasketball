// Prize payout worker: buys each winner's pull from Collector Crypt and records what happened.
//
// A pull costs real money, so this never buys twice for one prize:
//   pending -> sending -> sent      (memo saved; check it any time with GET /api/pack/status?memo=)
//                      -> failed
// The memo is saved the moment Collector Crypt has the payment. A failure before that (CC refused to
// build the purchase, house wallet short) retries automatically with backoff. A failure after it only
// ever resumes that same memo, never buys again. A prize found in 'sending' at startup with no memo
// may or may not have been paid, so it's parked for an admin to check on Collector Crypt first.

import { PACK_TIERS, type PackSource, type PackTier } from '../src/battles/service';
import { MICRO } from '../src/net/protocol';
import { now, type Db } from './db';
import type { Rpc } from './solana';

const MAX_ATTEMPTS = 5;

interface PrizeRow {
  id: string; battle_id: string; wallet: string; tier: PackTier; state: string; attempts: number; memo: string | null;
}

export class PayoutWorker {
  private busy = false;

  constructor(
    private db: Db,
    private source: PackSource | null,
    private opts: { rpc: Rpc | null; houseUsdcAccount: string; pollSeconds: number },
    private log = console,
  ) {}

  /** Park anything a crash interrupted. Call once at startup. */
  recover() {
    // Paid already (memo saved): safe to resume automatically.
    this.db.query("update prizes set state = 'failed', next_try_at = 0, updated_at = ? where state = 'sending' and memo is not null").run(now());
    const n = this.db.query("update prizes set state = 'failed', attempts = ?, last_error = ?, updated_at = ? where state = 'sending' and memo is null")
      .run(MAX_ATTEMPTS, 'Interrupted mid-purchase: check Collector Crypt for this battle before retrying', now()).changes;
    if (n) this.log.warn(`payouts: ${n} interrupted prize(s) need an admin check`);
  }

  async runOnce(): Promise<number> {
    if (this.busy || !this.source) return 0;
    this.busy = true;
    let sent = 0;
    try {
      const due = this.db.query(`select * from prizes where (state = 'pending' or (state = 'failed' and attempts < ?)) and next_try_at <= ?
        order by created_at limit 10`).all(MAX_ATTEMPTS, now()) as PrizeRow[];
      for (const p of due) if (await this.pay(p)) sent++;
    } finally {
      this.busy = false;
    }
    return sent;
  }

  private async pay(p: PrizeRow): Promise<boolean> {
    const claimed = this.db.query("update prizes set state = 'sending', updated_at = ? where id = ? and state in ('pending', 'failed')").run(now(), p.id).changes;
    if (!claimed) return false;
    try {
      if (this.opts.rpc && this.opts.houseUsdcAccount) {
        const have = await this.opts.rpc.tokenBalance(this.opts.houseUsdcAccount);
        const need = PACK_TIERS[p.tier].price * (MICRO / 100);
        if (have < need) throw new RetryableError(`House wallet has ${have / MICRO} USDC, needs ${need / MICRO}`);
      }
      let paidMemo = p.memo;
      const r = await this.source!.award(p.tier, p.wallet, p.battle_id, {
        resumeMemo: p.memo ?? undefined,
        onPaid: (memo, mode) => {
          paidMemo = memo;
          this.db.query('update prizes set memo = ?, mode = ?, updated_at = ? where id = ?').run(memo, mode, now(), p.id);
        },
      });
      p.memo = paidMemo;
      this.db.query("update prizes set state = 'sent', mode = ?, memo = ?, rarity = ?, nft_address = ?, last_error = null, updated_at = ? where id = ?")
        .run(r.mode, r.memo, r.rarity ?? null, r.nftAddress ?? null, now(), p.id);
      this.log.info(`payouts: ${p.id} sent (${r.mode}, memo ${r.memo})`);
      return true;
    } catch (e) {
      const attempts = p.attempts + 1;
      const msg = (e as Error).message;
      const memo = (this.db.query('select memo from prizes where id = ?').get(p.id) as { memo: string | null }).memo;
      // Paid: retry finishing that memo. Refused before payment: retry the purchase. Unknown (submit
      // threw, network dropped mid-call): park it for a human, because it may have been charged.
      const beforePayment = e instanceof RetryableError || /\/api\/(generateGift|generatePack|machines)\b/.test(msg);
      const retryable = !!memo || beforePayment;
      this.db.query("update prizes set state = 'failed', attempts = ?, last_error = ?, next_try_at = ?, updated_at = ? where id = ?")
        .run(retryable ? attempts : MAX_ATTEMPTS, retryable ? msg : `${msg} (may have been charged: check Collector Crypt before retrying)`,
          now() + Math.min(3600_000, 30_000 * 2 ** attempts), now(), p.id);
      this.log.error(`payouts: ${p.id} failed: ${(e as Error).message}`);
      return false;
    }
  }

  /** Admin: send a parked prize again (after checking Collector Crypt that the first try didn't land). */
  retry(id: string) {
    return this.db.query("update prizes set state = 'pending', attempts = 0, next_try_at = 0, updated_at = ? where id = ? and state = 'failed'").run(now(), id).changes === 1;
  }

  start() {
    const tick = () => this.runOnce().catch((e) => this.log.error('payouts:', (e as Error).message));
    return setInterval(tick, this.opts.pollSeconds * 1000);
  }
}

export class RetryableError extends Error {}
