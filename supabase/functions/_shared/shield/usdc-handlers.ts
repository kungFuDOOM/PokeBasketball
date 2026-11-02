// shield-usdc-intent and shield-usdc-confirm. The client sends a sku (intent) or an intent id plus a transaction signature
// (confirm); everything else is decided here: the user and their Phantom wallet come from the verified JWT's user record, the
// price and units from the database, the receiver and mint from config, and the payment itself from the Solana RPC.
// Nothing is credited on the client's say-so.
import { base58Decode, base58Encode, randomBytes, randomId } from '../pack/bytes.ts';
import { USDC_DECIMALS } from './usdc-chain.ts';
import { EXPIRY_GRACE_SECONDS, type UsdcConfig } from './usdc-config.ts';
import { verifyUsdcTx, type ChainTx, type IntentFacts } from './usdc-verify.ts';

export interface UsdcUser { id: string; anonymous: boolean; /** The Solana address on the verified user record, or null. */ wallet: string | null }

export interface IntentRow {
  id: string; sku: string; units: number; amount: number | string; mint: string; cluster: string; receiver: string; wallet: string;
  reference: string; memo: string; status: 'pending' | 'credited'; signature: string | null; created_at: number; expires_at: number;
}
export interface IntentCall { ok: boolean; code?: string; message?: string; intent_id?: string; sku?: string; units?: number; amount?: number | string; expires_at?: string }
export interface CreditCall { status: string; credited?: number; short?: number; needs_refund?: boolean }

export interface UsdcDeps {
  /** The verified player behind a session token (Supabase Auth getUser), or null. */
  userOf(jwt: string): Promise<UsdcUser | null>;
  /** pokejam_shield_usdc_intent with the service role. */
  createIntent(a: { user: string; anonymous: boolean; sku: string; wallet: string | null; reference: string; memo: string; receiver: string; mint: string; cluster: string }): Promise<IntentCall>;
  /** pokejam_shield_usdc_intent_get. */
  getIntent(id: string, user: string): Promise<IntentRow | null>;
  /** pokejam_shield_credit_usdc. */
  credit(intent: string, user: string, signature: string): Promise<CreditCall>;
  /** getTransaction (jsonParsed) at the config's commitment; null when the cluster doesn't have it yet. */
  getTransaction(signature: string): Promise<ChainTx | null>;
  nowMs?: () => number;
  log?: (msg: string) => void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CODE_STATUS: Record<string, number> = { guest: 401, no_wallet: 403, unknown_sku: 400, inactive: 409, no_usdc: 409, blocked: 403, hold_cap: 409, season_cap: 409, rate_limited: 429 };

/** Common front door: CORS, method, origin, config, JWT, non-guest, linked wallet. Returns the user, or the response to send. */
async function gate(req: Request, cfg: UsdcConfig, deps: UsdcDeps, fn: string): Promise<{ user: UsdcUser & { wallet: string }; json: (b: unknown, s?: number) => Response } | Response> {
  const origin = req.headers.get('origin') ?? '';
  const allowed = cfg.origins.includes(origin);
  const cors: Record<string, string> = {
    'access-control-allow-origin': allowed ? origin : 'null',
    'access-control-allow-headers': 'authorization, x-client-info, apikey, content-type',
    'access-control-allow-methods': 'POST, OPTIONS',
    vary: 'origin',
  };
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'content-type': 'application/json' } });
  if (req.method === 'OPTIONS') return new Response(null, { status: allowed ? 204 : 403, headers: cors });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (!allowed) return json({ error: 'origin not allowed' }, 403);
  if (cfg.disabled) {
    deps.log?.(`${fn}: USDC payments off: ${cfg.disabled}`);
    return json({ error: 'USDC payments are not open yet' }, 503);
  }
  const jwt = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const user = jwt ? await deps.userOf(jwt).catch(() => null) : null;
  if (!user) return json({ error: 'Sign in to buy' }, 401);
  if (user.anonymous) return json({ error: 'Sign in with Phantom to pay with USDC', code: 'guest' }, 403);
  if (!user.wallet) return json({ error: 'Sign in with Phantom to pay with USDC', code: 'no_wallet' }, 403);
  return { user: user as UsdcUser & { wallet: string }, json };
}

export async function usdcIntentHandler(req: Request, cfg: UsdcConfig, deps: UsdcDeps): Promise<Response> {
  const g = await gate(req, cfg, deps, 'shield-usdc-intent');
  if (g instanceof Response) return g;
  const { user, json } = g;
  type Body = { sku?: unknown; ageConfirmed?: unknown } | null;
  let body: Body = null;
  try { body = (await req.json()) as Body; } catch { /* handled below */ }
  const sku = body?.sku;
  if (typeof sku !== 'string' || !/^[a-z0-9_]{1,32}$/.test(sku)) return json({ error: 'Unknown pack' }, 400);
  if (body?.ageConfirmed !== true) return json({ error: "Confirm you are 18+ or have a parent's permission", code: 'age' }, 400);
  const reference = base58Encode(randomBytes(32));
  const memo = `pj-${randomId(12)}`;
  let c: IntentCall;
  try {
    c = await deps.createIntent({ user: user.id, anonymous: user.anonymous, sku, wallet: user.wallet, reference, memo, receiver: cfg.receiver, mint: cfg.mint, cluster: cfg.cluster });
  } catch (e) {
    deps.log?.(`shield-usdc-intent: ${e instanceof Error ? e.message : String(e)}`);
    return json({ error: 'Could not start the payment. Try again in a moment.' }, 502);
  }
  if (!c.ok || !c.intent_id) return json({ error: c.message ?? 'Not available', code: c.code }, CODE_STATUS[c.code ?? ''] ?? 400);
  return json({
    intentId: c.intent_id, sku, units: c.units, reference, memo, receiver: cfg.receiver, mint: cfg.mint, cluster: cfg.cluster,
    amount: String(c.amount), decimals: USDC_DECIMALS, expiresAt: c.expires_at,
  });
}

const SIG_BYTES = 64;
const isSignature = (s: unknown): s is string => {
  if (typeof s !== 'string' || s.length < 80 || s.length > 90) return false;
  try { return base58Decode(s).length === SIG_BYTES; } catch { return false; }
};

/**
 * Responses: 200 {status:'credited', credited, short}; 202 {status:'pending'} (not confirmed yet: ask again with the same
 * signature); 4xx {error, code} for a refused payment. Safe to call again with the same signature at any time (it is the
 * reconcile path too): the database credits once per intent and once per signature.
 */
export async function usdcConfirmHandler(req: Request, cfg: UsdcConfig, deps: UsdcDeps): Promise<Response> {
  const g = await gate(req, cfg, deps, 'shield-usdc-confirm');
  if (g instanceof Response) return g;
  const { user, json } = g;
  type Body = { intentId?: unknown; signature?: unknown } | null;
  let body: Body = null;
  try { body = (await req.json()) as Body; } catch { /* handled below */ }
  const intentId = body?.intentId;
  const signature = body?.signature;
  if (typeof intentId !== 'string' || !UUID.test(intentId) || !isSignature(signature)) return json({ error: 'Bad request', code: 'bad_request' }, 400);
  const intent = await deps.getIntent(intentId, user.id).catch(() => null);
  if (!intent) return json({ error: 'Unknown purchase', code: 'no_intent' }, 404);
  if (intent.wallet !== user.wallet) return json({ error: 'The payment was not signed by your signed-in wallet', code: 'wrong_signer' }, 403);
  if (intent.cluster !== cfg.cluster || intent.mint !== cfg.mint) return json({ error: 'The shop switched networks. Start a new purchase', code: 'cluster_changed' }, 409);
  if (intent.status === 'credited') {
    return intent.signature === signature
      ? json({ status: 'credited', duplicate: true })
      : json({ error: 'This purchase was already paid with another transaction', code: 'intent_done' }, 409);
  }
  let tx: ChainTx | null;
  try {
    tx = await deps.getTransaction(signature);
  } catch (e) {
    deps.log?.(`shield-usdc-confirm: RPC failed: ${e instanceof Error ? e.message : String(e)}`);
    return json({ error: 'Could not reach Solana. Try again in a moment.', code: 'rpc' }, 502);
  }
  const facts: IntentFacts = { amount: intent.amount, mint: intent.mint, receiver: intent.receiver, wallet: intent.wallet, reference: intent.reference, memo: intent.memo, createdAt: intent.created_at, expiresAt: intent.expires_at };
  const v = await verifyUsdcTx(tx, signature, facts);
  if (!v.ok) {
    if (v.code === 'pending') {
      const nowS = Math.floor((deps.nowMs ?? Date.now)() / 1000);
      if (!tx && nowS > intent.expires_at + EXPIRY_GRACE_SECONDS) return json({ error: 'This payment window has expired. Start a new purchase', code: 'expired' }, 410);
      return json({ status: 'pending' }, 202);
    }
    return json({ error: v.message, code: v.code }, v.code === 'tx_failed' ? 409 : v.code === 'expired' ? 410 : 400);
  }
  let r: CreditCall;
  try {
    r = await deps.credit(intent.id, user.id, signature);
  } catch (e) {
    deps.log?.(`shield-usdc-confirm: credit failed: ${e instanceof Error ? e.message : String(e)}`);
    return json({ error: 'Could not record the payment. Try again in a moment.', code: 'db' }, 502);
  }
  if (r.status === 'credited' || r.status === 'duplicate') {
    if (r.needs_refund || (r.short ?? 0) > 0) deps.log?.(`shield-usdc-confirm: intent ${intent.id} was over the hold cap: ${r.short} unit(s) need a manual USDC refund`);
    return json({ status: 'credited', credited: r.credited ?? 0, short: r.short ?? 0, duplicate: r.status === 'duplicate' });
  }
  if (r.status === 'signature_used') return json({ error: 'That transaction already paid for another purchase', code: 'signature_used' }, 409);
  if (r.status === 'intent_done') return json({ error: 'This purchase was already paid with another transaction', code: 'intent_done' }, 409);
  return json({ error: 'Unknown purchase', code: r.status }, 404);
}
