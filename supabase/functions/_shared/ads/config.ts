// Billboard ads: Edge Function settings, from Edge Function secrets (never the repo).
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
