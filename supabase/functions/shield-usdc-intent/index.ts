// shield-usdc-intent: a Phantom-signed-in player asks to pay for a Rank Shield pack in USDC. Checks the shop caps and returns a
// one-time intent (reference key, memo, price, receiver, mint, cluster). See _shared/shield/usdc-handlers.ts and
// docs/rank-shield-usdc.md. Keep JWT verification ON (the default) when deploying.
// Secrets: SHIELD_USDC_RECEIVER (the owner's PUBLIC wallet address), SHIELD_USDC_CLUSTER, SHIELD_USDC_ALLOW_MAINNET,
// SHIELD_USDC_RPC_URL, SHIELD_ALLOWED_ORIGINS. No private key is ever needed.
import { usdcRuntime } from '../_shared/shield/usdc-deps.ts';
import { usdcIntentHandler } from '../_shared/shield/usdc-handlers.ts';

const { cfg, deps } = usdcRuntime();
Deno.serve((req) => usdcIntentHandler(req, cfg, deps));
