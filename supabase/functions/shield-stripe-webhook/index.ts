// shield-stripe-webhook: Stripe events -> Rank Shield credits and revokes. Deploy with --no-verify-jwt (Stripe sends no JWT;
// the Stripe-Signature check is the authentication). See _shared/shield/webhook.ts and docs/rank-shield-stripe.md.
// Secrets: STRIPE_WEBHOOK_SECRET (whsec_...); optional STRIPE_LIVE_MODE.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { webhookConfig, webhookHandler } from '../_shared/shield/webhook.ts';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

Deno.serve((req) => webhookHandler(req, webhookConfig((k) => Deno.env.get(k)), {
  log: (m) => console.error(m),
  store: {
    async credit(a) {
      const { data, error } = await admin.rpc('pokejam_shield_credit_purchase', {
        p_session: a.session, p_user: a.user, p_sku: a.sku, p_units: a.units, p_payment_intent: a.paymentIntent,
        p_amount_cents: a.amountCents, p_event: a.event, p_event_type: a.type,
      });
      if (error) throw new Error(error.message);
      return data;
    },
    async revoke(a) {
      const { data, error } = await admin.rpc('pokejam_shield_revoke', {
        p_payment_intent: a.paymentIntent, p_reason: a.reason, p_event: a.event, p_event_type: a.type,
      });
      if (error) throw new Error(error.message);
      return data;
    },
  },
}));
