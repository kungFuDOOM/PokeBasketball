import { describe, expect, it, vi } from 'vitest';
vi.hoisted(() => vi.stubEnv('VITE_MODE_RANKED', 'true'));
import { base58Decode, base58Encode } from '../../../supabase/functions/_shared/pack/bytes.ts';
import { deriveAta } from '../../../supabase/functions/_shared/shield/usdc-chain.ts';
import { parseShopInfo } from './serverRank';
import { USDC_NOTICES, shopBodyHtml, usdcOption, usdcText, type ShopModel } from './shopView';
import { UsdcPayError, parseIntent, pollConfirm, prepareTransfer, rpcFor, signAndSend, type PayProvider, type RpcCall } from './usdcPay';

const PHANTOM_USER = { app_metadata: { provider: 'web3' }, identities: [{ provider: 'web3', identity_data: { custom_claims: { address: '5njibWvkiFg4LSyzq4ySFhyCsFEF4YhTqRLJo8Z9q16p', chain: 'solana' } } }] };
const GOOGLE_USER = { app_metadata: { provider: 'google' }, identities: [{ provider: 'google', identity_data: { email: 'a@b.c' } }] };
const GUEST_USER = { app_metadata: { provider: 'anonymous' }, identities: [] };

const info = (o: Record<string, unknown> = {}) => parseShopInfo({
  held: 3, cap: 14, purchases_left: 39, blocked: false,
  products: [{ sku: 'shield_3', units: 3, price_cents: 199, usdc_amount: 1990000 }, { sku: 'shield_7', units: 7, price_cents: 399, usdc_amount: 3990000 }, { sku: 'shield_14', units: 14, price_cents: 699, usdc_amount: 6990000 }], ...o })!;
const model = (o: Partial<ShopModel> = {}): ShopModel => ({ info: info({ held: 0 }), signedIn: true, agreed: true, busy: null, notice: null, ...o });
const usdcButtons = (html: string) => [...html.matchAll(/<button class="btn shop-buy shop-usdc"[^>]*?( disabled)?>([^<]*)</g)].map((m) => [!m[1], m[2]]);

describe('who sees the USDC option', () => {
  it('only a player signed in with Phantom, and only with the flag on', () => {
    expect(usdcOption(PHANTOM_USER, true, 'devnet')).toEqual({ wallet: '5njibWvkiFg4LSyzq4ySFhyCsFEF4YhTqRLJo8Z9q16p', cluster: 'devnet' });
    expect(usdcOption(PHANTOM_USER, false, 'devnet')).toBeNull();
    expect(usdcOption(GOOGLE_USER, true, 'devnet')).toBeNull();
    expect(usdcOption(GUEST_USER, true, 'devnet')).toBeNull();
    expect(usdcOption(null, true, 'devnet')).toBeNull();
    expect(usdcOption({ app_metadata: { provider: 'google' }, user_metadata: { address: '5njibWvkiFg4LSyzq4ySFhyCsFEF4YhTqRLJo8Z9q16p' } }, true, 'devnet')).toBeNull();
  });
  it('the build flags: USDC needs only Ranked + VITE_SHIELD_USDC, Stripe only Ranked + VITE_SHIELD_SHOP, shop is either', async () => {
    const flags = async (env: Record<string, string>) => {
      vi.resetModules();
      for (const k of ['VITE_MODE_RANKED', 'VITE_SHIELD_SHOP', 'VITE_SHIELD_USDC', 'VITE_SHIELD_USDC_CLUSTER']) vi.stubEnv(k, env[k] ?? '');
      const m = await import('../../config/features');
      return [m.MODE_SHIELD_USDC, m.SHIELD_USDC_CLUSTER] as const;
    };
    const combo = async (env: Record<string, string>) => {
      vi.resetModules();
      for (const k of ['VITE_MODE_RANKED', 'VITE_SHIELD_SHOP', 'VITE_SHIELD_USDC']) vi.stubEnv(k, env[k] ?? '');
      const m = await import('../../config/features');
      return { stripe: m.MODE_SHIELD_STRIPE, usdc: m.MODE_SHIELD_USDC, shop: m.MODE_SHIELD_SHOP };
    };
    const R = { VITE_MODE_RANKED: 'true' };
    expect(await combo(R)).toEqual({ stripe: false, usdc: false, shop: false });
    expect(await combo({ ...R, VITE_SHIELD_SHOP: 'true' })).toEqual({ stripe: true, usdc: false, shop: true });
    expect(await combo({ ...R, VITE_SHIELD_USDC: 'true' })).toEqual({ stripe: false, usdc: true, shop: true });
    expect(await combo({ ...R, VITE_SHIELD_SHOP: 'true', VITE_SHIELD_USDC: 'true' })).toEqual({ stripe: true, usdc: true, shop: true });
    expect(await combo({ VITE_SHIELD_SHOP: 'true', VITE_SHIELD_USDC: 'true' })).toEqual({ stripe: false, usdc: false, shop: false });
    expect(await flags({ VITE_MODE_RANKED: 'true', VITE_SHIELD_SHOP: 'true', VITE_SHIELD_USDC: 'true' })).toEqual([true, 'devnet']);
    expect(await flags({ VITE_MODE_RANKED: 'true', VITE_SHIELD_SHOP: 'true' })).toEqual([false, 'devnet']);
    expect(await flags({ VITE_MODE_RANKED: 'true', VITE_SHIELD_USDC: 'true' })).toEqual([true, 'devnet']);
    expect(await flags({ VITE_SHIELD_USDC: 'true' })).toEqual([false, 'devnet']);
    expect(await flags({ VITE_MODE_RANKED: 'true', VITE_SHIELD_SHOP: 'true', VITE_SHIELD_USDC: 'true', VITE_SHIELD_USDC_CLUSTER: 'mainnet-beta' })).toEqual([true, 'mainnet-beta']);
    expect(await flags({ VITE_MODE_RANKED: 'true', VITE_SHIELD_SHOP: 'true', VITE_SHIELD_USDC: 'true', VITE_SHIELD_USDC_CLUSTER: 'main' })).toEqual([true, 'devnet']);
    vi.unstubAllEnvs();
  });
});

describe('shop sheet with USDC', () => {
  it('reads the USDC price from the server', () => {
    expect(info().products.map((p) => p.usdcAmount)).toEqual([1990000, 3990000, 6990000]);
    expect(parseShopInfo({ held: 0, products: [{ sku: 'a', units: 3, price_cents: 199 }] })!.products[0].usdcAmount).toBeNull();
    expect(usdcText(1990000)).toBe('1.99');
    expect(usdcText(6990000)).toBe('6.99');
  });
  it('shows no USDC button to card-only players', () => {
    for (const m of [model(), model({ usdc: null })]) {
      const html = shopBodyHtml(m);
      expect(html).not.toContain('data-a="buy-usdc"');
      expect(html).not.toContain('USDC');
      expect(html).toContain('>$1.99<');
    }
  });
  it('adds "Pay 1.99 USDC" beside the card button for a Phantom player, with the devnet badge', () => {
    const html = shopBodyHtml(model({ usdc: { cluster: 'devnet' } }));
    expect(usdcButtons(html)).toEqual([[true, 'Pay 1.99 USDC'], [true, 'Pay 3.99 USDC'], [true, 'Pay 6.99 USDC']]);
    expect(html).toContain('Card $1.99');
    expect(html).toContain('Devnet test USDC');
    expect(html).toContain('USDC payments are final on-chain');
    expect(html).toContain('Secure checkout by Stripe'); // the card path is unchanged
    expect(html).toContain("I'm 18+ or have a parent's permission");
  });
  it('shows no devnet badge on mainnet', () => {
    const html = shopBodyHtml(model({ usdc: { cluster: 'mainnet-beta' } }));
    expect(html).not.toContain('Devnet');
    expect(usdcButtons(html)).toHaveLength(3);
  });
  it('needs the age box, and follows the same caps as the card button', () => {
    expect(usdcButtons(shopBodyHtml(model({ agreed: false, usdc: { cluster: 'devnet' } }))).map((b) => b[0])).toEqual([false, false, false]);
    expect(usdcButtons(shopBodyHtml(model({ info: info({ held: 8 }), usdc: { cluster: 'devnet' } }))).map((b) => b[0])).toEqual([true, false, false]);
    expect(usdcButtons(shopBodyHtml(model({ info: info({ blocked: true }), usdc: { cluster: 'devnet' } }))).map((b) => b[0])).toEqual([false, false, false]);
  });
  it('hides the USDC button on a pack without a USDC price', () => {
    const i = info({ held: 0, products: [{ sku: 'shield_3', units: 3, price_cents: 199 }, { sku: 'shield_7', units: 7, price_cents: 399, usdc_amount: 3990000 }] });
    expect(usdcButtons(shopBodyHtml(model({ info: i, usdc: { cluster: 'devnet' } })))).toEqual([[true, 'Pay 3.99 USDC']]);
  });
  it('shows the steps: approve in Phantom, then confirming on Solana, and locks every button meanwhile', () => {
    const step = (s: 'approve' | 'confirm') => shopBodyHtml(model({ usdc: { cluster: 'devnet' }, busy: 'shield_7', rail: 'usdc', usdcStep: s, notice: s === 'approve' ? USDC_NOTICES.approve : USDC_NOTICES.confirming }));
    const a = step('approve');
    expect(a).toContain('Approve in Phantom…');
    expect(usdcButtons(a).map((b) => b[1])).toEqual(['Pay 1.99 USDC', 'Approve…', 'Pay 6.99 USDC']);
    expect(usdcButtons(a).map((b) => b[0])).toEqual([false, false, false]);
    const c = step('confirm');
    expect(c).toContain('Confirming on Solana…');
    expect(usdcButtons(c)[1][1]).toBe('Confirming…');
    expect(c).not.toContain('Opening…');
  });
  it('escapes everything it prints', () => {
    expect(shopBodyHtml(model({ usdc: { cluster: 'devnet' }, notice: { tone: 'bad', text: '<img src=x>' } }))).not.toContain('<img');
  });
});

describe('usdcPay', () => {
  const GOOD = {
    intentId: crypto.randomUUID(), reference: base58Encode(new Uint8Array(32).fill(7)), memo: 'pj-abc', receiver: '11111111111111111111111111111112',
    mint: 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr', cluster: 'devnet', amount: '1990000', decimals: 6,
  };
  const WALLET = '5njibWvkiFg4LSyzq4ySFhyCsFEF4YhTqRLJo8Z9q16p';

  it('parses the intent and refuses an incomplete or odd one', () => {
    expect(parseIntent(GOOD)).toMatchObject({ amount: '1990000', cluster: 'devnet' });
    expect(() => parseIntent({ ...GOOD, memo: '' })).toThrow(UsdcPayError);
    expect(() => parseIntent({ ...GOOD, cluster: 'testnet' })).toThrow(UsdcPayError);
    expect(() => parseIntent({ ...GOOD, amount: '-5' })).toThrow(UsdcPayError);
    expect(() => parseIntent({ ...GOOD, decimals: 9 })).toThrow(UsdcPayError);
    expect(() => parseIntent(null)).toThrow(UsdcPayError);
  });
  it('builds the transfer after reading a blockhash and checking the shop wallet\'s token account', async () => {
    const calls: string[] = [];
    const rpc = (async (method: string) => {
      calls.push(method);
      return method === 'getLatestBlockhash' ? { value: { blockhash: base58Encode(new Uint8Array(32).fill(9)) } } : { value: { owner: 'x' } };
    }) as RpcCall;
    const built = await prepareTransfer(parseIntent(GOOD), WALLET, rpc);
    expect(calls).toEqual(['getLatestBlockhash', 'getAccountInfo']);
    expect(built.destination).toBe(await deriveAta(GOOD.receiver, GOOD.mint));
    expect(built.transaction.length).toBe(1 + 64 + built.message.length);
  });
  it('stops before asking for a signature if the shop wallet has no USDC account, or Solana is unreachable', async () => {
    const noAta = (async (m: string) => (m === 'getLatestBlockhash' ? { value: { blockhash: base58Encode(new Uint8Array(32)) } } : { value: null })) as RpcCall;
    await expect(prepareTransfer(parseIntent(GOOD), WALLET, noAta)).rejects.toMatchObject({ kind: 'shop-wallet' });
    const down = (async () => { throw new Error('offline'); }) as RpcCall;
    await expect(prepareTransfer(parseIntent(GOOD), WALLET, down)).rejects.toThrow('Could not reach Solana');
  });
  it('talks JSON-RPC to the cluster\'s public endpoint', async () => {
    const f = vi.fn(async (_u: string, init?: RequestInit) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: { ok: JSON.parse(String(init?.body)).method } })));
    expect(await rpcFor('devnet', f as never)('getHealth', [])).toEqual({ ok: 'getHealth' });
    expect(f.mock.calls[0][0]).toBe('https://api.devnet.solana.com');
    expect(rpcFor('mainnet-beta', f as never)).toBeTypeOf('function');
    await rpcFor('mainnet-beta', f as never)('x', []);
    expect(f.mock.calls[1][0]).toBe('https://api.mainnet-beta.solana.com');
    const bad = (async () => new Response('', { status: 429 })) as never;
    await expect(rpcFor('devnet', bad)('x', [])).rejects.toThrow('HTTP 429');
  });

  describe('signAndSend', () => {
    const SIG = base58Encode(new Uint8Array(64).fill(3));
    const built = { source: 's', destination: 'd', message: new Uint8Array([1, 2, 3]), transaction: new Uint8Array([1, 0, 1, 2, 3]) };
    it('hands Phantom a serializable transaction and returns the signature', async () => {
      let got: { serialize(): Uint8Array } | null = null;
      const p: PayProvider = { publicKey: { toString: () => WALLET }, signAndSendTransaction: async (tx) => { got = tx as never; return { signature: SIG }; } };
      expect(await signAndSend(p, built, WALLET)).toBe(SIG);
      expect([...got!.serialize()]).toEqual([1, 0, 1, 2, 3]);
    });
    it('reports a cancelled prompt as "not charged"', async () => {
      const p: PayProvider = { signAndSendTransaction: async () => { throw Object.assign(new Error('User rejected the request.'), { code: 4001 }); } };
      await expect(signAndSend(p, built, WALLET)).rejects.toMatchObject({ kind: 'rejected' });
    });
    it('refuses when Phantom is on another wallet, and when there is no Phantom', async () => {
      const p: PayProvider = { publicKey: { toString: () => 'SomeoneElse' }, signAndSendTransaction: vi.fn(async () => SIG) };
      await expect(signAndSend(p, built, WALLET)).rejects.toMatchObject({ kind: 'wrong-wallet' });
      expect(p.signAndSendTransaction).not.toHaveBeenCalled();
      await expect(signAndSend({}, built, WALLET)).rejects.toMatchObject({ kind: 'no-phantom' });
    });
    it('falls back to request() only when Phantom could not read the transaction, never after a send that may have happened', async () => {
      const request = vi.fn(async () => ({ signature: SIG }));
      const p1: PayProvider = { signAndSendTransaction: async () => { throw new TypeError('tx.serialize is not a function'); }, request };
      expect(await signAndSend(p1, built, WALLET)).toBe(SIG);
      expect(request).toHaveBeenCalledWith({ method: 'signAndSendTransaction', params: { message: base58Encode(built.transaction) } });
      const request2 = vi.fn(async () => ({ signature: SIG }));
      const p2: PayProvider = { signAndSendTransaction: async () => { throw new Error('network error'); }, request: request2 };
      await expect(signAndSend(p2, built, WALLET)).rejects.toThrow('Check Phantom');
      expect(request2).not.toHaveBeenCalled();
    });
    it('rejects an answer without a real signature', async () => {
      await expect(signAndSend({ signAndSendTransaction: async () => ({ signature: 'abc' }) }, built, WALLET)).rejects.toThrow('signature');
      expect(base58Decode(SIG)).toHaveLength(64);
    });
  });

  describe('pollConfirm', () => {
    const clock = () => { let t = 0; return { now: () => t, sleep: async (ms: number) => { t += ms; } }; };
    it('keeps asking while pending and resolves when credited', async () => {
      const answers = [{ status: 'pending' as const }, { status: 'pending' as const }, { status: 'credited' as const, credited: 3 }];
      const confirm = vi.fn(async () => answers.shift()!);
      expect(await pollConfirm(confirm, clock())).toEqual({ status: 'credited', credited: 3 });
      expect(confirm).toHaveBeenCalledTimes(3);
    });
    it('times out while pending, stops when asked, and lets a refusal through', async () => {
      expect(await pollConfirm(async () => ({ status: 'pending' }), { ...clock(), intervalMs: 1000, timeoutMs: 5000 })).toBe('timeout');
      expect(await pollConfirm(async () => ({ status: 'pending' }), { ...clock(), stop: () => true })).toBe('timeout');
      await expect(pollConfirm(async () => { throw new Error('The payment amount does not match the price'); }, clock())).rejects.toThrow('does not match');
    });
  });
});

describe('shop sheet by payment flags', () => {
  const hasCard = (h: string) => h.includes('data-a="buy"');
  const hasUsdc = (h: string) => h.includes('data-a="buy-usdc"');
  const phantom = { cluster: 'devnet' as const };
  it('Stripe only: card button, no USDC', () => {
    const h = shopBodyHtml(model({ card: true, usdc: null }));
    expect(hasCard(h)).toBe(true);
    expect(hasUsdc(h)).toBe(false);
    expect(h).toContain('Stripe');
  });
  it('USDC only: USDC button, no card button, no Stripe text', () => {
    const h = shopBodyHtml(model({ card: false, usdc: phantom }));
    expect(hasCard(h)).toBe(false);
    expect(hasUsdc(h)).toBe(true);
    expect(h).not.toContain('Stripe');
    expect(h).toContain('Pay 1.99 USDC');
  });
  it('both on: both buttons', () => {
    const h = shopBodyHtml(model({ card: true, usdc: phantom }));
    expect(hasCard(h)).toBe(true);
    expect(hasUsdc(h)).toBe(true);
  });
  it('USDC only for a non-Phantom player: no buy buttons at all, a hint instead', () => {
    const h = shopBodyHtml(model({ card: false, usdc: null }));
    expect(hasCard(h) || hasUsdc(h)).toBe(false);
    expect(h).toContain('Sign in with Phantom');
  });
  it('both off: no shop button on the hub', async () => {
    const { shieldItemHtml } = await import('./view');
    expect(shieldItemHtml({ count: 1, armed: false, locked: false, arm_block: null, next_use_at: null } as never, Date.now(), false)).not.toContain('data-a="shop"');
  });
});
