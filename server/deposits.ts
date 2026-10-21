// Deposit scanner. Players send USDC from the wallet they signed in with to the house USDC account;
// this polls that account's transactions and credits each transfer to the sender's balance.
//
// A transfer from a wallet nobody signed in with (an exchange withdrawal, say) is recorded but not
// credited; it shows up in /api/admin/unmatched-deposits for a manual credit.

import type { Config } from './config';
import { kvGet, kvSet, now, post, type Db } from './db';
import { usdcReceived, type Rpc } from './solana';

const CURSOR = 'deposits.cursor';

export class DepositScanner {
  private running = false;

  constructor(private db: Db, private rpc: Rpc, private cfg: Config, private log = console) {}

  /** Scan new transactions on the house USDC account. Safe to call any time; overlapping calls are skipped. */
  async scan(): Promise<number> {
    if (this.running || !this.cfg.houseUsdcAccount) return 0;
    this.running = true;
    try {
      const cursor = kvGet(this.db, CURSOR) ?? undefined;
      // Walk back from the newest signature to the cursor, then process oldest first.
      const found: { signature: string; slot: number }[] = [];
      let before: string | undefined;
      for (let page = 0; page < 20; page++) {
        const sigs = await this.rpc.signaturesFor(this.cfg.houseUsdcAccount, { until: cursor, before, limit: 100, commitment: this.cfg.depositCommitment });
        found.push(...sigs.filter((s) => !s.err).map((s) => ({ signature: s.signature, slot: s.slot })));
        if (sigs.length < 100) break;
        before = sigs[sigs.length - 1].signature;
      }
      let credited = 0;
      for (const s of found.reverse()) {
        if (this.db.query('select 1 from deposits where signature = ?').get(s.signature)) continue;
        const tx = await this.rpc.transaction(s.signature, this.cfg.depositCommitment);
        // Not visible at this commitment yet: stop here so the cursor never moves past it.
        if (!tx) break;
        const got = usdcReceived(tx, this.cfg.houseUsdcAccount, this.cfg.usdcMint);
        const user = got?.sender ? this.db.query('select wallet from users where wallet = ?').get(got.sender) as { wallet: string } | null : null;
        this.db.transaction(() => {
          this.db.query('insert into deposits (signature, wallet, sender, amount, slot, created_at) values (?, ?, ?, ?, ?, ?)')
            .run(s.signature, user?.wallet ?? null, got?.sender ?? null, got?.amount ?? 0, s.slot, (tx.blockTime ?? 0) * 1000 || now());
          if (got && user) post(this.db, user.wallet, got.amount, 'deposit', s.signature);
        })();
        if (got && user) credited++;
        else if (got) this.log.warn(`deposit ${s.signature}: ${got.amount} from ${got.sender ?? 'unknown'} has no matching player`);
        kvSet(this.db, CURSOR, s.signature);
      }
      return credited;
    } finally {
      this.running = false;
    }
  }

  start() {
    const tick = () => this.scan().catch((e) => this.log.error('deposit scan failed:', (e as Error).message));
    void tick();
    return setInterval(tick, this.cfg.depositPollSeconds * 1000);
  }
}
