// shield-create-checkout: a signed-in player asks to buy a pack; we check the caps in the database and create a Stripe
// Checkout Session (hosted page, mode=payment). The client sends only a sku and its age confirmation: the price comes from
// pokejam_shield_products (or an owner secret), the units from the same row, the user from the verified JWT.
import { STRIPE_API, formEncode, keyRefusal } from './stripe.ts';

export interface CheckoutConfig {
  stripeKey: string;
  /** Why the shop is off (missing/non-test key), or null. The reason is logged, never sent to the client. */
  disabled: string | null;
  siteUrl: string;
  origins: string[];
  /** Optional per-sku price id override (secrets STRIPE_PRICE_SHIELD_3 / _7 / _14). */
  priceOverride(sku: string): string | undefined;
}

export interface CheckCall {
  ok: boolean;
  code?: string;
  message?: string;
  sku?: string;
  units?: number;
  stripe_price_id?: string | null;
  checkout_id?: number | string;
}

export interface CheckoutDeps {
  /** The verified player behind a session token (Supabase Auth getUser), or null. */
  userOf(jwt: string): Promise<{ id: string; anonymous: boolean } | null>;
  /** pokejam_shield_checkout_check with the service role. */
  check(userId: string, sku: string, anonymous: boolean): Promise<CheckCall>;
  fetch: typeof fetch;
  nowMs?: () => number;
  log?: (msg: string) => void;
}

export function checkoutConfig(get: (k: string) => string | undefined): CheckoutConfig {
  const key = get('STRIPE_SECRET_KEY')?.trim() ?? '';
  return {
    stripeKey: key,
    disabled: keyRefusal(key, get('STRIPE_LIVE_MODE')),
    siteUrl: (get('SHIELD_SITE_URL')?.trim() || 'https://pokejam.xyz').replace(/\/+$/, ''),
    origins: (get('SHIELD_ALLOWED_ORIGINS') ?? 'https://pokejam.xyz').split(',').map((s) => s.trim()).filter(Boolean),
    priceOverride: (sku) => get(`STRIPE_PRICE_${sku.toUpperCase()}`)?.trim() || undefined,
  };
}

const CODE_STATUS: Record<string, number> = { guest: 401, unknown_sku: 400, inactive: 409, blocked: 403, hold_cap: 409, season_cap: 409, rate_limited: 429 };

export async function checkoutHandler(req: Request, cfg: CheckoutConfig, deps: CheckoutDeps): Promise<Response> {
  const log = deps.log ?? (() => {});
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
    log(`shield-create-checkout: shop off: ${cfg.disabled}`);
    return json({ error: 'The shop is not open yet' }, 503);
  }
  const jwt = req.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '';
  const user = jwt ? await deps.userOf(jwt).catch(() => null) : null;
  if (!user) return json({ error: 'Sign in to buy' }, 401);
  if (user.anonymous) return json({ error: 'Sign in with Google or Phantom to buy', code: 'guest' }, 403);

  let body: { sku?: unknown; ageConfirmed?: unknown } | null = null;
  try { body = (await req.json()) as typeof body; } catch { /* handled below */ }
  const sku = body?.sku;
  if (typeof sku !== 'string' || !/^[a-z0-9_]{1,32}$/.test(sku)) return json({ error: 'Unknown pack' }, 400);
  if (body?.ageConfirmed !== true) return json({ error: "Confirm you are 18+ or have a parent's permission", code: 'age' }, 400);

  const c = await deps.check(user.id, sku, user.anonymous);
  if (!c.ok) return json({ error: c.message ?? 'Not available', code: c.code }, CODE_STATUS[c.code ?? ''] ?? 400);
  const price = cfg.priceOverride(sku) ?? c.stripe_price_id ?? '';
  if (!price) {
    log(`shield-create-checkout: no price id for ${sku}`);
    return json({ error: 'The shop is not open yet' }, 503);
  }
  const now = Math.floor((deps.nowMs ?? Date.now)() / 1000);
  const meta = { sku, user_id: user.id, units: String(Number(c.units)) };
  const form = formEncode({
    mode: 'payment',
    line_items: [{ price, quantity: 1 }],
    client_reference_id: user.id,
    metadata: meta,
    payment_intent_data: { metadata: meta },
    success_url: `${cfg.siteUrl}/?shop=success`,
    cancel_url: `${cfg.siteUrl}/?shop=cancel`,
    expires_at: now + 31 * 60,
  });
  let r: Response;
  try {
    r = await deps.fetch(`${STRIPE_API}/checkout/sessions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${cfg.stripeKey}`,
        'content-type': 'application/x-www-form-urlencoded',
        'idempotency-key': `shield-checkout-${c.checkout_id}`,
      },
      body: form,
    });
  } catch {
    return json({ error: 'Could not reach the payment provider' }, 502);
  }
  const session = (await r.json().catch(() => null)) as { url?: unknown; error?: { message?: string } } | null;
  if (!r.ok || typeof session?.url !== 'string') {
    log(`shield-create-checkout: Stripe answered ${r.status}${session?.error?.message ? `: ${session.error.message}` : ''}`);
    return json({ error: 'Could not start checkout' }, 502);
  }
  return json({ url: session.url });
}
