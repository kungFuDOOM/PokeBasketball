// Collector Crypt Gacha Machine API client for Pack Battles payouts.
// Docs: https://docs.collectorcrypt.com/gacha/api and https://docs.collectorcrypt.com/gacha/vrf
//
// SERVER ONLY: it holds the house wallet. Ported from the prototype (server/collector-crypt.ts) after the
// devnet dry run on 2026-10-21, which confirmed every call below against dev-gacha.collectorcrypt.com:
//   buy()      generatePack(playerAddress = house) -> house signs (it's the only unsigned slot) ->
//              submitTransaction -> openPack (polls through WAITING_FOR_WEBHOOK). CC's VRF picks the card,
//              which lands in the house wallet; its VRF record (beta as 0x-prefixed hex) goes in the proof.
//   deliver()  transfer the card (a Metaplex Core asset) to the winner. A non-Core card fails loudly.
//   buyback()  sell the card back to CC (85-93% of its insured value) for a winner who prefers cash.
//   machines() CC's live prices, odds and stock.

import { base58Encode, base64Decode, hex } from './bytes.ts';
import { MPL_CORE, buildTransfer, decodeAccountData, parseAsset } from './core-transfer.ts';
import type { Keypair } from './ed25519.ts';
import type { Fetch, Rpc } from './rpc.ts';
import { signTransactionBase64 } from './solana-tx.ts';
import { PACK_TIERS, type PackTier } from './tiers.ts';
import { PROGRAM, UnsafeTransaction, checkCcTransaction, purchaseDestination, type GuardOptions } from './tx-guard.ts';

export const CC_PROD = 'https://gacha.collectorcrypt.com';
export const CC_DEVNET = 'https://dev-gacha.collectorcrypt.com';

/** A pull the house bought: the card, and Collector Crypt's VRF record for it. */
export interface Pull {
  memo: string;
  nftAddress: string;
  name: string;
  image: string | null;
  /** CC's insured value for the card, in dollars. */
  insuredValue: number | null;
  grade: string | null;
  rarity: string | null;
  roll: number | null;
  /** CC's VRF output (beta, hex) when published, else the roll: proves which card was picked. */
  entropy: string;
  vrf: unknown;
}

export interface BuyHooks {
  /** The most the house may pay CC for this pull (the escrowed pot); defaults to the tier's price. */
  maxPrice?: number;
  /** Called the moment the purchase is paid, before anything can fail after it. Save the memo then. */
  onPaid?(memo: string): Promise<void> | void;
  /** Finish a purchase that was already paid (from onPaid) instead of buying again. */
  resumeMemo?: string;
}

export interface CollectorCryptOptions {
  house: Keypair;
  rpc: Rpc;
  baseUrl?: string;
  apiKey?: string;
  /** Max time to wait for CC to see the payment before openPack gives up (the memo is kept for a retry). */
  openTimeoutMs?: number;
  /** How long to wait between openPack polls. */
  pollMs?: number;
  fetch?: Fetch;
  /** What the house will sign: its USDC account and mint, and CC's gacha wallet if pinned (tx-guard.ts). */
  guard: Omit<GuardOptions, 'house'>;
}

export class CollectorCryptError extends Error {
  constructor(message: string, readonly status: number, readonly body: unknown) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface OpenResult {
  success?: boolean;
  code?: string;
  rarity?: string;
  roll?: number;
  nft_address?: string;
  nftWon?: { content?: { metadata?: { name?: string; json_name?: string; insuredValue?: string; attributes?: { trait_type?: string; value?: string }[] }; links?: { image?: string }; files?: { uri?: string; cdn_uri?: string; cc_cdn?: string }[] } };
}

/** Find the 64-byte VRF output in CC's verify record: `beta`, as 0x-prefixed or plain hex, or base64. */
export function betaFrom(vrf: unknown): string | null {
  const seen = new Set<unknown>();
  const walk = (v: unknown, key = ''): string | null => {
    if (v === null || typeof v !== 'object' || seen.has(v)) {
      if (typeof v === 'string' && /beta/i.test(key)) {
        const h = v.replace(/^0x/i, '');
        if (/^[0-9a-f]{128}$/i.test(h)) return h.toLowerCase();
        try { const b = base64Decode(v); if (b.length === 64) return hex(b); } catch { /* not base64 */ }
      }
      return null;
    }
    seen.add(v);
    for (const [k, x] of Object.entries(v)) {
      const r = walk(x, k);
      if (r) return r;
    }
    return null;
  };
  return walk(vrf);
}

export class CollectorCrypt {
  readonly base: string;
  private openTimeoutMs: number;
  private pollMs: number;
  private fetchFn: Fetch;

  constructor(private opts: CollectorCryptOptions) {
    this.base = (opts.baseUrl ?? CC_PROD).replace(/\/$/, '');
    this.openTimeoutMs = opts.openTimeoutMs ?? 90_000;
    this.pollMs = opts.pollMs ?? 1200;
    this.fetchFn = opts.fetch ?? ((i, init) => fetch(i, init));
  }

  get house() {
    return this.opts.house.address;
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await this.fetchFn(this.base + path, {
      method,
      headers: { 'content-type': 'application/json', ...(this.opts.apiKey ? { 'x-api-key': this.opts.apiKey } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const d = data as { error?: string; details?: string } | null;
      throw new CollectorCryptError(`${method} ${path.split('?')[0]}: ${res.status} ${d?.details ?? d?.error ?? ''}`.trim(), res.status, data);
    }
    return data as T;
  }

  /** Live machine list (price, odds, stock). */
  machines(): Promise<unknown> {
    return this.call('GET', '/api/machines');
  }

  private get guard(): GuardOptions {
    if (!this.opts.guard.houseUsdc) throw new UnsafeTransaction("HOUSE_USDC_ACCOUNT is not set, so payments from the house can't be checked");
    return { ...this.opts.guard, house: this.opts.house.address };
  }

  /** The purchase must pay a USDC token account, owned by CC's gacha wallet when that's pinned. */
  private async checkTreasury(tx: Uint8Array) {
    const g = this.guard;
    const dst = purchaseDestination(tx, g.houseUsdc);
    const info = dst ? await this.opts.rpc.accountInfo(dst) : null;
    if (!dst || !info || info.owner !== PROGRAM.splToken) throw new UnsafeTransaction(`the payment goes to ${dst ?? 'nowhere'}, which isn't a token account`);
    const data = base64Decode(info.data);
    if (base58Encode(data.slice(0, 32)) !== g.usdcMint) throw new UnsafeTransaction('the payment goes to an account for another token');
    const owner = base58Encode(data.slice(32, 64));
    if (g.ccSigner && owner !== g.ccSigner) throw new UnsafeTransaction(`the payment goes to ${owner}'s account, not Collector Crypt's`);
  }

  private async signAndSubmit(base64Tx: string): Promise<string> {
    const signedTransaction = await signTransactionBase64(base64Tx, this.opts.house);
    const r = await this.call<{ success: boolean; signature: string }>('POST', '/api/submitTransaction', { signedTransaction });
    if (!r.success) throw new CollectorCryptError('submitTransaction did not succeed', 200, r);
    return r.signature;
  }

  /** CC's VRF record for a memo. */
  vrf(memo: string): Promise<unknown> {
    return this.call('GET', `/api/vrf/verify?memo=${encodeURIComponent(memo)}`);
  }

  async buy(packType: PackTier, hooks: BuyHooks = {}): Promise<Pull> {
    let memo = hooks.resumeMemo;
    if (!memo) {
      const p = await this.call<{ memo: string; transaction: string }>('POST', '/api/generatePack', { playerAddress: this.opts.house.address, packType, turbo: false });
      const tx = base64Decode(p.transaction);
      checkCcTransaction(tx, this.guard, { kind: 'purchase', maxPrice: hooks.maxPrice ?? PACK_TIERS[packType].price });
      await this.checkTreasury(tx);
      await this.signAndSubmit(p.transaction);
      memo = p.memo;
      await hooks.onPaid?.(memo);
    }
    const opened = await this.openMemo(memo);
    // The VRF commit can land a moment after the open; give it a few tries.
    let vrf: unknown = null;
    for (let i = 0; i < 5 && vrf === null; i++) {
      try { vrf = await this.vrf(memo); } catch { await sleep(this.pollMs); }
    }
    const meta = opened.nftWon?.content?.metadata;
    const attr = (t: string) => meta?.attributes?.find((a) => a.trait_type === t)?.value ?? null;
    const files = opened.nftWon?.content?.files?.[0];
    if (!opened.nft_address) throw new Error(`openPack for ${memo} returned no card`);
    return {
      memo,
      nftAddress: opened.nft_address,
      name: meta?.json_name ?? meta?.name ?? 'Collector Crypt card',
      image: files?.cc_cdn ?? opened.nftWon?.content?.links?.image ?? files?.uri ?? null,
      insuredValue: meta?.insuredValue ? Number(meta.insuredValue) : null,
      grade: attr('The Grade'),
      rarity: opened.rarity ?? null,
      roll: typeof opened.roll === 'number' ? opened.roll : null,
      entropy: betaFrom(vrf) ?? `roll:${opened.roll ?? 'none'}:nft:${opened.nft_address}`,
      vrf,
    };
  }

  /** CC answers WAITING_FOR_WEBHOOK (or 404) until it sees the payment; keep asking with the same memo. */
  private async openMemo(memo: string): Promise<OpenResult> {
    const deadline = Date.now() + this.openTimeoutMs;
    for (;;) {
      try {
        const o = await this.call<OpenResult>('POST', '/api/openPack', { memo });
        if (o.code !== 'WAITING_FOR_WEBHOOK') return o;
      } catch (e) {
        if (!(e instanceof CollectorCryptError && e.status === 404)) throw e;
      }
      if (Date.now() > deadline) throw new Error(`openPack still waiting for payment on ${memo}`);
      await sleep(this.pollMs);
    }
  }

  /**
   * A card's Core asset, or a clear error if it isn't one. CC's devnet pool had one frozen pNFT test entry
   * among Core cards; a pNFT's mint account also starts with byte 1, so parseAsset alone would misread it.
   */
  private async coreAsset(nftAddress: string) {
    const info = await this.opts.rpc.accountInfo(nftAddress);
    if (!info) throw new Error(`card ${nftAddress} not found on chain`);
    if (info.owner !== MPL_CORE) throw new Error(`card ${nftAddress} is not a Metaplex Core asset (owned by program ${info.owner}); it can't be delivered automatically`);
    return parseAsset(decodeAccountData(info.data));
  }

  /** Who owns a card right now (null if it isn't a Core asset or doesn't exist). */
  async ownerOf(nftAddress: string): Promise<string | null> {
    const info = await this.opts.rpc.accountInfo(nftAddress);
    if (!info || info.owner !== MPL_CORE) return null;
    return parseAsset(decodeAccountData(info.data)).owner;
  }

  /** Transfer a card the house holds to `to`. Safe to retry: it checks the owner on-chain first. */
  async deliver(nftAddress: string, to: string): Promise<string> {
    const asset = await this.coreAsset(nftAddress);
    if (asset.owner === to) return 'already-delivered';
    if (asset.owner !== this.opts.house.address) throw new Error(`card ${nftAddress} is owned by ${asset.owner}, not the house`);
    const { base64 } = await buildTransfer(this.opts.house, nftAddress, asset.collection, to, await this.opts.rpc.latestBlockhash());
    const sig = await this.opts.rpc.send(base64);
    if (!(await this.opts.rpc.confirm(sig))) throw new Error(`transfer ${sig} not confirmed yet`);
    return sig;
  }

  /** Sell a card the house holds back to Collector Crypt (within 72 hours of the pull). */
  async buyback(nftAddress: string): Promise<{ memo: string; refundAmount: number }> {
    const b = await this.call<{ serializedTransaction: string; refundAmount: unknown; memo: string }>('POST', '/api/buyback', { playerAddress: this.opts.house.address, nftAddress });
    // Credit what CC's transaction actually pays the house, and only if it matches CC's quote.
    const { received } = checkCcTransaction(base64Decode(b.serializedTransaction), this.guard, { kind: 'buyback', nft: nftAddress });
    if (received <= 0) throw new UnsafeTransaction('the buyback pays the house nothing');
    if (Number(b.refundAmount) !== received) throw new UnsafeTransaction(`CC quotes ${String(b.refundAmount)} but its transaction pays ${received}`);
    await this.signAndSubmit(b.serializedTransaction);
    return { memo: b.memo, refundAmount: received };
  }

  verifyUrl(memo: string) {
    return `${this.base}/verify-selection/${encodeURIComponent(memo)}`;
  }

  vrfUrl(memo: string) {
    return `${this.base}/api/vrf/verify?memo=${encodeURIComponent(memo)}`;
  }
}
