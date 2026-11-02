// Rank Shield shop sheet as an HTML string, plus the "wait for the payment to land" poll. Pure (no DOM, no network), so it
// unit-tests in node. Menus only: nothing here is drawn over the court or the in-game HUD. shop.ts wires the buttons.
import { SIGNIN_GOOGLE } from '../../config/features';
import { esc } from '../../util';
import { getSolanaAddress, type WalletUser } from '../../wallet/phantom';
import type { ShopInfo, ShopProduct } from './serverRank';

export interface ShopNotice {
  tone: 'wait' | 'ok' | 'warn' | 'bad';
  text: string;
}

export interface ShopModel {
  /** null while loading, or when the server has no shop. */
  info: ShopInfo | null;
  /** false for a guest session: they only see "Sign in to buy". */
  signedIn: boolean;
  /** The "18+ or parent's permission" checkbox. */
  agreed: boolean;
  /** The sku being sent to checkout. */
  busy: string | null;
  notice: ShopNotice | null;
  /** Set only for a player signed in with Phantom, with the USDC flag on: the "Pay with USDC" buttons. null/absent = card only. */
  usdc?: { cluster: 'devnet' | 'mainnet-beta' } | null;
  /** Draw the card (Stripe) Buy button. Default true; shop.ts sets it from MODE_SHIELD_STRIPE. */
  card?: boolean;
  /** Which payment `busy` is for (default card). */
  rail?: 'card' | 'usdc';
  /** Where the USDC payment is: waiting for Phantom, or for Solana to confirm. */
  usdcStep?: 'approve' | 'confirm' | null;
}

/**
 * The USDC option for this player: only when the flag is on AND the Supabase user signed in with a Phantom (Solana) wallet.
 * Guests and Google users get null. The server re-reads the wallet from the verified JWT and trusts nothing sent from here.
 */
export function usdcOption(user: WalletUser | null | undefined, enabled: boolean, cluster: 'devnet' | 'mainnet-beta'): { wallet: string; cluster: 'devnet' | 'mainnet-beta' } | null {
  const wallet = enabled ? getSolanaAddress(user) : null;
  return wallet ? { wallet, cluster } : null;
}

/** 199 -> "$1.99". */
export const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
/** 1_990_000 (6 decimals) -> "1.99". */
export const usdcText = (amount: number) => (amount / 1_000_000).toFixed(2);
/** "$0.66 each" (rounded to the cent). */
export const perShield = (p: ShopProduct) => `${usd(Math.round(p.priceCents / p.units))} each`;

/** Why a pack can't be bought right now (null = it can). */
export function packBlock(p: ShopProduct, info: ShopInfo): string | null {
  if (info.blocked) return 'Purchases are off';
  if (info.held + p.units > info.cap) return `Max ${info.cap} held`;
  if (p.units > info.purchasesLeft) return 'Season limit';
  return null;
}

function packHtml(p: ShopProduct, m: ShopModel, best: boolean): string {
  const block = packBlock(p, m.info!);
  const can = !block && m.agreed && !m.busy;
  const usdc = m.usdc && p.usdcAmount !== null;
  const here = m.busy === p.sku;
  const card = m.card !== false;
  const cardLabel = here && m.rail !== 'usdc' ? 'Opening…' : usdc ? `Card ${usd(p.priceCents)}` : usd(p.priceCents);
  const usdcLabel = here && m.rail === 'usdc' ? (m.usdcStep === 'confirm' ? 'Confirming…' : 'Approve…') : `Pay ${usdcText(p.usdcAmount ?? 0)} USDC`;
  const buttons = (card ? `<button class="btn primary shop-buy" type="button" data-a="buy" data-sku="${esc(p.sku)}"${can ? '' : ' disabled'}>${cardLabel}</button>` : '')
    + (usdc ? `<button class="btn shop-buy shop-usdc" type="button" data-a="buy-usdc" data-sku="${esc(p.sku)}"${can ? '' : ' disabled'}>${usdcLabel}</button>` : '');
  return `<div class="shop-card${best ? ' best' : ''}${usdc ? ' has-usdc' : ''}" data-sku="${esc(p.sku)}">
    <span class="shop-units" aria-hidden="true">🛡<b>${p.units}</b></span>
    <span class="shop-name"><strong>${p.units} Rank Shields</strong><em>${esc(perShield(p))}${best ? ' · best value' : ''}</em>${block ? `<small>${esc(block)}</small>` : ''}</span>
    <span class="shop-pay">${buttons || '<small>Sign in with Phantom to pay with USDC</small>'}</span></div>`;
}

const USDC_FINE = (c: 'devnet' | 'mainnet-beta') => `<p class="shop-fine shop-usdc-note">${c === 'devnet'
  ? '<span class="shop-net" data-net="devnet">Devnet test USDC</span> Phantom must be on devnet. No real money.'
  : '<span class="shop-net" data-net="mainnet-beta">USDC on Solana</span>'} USDC payments are final on-chain.</p>`;

const LINKS = `<span class="shop-links"><a href="terms.html#sale" target="_blank" rel="noopener">Terms of sale</a><a href="terms.html#refunds" target="_blank" rel="noopener">Refunds</a><a href="privacy.html" target="_blank" rel="noopener">Privacy</a></span>`;

export interface ShopViewOpts {
  /** Offer Google in the guest sign-in hint (default: the SIGNIN_GOOGLE build flag). */
  google?: boolean;
}

/** The sheet's contents (the part that re-renders): packs on the left, held / consent / links on the right. */
export function shopBodyHtml(m: ShopModel, o: ShopViewOpts = {}): string {
  const notice = m.notice ? `<p class="shop-notice ${m.notice.tone}" role="status">${esc(m.notice.text)}</p>` : '';
  if (!m.signedIn) {
    return `<div class="shop-solo"><p class="shop-msg">Sign in to buy</p><p class="note">Rank Shields belong to your account. Sign in with ${(o.google ?? SIGNIN_GOOGLE) ? 'Google or Phantom' : 'Phantom'} from the Ranked screen.</p>${notice}</div>`;
  }
  if (!m.info) return `<div class="shop-solo">${notice || '<p class="note">Loading the shop…</p>'}</div>`;
  const packs = m.info.products;
  if (!packs.length) return `<div class="shop-solo"><p class="shop-msg">Shop coming soon</p>${notice}</div>`;
  const best = packs[packs.length - 1];
  return `<div class="shop-packs">${packs.map((p) => packHtml(p, m, p === best && packs.length > 1)).join('')}</div>
    <div class="shop-side">
      <p class="shop-held">Held <strong>${m.info.held} / ${m.info.cap}</strong></p>
      ${notice}
      <label class="shop-age"><input type="checkbox" data-a="age"${m.agreed ? ' checked' : ''}${m.busy ? ' disabled' : ''}> <span>I'm 18+ or have a parent's permission</span></label>
      <p class="shop-fine">${m.card !== false ? '🔒 Secure checkout by Stripe. ' : ''}Digital item: one use per 24 hours, tied to your account, no cash value.</p>
      ${m.usdc && packs.some((p) => p.usdcAmount !== null) ? USDC_FINE(m.usdc.cluster) : ''}
      ${LINKS}</div>`;
}

export function shopHtml(m: ShopModel, o: ShopViewOpts = {}): string {
  return `<div class="shop-sheet" data-shop><div class="shop-panel" role="dialog" aria-modal="true" aria-label="Rank Shield shop">
    <header class="shop-head"><h2>RANK SHIELD SHOP</h2><button class="btn ghost shop-x" type="button" data-a="shop-close" aria-label="Close the shop">✕</button></header>
    <div class="shop-body" data-shop-body>${shopBodyHtml(m, o)}</div></div></div>`;
}

/** The Stripe return the page was opened with (?shop=success / ?shop=cancel), or null. */
export function shopReturnOf(search: string): 'success' | 'cancel' | null {
  const v = new URLSearchParams(search).get('shop');
  return v === 'success' || v === 'cancel' ? v : null;
}

export const SHOP_NOTICES = {
  waiting: { tone: 'wait', text: 'Waiting for payment confirmation…' },
  cancelled: { tone: 'warn', text: 'Checkout cancelled. You were not charged.' },
  timeout: { tone: 'warn', text: "Still waiting. Payments can take a minute: check back soon. If your shields don't show up, email kungfudoom@mail.grokbot.com." },
} as const satisfies Record<string, ShopNotice>;

/** The USDC payment, step by step. Errors from the server carry their own text. */
export const USDC_NOTICES = {
  approve: { tone: 'wait', text: 'Approve in Phantom…' },
  confirming: { tone: 'wait', text: 'Confirming on Solana…' },
  timeout: { tone: 'warn', text: 'Still confirming on Solana. Your payment is safe: reopen the shop in a minute and it will finish. If your shields don\'t show up, email kungfudoom@mail.grokbot.com.' },
  rejected: { tone: 'warn', text: 'Cancelled in Phantom. You were not charged.' },
  noPhantom: { tone: 'bad', text: 'Open PokeJam in the Phantom app or browser extension to pay with USDC.' },
  wrongWallet: { tone: 'bad', text: 'Switch Phantom to the wallet you signed in with, then try again.' },
  shopWallet: { tone: 'warn', text: 'USDC payments are not ready yet. Try again later.' },
} as const satisfies Record<string, ShopNotice>;

export const gotShields = (n: number): ShopNotice => ({ tone: 'ok', text: `Payment confirmed: +${n} Rank Shield${n === 1 ? '' : 's'}.` });

/**
 * Polls until the shield count rises above `before`. Resolves with the new count, or null on timeout. The server credits
 * only from Stripe's webhook, so this never credits anything: it just waits to see it.
 */
export async function pollForRise(read: () => Promise<number | null>, before: number, o: {
  intervalMs?: number; timeoutMs?: number; sleep?: (ms: number) => Promise<void>; now?: () => number; stop?: () => boolean;
} = {}): Promise<number | null> {
  const interval = o.intervalMs ?? 2000;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const end = now() + (o.timeoutMs ?? 60_000);
  for (;;) {
    const n = await read().catch(() => null);
    if (n !== null && n > before) return n;
    if (o.stop?.() || now() + interval > end) return null;
    await sleep(interval);
  }
}
