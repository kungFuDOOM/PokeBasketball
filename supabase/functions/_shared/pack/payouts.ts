// Prize worker: buys each winner's pull after the result, then sends the card or its cash value.
//
//   pending -> sending -> revealed  the card is open and shown to the winner, who has choiceSeconds to
//                                   keep it or sell it back (pokejam_pack_choose_prize). The house holds
//                                   the card meanwhile; after the wait, their saved preference applies.
//           -> sending -> sent      the card is in the winner's wallet (they kept it)
//                      -> cashed    they sold it back: the house sold the card to CC and credited the
//                                   buyback to the winner's balance
//                      -> refunded  CC wouldn't sell the pull (machine off, empty, or priced above the pot)
//                                   after a few tries: the winner is credited the whole pot instead
//                      -> failed    retried later with backoff; parked for a person after too many tries
//
// Every step is safe to retry. Before buying, the worker checks CC's live machine and the house's USDC;
// a refusal there (or from CC before payment) costs nothing. A paid purchase is resumed from its saved
// memo, never bought twice, and deliver() checks on-chain who owns the card before sending. The one case
// that needs a person: a crash after CC may have charged the house but before the memo was saved; that
// prize is parked with a note (pokejam_pack_recover_prizes).
//
// Pulls are only ever bought after a battle has a winner, so there is no "card left with the house"
// case to sell back: a battle that's called off is a plain refund in the escrow flow.

import { UnsafeTransaction } from './tx-guard.ts';
import type { CollectorCrypt, Pull } from './collector-crypt.ts';
import { parseMachines, type MachineInfo } from './machines.ts';
import type { Rpc } from './rpc.ts';
import type { PrizeRow, PrizeStore } from './store.ts';
import { MICRO, PACK_TIERS, usd } from './tiers.ts';

export const MAX_ATTEMPTS = 8;

export interface PayoutDeps {
  store: PrizeStore;
  cc: Pick<CollectorCrypt, 'buy' | 'deliver' | 'ownerOf' | 'buyback' | 'machines' | 'verifyUrl' | 'vrfUrl'>;
  /** With both set, the worker checks the house holds enough USDC before buying. */
  rpc?: Pick<Rpc, 'tokenBalance'> | null;
  houseUsdcAccount?: string;
  /** Refusals from CC before the winner is credited the pot instead (default 3). */
  fallbackAfter?: number;
  /** Seconds a revealed card waits for the winner's keep-or-sell pick (default 0: use their saved preference at once). */
  choiceSeconds?: number;
  /** Called with CC's machines whenever the worker reads them (to refresh the lobby's copy). */
  onMachines?(machines: Map<string, MachineInfo>): Promise<void>;
  log?: Pick<Console, 'info' | 'warn' | 'error'>;
}

export type Outcome = 'revealed' | 'sent' | 'cashed' | 'refunded' | 'failed';

/** CC can't sell this pull right now. Nothing was paid, so it's safe to retry, or to refund the pot. */
class Refused extends Error {}

const baseUnits = (v: unknown) => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/** Settle up to `limit` due prizes. */
export async function runPayouts(d: PayoutDeps, limit = 10): Promise<{ id: string; outcome: Outcome }[]> {
  const due = await d.store.claim(limit, MAX_ATTEMPTS);
  const out: { id: string; outcome: Outcome }[] = [];
  for (const p of due) out.push({ id: p.id, outcome: await payOne(d, p) });
  return out;
}

async function readMachines(d: PayoutDeps) {
  const machines = parseMachines(await d.cc.machines());
  await d.onMachines?.(machines).catch((e) => d.log?.warn(`payouts: couldn't save machines: ${(e as Error).message}`));
  return machines;
}

/** Refuse before paying if CC no longer sells this pull within the pot, or the house is short. Returns the machine. */
async function preflight(d: PayoutDeps, p: PrizeRow): Promise<MachineInfo> {
  const m = (await readMachines(d)).get(p.tier);
  const name = PACK_TIERS[p.tier]?.ccName ?? p.tier;
  if (!m) throw new Refused(`Collector Crypt isn't offering the ${name}`);
  if (!m.available) throw new Refused(`Collector Crypt's ${name} machine is ${m.why}`);
  if (m.price > p.price_micro) throw new Refused(`Collector Crypt's ${name} now costs ${usd(m.price)}, more than the ${usd(p.price_micro)} pot`);
  if (d.rpc && d.houseUsdcAccount) {
    const have = await d.rpc.tokenBalance(d.houseUsdcAccount);
    if (have < m.price) throw new Error(`House wallet has ${have / MICRO} USDC, needs ${m.price / MICRO}`);
  }
  return m;
}

/** What the winner might get for selling the card back: its insured value at the machine's buyback rate. */
async function sellEstimate(d: PayoutDeps, p: PrizeRow, pull: Pull | null, machine: MachineInfo | null): Promise<number | null> {
  if (!pull?.insuredValue) return null;
  const rate = machine?.buyback ?? (await readMachines(d).catch(() => null))?.get(p.tier)?.buyback;
  return rate ? Math.round(pull.insuredValue * rate * MICRO) : null;
}

/**
 * Card or cash: the winner's pick, or their saved preference once the reveal's wait is over. Null when the
 * card should wait on the reveal. The pick can't change under us: claiming moved the prize out of 'revealed'.
 */
function decide(d: PayoutDeps, p: PrizeRow): 'card' | 'cash' | null {
  if (p.choice === 'keep') return 'card';
  if (p.choice === 'sell') return 'cash';
  if ((d.choiceSeconds ?? 0) > 0 && (p.choose_by === null || p.choose_by > Date.now())) return null;
  return p.prefer_cash ? 'cash' : 'card';
}

async function payOne(d: PayoutDeps, p: PrizeRow): Promise<Outcome> {
  const log = d.log ?? console;
  let paidBeforeError = !!p.memo || !!p.nft_address;
  try {
    let nft = p.nft_address;
    let pull: Pull | null = p.pull;
    let machine: MachineInfo | null = null;
    if (!nft) {
      if (!p.memo) machine = await preflight(d, p);
      pull = await d.cc.buy(p.tier, {
        maxPrice: Number(p.price_micro),
        resumeMemo: p.memo ?? undefined,
        onPaid: async (memo) => {
          paidBeforeError = true;
          await d.store.paid(p.id, memo);
        },
      });
      await d.store.pulled(p.id, { ...pull, verifyUrl: d.cc.verifyUrl(pull.memo), vrfUrl: d.cc.vrfUrl(pull.memo) });
      nft = pull.nftAddress;
    }
    const want = decide(d, p);
    if (!want) {
      await d.store.revealed(p.id, d.choiceSeconds ?? 0, await sellEstimate(d, p, pull, machine));
      log.info(`payouts: ${p.id} revealed ${nft} to ${p.user_id}; waiting for keep or sell`);
      return 'revealed';
    }
    if (want === 'cash' && (await d.cc.ownerOf(nft)) !== p.wallet) {
      try {
        const r = await d.cc.buyback(nft);
        const amount = baseUnits(r.refundAmount);
        if (!amount) throw new Error(`Collector Crypt quoted an unusable buyback amount (${String(r.refundAmount)})`);
        await d.store.cashed(p.id, amount, `sold back ${nft} (${r.memo})`);
        log.info(`payouts: ${p.id} sold ${nft} back for ${usd(amount)} to ${p.user_id}`);
        return 'cashed';
      } catch (e) {
        // The card is still the house's: send it instead, so a winner is never left with nothing.
        log.warn(`payouts: ${p.id} cash-out failed (${(e as Error).message}); sending the card`);
      }
    }
    const sig = await d.cc.deliver(nft, p.wallet);
    await d.store.sent(p.id, sig);
    log.info(`payouts: ${p.id} sent ${nft} to ${p.wallet} (${sig})`);
    return 'sent';
  } catch (e) {
    const attempts = p.attempts + 1;
    const msg = (e as Error).message;
    // CC handed the house a transaction it won't sign. Nothing was paid, but it may be an attack on the house
    // wallet: park the prize for a person to look at rather than retry or refund it.
    if (e instanceof UnsafeTransaction && !paidBeforeError) {
      await d.store.failed(p.id, MAX_ATTEMPTS, `${msg} (nothing was signed)`, 3600);
      log.error(`payouts: ${p.id} SECURITY: ${msg}`);
      return 'failed';
    }
    // CC said no before taking payment. After a few tries, pay the winner the pot rather than wait on a
    // machine that may not come back.
    const refused = !paidBeforeError && (e instanceof Refused || /\/api\/generatePack\b/.test(msg));
    if (refused && attempts >= (d.fallbackAfter ?? 3)) {
      await d.store.refunded(p.id, msg);
      log.warn(`payouts: ${p.id} credited the ${usd(p.price_micro)} pot to ${p.user_id}: ${msg}`);
      return 'refunded';
    }
    // Safe to retry: the card exists (delivery re-checks ownership), the memo is saved (resume), or CC
    // refused before payment. Unknown: the purchase may have been charged without a memo, so park it.
    const retryable = paidBeforeError || refused || /^House wallet has/.test(msg);
    await d.store.failed(p.id, retryable ? attempts : MAX_ATTEMPTS,
      retryable ? msg : `${msg} (may have been charged: check Collector Crypt before retrying)`,
      Math.min(3600, 15 * 2 ** attempts));
    log.error(`payouts: ${p.id} failed: ${msg}`);
    return 'failed';
  }
}
