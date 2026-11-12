// Edge Function settings, from Edge Function secrets (never the repo). SUPABASE_URL and
// SUPABASE_SERVICE_ROLE_KEY are provided by the Edge runtime; the rest are set with `supabase secrets set`.
//
// Devnet only until kungFuDOOM approves real money: any other cluster refuses to start unless
// PACK_ALLOW_MAINNET is set to the exact approval phrase.

import { CC_DEVNET, CC_PROD } from './collector-crypt.ts';

export type Cluster = 'devnet' | 'mainnet-beta';

export const MAINNET_APPROVAL = 'approved-by-kungfudoom';

export interface PackConfig {
  cluster: Cluster;
  rpcUrl: string;
  ccBaseUrl: string;
  ccApiKey: string | undefined;
  /** Partner machine codes by tier (CC_MACHINE_CODES), when set. */
  ccMachineCodes: Partial<Record<string, string>>;
  /** The house wallet's 64-byte secret (Solana CLI JSON array or base58). */
  houseSecret: string;
  /** The house's USDC token account, checked before every purchase. */
  houseUsdcAccount: string;
  /** The USDC mint CC charges in (on devnet, its own USDC-Dev). */
  usdcMint: string;
  /** Collector Crypt's gacha wallet: it co-signs every purchase and owns the account the house pays. */
  ccSigner: string | undefined;
  /** Refusals from CC before a winner is credited the pot instead. */
  fallbackAfter: number;
  /** Seconds the winner has, once their card is revealed, to keep it or sell it back. Then their saved preference applies. 0 = no wait. */
  choiceSeconds: number;
  /** Priority fee on the house's own transactions (withdrawals), in micro-lamports per compute unit. */
  priorityMicroLamports: number;
  /** Where alerts go (a Slack or Discord incoming webhook), at most hourly for the same alert. Optional. */
  alertWebhookUrl: string | undefined;
  supabaseUrl: string;
  serviceKey: string;
}

const RPC: Record<Cluster, string> = { devnet: 'https://api.devnet.solana.com', 'mainnet-beta': 'https://api.mainnet-beta.solana.com' };
const CC: Record<Cluster, string> = { devnet: CC_DEVNET, 'mainnet-beta': CC_PROD };
const USDC: Record<Cluster, string> = { devnet: 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr', 'mainnet-beta': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' };
// Collector Crypt's gacha wallet, which owns the USDC account every purchase pays. Devnet: read from CC's devnet
// transactions (2026-10-22). Mainnet: the owner of D9CEogjHA6CpS12F8St9zpSco7pQKJB5uR1RqDsuzQZk, the gacha wallet's
// USDC account that CC's API docs publish, read on-chain on 2026-11-12 (the same address the docs list as the
// buyback rent destination). CC_SIGNER overrides it.
const CC_SIGNER: Record<Cluster, string | undefined> = { devnet: 'A4ahkivAG4NoZAE8Sy4qv8nn2DU9yoXRQcttuCeGtTJv', 'mainnet-beta': 'GachaNgyXTU3zFogQ8Z5jR2BLXs8215X2AtEH18VxJq3' };

/** CC_MACHINE_CODES: an optional JSON map from a tier to the partner machine code to buy from, e.g.
 * {"pokemon_25":"bf_poke25_xyz"}. Without it the machines are found by price on the key's own machine list. */
function machineCodes(raw: string | undefined): Partial<Record<string, string>> {
  if (!raw) return {};
  try {
    const o = JSON.parse(raw) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(o).filter(([, v]) => typeof v === 'string' && v.trim() !== '').map(([k, v]) => [k, (v as string).trim()]));
  } catch {
    throw new Error('CC_MACHINE_CODES must be JSON, like {"pokemon_25":"bf_poke25"}');
  }
}

export function packConfig(get: (k: string) => string | undefined, opts: { needHouse?: boolean } = {}): PackConfig {
  const val = (k: string) => { const v = get(k); return v === undefined || v.trim() === '' ? undefined : v.trim(); };
  const need = (k: string) => { const v = val(k); if (!v) throw new Error(`${k} is not set`); return v; };
  const cluster: Cluster = val('CLUSTER') === 'mainnet-beta' ? 'mainnet-beta' : 'devnet';
  if (cluster !== 'devnet' && val('PACK_ALLOW_MAINNET') !== MAINNET_APPROVAL) {
    throw new Error('Pack Battles payouts are devnet-only until kungFuDOOM approves real money');
  }
  // With real money, the house only signs once it can check where every payment goes.
  if (cluster === 'mainnet-beta' && (!val('HOUSE_USDC_ACCOUNT') || !(val('CC_SIGNER') ?? CC_SIGNER[cluster]))) {
    throw new Error("Mainnet needs HOUSE_USDC_ACCOUNT and CC_SIGNER (Collector Crypt's gacha wallet, confirmed with them)");
  }
  // The public mainnet RPC rate-limits history lookups (deposits) and drops sends under load: use a paid one.
  if (cluster === 'mainnet-beta' && (!val('RPC_URL') || val('RPC_URL') === RPC['mainnet-beta'])) {
    throw new Error('Mainnet needs RPC_URL set to a paid RPC (Helius, Triton or QuickNode), not the public endpoint');
  }
  const fallback = Number(val('PRIZE_FALLBACK_ATTEMPTS') ?? 3);
  const choice = Number(val('PRIZE_CHOICE_SECONDS') ?? 120);
  return {
    cluster,
    rpcUrl: val('RPC_URL') ?? RPC[cluster],
    ccBaseUrl: val('CC_BASE_URL') ?? CC[cluster],
    ccApiKey: val('CC_API_KEY'),
    ccMachineCodes: machineCodes(val('CC_MACHINE_CODES')),
    houseSecret: opts.needHouse === false ? val('HOUSE_SECRET_KEY') ?? '' : need('HOUSE_SECRET_KEY'),
    houseUsdcAccount: val('HOUSE_USDC_ACCOUNT') ?? '',
    usdcMint: val('USDC_MINT') ?? USDC[cluster],
    ccSigner: val('CC_SIGNER') ?? CC_SIGNER[cluster],
    fallbackAfter: Number.isInteger(fallback) && fallback >= 1 ? fallback : 3,
    choiceSeconds: Number.isFinite(choice) && choice >= 0 ? Math.min(Math.round(choice), 86_400) : 120,
    priorityMicroLamports: Math.max(0, Math.min(Number(val('PRIORITY_MICROLAMPORTS') ?? (cluster === 'devnet' ? 0 : 20_000)) || 0, 5_000_000)),
    alertWebhookUrl: val('ALERT_WEBHOOK_URL'),
    supabaseUrl: need('SUPABASE_URL'),
    serviceKey: need('SUPABASE_SERVICE_ROLE_KEY'),
  };
}

/**
 * Why a worker must not run on this cluster with the database's switches as they are, or null. On mainnet the
 * database must say real money is on (pack_real_money) and test credits are off, so a test balance can never buy a
 * real pull or be withdrawn as real USDC. On devnet, real money must be off.
 */
export function realMoneyRefusal(cluster: Cluster, h: { real_money?: boolean; test_credits?: boolean }): string | null {
  if (cluster === 'mainnet-beta') {
    if (!h.real_money) return 'mainnet, but pack_real_money is off in the database';
    if (h.test_credits) return 'mainnet, but pack_test_credits is on in the database: turn it off before launch';
  } else if (h.real_money) {
    return 'pack_real_money is on, but the workers are on devnet';
  }
  return null;
}

/** Only callers holding the service key (cron, an admin) may run the workers. */
export function authorized(req: Request, cfg: Pick<PackConfig, 'serviceKey'>): boolean {
  const got = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const want = cfg.serviceKey;
  if (!want || got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= got.charCodeAt(i) ^ want.charCodeAt(i);
  return diff === 0;
}

export const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
