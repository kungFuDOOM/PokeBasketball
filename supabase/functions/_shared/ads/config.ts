// Billboard ads: Edge Function settings, from Edge Function secrets (never the repo).
import { USDC_MINT, USDC_RECEIVER } from './usdc-chain.ts';
//
// Devnet until kungFuDOOM approves mainnet: any other cluster refuses to start unless ADS_ALLOW_MAINNET is the
// exact approval phrase. Nothing here is secret on mainnet (the server never signs a burn); on devnet the faucet's
// key, AD_FAUCET_SECRET, is the test mint's authority and holds only test tokens and test SOL.

export type Cluster = 'devnet' | 'mainnet-beta';

export const MAINNET_APPROVAL = 'approved-by-kungfudoom';

/** $PJAM, the official token (Token-2022, 6 decimals). */
export const PJAM_MAINNET = 'GQe9QiBBV4G6bRUCxx2JgKrzT7G7RD17FJquBWgVpump';

export interface AdsConfig {
  cluster: Cluster;
  rpcUrl: string;
  mint: string;
  /** Sites allowed to call (exact origins). Empty: any origin. */
  origins: string[];
  /** Priority fee on the burn, in micro-lamports per compute unit (0: none). */
  priorityMicroLamports: number;
  /** Devnet only: the test mint's authority (Solana CLI JSON array or base58), for the faucet. */
  faucetSecret: string | undefined;
  /** Test tokens per faucet claim, in base units. */
  faucetAmount: bigint;
  /** Who may run the sweeper (cron). */
  serviceKey: string;
  /** Paying in USDC (the live function only; the devnet pokejam-ads has none, so its actions don't exist there). */
  usdc?: UsdcSettings;
  /** The SQL function a handler call really goes to (the live function's tables are pokejam_live_*). Default: as named. */
  dbName?: (fn: string) => string;
}

export interface UsdcSettings {
  /** Fixed per cluster (USDC_MINT): never taken from a secret or from the client. */
  mint: string;
  /** The receiving wallet's public address; the payment must land in its associated token account for `mint`. */
  receiver: string;
  /** 'finalized' on mainnet, 'confirmed' on devnet. */
  commitment: 'confirmed' | 'finalized';
}

const RPC: Record<Cluster, string> = { devnet: 'https://api.devnet.solana.com', 'mainnet-beta': 'https://api.mainnet-beta.solana.com' };

export function adsConfig(get: (k: string) => string | undefined): AdsConfig {
  const val = (k: string) => { const v = get(k); return v === undefined || v.trim() === '' ? undefined : v.trim(); };
  const need = (k: string) => { const v = val(k); if (!v) throw new Error(`${k} is not set`); return v; };
  const cluster: Cluster = val('ADS_CLUSTER') === 'mainnet-beta' ? 'mainnet-beta' : 'devnet';
  if (cluster !== 'devnet' && val('ADS_ALLOW_MAINNET') !== MAINNET_APPROVAL) {
    throw new Error('Billboard ads are devnet-only until kungFuDOOM approves mainnet');
  }
  const priority = Number(val('ADS_PRIORITY_MICROLAMPORTS') ?? (cluster === 'devnet' ? 0 : 20_000));
  const faucet = val('AD_FAUCET_AMOUNT') ?? '25000000000000';
  return {
    cluster,
    rpcUrl: val('ADS_RPC_URL') ?? RPC[cluster],
    // Mainnet burns the official $PJAM, whatever is set. Devnet: the test mint made by scripts/ads-devnet-setup.ts.
    mint: cluster === 'mainnet-beta' ? PJAM_MAINNET : need('AD_MINT'),
    origins: (val('ADS_ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    priorityMicroLamports: Number.isFinite(priority) && priority >= 0 ? Math.min(priority, 5_000_000) : 0,
    // Never a faucet on mainnet, whatever is set.
    faucetSecret: cluster === 'devnet' ? val('AD_FAUCET_SECRET') : undefined,
    faucetAmount: /^\d+$/.test(faucet) ? BigInt(faucet) : 25_000_000_000_000n,
    serviceKey: val('SUPABASE_SERVICE_ROLE_KEY') ?? '',
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Live site (pokejam.xyz): the separate pokejam-ads-live function. adsConfig above is the devnet test site's and is
// unchanged. Edge Function secrets are shared by every function in the Supabase project, so the live function takes
// its cluster as a parameter and reads ADS_LIVE_* keys for anything the devnet function also reads (RPC, origins,
// priority fee). Setting them can never move the devnet function off devnet.

/** The live function runs on mainnet only when this secret is exactly this string. */
export const LIVE_MAINNET_FLAG = 'true';

/**
 * The live tables' SQL functions: pokejam_ad_<x> is pokejam_live_ad_<x> (20261125_pokejam_ads_live.sql). The faucet's
 * once-a-day claim (devnet test tokens only; never reached on mainnet) has no live copy and stays shared.
 */
export const liveDbName = (fn: string) => (fn.startsWith('pokejam_ad_faucet_') ? fn : fn.replace(/^pokejam_ad_/, 'pokejam_live_ad_'));

/** Base58 public key (32 bytes, 32-44 chars). */
const PUBKEY = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

export interface LiveOptions {
  /** Which cluster this deployment serves. Default: mainnet-beta. */
  cluster?: Cluster;
}

export function adsConfigLive(get: (k: string) => string | undefined, opts: LiveOptions = {}): AdsConfig {
  const val = (k: string) => { const v = get(k); return v === undefined || v.trim() === '' ? undefined : v.trim(); };
  const cluster: Cluster = opts.cluster ?? 'mainnet-beta';
  if (cluster !== 'devnet' && cluster !== 'mainnet-beta') throw new Error(`unknown cluster ${String(cluster)}`);
  // Exact string, untrimmed: "TRUE", " true", "1", "yes" all refuse.
  if (cluster === 'mainnet-beta' && get('ADS_ALLOW_MAINNET') !== LIVE_MAINNET_FLAG) {
    throw new Error('pokejam-ads-live refuses mainnet: ADS_ALLOW_MAINNET is not "true"');
  }
  // NEEDS USER CONFIRMATION: the $PJAM mint was hard-coded in #45 (PJAM_MAINNET). kungFuDOOM must confirm it is the
  // official token before mainnet goes on; ADS_PJAM_MINT overrides it. On devnet there is no default: a devnet
  // deployment must name its test mint, so it can never point at the real token by accident.
  const mintVal = val('ADS_PJAM_MINT') ?? (cluster === 'mainnet-beta' ? PJAM_MAINNET : undefined);
  if (!mintVal) throw new Error('ADS_PJAM_MINT is not set');
  if (!PUBKEY.test(mintVal)) throw new Error('ADS_PJAM_MINT is not a valid Solana address');
  // USDC goes to kungfudoom.sns unless ADS_USDC_RECEIVER names another wallet. The mint is never configurable.
  const receiver = val('ADS_USDC_RECEIVER') ?? USDC_RECEIVER;
  if (!PUBKEY.test(receiver)) throw new Error('ADS_USDC_RECEIVER is not a valid Solana address');
  const priority = Number(val('ADS_LIVE_PRIORITY_MICROLAMPORTS') ?? (cluster === 'devnet' ? 0 : 20_000));
  const faucet = val('AD_FAUCET_AMOUNT') ?? '25000000000000';
  return {
    cluster,
    rpcUrl: val('ADS_LIVE_RPC_URL') ?? RPC[cluster],
    mint: mintVal,
    origins: (val('ADS_LIVE_ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    priorityMicroLamports: Number.isFinite(priority) && priority >= 0 ? Math.min(priority, 5_000_000) : 0,
    // Hard-off on mainnet, whatever is set: the handler's faucet action 404s and the board reports faucet: false.
    faucetSecret: cluster === 'devnet' ? val('AD_FAUCET_SECRET') : undefined,
    faucetAmount: /^\d+$/.test(faucet) ? BigInt(faucet) : 25_000_000_000_000n,
    serviceKey: val('SUPABASE_SERVICE_ROLE_KEY') ?? '',
    usdc: { mint: USDC_MINT[cluster], receiver, commitment: cluster === 'mainnet-beta' ? 'finalized' : 'confirmed' },
    dbName: liveDbName,
  };
}
