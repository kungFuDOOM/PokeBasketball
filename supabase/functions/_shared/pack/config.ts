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
  supabaseUrl: string;
  serviceKey: string;
}

const RPC: Record<Cluster, string> = { devnet: 'https://api.devnet.solana.com', 'mainnet-beta': 'https://api.mainnet-beta.solana.com' };
const CC: Record<Cluster, string> = { devnet: CC_DEVNET, 'mainnet-beta': CC_PROD };
const USDC: Record<Cluster, string> = { devnet: 'Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr', 'mainnet-beta': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v' };
// Read from CC's devnet transactions (2026-10-22). Mainnet's: confirm with Collector Crypt.
const CC_SIGNER: Record<Cluster, string | undefined> = { devnet: 'A4ahkivAG4NoZAE8Sy4qv8nn2DU9yoXRQcttuCeGtTJv', 'mainnet-beta': undefined };

export function packConfig(get: (k: string) => string | undefined, opts: { needHouse?: boolean } = {}): PackConfig {
  const val = (k: string) => { const v = get(k); return v === undefined || v.trim() === '' ? undefined : v.trim(); };
  const need = (k: string) => { const v = val(k); if (!v) throw new Error(`${k} is not set`); return v; };
  const cluster: Cluster = val('CLUSTER') === 'mainnet-beta' ? 'mainnet-beta' : 'devnet';
  if (cluster !== 'devnet' && val('PACK_ALLOW_MAINNET') !== MAINNET_APPROVAL) {
    throw new Error('Pack Battles payouts are devnet-only until kungFuDOOM approves real money');
  }
  const fallback = Number(val('PRIZE_FALLBACK_ATTEMPTS') ?? 3);
  const choice = Number(val('PRIZE_CHOICE_SECONDS') ?? 120);
  return {
    cluster,
    rpcUrl: val('RPC_URL') ?? RPC[cluster],
    ccBaseUrl: val('CC_BASE_URL') ?? CC[cluster],
    ccApiKey: val('CC_API_KEY'),
    houseSecret: opts.needHouse === false ? val('HOUSE_SECRET_KEY') ?? '' : need('HOUSE_SECRET_KEY'),
    houseUsdcAccount: val('HOUSE_USDC_ACCOUNT') ?? '',
    usdcMint: val('USDC_MINT') ?? USDC[cluster],
    ccSigner: val('CC_SIGNER') ?? CC_SIGNER[cluster],
    fallbackAfter: Number.isInteger(fallback) && fallback >= 1 ? fallback : 3,
    choiceSeconds: Number.isFinite(choice) && choice >= 0 ? Math.min(Math.round(choice), 86_400) : 120,
    supabaseUrl: need('SUPABASE_URL'),
    serviceKey: need('SUPABASE_SERVICE_ROLE_KEY'),
  };
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
