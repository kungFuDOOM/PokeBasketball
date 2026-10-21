// Collector Crypt Gacha Machine API client for the Pack Battles server.
// Docs: https://docs.collectorcrypt.com/gacha/api
//
// SERVER ONLY. This holds the house wallet that pays for prize pulls; it must never ship to the browser.
// Run it after your server has decided a battle (never on a score a client reported) and both entries
// have settled in the house wallet as USDC.
//
// Two ways to hand the winner their pull:
//   gift (default)  generateGift(sender = house, receiver = winner) -> house signs -> submitTransaction.
//                   The winner gets an unopened pack on Collector Crypt and rips it themselves.
//   open            generatePack(playerAddress = house, altPlayerAddress = winner) -> house signs ->
//                   submitTransaction -> openPack. The card goes straight to the winner's wallet and you
//                   get the rarity back to show in the game.
//
// Play endpoints work without an API key, but then packs are tagged with CC's default memo prefix and
// can't be attributed to you. Ask Collector Crypt for a key (and, if you want a per-pack fee, their
// can_adopt partner capability) before launch.

import type { AwardHooks, AwardResult, PackSource, PackTier } from '../src/battles/service';
import { signTransactionBase64 } from './lib/solana-tx';
import type { Keypair } from './lib/ed25519';

export const CC_PROD = 'https://gacha.collectorcrypt.com';
export const CC_DEVNET = 'https://dev-gacha.collectorcrypt.com';

/** The house wallet: its address, and a function that adds its signature to a base64 transaction. */
export interface HouseWallet {
  address: string;
  /**
   * Sign a base64 transaction from CC (already partially signed by their gacha wallet) and return it
   * base64-encoded. With @solana/web3.js:
   *
   *   import { Keypair, Transaction, VersionedTransaction } from '@solana/web3.js';
   *   const sign = async (b64: string) => {
   *     const buf = Buffer.from(b64, 'base64');
   *     try {
   *       const tx = VersionedTransaction.deserialize(buf);
   *       tx.sign([houseKeypair]); // adds a signature, keeps CC's
   *       return Buffer.from(tx.serialize()).toString('base64');
   *     } catch {
   *       const tx = Transaction.from(buf);
   *       tx.partialSign(houseKeypair); // partialSign keeps CC's signature; sign() would wipe it
   *       return tx.serialize({ requireAllSignatures: false }).toString('base64');
   *     }
   *   };
   *
   * Load the keypair from a secrets manager, not from the repo.
   */
  sign(base64Tx: string): Promise<string>;
}

/** A HouseWallet backed by a keypair, with no Solana SDK (see lib/solana-tx.ts). */
export const keypairWallet = (kp: Keypair): HouseWallet => ({ address: kp.address, sign: (tx) => signTransactionBase64(tx, kp) });

export interface CollectorCryptOptions {
  wallet: HouseWallet;
  baseUrl?: string;
  apiKey?: string;
  mode?: 'gift' | 'open';
  /** Max time to wait for CC to see the payment before giving up on openPack. */
  openTimeoutMs?: number;
}

export interface Machine {
  code: string;
  price: number;
  odds?: unknown;
  public?: boolean;
}

export class CollectorCryptError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class CollectorCryptPackSource implements PackSource {
  private base: string;
  private mode: 'gift' | 'open';
  private openTimeoutMs: number;

  constructor(private opts: CollectorCryptOptions) {
    this.base = (opts.baseUrl ?? CC_PROD).replace(/\/$/, '');
    this.mode = opts.mode ?? 'gift';
    this.openTimeoutMs = opts.openTimeoutMs ?? 60_000;
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(this.opts.apiKey ? { 'x-api-key': this.opts.apiKey } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const d = data as { error?: string; details?: string } | null;
      throw new CollectorCryptError(`${method} ${path}: ${res.status} ${d?.details ?? d?.error ?? ''}`.trim(), res.status, data);
    }
    return data as T;
  }

  /** Live machine list (price, odds, stock). Check the price before taking entries for a battle. */
  machines(): Promise<Machine[] | Record<string, Machine>> {
    return this.call('GET', '/api/machines');
  }

  private async signAndSubmit(base64Tx: string): Promise<string> {
    const signedTransaction = await this.opts.wallet.sign(base64Tx);
    const r = await this.call<{ success: boolean; signature: string; confirmationStatus: string }>(
      'POST', '/api/submitTransaction', { signedTransaction });
    if (!r.success) throw new CollectorCryptError('submitTransaction did not succeed', 200, r);
    return r.signature;
  }

  async award(machine: PackTier, winnerWallet: string, battleId: string, hooks: AwardHooks = {}): Promise<AwardResult> {
    if (!winnerWallet) throw new Error(`Battle ${battleId}: winner has no wallet on file`);
    if (hooks.resumeMemo) {
      // Already paid: a gift is complete once submitted; an open pull just needs openPack.
      return this.mode === 'gift' ? { memo: hooks.resumeMemo, mode: 'gift' } : this.openMemo(hooks.resumeMemo);
    }
    return this.mode === 'gift' ? this.gift(machine, winnerWallet, hooks) : this.open(machine, winnerWallet, hooks);
  }

  /** House buys one pack and gifts it to the winner, unopened. */
  private async gift(packType: PackTier, receiver: string, hooks: AwardHooks): Promise<AwardResult> {
    const g = await this.call<{ giftId: string; memo: string; transaction: string; totalCost: number }>(
      'POST', '/api/generateGift', { sender: this.opts.wallet.address, receiver, packType, count: 1 });
    await this.signAndSubmit(g.transaction);
    hooks.onPaid?.(g.memo, 'gift');
    return { memo: g.memo, mode: 'gift' };
  }

  /** House buys and opens one pack; the card goes straight to the winner. */
  private async open(packType: PackTier, winner: string, hooks: AwardHooks): Promise<AwardResult> {
    const p = await this.call<{ memo: string; transaction: string }>('POST', '/api/generatePack', {
      playerAddress: this.opts.wallet.address,
      altPlayerAddress: winner,
      packType,
      turbo: false,
    });
    await this.signAndSubmit(p.transaction);
    hooks.onPaid?.(p.memo, 'open');
    return this.openMemo(p.memo);
  }

  /**
   * CC answers WAITING_FOR_WEBHOOK (or 404) until it sees the payment on chain; poll the same memo.
   * Packs must be opened within 2 hours of generatePack (CC refunds unopened ones after that), so a
   * timeout here is retried with the same memo, never with a new purchase.
   */
  private async openMemo(memo: string): Promise<AwardResult> {
    const deadline = Date.now() + this.openTimeoutMs;
    for (;;) {
      try {
        const o = await this.call<{ success?: boolean; code?: string; rarity?: string; nft_address?: string }>(
          'POST', '/api/openPack', { memo });
        if (o.code !== 'WAITING_FOR_WEBHOOK') return { memo, mode: 'open', rarity: o.rarity, nftAddress: o.nft_address };
      } catch (e) {
        if (!(e instanceof CollectorCryptError && e.status === 404)) throw e;
      }
      if (Date.now() > deadline) throw new Error(`openPack still waiting for payment on ${memo}`);
      await sleep(1200);
    }
  }

  /** Delivery status for a memo (pack bought, card sent). */
  status(memo: string) {
    return this.call<{ memo: string; pack: { status: string | null } | null; send: { status: string | null } | null }>(
      'GET', `/api/pack/status?memo=${encodeURIComponent(memo)}`);
  }
}
