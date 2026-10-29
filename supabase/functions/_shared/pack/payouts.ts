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
//                      -> failed    retried later with backoff; parked for a person after too many tries,
//                                   or held without using up an attempt when nothing needs a person
//
// Every step is safe to retry, including after a crash:
//   * Before buying, the worker checks CC's live machine, the kill switch, the hourly spending cap and the
//     house's USDC. A refusal there (or from CC before payment) costs nothing.
//   * Every transaction the house submits (a purchase or a buyback) is recorded first, with its id and
//     blockhash. If the reply is lost, the next run asks the chain: landed (resume it), failed or expired
//     unseen (it never will land: try again), or still landing (wait). Nothing is ever bought or sold twice.
//   * A paid purchase resumes from its memo; deliver() checks on-chain who owns the card before sending.
//   * A card that's neither the house's nor the winner's is parked for a person.
//
// Pulls are only ever bought after a battle has a winner, so there is no "card left with the house"
// case to sell back: a battle that's called off is a plain refund in the escrow flow.

import { UnsafeTransaction } from './tx-guard.ts';
import type { CollectorCrypt, Pull } from './collector-crypt.ts';
import { parseMachines, type MachineInfo } from './machines.ts';
import type { Rpc } from './rpc.ts';
import type { Health, PrizeRow, PrizeStore } from './store.ts';
import { MICRO, PACK_TIERS, usd } from './tiers.ts';

export const MAX_ATTEMPTS = 8;

export interface PayoutDeps {
  store: PrizeStore;
  cc: Pick<CollectorCrypt, 'house' | 'buy' | 'deliver' | 'ownerOf' | 'buyback' | 'txStatus' | 'machines' | 'verifyUrl' | 'vrfUrl'>;
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

/** Nothing for a person to do: wait and retry without using up an attempt. */
class Held extends Error {
  constructor(message: string, readonly retrySeconds: number) {
    super(message);
  }
}

/** Only a person can sort this out: park the prize. */
class NeedsPerson extends Error {}

const baseUnits = (v: unknown) => {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
};

/** Settle up to `limit` due prizes. Does nothing while the kill switch is on. */
export async function runPayouts(d: PayoutDeps, limit = 10): Promise<{ id: string; outcome: Outcome }[]> {
  if (await d.store.paused()) {
    (d.log ?? console).warn('payouts: paused (pokejam_config pack_payouts_paused); nothing bought, sent or sold');
    return [];
  }
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
  const stop = await d.store.spendCheck(m.price);
  if (stop) throw new Held(`Holding the purchase: ${stop}`, 600);
  if (d.rpc && d.houseUsdcAccount) {
    const have = await d.rpc.tokenBalance(d.houseUsdcAccount);
    if (have < m.price) throw new Held(`House wallet has ${have / MICRO} USDC, needs ${m.price / MICRO}`, 600);
  }
  return m;
}

/**
 * A purchase recorded before it was submitted, settled from the chain: the memo to resume when it landed, or
 * null when it never will (it failed, or its blockhash expired unseen) and a fresh purchase is safe.
 */
async function settlePurchase(d: PayoutDeps, p: PrizeRow): Promise<string | null> {
  if (!p.pay_txid || !p.pay_memo || !p.pay_blockhash) return null;
  const st = await d.cc.txStatus(p.pay_txid, p.pay_blockhash);
  if (st === 'landed') {
    await d.store.paid(p.id, p.pay_memo);
    return p.pay_memo;
  }
  if (st === 'pending') throw new Held(`Purchase ${p.pay_txid} is still landing`, 20);
  await d.store.submitCleared(p.id);
  (d.log ?? console).warn(`payouts: ${p.id} purchase ${p.pay_txid} ${st === 'failed' ? 'failed on-chain' : 'expired without landing'}; nothing was charged`);
  return null;
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
  // Whether the house may have paid for this prize: a refusal or a refused signature is only free before then.
  let submitted = !!p.memo || !!p.nft_address || !!p.pay_txid;
  try {
    let nft = p.nft_address;
    let pull: Pull | null = p.pull;
    let machine: MachineInfo | null = null;
    if (!nft) {
      const memo = p.memo ?? (await settlePurchase(d, p));
      submitted = !!memo;
      if (!memo) machine = await preflight(d, p);
      pull = await d.cc.buy(p.tier, {
        maxPrice: Number(p.price_micro),
        resumeMemo: memo ?? undefined,
        onSubmitting: async (s) => {
          if (!(await d.store.submitting(p.id, s))) throw new Error(`couldn't record the purchase for ${p.id}, so it wasn't submitted`);
          submitted = true;
        },
        onPaid: async (m) => { await d.store.paid(p.id, m); },
      });
      await d.store.pulled(p.id, { ...pull, verifyUrl: d.cc.verifyUrl(pull.memo), vrfUrl: d.cc.vrfUrl(pull.memo) });
      nft = pull.nftAddress;
    }
    // A buyback recorded before it was submitted: settle it before anything else touches the card.
    if (p.cash_txid && p.cash_blockhash && p.cash_pending) {
      const st = await d.cc.txStatus(p.cash_txid, p.cash_blockhash);
      if (st === 'landed') {
        await d.store.cashed(p.id, p.cash_pending, `sold back ${nft} (${p.cash_txid})`);
        log.info(`payouts: ${p.id} buyback ${p.cash_txid} had landed; credited ${usd(p.cash_pending)} to ${p.user_id}`);
        return 'cashed';
      }
      if (st === 'pending') throw new Held(`Buyback ${p.cash_txid} is still landing`, 20);
      await d.store.cashCleared(p.id);
    }
    const want = decide(d, p);
    if (!want) {
      await d.store.revealed(p.id, d.choiceSeconds ?? 0, await sellEstimate(d, p, pull, machine));
      log.info(`payouts: ${p.id} revealed ${nft} to ${p.user_id}; waiting for keep or sell`);
      return 'revealed';
    }
    const owner = await d.cc.ownerOf(nft);
    if (owner === p.wallet) {
      await d.store.sent(p.id, 'already-delivered');
      return 'sent';
    }
    if (owner !== null && owner !== d.cc.house) throw new NeedsPerson(`card ${nft} is held by ${owner}, neither the house nor the winner`);
    if (want === 'cash' && owner === d.cc.house) {
      let recorded = false;
      try {
        const r = await d.cc.buyback(nft, {
          onSubmitting: async (s) => {
            if (!(await d.store.cashing(p.id, s))) throw new Error(`couldn't record the buyback for ${p.id}, so it wasn't submitted`);
            recorded = true;
          },
        });
        const amount = baseUnits(r.refundAmount);
        if (!amount) throw new Error(`Collector Crypt quoted an unusable buyback amount (${String(r.refundAmount)})`);
        await d.store.cashed(p.id, amount, `sold back ${nft} (${r.memo})`);
        log.info(`payouts: ${p.id} sold ${nft} back for ${usd(amount)} to ${p.user_id}`);
        return 'cashed';
      } catch (e) {
        // Submitted, then something failed: it may have gone through. Settle it from the chain on the next
        // run, and never also send the card.
        if (recorded) throw e;
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
    if (e instanceof Held) {
      await d.store.held(p.id, msg, e.retrySeconds);
      log.warn(`payouts: ${p.id} held: ${msg}`);
      return 'failed';
    }
    if (e instanceof NeedsPerson) {
      await d.store.failed(p.id, MAX_ATTEMPTS, `${msg} (needs a person)`, 3600);
      log.error(`payouts: ${p.id} needs a person: ${msg}`);
      return 'failed';
    }
    // CC handed the house a transaction it won't sign. Nothing was paid, but it may be an attack on the house
    // wallet: park the prize for a person to look at rather than retry or refund it.
    if (e instanceof UnsafeTransaction && !submitted) {
      await d.store.failed(p.id, MAX_ATTEMPTS, `${msg} (nothing was signed)`, 3600);
      log.error(`payouts: ${p.id} SECURITY: ${msg}`);
      return 'failed';
    }
    // CC said no before taking payment. After a few tries, pay the winner the pot rather than wait on a
    // machine that may not come back.
    const refused = !submitted && (e instanceof Refused || /\/api\/generatePack\b/.test(msg));
    if (refused && attempts >= (d.fallbackAfter ?? 3)) {
      await d.store.refunded(p.id, msg);
      log.warn(`payouts: ${p.id} credited the ${usd(p.price_micro)} pot to ${p.user_id}: ${msg}`);
      return 'refunded';
    }
    // Anything else is safe to retry: nothing is submitted without a record, and a recorded transaction is
    // settled from the chain before anything else happens. Too many tries parks it for a person.
    await d.store.failed(p.id, attempts, msg, Math.min(3600, 15 * 2 ** attempts));
    log.error(`payouts: ${p.id} failed: ${msg}`);
    return 'failed';
  }
}

/** What needs a person, from the prize table and the house's USDC (when known). */
export async function healthAlerts(store: Pick<PrizeStore, 'health'>, houseUsdc: number | null): Promise<{ health: Health; owed: number; alerts: { key: string; text: string }[] }> {
  const h = await store.health(MAX_ATTEMPTS);
  const owed = h.balances + h.unbought_pots;
  const alerts: { key: string; text: string }[] = [];
  if (h.paused) alerts.push({ key: 'paused', text: 'Pack payouts are paused (pack_payouts_paused)' });
  if (houseUsdc !== null && houseUsdc < owed) {
    alerts.push({ key: 'insolvent', text: `House wallet holds ${usd(houseUsdc)} but owes players ${usd(owed)} (${usd(h.balances)} in balances, ${usd(h.unbought_pots)} in unbought pots)` });
  }
  if (h.parked > 0) alerts.push({ key: 'parked', text: `${h.parked} prize${h.parked === 1 ? ' is' : 's are'} parked for a person (state failed, attempts at the limit)` });
  if (h.cards_in_house_over_48h > 0) {
    alerts.push({ key: 'buyback-window', text: `${h.cards_in_house_over_48h} card${h.cards_in_house_over_48h === 1 ? '' : 's'} still in the house wallet after 48 hours: Collector Crypt's 72-hour buyback window is closing` });
  }
  if (h.oldest_unsettled_minutes >= 60) alerts.push({ key: 'slow', text: `A prize has waited ${h.oldest_unsettled_minutes} minutes to settle` });
  return { health: h, owed, alerts };
}
