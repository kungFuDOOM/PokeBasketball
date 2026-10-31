import { describe, expect, it } from 'vitest';
import { base58Decode, base58Encode, base64Encode } from '../../supabase/functions/_shared/pack/bytes.ts';
import { USDC_MINT, USDC_RECEIVER, buildUsdcTransfer, deriveAta } from '../../supabase/functions/_shared/ads/usdc-chain.ts';
import { adsUrl } from './api';
import {
  USDC_PLANS, USDC_PLAN_HOURS, USDC_PLAN_USD, UsdcPayError, checkTransfer, isUsdcPlan, parseUsdcIntent, planBaseUnits, pollUsdcConfirm, usd,
} from './usdcPay';

/** Where `needle` first appears in `hay`, or -1. */
function find(hay: Uint8Array, needle: Uint8Array): number {
  for (let i = 0; i + needle.length <= hay.length; i++) if (needle.every((x, k) => hay[i + k] === x)) return i;
  return -1;
}

const key = (seed: number) => base58Encode(Uint8Array.from({ length: 32 }, (_, i) => (seed * 31 + i * 7 + 1) & 0xff));
const PAYER = '9wqyXNVZ4zdcfbPcRk5uM5fhy14AHmg3a2iqMTGUhezh';
const REFERENCE = key(3);
const BLOCKHASH = key(4);
const MEMO = 'pokejam-ad-usdc:0123456789abcdef';
const MAINNET_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** What pokejam-ads-live's usdc-intent answers (usdc-handlers.ts), with the transfer it builds. */
async function serverReply(over: { amount?: bigint; mint?: string; receiver?: string; payer?: string; plan?: string } = {}) {
  const amount = over.amount ?? 150_000_000n;
  const mint = over.mint ?? USDC_MINT['mainnet-beta'];
  const receiver = over.receiver ?? USDC_RECEIVER;
  const built = await buildUsdcTransfer({ payer: over.payer ?? PAYER, mint, receiver, amount, reference: REFERENCE, memo: MEMO, blockhash: BLOCKHASH });
  return {
    intent: { id: '7b0e1c2a-1111-4222-8333-944445555666', wallet: PAYER, plan: over.plan ?? 'week', amount: amount.toString(), mint, receiver, reference: REFERENCE, memo: MEMO, status: 'open' },
    tx: base64Encode(built.transaction), blockhash: BLOCKHASH, cluster: 'mainnet-beta', mint, receiver, receiverAta: built.destination, amount: amount.toString(), decimals: 6,
  };
}

describe('USDC plans', () => {
  it('maps the courtside half to $150 a week and $500 a month', () => {
    expect(USDC_PLANS).toEqual(['week', 'month']);
    expect(USDC_PLAN_USD).toEqual({ week: 150, month: 500 });
    expect(USDC_PLAN_HOURS).toEqual({ week: 168, month: 720 });
    expect(planBaseUnits('week')).toBe(150_000_000n);
    expect(planBaseUnits('month')).toBe(500_000_000n);
  });

  it('knows which plans USDC pays for', () => {
    expect(isUsdcPlan('week')).toBe(true);
    expect(isUsdcPlan('month')).toBe(true);
    expect(isUsdcPlan('hour')).toBe(false);
    expect(isUsdcPlan('day')).toBe(false);
    expect(isUsdcPlan(undefined)).toBe(false);
  });

  it('formats base units as dollars', () => {
    expect(usd('150000000')).toBe('$150');
    expect(usd(500_000_000n)).toBe('$500');
    expect(usd('1500500000')).toBe('$1,500.50');
    expect(usd('1')).toBe('$0');
  });

  it('pays the official USDC mint to kungfudoom.sns', () => {
    expect(USDC_MINT['mainnet-beta']).toBe(MAINNET_USDC);
    expect(USDC_RECEIVER).toBe('FPwoDYkHTFef4Fg45o1wzReXiVoYGP6KXEgRyfqqBpyk');
  });
});

describe('parseUsdcIntent', () => {
  it('reads the server answer', async () => {
    const i = parseUsdcIntent(await serverReply());
    expect(i).toMatchObject({ plan: 'week', amount: '150000000', cluster: 'mainnet-beta', reference: REFERENCE, memo: MEMO, blockhash: BLOCKHASH, wallet: PAYER });
  });

  it('refuses an answer it does not understand', async () => {
    const r = await serverReply();
    expect(() => parseUsdcIntent(null)).toThrow(UsdcPayError);
    expect(() => parseUsdcIntent({ ...r, cluster: 'testnet' })).toThrow(UsdcPayError);
    expect(() => parseUsdcIntent({ ...r, decimals: 9 })).toThrow(UsdcPayError);
    expect(() => parseUsdcIntent({ ...r, intent: { ...r.intent, plan: 'hour' } })).toThrow(UsdcPayError);
    expect(() => parseUsdcIntent({ ...r, intent: { ...r.intent, amount: '-5' } })).toThrow(UsdcPayError);
    expect(() => parseUsdcIntent({ ...r, tx: '' })).toThrow(UsdcPayError);
  });
});

describe('checkTransfer (the page checks the transaction before the wallet signs it)', () => {
  it('accepts the exact transfer to the receiver USDC account', async () => {
    const intent = parseUsdcIntent(await serverReply());
    const { destination } = await checkTransfer(intent, { payer: PAYER, expectAmount: '150000000' });
    expect(destination).toBe(await deriveAta(USDC_RECEIVER, MAINNET_USDC));
  });

  it('builds the same bytes the server builds: TransferChecked of the amount, then the memo', async () => {
    const built = await buildUsdcTransfer({ payer: PAYER, mint: MAINNET_USDC, receiver: USDC_RECEIVER, amount: 500_000_000n, reference: REFERENCE, memo: MEMO, blockhash: BLOCKHASH });
    const msg = built.message;
    expect(built.transaction.length).toBe(1 + 64 + msg.length);
    expect([...msg.slice(0, 3)]).toEqual([1, 0, 4]);
    expect(msg[3]).toBe(7); // payer, source, destination, mint, reference, token program, memo program
    const at = (k: string) => find(msg, base58Decode(k));
    expect(at(USDC_RECEIVER)).toBe(-1); // the receiver wallet itself is not an account: its USDC token account is
    expect(at(built.destination)).toBe(4 + 2 * 32);
    expect(at(MAINNET_USDC)).toBe(4 + 3 * 32);
    expect(at(REFERENCE)).toBe(4 + 4 * 32);
    // TransferChecked: [12, 500_000_000 as u64 LE, 6 decimals], then the memo at the very end.
    expect(find(msg, Uint8Array.from([12, 0x00, 0x65, 0xcd, 0x1d, 0, 0, 0, 0, 6]))).toBeGreaterThan(0);
    expect(new TextDecoder().decode(msg.slice(msg.length - MEMO.length))).toBe(MEMO);
  });

  it('refuses a different mint', async () => {
    const intent = parseUsdcIntent(await serverReply({ mint: key(9) }));
    await expect(checkTransfer(intent, { payer: PAYER })).rejects.toThrow(/not USDC/);
  });

  it('refuses a different receiver', async () => {
    const intent = parseUsdcIntent(await serverReply({ receiver: key(8) }));
    await expect(checkTransfer(intent, { payer: PAYER })).rejects.toThrow(/different receiver/);
  });

  it('refuses a price other than the one shown', async () => {
    const intent = parseUsdcIntent(await serverReply({ amount: 1_500_000_000n }));
    await expect(checkTransfer(intent, { payer: PAYER, expectAmount: '150000000' })).rejects.toThrow(/different price/);
  });

  it('refuses a transaction for another wallet', async () => {
    const intent = parseUsdcIntent(await serverReply());
    await expect(checkTransfer(intent, { payer: key(7) })).rejects.toThrow(/different wallet/);
  });

  it('refuses a transaction that differs from the intent (e.g. a larger amount or another destination)', async () => {
    const good = await serverReply();
    const other = await serverReply({ amount: 999_000_000n });
    const intent = parseUsdcIntent({ ...good, tx: other.tx });
    await expect(checkTransfer(intent, { payer: PAYER })).rejects.toThrow(/transaction differs/);
    const devnet = await buildUsdcTransfer({ payer: PAYER, mint: MAINNET_USDC, receiver: key(6), amount: 150_000_000n, reference: REFERENCE, memo: MEMO, blockhash: BLOCKHASH });
    await expect(checkTransfer(parseUsdcIntent({ ...good, tx: base64Encode(devnet.transaction) }), { payer: PAYER })).rejects.toThrow(/transaction differs/);
  });

  it('refuses the devnet mint on a mainnet intent', async () => {
    const intent = parseUsdcIntent(await serverReply({ mint: USDC_MINT.devnet }));
    await expect(checkTransfer(intent, { payer: PAYER })).rejects.toThrow(/not USDC/);
  });
});

describe('pollUsdcConfirm', () => {
  it('waits until paid', async () => {
    const answers = [{ status: 'pending' as const }, { status: 'open' as const }, { status: 'paid' as const }];
    let n = 0;
    const r = await pollUsdcConfirm(async () => answers[n++], { sleep: async () => {}, intervalMs: 1 });
    expect(r).toEqual({ status: 'paid' });
    expect(n).toBe(3);
  });

  it('gives up after the timeout', async () => {
    let t = 0;
    const r = await pollUsdcConfirm(async () => ({ status: 'pending' as const }), { sleep: async (ms) => { t += ms; }, now: () => t, intervalMs: 1000, timeoutMs: 3000 });
    expect(r).toBe('timeout');
  });

  it('stops on a refusal', async () => {
    await expect(pollUsdcConfirm(async () => { throw new Error('That transaction already paid for another ad.'); })).rejects.toThrow(/already paid/);
  });
});

describe('the live endpoint', () => {
  it('calls pokejam-ads-live on the Supabase project', () => {
    expect(adsUrl({ VITE_SUPABASE_URL: 'https://ksvfgxodbwfntqnahukn.supabase.co/' })).toBe('https://ksvfgxodbwfntqnahukn.supabase.co/functions/v1/pokejam-ads-live');
    expect(adsUrl({ VITE_ADS_API: 'http://localhost:54321/functions/v1/pokejam-ads-live', VITE_SUPABASE_URL: 'https://x.supabase.co' })).toBe('http://localhost:54321/functions/v1/pokejam-ads-live');
    expect(adsUrl({})).toBe('');
  });

  it('no client source names the devnet pokejam-ads function', () => {
    // Every client source file (the game, the ad page, the admin page), as text.
    const sources = import.meta.glob(['../**/*.{ts,js,html}', '!../**/*.test.ts'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
    expect(Object.keys(sources).length).toBeGreaterThan(20);
    const hits = Object.keys(sources).filter((f) => /pokejam-ads(?!-live)/.test(sources[f]));
    expect(hits).toEqual([]);
  });
});
