// shield-usdc-confirm: the player's wallet sent the USDC; this function reads the transaction from Solana, verifies it against
// the intent (mint, exact amount, receiver, signer, reference, memo, time window) and credits the shields once. Returns
// {status:'pending'} (HTTP 202) until the transaction is confirmed: the client asks again with the same signature.
// See _shared/shield/usdc-handlers.ts and docs/rank-shield-usdc.md. Keep JWT verification ON (the default) when deploying.
import { usdcRuntime } from '../_shared/shield/usdc-deps.ts';
import { usdcConfirmHandler } from '../_shared/shield/usdc-handlers.ts';

const { cfg, deps } = usdcRuntime();
Deno.serve((req) => usdcConfirmHandler(req, cfg, deps));
