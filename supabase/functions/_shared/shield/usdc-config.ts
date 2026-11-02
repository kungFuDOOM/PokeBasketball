// Settings for the Rank Shield USDC payment, from Edge Function secrets (never the repo). The house only RECEIVES: the
// receiver is the owner's PUBLIC wallet address, and no private key exists anywhere in this feature.
//
// Devnet only (USDC-Dev) until kungFuDOOM approves real money: the mainnet cluster is refused unless
// SHIELD_USDC_ALLOW_MAINNET is the exact approval phrase (the same MAINNET_APPROVAL Pack Battles uses).
import { isAddress } from '../pack/bytes.ts';
import { MAINNET_APPROVAL } from '../pack/config.ts';
import { PUBLIC_RPC, USDC_MINT, type UsdcCluster } from './usdc-chain.ts';

export interface UsdcConfig {
  cluster: UsdcCluster;
  /** Fixed per cluster: never taken from a secret or from the client. */
  mint: string;
  /** The house wallet's public address (SHIELD_USDC_RECEIVER). */
  receiver: string;
  rpcUrl: string;
  /** 'finalized' on mainnet, 'confirmed' on devnet. */
  commitment: 'confirmed' | 'finalized';
  /** Why USDC payments are off (missing receiver, mainnet not approved), or null. Logged, never sent to the client. */
  disabled: string | null;
  origins: string[];
}

/** Seconds past an intent's expiry in which a transaction's block time is still accepted (slow confirmation, clock skew). */
export const EXPIRY_GRACE_SECONDS = 600;
/** Seconds a block time may precede the intent's creation (block times are estimates). */
export const EARLY_SKEW_SECONDS = 60;

export function usdcConfig(get: (k: string) => string | undefined): UsdcConfig {
  const val = (k: string) => { const v = get(k)?.trim(); return v ? v : undefined; };
  const asked = val('SHIELD_USDC_CLUSTER') ?? 'devnet';
  const cluster: UsdcCluster = asked === 'mainnet-beta' ? 'mainnet-beta' : 'devnet';
  const receiver = val('SHIELD_USDC_RECEIVER') ?? '';
  let disabled: string | null = null;
  if (asked !== 'devnet' && asked !== 'mainnet-beta') disabled = 'SHIELD_USDC_CLUSTER must be devnet or mainnet-beta';
  else if (cluster === 'mainnet-beta' && val('SHIELD_USDC_ALLOW_MAINNET') !== MAINNET_APPROVAL) disabled = 'USDC payments are devnet-only until kungFuDOOM approves real money';
  else if (!isAddress(receiver)) disabled = 'SHIELD_USDC_RECEIVER is not set to a Solana address';
  return {
    cluster,
    mint: USDC_MINT[cluster],
    receiver,
    rpcUrl: val('SHIELD_USDC_RPC_URL') ?? PUBLIC_RPC[cluster],
    commitment: cluster === 'mainnet-beta' ? 'finalized' : 'confirmed',
    disabled,
    origins: (get('SHIELD_ALLOWED_ORIGINS') ?? 'https://pokejam.xyz').split(',').map((s) => s.trim()).filter(Boolean),
  };
}

/** The bits of a Supabase user the wallet is read from (all optional: Supabase has used several shapes). */
export interface WalletUser {
  app_metadata?: { provider?: string; providers?: string[] } | null;
  user_metadata?: Record<string, unknown> | null;
  identities?: { provider?: string; identity_data?: Record<string, unknown> | null }[] | null;
}

function fromRecord(r: Record<string, unknown> | null | undefined): string | null {
  if (!r) return null;
  const claims = r.custom_claims as Record<string, unknown> | undefined;
  for (const [addr, chain] of [[claims?.address, claims?.chain], [r.address, r.chain], [r.wallet_address, r.chain]]) {
    if (isAddress(addr) && (chain === undefined || chain === 'solana')) return addr;
  }
  for (const k of ['sub', 'provider_id']) {
    const m = typeof r[k] === 'string' ? /^web3:solana:(.+)$/.exec(r[k] as string) : null;
    if (m && isAddress(m[1])) return m[1];
  }
  return null;
}

/**
 * The Solana address a Supabase user signed in with (Sign in with Solana), or null for a Google or guest user. Same rules as
 * src/wallet/phantom.ts getSolanaAddress. Call it on the user record Supabase Auth returned for the verified JWT.
 */
export function solanaAddressOf(user: WalletUser | null | undefined): string | null {
  if (!user) return null;
  for (const id of user.identities ?? []) {
    if (id.provider === 'web3') {
      const a = fromRecord(id.identity_data);
      if (a) return a;
    }
  }
  if (user.app_metadata?.provider === 'web3' || user.app_metadata?.providers?.includes('web3')) return fromRecord(user.user_metadata);
  return null;
}
