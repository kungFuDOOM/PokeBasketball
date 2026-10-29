// shield-stripe-webhook: Stripe -> credits and revokes. Verifies the signature over the RAW body, then does the database
// work and answers 2xx only after it committed. A bad signature is 400; a database error is 500 so Stripe retries.
// Units come from the product row (the database ignores the units we pass); metadata only names the sku and the user.
import { verifySignature } from './stripe.ts';

export interface WebhookConfig {
  secret: string;
  /** STRIPE_LIVE_MODE=true: live events are processed. Otherwise a livemode event is ignored. */
  allowLive: boolean;
  toleranceSeconds?: number;
}

export interface CreditArgs { session: string; user: string; sku: string; units: number; paymentIntent: string; amountCents: number | null; event: string; type: string }
export interface RevokeArgs { paymentIntent: string; reason: 'refund' | 'dispute'; event: string; type: string }
export interface DbResult { status: string; credited?: number; removed?: number; short?: number }

export interface WebhookStore {
  credit(a: CreditArgs): Promise<DbResult>;
  revoke(a: RevokeArgs): Promise<DbResult>;
}

export interface WebhookDeps { store: WebhookStore; nowMs?: () => number; log?: (msg: string) => void }

export function webhookConfig(get: (k: string) => string | undefined): WebhookConfig | null {
  const secret = get('STRIPE_WEBHOOK_SECRET')?.trim();
  return secret ? { secret, allowLive: get('STRIPE_LIVE_MODE') === 'true' } : null;
}

type Obj = Record<string, unknown>;
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function webhookHandler(req: Request, cfg: WebhookConfig | null, deps: WebhookDeps): Promise<Response> {
  const log = deps.log ?? (() => {});
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  if (req.method !== 'POST') return json({ error: 'POST only' }, 405);
  if (!cfg) {
    log('shield-stripe-webhook: STRIPE_WEBHOOK_SECRET is not set');
    return json({ error: 'not configured' }, 500);
  }
  const raw = await req.text();
  const sig = await verifySignature(raw, req.headers.get('stripe-signature'), cfg.secret, (deps.nowMs ?? Date.now)(), cfg.toleranceSeconds);
  if (!sig.ok) {
    log(`shield-stripe-webhook: bad signature (${sig.reason})`);
    return json({ error: 'bad signature' }, 400);
  }
  let event: Obj;
  try { event = JSON.parse(raw) as Obj; } catch { return json({ error: 'bad json' }, 400); }
  const id = str(event.id);
  const type = str(event.type);
  const obj = ((event.data as Obj | undefined)?.object ?? {}) as Obj;
  if (!id || !type) return json({ error: 'bad event' }, 400);
  if (event.livemode === true && !cfg.allowLive) {
    log(`shield-stripe-webhook: ignored live-mode event ${id}`);
    return json({ received: true, ignored: 'livemode' });
  }
  try {
    if (type === 'checkout.session.completed' || type === 'checkout.session.async_payment_succeeded') {
      if (obj.payment_status !== 'paid' || obj.mode !== 'payment') return json({ received: true, ignored: 'not paid' });
      const meta = (obj.metadata ?? {}) as Obj;
      const user = str(obj.client_reference_id) || str(meta.user_id);
      const sku = str(meta.sku);
      if (!sku || !UUID.test(user) || (str(meta.user_id) && str(meta.user_id) !== user)) {
        log(`shield-stripe-webhook: ${id} is not a shield purchase`);
        return json({ received: true, ignored: 'not ours' });
      }
      const r = await deps.store.credit({
        session: str(obj.id), user, sku, units: Number(meta.units) || 0, paymentIntent: str(obj.payment_intent),
        amountCents: typeof obj.amount_total === 'number' ? obj.amount_total : null, event: id, type,
      });
      if (r.status === 'credited' && (r.short ?? 0) > 0) log(`shield-stripe-webhook: session ${str(obj.id)} was over the hold cap: ${r.short} unit(s) need a manual refund`);
      return json({ received: true, status: r.status });
    }
    if (type === 'charge.refunded' || type === 'charge.dispute.created') {
      const refund = type === 'charge.refunded';
      // A partial refund fires the same event with refunded=false: no revoke (the owner handles it by hand).
      if (refund && obj.refunded !== true) return json({ received: true, ignored: 'partial refund' });
      const pi = str(obj.payment_intent);
      if (!pi) return json({ received: true, ignored: 'no payment intent' });
      const r = await deps.store.revoke({ paymentIntent: pi, reason: refund ? 'refund' : 'dispute', event: id, type });
      if (r.status === 'unknown_purchase') {
        // The credit may not have landed yet: 500 makes Stripe retry. A refund of something that isn't a shield is ignored.
        const ours = !refund || !!str(((obj.metadata ?? {}) as Obj).sku);
        if (ours) return json({ error: 'purchase not found yet' }, 500);
        return json({ received: true, ignored: 'not ours' });
      }
      return json({ received: true, status: r.status });
    }
    return json({ received: true, ignored: type });
  } catch (e) {
    log(`shield-stripe-webhook: ${type} ${id} failed: ${e instanceof Error ? e.message : String(e)}`);
    return json({ error: 'database error' }, 500);
  }
}
