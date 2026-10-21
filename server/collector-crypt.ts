// Collector Crypt Gacha Machine API client for the Pack Battles server.
// Docs: https://docs.collectorcrypt.com/gacha/api and https://docs.collectorcrypt.com/gacha/vrf
//
// SERVER ONLY. This holds the house wallet; it must never ship to the browser.
//
// Pull first, then play:
//   buy()     after the draft: generatePack(playerAddress = house) -> house signs -> submitTransaction ->
//             openPack. CC's VRF (RFC 9381 ECVRF over the house's payment signature, committed on-chain
//             by program ccvrfu3fSpbnPLiUqdWAt85Zn9nq96ekwGTbHqGtdgQ) picks the card, which lands in the
//             house wallet. Its VRF record (GET /api/vrf/verify?memo=) supplies the game's entropy.
//   deliver() after the game: transfer the card (a Metaplex Core asset) to the winner.
//   buyback() if a battle is voided after its pull was bought: sell the card back to CC (72-hour window).
//
// Play endpoints work without an API key, but then packs carry CC's default memo prefix and can't be
// attributed to you. Ask Collector Crypt for a key before launch.

import type { BuyHooks, PackSource, PackTier, Pull } from '../src/battles/service';
import { hex, base64Decode } from './lib/bytes';
import { buildTransfer, decodeAccountData, parseAsset } from './lib/core-transfer';
import type { Keypair } from './lib/ed25519';
import { signTransactionBase64 } from './lib/solana-tx';
import type { Rpc } from './solana';

export const CC_PROD = 'https://gacha.collectorcrypt.com';
export const CC_DEVNET = 'https://dev-gacha.collectorcrypt.com';

export interface CollectorCryptOptions {
  house: Keypair;
  rpc: Rpc;
  baseUrl?: string;
  apiKey?: string;
  /** Max time to wait for CC to see the payment before openPack gives up (the memo is kept for a retry). */
  openTimeoutMs?: number;
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

/** Where CC's browser verifier shows a pack's selection proof. */
export const verifyUrl = (base: string, memo: string) => `${base.replace(/\/$/, '')}/verify-selection/${encodeURIComponent(memo)}`;

/** Find the VRF output in CC's verify record. The field name isn't documented yet, so look for the 64-byte beta. */
export function betaFrom(vrf: unknown): string | null {
  const seen = new Set<unknown>();
  const walk = (v: unknown, key = ''): string | null => {
    if (v === null || typeof v !== 'object' || seen.has(v)) {
      if (typeof v === 'string' && /beta/i.test(key)) {
        if (/^[0-9a-f]{128}$/i.test(v)) return v.toLowerCase();
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

export class CollectorCryptPackSource implements PackSource {
  readonly base: string;
  private openTimeoutMs: number;

  constructor(private opts: CollectorCryptOptions) {
    this.base = (opts.baseUrl ?? CC_PROD).replace(/\/$/, '');
    this.openTimeoutMs = opts.openTimeoutMs ?? 90_000;
  }

  get house() {
    return this.opts.house.address;
  }

  private async call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.base + path, {
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

  private async signAndSubmit(base64Tx: string): Promise<string> {
    const signedTransaction = await signTransactionBase64(base64Tx, this.opts.house);
    const r = await this.call<{ success: boolean; signature: string }>('POST', '/api/submitTransaction', { signedTransaction });
    if (!r.success) throw new CollectorCryptError('submitTransaction did not succeed', 200, r);
    return r.signature;
  }

  /** CC's VRF record for a memo: proof, public key, alpha, beta, commit status, award signature, match flag. */
  async vrf(memo: string): Promise<unknown> {
    return this.call('GET', `/api/vrf/verify?memo=${encodeURIComponent(memo)}`);
  }

  async buy(packType: PackTier, battleId: string, hooks: BuyHooks = {}): Promise<Pull> {
    let memo = hooks.resumeMemo;
    if (!memo) {
      const p = await this.call<{ memo: string; transaction: string }>('POST', '/api/generatePack', {
        playerAddress: this.opts.house.address,
        packType,
        turbo: false,
      });
      await this.signAndSubmit(p.transaction);
      memo = p.memo;
      hooks.onPaid?.(memo);
    }
    const opened = await this.openMemo(memo);
    // The VRF commit can land a moment after the open; give it a few tries.
    let vrf: unknown = null;
    for (let i = 0; i < 5 && vrf === null; i++) {
      try { vrf = await this.vrf(memo); } catch { await sleep(1500); }
    }
    const meta = opened.nftWon?.content?.metadata;
    const attr = (t: string) => meta?.attributes?.find((a) => a.trait_type === t)?.value ?? null;
    const files = opened.nftWon?.content?.files?.[0];
    const beta = betaFrom(vrf);
    if (!opened.nft_address) throw new Error(`openPack for ${memo} returned no card (battle ${battleId})`);
    return {
      memo,
      nftAddress: opened.nft_address,
      name: meta?.json_name ?? meta?.name ?? 'Collector Crypt card',
      image: files?.cc_cdn ?? opened.nftWon?.content?.links?.image ?? files?.uri ?? null,
      insuredValue: meta?.insuredValue ? Number(meta.insuredValue) : null,
      grade: attr('The Grade'),
      rarity: opened.rarity ?? null,
      roll: typeof opened.roll === 'number' ? opened.roll : null,
      // Prefer CC's 64-byte VRF output; fall back to the VRF-derived roll and the card it selected.
      entropy: beta ?? `roll:${opened.roll ?? 'none'}:nft:${opened.nft_address}`,
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
      await sleep(1200);
    }
  }

  async ownerOf(nftAddress: string): Promise<string | null> {
    const data = await this.opts.rpc.accountData(nftAddress);
    return data ? parseAsset(decodeAccountData(data)).owner : null;
  }

  async deliver(nftAddress: string, to: string): Promise<string> {
    const data = await this.opts.rpc.accountData(nftAddress);
    if (!data) throw new Error(`card ${nftAddress} not found on chain`);
    const asset = parseAsset(decodeAccountData(data));
    if (asset.owner === to) return 'already-delivered';
    if (asset.owner !== this.opts.house.address) throw new Error(`card ${nftAddress} is owned by ${asset.owner}, not the house`);
    const { base64 } = await buildTransfer(this.opts.house, nftAddress, asset.collection, to, await this.opts.rpc.latestBlockhash());
    const sig = await this.opts.rpc.send(base64);
    if (!(await this.opts.rpc.confirm(sig))) throw new Error(`transfer ${sig} not confirmed yet`);
    return sig;
  }

  /** Sell a card the house holds back to Collector Crypt (within 72 hours of the pull). */
  async buyback(nftAddress: string): Promise<{ memo: string; refundAmount: unknown }> {
    const b = await this.call<{ serializedTransaction: string; refundAmount: unknown; memo: string }>('POST', '/api/buyback', { playerAddress: this.opts.house.address, nftAddress });
    await this.signAndSubmit(b.serializedTransaction);
    return { memo: b.memo, refundAmount: b.refundAmount };
  }

  verifyUrl(memo: string) {
    return verifyUrl(this.base, memo);
  }

  /** CC's VRF record for a memo, as JSON anyone can open. */
  vrfUrl(memo: string) {
    return `${this.base}/api/vrf/verify?memo=${encodeURIComponent(memo)}`;
  }
}
