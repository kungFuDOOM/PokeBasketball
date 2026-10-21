// Server configuration from environment variables. See server/.env.example for every option.

export type Cluster = 'mainnet-beta' | 'devnet';

const env = (k: string, d?: string) => {
  const v = process.env[k];
  return v === undefined || v === '' ? d : v;
};
const num = (k: string, d: number) => {
  const v = Number(env(k));
  return Number.isFinite(v) && env(k) !== undefined ? v : d;
};
const list = (k: string) => (env(k) ?? '').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);

const USDC = { 'mainnet-beta': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', devnet: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU' };
const CC = { 'mainnet-beta': 'https://gacha.collectorcrypt.com', devnet: 'https://dev-gacha.collectorcrypt.com' };
const RPC = { 'mainnet-beta': 'https://api.mainnet-beta.solana.com', devnet: 'https://api.devnet.solana.com' };

export function loadConfig() {
  const cluster = (env('CLUSTER', 'devnet') === 'mainnet-beta' ? 'mainnet-beta' : 'devnet') as Cluster;
  return {
    port: num('PORT', 8787),
    dbPath: env('DB_PATH', './data/pokejam.sqlite')!,
    /** Comma-separated origins allowed to call the API (the game's URL). */
    clientOrigins: (env('CLIENT_ORIGIN', 'http://localhost:5173') ?? '').split(',').map((s) => s.trim()).filter(Boolean),
    cluster,
    rpcUrl: env('RPC_URL', RPC[cluster])!,
    usdcMint: env('USDC_MINT', USDC[cluster])!,
    /** The house wallet's 64-byte secret key (JSON array or base58). Pays for prize pulls. Keep it in a secrets manager. */
    houseSecret: env('HOUSE_SECRET_KEY'),
    /** The house wallet's USDC token account (its associated token account for the USDC mint). Deposits land here. */
    houseUsdcAccount: env('HOUSE_USDC_ACCOUNT', '')!,
    ccBaseUrl: env('CC_BASE_URL', CC[cluster])!,
    ccApiKey: env('CC_API_KEY'),
    payoutMode: (env('PAYOUT_MODE', 'gift') === 'open' ? 'open' : 'gift') as 'gift' | 'open',
    /** Comma-separated US state codes where paid battles are off. Empty by default. */
    restrictedRegions: list('RESTRICTED_REGIONS'),
    minDepositUsd: num('MIN_DEPOSIT_USD', 5),
    minWithdrawalUsd: num('MIN_WITHDRAWAL_USD', 10),
    pickSeconds: num('PICK_SECONDS', 20),
    acceptTimeoutSeconds: num('ACCEPT_TIMEOUT_SECONDS', 180),
    forfeitSeconds: num('FORFEIT_SECONDS', 20),
    maxOpenBattlesPerPlayer: num('MAX_OPEN_BATTLES', 3),
    depositPollSeconds: num('DEPOSIT_POLL_SECONDS', 15),
    depositCommitment: (env('DEPOSIT_COMMITMENT', 'finalized') === 'confirmed' ? 'confirmed' : 'finalized') as 'confirmed' | 'finalized',
    payoutPollSeconds: num('PAYOUT_POLL_SECONDS', 5),
    /** Bearer token for /api/admin/*. Leave unset to disable the admin API. */
    adminToken: env('ADMIN_TOKEN'),
    /** Requests per minute per IP for the HTTP API. */
    rateLimitPerMinute: num('RATE_LIMIT_PER_MINUTE', 240),
    /** Tests only: run match clocks this many times faster than real time. Never set in production. */
    simSpeed: Math.max(1, num('SIM_SPEED', 1)),
  };
}

export type Config = ReturnType<typeof loadConfig>;
