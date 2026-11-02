// shield-create-checkout: creates a Stripe Checkout Session (TEST MODE) for a Rank Shield pack. See
// _shared/shield/checkout.ts and docs/rank-shield-stripe.md. Keep JWT verification ON (the default) when deploying.
// Secrets: STRIPE_SECRET_KEY (sk_test_...), SHIELD_SITE_URL, SHIELD_ALLOWED_ORIGINS; optional STRIPE_PRICE_SHIELD_3/7/14,
// STRIPE_LIVE_MODE. SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY come with the Edge runtime.
import { createClient } from 'npm:@supabase/supabase-js@2';
import { checkoutConfig, checkoutHandler } from '../_shared/shield/checkout.ts';

const admin = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false } });

Deno.serve((req) => checkoutHandler(req, checkoutConfig((k) => Deno.env.get(k)), {
  fetch,
  log: (m) => console.error(m),
  async userOf(jwt) {
    const { data, error } = await admin.auth.getUser(jwt);
    if (error || !data.user) return null;
    return { id: data.user.id, anonymous: data.user.is_anonymous === true };
  },
  async check(userId, sku, anonymous) {
    const { data, error } = await admin.rpc('pokejam_shield_checkout_check', { p_user: userId, p_sku: sku, p_anonymous: anonymous });
    if (error) throw new Error(error.message);
    return data;
  },
}));
