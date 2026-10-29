import { describe, expect, it, vi } from 'vitest';
import { checkoutConfig, checkoutHandler, type CheckCall, type CheckoutDeps } from './checkout.ts';
import { formEncode, keyRefusal, signPayload, verifySignature } from './stripe.ts';
import { webhookConfig, webhookHandler, type WebhookStore } from './webhook.ts';
import { testDb } from '../../../tests/testDb';

vi.setConfig({ testTimeout: 60_000 });

const SECRET = 'whsec_test_secret';
const NOW = 1_800_000_000_000;
const ts = NOW / 1000;

describe('Stripe-Signature verification', () => {
  const body = '{"id":"evt_1"}';
  it('accepts a valid signature, and any one of several v1 signatures', async () => {
    const good = await signPayload(SECRET, body, ts);
    expect(await verifySignature(body, good, SECRET, NOW)).toEqual({ ok: true });
    const other = await signPayload('whsec_old', body, ts);
    const v1 = (h: string) => h.split(',')[1];
    expect(await verifySignature(body, `${other},${v1(good)}`, SECRET, NOW)).toEqual({ ok: true });
    expect(await verifySignature(body, `${good},${v1(other)}`, SECRET, NOW)).toEqual({ ok: true });
  });
  it('rejects a tampered body, a wrong secret, and signatures that all differ', async () => {
    const good = await signPayload(SECRET, body, ts);
    expect(await verifySignature(body + ' ', good, SECRET, NOW)).toEqual({ ok: false, reason: 'mismatch' });
    expect(await verifySignature(body, good, 'whsec_other', NOW)).toEqual({ ok: false, reason: 'mismatch' });
    const o1 = (await signPayload('a', body, ts)).split(',')[1];
    const o2 = (await signPayload('b', body, ts)).split(',')[1];
    expect(await verifySignature(body, `t=${ts},${o1},${o2}`, SECRET, NOW)).toEqual({ ok: false, reason: 'mismatch' });
    // a signature for another timestamp doesn't verify with this one
    const moved = (await signPayload(SECRET, body, ts + 1)).split(',')[1];
    expect(await verifySignature(body, `t=${ts},${moved}`, SECRET, NOW)).toEqual({ ok: false, reason: 'mismatch' });
  });
  it('rejects an old or future timestamp (300 s) and a missing or malformed header', async () => {
    const old = await signPayload(SECRET, body, ts - 301);
    expect(await verifySignature(body, old, SECRET, NOW)).toEqual({ ok: false, reason: 'stale' });
    expect((await verifySignature(body, await signPayload(SECRET, body, ts - 299), SECRET, NOW)).ok).toBe(true);
    expect(await verifySignature(body, await signPayload(SECRET, body, ts + 400), SECRET, NOW)).toEqual({ ok: false, reason: 'stale' });
    expect(await verifySignature(body, null, SECRET, NOW)).toEqual({ ok: false, reason: 'missing' });
    expect(await verifySignature(body, 'garbage', SECRET, NOW)).toEqual({ ok: false, reason: 'malformed' });
    expect(await verifySignature(body, `t=${ts},v1=zz`, SECRET, NOW)).toEqual({ ok: false, reason: 'malformed' });
    expect(await verifySignature(body, `v1=${'a'.repeat(64)}`, SECRET, NOW)).toEqual({ ok: false, reason: 'malformed' });
    expect(await verifySignature(body, await signPayload(SECRET, body, ts), '', NOW)).toEqual({ ok: false, reason: 'missing' });
  });
  it('encodes nested form fields the way Stripe expects, and guards the key', () => {
    expect(formEncode({ mode: 'payment', line_items: [{ price: 'p 1', quantity: 1 }], metadata: { a: 'x&y' }, skip: undefined }))
      .toBe('mode=payment&line_items%5B0%5D%5Bprice%5D=p%201&line_items%5B0%5D%5Bquantity%5D=1&metadata%5Ba%5D=x%26y');
    expect(keyRefusal('sk_test_abc', undefined)).toBeNull();
    expect(keyRefusal('sk_live_abc', undefined)).toMatch(/not a test key/);
    expect(keyRefusal('sk_live_abc', 'true')).toBeNull();
    expect(keyRefusal('sk_test_abc', 'true')).toBeNull();
    expect(keyRefusal('rk_foo', 'true')).not.toBeNull();
    expect(keyRefusal('', 'true')).toMatch(/not set/);
    expect(keyRefusal(undefined, undefined)).toMatch(/not set/);
  });
});

// ---- webhook against the real SQL (PGlite) ----
async function webhookSetup() {
  const t = await testDb();
  await t.sql('select public.pokejam_ranked_season()');
  await t.sql(`update public.pokejam_shield_products set active = true, stripe_price_id = 'price_test_' || units`);
  const rpc = async (fn: string, args: unknown[]) =>
    (await t.service(`select public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) as r`, args))[0].r as { status: string };
  const store: WebhookStore = {
    credit: (a) => rpc('pokejam_shield_credit_purchase', [a.session, a.user, a.sku, a.units, a.paymentIntent, a.amountCents, a.event, a.type]),
    revoke: (a) => rpc('pokejam_shield_revoke', [a.paymentIntent, a.reason, a.event, a.type]),
  };
  const logs: string[] = [];
  const cfg = webhookConfig((k) => ({ STRIPE_WEBHOOK_SECRET: SECRET } as Record<string, string>)[k])!;
  const send = async (event: object, o: { secret?: string; at?: number; tamper?: boolean; header?: string | null; method?: string } = {}) => {
    const body = JSON.stringify(event);
    const header = o.header !== undefined ? o.header : await signPayload(o.secret ?? SECRET, body, o.at ?? ts);
    return webhookHandler(new Request('https://f.test/shield-stripe-webhook', {
      method: o.method ?? 'POST', headers: header ? { 'stripe-signature': header } : {}, body: o.method === 'GET' ? undefined : o.tamper ? body.replace('paid', 'pa1d') : body,
    }), cfg, { store, nowMs: () => NOW, log: (m) => logs.push(m) });
  };
  const held = async (id: string) => Number((await t.sql('select count from public.pokejam_shield_inventory where user_id = $1', [id]))[0]?.count ?? 0);
  return { t, send, held, logs, store };
}
const session = (user: string, o: Record<string, unknown> = {}) => ({
  id: 'cs_test_1', object: 'checkout.session', mode: 'payment', payment_status: 'paid', client_reference_id: user, payment_intent: 'pi_test_1', amount_total: 399,
  metadata: { sku: 'shield_7', user_id: user, units: '1' }, ...o,
});
const evt = (id: string, type: string, object: object, livemode = false) => ({ id, type, livemode, data: { object } });

describe('shield-stripe-webhook', () => {
  it('credits a paid checkout once, taking the units from the product row (not the metadata)', async () => {
    const s = await webhookSetup();
    const u = await s.t.user('A');
    const r = await s.send(evt('evt_1', 'checkout.session.completed', session(u.id)));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ received: true, status: 'credited' });
    expect(await s.held(u.id)).toBe(7); // metadata said 1
    expect(await s.t.sql('select amount_cents, payment_intent from public.pokejam_shield_purchases')).toEqual([{ amount_cents: 399, payment_intent: 'pi_test_1' }]);
  });

  it('the same event replayed credits once; a different event for the same session credits once', async () => {
    const s = await webhookSetup();
    const u = await s.t.user('A');
    const e = evt('evt_1', 'checkout.session.completed', session(u.id));
    expect((await s.send(e)).status).toBe(200);
    expect(await (await s.send(e)).json()).toMatchObject({ status: 'duplicate_event' });
    expect(await (await s.send(evt('evt_2', 'checkout.session.async_payment_succeeded', session(u.id)))).json()).toMatchObject({ status: 'duplicate_session' });
    expect(await s.held(u.id)).toBe(7);
  });

  it('does not credit an unpaid session, a non-payment mode, a foreign product or unrelated events', async () => {
    const s = await webhookSetup();
    const u = await s.t.user('A');
    for (const o of [{ payment_status: 'unpaid' }, { mode: 'subscription' }, { metadata: {} }, { client_reference_id: 'not-a-uuid', metadata: { sku: 'shield_7' } },
      { metadata: { sku: 'shield_7', user_id: crypto.randomUUID() } }]) {
      const r = await s.send(evt(`evt_${Math.random()}`, 'checkout.session.completed', session(u.id, o)));
      expect(r.status).toBe(200);
      expect(await r.json()).toMatchObject({ ignored: expect.any(String) });
    }
    expect((await s.send(evt('evt_x', 'payment_intent.created', {}))).status).toBe(200);
    expect(await s.held(u.id)).toBe(0);
    expect(await s.t.sql('select count(*)::int as n from public.pokejam_stripe_events')).toEqual([{ n: 0 }]);
  });

  it('credits a delayed payment (async_payment_succeeded)', async () => {
    const s = await webhookSetup();
    const u = await s.t.user('A');
    expect((await s.send(evt('evt_1', 'checkout.session.completed', session(u.id, { payment_status: 'unpaid' })))).status).toBe(200);
    expect(await s.held(u.id)).toBe(0);
    await s.send(evt('evt_2', 'checkout.session.async_payment_succeeded', session(u.id)));
    expect(await s.held(u.id)).toBe(7);
  });

  it('a full refund revokes the shields; a partial refund does not; a replay changes nothing', async () => {
    const s = await webhookSetup();
    const u = await s.t.user('A');
    await s.send(evt('evt_1', 'checkout.session.completed', session(u.id)));
    expect(await (await s.send(evt('evt_p', 'charge.refunded', { payment_intent: 'pi_test_1', refunded: false, metadata: { sku: 'shield_7' } }))).json()).toMatchObject({ ignored: 'partial refund' });
    expect(await s.held(u.id)).toBe(7);
    const full = evt('evt_r', 'charge.refunded', { payment_intent: 'pi_test_1', refunded: true, metadata: { sku: 'shield_7' } });
    expect(await (await s.send(full)).json()).toMatchObject({ status: 'revoked' });
    expect(await s.held(u.id)).toBe(0);
    expect(await (await s.send(full)).json()).toMatchObject({ status: 'duplicate_event' });
    expect(await s.held(u.id)).toBe(0);
  });

  it('a dispute revokes, blocks further checkouts, and a refund after used units records clawback_short', async () => {
    const s = await webhookSetup();
    const u = await s.t.user('A');
    await s.send(evt('evt_1', 'checkout.session.completed', session(u.id)));
    await s.t.sql('update public.pokejam_shield_inventory set count = 2 where user_id = $1', [u.id]);
    expect(await (await s.send(evt('evt_d', 'charge.dispute.created', { payment_intent: 'pi_test_1' }))).json()).toMatchObject({ status: 'revoked' });
    expect(await s.held(u.id)).toBe(0);
    expect((await s.t.sql('select clawback_short, status from public.pokejam_shield_purchases'))[0]).toEqual({ clawback_short: 5, status: 'disputed' });
    const check = (await s.t.service('select public.pokejam_shield_checkout_check($1, $2) as r', [u.id, 'shield_3']))[0].r as { code: string };
    expect(check.code).toBe('blocked');
  });

  it('answers 500 (so Stripe retries) for a refund or dispute whose purchase is not credited yet, and 200 for a charge that is not ours', async () => {
    const s = await webhookSetup();
    expect((await s.send(evt('evt_d', 'charge.dispute.created', { payment_intent: 'pi_missing' }))).status).toBe(500);
    expect((await s.send(evt('evt_r', 'charge.refunded', { payment_intent: 'pi_missing', refunded: true, metadata: { sku: 'shield_3' } }))).status).toBe(500);
    expect((await s.send(evt('evt_o', 'charge.refunded', { payment_intent: 'pi_other', refunded: true, metadata: {} }))).status).toBe(200);
    // after the credit lands, the retry works
    const u = await s.t.user('A');
    await s.send(evt('evt_1', 'checkout.session.completed', session(u.id, { payment_intent: 'pi_missing' })));
    expect((await s.send(evt('evt_r', 'charge.refunded', { payment_intent: 'pi_missing', refunded: true, metadata: { sku: 'shield_3' } }))).status).toBe(200);
    expect(await s.held(u.id)).toBe(0);
  });

  it('answers 500 on a database error and the retry then credits (the event row rolled back)', async () => {
    const s = await webhookSetup();
    const u = await s.t.user('A');
    const e = evt('evt_1', 'checkout.session.completed', session(u.id, { metadata: { sku: 'shield_99', user_id: u.id } }));
    expect((await s.send(e)).status).toBe(500);
    expect(await s.t.sql('select count(*)::int as n from public.pokejam_stripe_events')).toEqual([{ n: 0 }]);
    const fixed = evt('evt_1', 'checkout.session.completed', session(u.id));
    expect((await s.send(fixed)).status).toBe(200);
    expect(await s.held(u.id)).toBe(7);
  });

  it('answers 400 and does nothing for a bad, tampered, stale or missing signature', async () => {
    const s = await webhookSetup();
    const u = await s.t.user('A');
    const e = evt('evt_1', 'checkout.session.completed', session(u.id));
    expect((await s.send(e, { secret: 'whsec_wrong' })).status).toBe(400);
    expect((await s.send(e, { tamper: true })).status).toBe(400);
    expect((await s.send(e, { at: ts - 1000 })).status).toBe(400);
    expect((await s.send(e, { header: null })).status).toBe(400);
    expect((await s.send(e, { method: 'GET' })).status).toBe(405);
    expect(await s.held(u.id)).toBe(0);
    expect(s.logs.join()).not.toContain(SECRET);
  });

  it('ignores a live-mode event unless STRIPE_LIVE_MODE=true, and refuses to run without a webhook secret', async () => {
    const s = await webhookSetup();
    const u = await s.t.user('A');
    const live = evt('evt_1', 'checkout.session.completed', session(u.id), true);
    expect(await (await s.send(live)).json()).toMatchObject({ ignored: 'livemode' });
    expect(await s.held(u.id)).toBe(0);
    const body = JSON.stringify(live);
    const allow = webhookConfig((k) => ({ STRIPE_WEBHOOK_SECRET: SECRET, STRIPE_LIVE_MODE: 'true' } as Record<string, string>)[k])!;
    const r = await webhookHandler(new Request('https://f.test/', { method: 'POST', headers: { 'stripe-signature': await signPayload(SECRET, body, ts) }, body }), allow, { store: s.store, nowMs: () => NOW });
    expect(r.status).toBe(200);
    expect(await s.held(u.id)).toBe(7);
    expect(webhookConfig(() => undefined)).toBeNull();
    expect((await webhookHandler(new Request('https://f.test/', { method: 'POST', body }), null, { store: s.store })).status).toBe(500);
  });
});

// ---- create-checkout with a mocked Stripe ----
const USER = '11111111-1111-4111-8111-111111111111';
function checkoutSetup(o: { env?: Record<string, string>; check?: CheckCall; anonymous?: boolean; stripe?: () => Response } = {}) {
  const env: Record<string, string> = { STRIPE_SECRET_KEY: 'sk_test_abc123', SHIELD_SITE_URL: 'https://pokejam.xyz/', ...o.env };
  const cfg = checkoutConfig((k) => env[k]);
  const calls: { url: string; init: RequestInit }[] = [];
  const checks: unknown[][] = [];
  const logs: string[] = [];
  const deps: CheckoutDeps = {
    userOf: async (jwt) => (jwt === 'jwt' ? { id: USER, anonymous: o.anonymous === true } : null),
    check: async (...a) => { checks.push(a); return o.check ?? { ok: true, sku: 'shield_7', units: 7, stripe_price_id: 'price_db_7', checkout_id: 42 }; },
    fetch: (async (url: string, init: RequestInit) => { calls.push({ url, init }); return o.stripe?.() ?? Response.json({ id: 'cs_1', url: 'https://checkout.stripe.com/c/pay/cs_1' }); }) as unknown as typeof fetch,
    nowMs: () => NOW,
    log: (m) => logs.push(m),
  };
  const post = (body: unknown, headers: Record<string, string> = { origin: 'https://pokejam.xyz', authorization: 'Bearer jwt' }, method = 'POST') =>
    checkoutHandler(new Request('https://f.test/shield-create-checkout', { method, headers, body: method === 'POST' ? JSON.stringify(body) : undefined }), cfg, deps);
  return { post, calls, checks, logs, cfg };
}

describe('shield-create-checkout', () => {
  it('creates a payment-mode session with the price from the database, the user from the JWT, and an idempotency key', async () => {
    const s = checkoutSetup();
    // everything the client may send beyond sku and ageConfirmed is ignored
    const r = await s.post({ sku: 'shield_7', ageConfirmed: true, price: 'price_evil', priceId: 'price_evil', amount: 1, units: 99, user_id: 'someone-else', client_reference_id: 'x' });
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ url: 'https://checkout.stripe.com/c/pay/cs_1' });
    expect(s.calls).toHaveLength(1);
    const { url, init } = s.calls[0];
    expect(url).toBe('https://api.stripe.com/v1/checkout/sessions');
    const h = init.headers as Record<string, string>;
    expect(h.authorization).toBe('Bearer sk_test_abc123');
    expect(h['idempotency-key']).toBe('shield-checkout-42');
    expect(h['content-type']).toBe('application/x-www-form-urlencoded');
    const f = new URLSearchParams(init.body as string);
    expect(Object.fromEntries(f)).toEqual({
      mode: 'payment', 'line_items[0][price]': 'price_db_7', 'line_items[0][quantity]': '1', client_reference_id: USER,
      'metadata[sku]': 'shield_7', 'metadata[user_id]': USER, 'metadata[units]': '7',
      'payment_intent_data[metadata][sku]': 'shield_7', 'payment_intent_data[metadata][user_id]': USER, 'payment_intent_data[metadata][units]': '7',
      success_url: 'https://pokejam.xyz/?shop=success', cancel_url: 'https://pokejam.xyz/?shop=cancel', expires_at: String(ts + 31 * 60),
    });
    expect(init.body as string).not.toMatch(/evil|amount|unit_amount|price_data/);
    expect(s.checks).toEqual([[USER, 'shield_7', false]]);
  });

  it('prefers an owner price override secret, and answers 503 when there is no price id at all', async () => {
    const o = checkoutSetup({ env: { STRIPE_PRICE_SHIELD_7: 'price_override' } });
    await o.post({ sku: 'shield_7', ageConfirmed: true });
    expect(new URLSearchParams(o.calls[0].init.body as string).get('line_items[0][price]')).toBe('price_override');
    const n = checkoutSetup({ check: { ok: true, sku: 'shield_7', units: 7, stripe_price_id: null, checkout_id: 1 } });
    expect((await n.post({ sku: 'shield_7', ageConfirmed: true })).status).toBe(503);
    expect(n.calls).toHaveLength(0);
  });

  it('refuses to run with a live key unless STRIPE_LIVE_MODE=true, or with no key, and never logs the key', async () => {
    const live = checkoutSetup({ env: { STRIPE_SECRET_KEY: 'sk_live_secretvalue' } });
    expect((await live.post({ sku: 'shield_7', ageConfirmed: true })).status).toBe(503);
    expect(live.calls).toHaveLength(0);
    expect(live.checks).toHaveLength(0);
    expect(live.logs.join()).not.toContain('secretvalue');
    expect((await checkoutSetup({ env: { STRIPE_SECRET_KEY: '' } }).post({ sku: 'shield_7', ageConfirmed: true })).status).toBe(503);
    const ok = checkoutSetup({ env: { STRIPE_SECRET_KEY: 'sk_live_secretvalue', STRIPE_LIVE_MODE: 'true' } });
    expect((await ok.post({ sku: 'shield_7', ageConfirmed: true })).status).toBe(200);
  });

  it('requires a verified signed-in non-guest user, a valid sku and the age confirmation', async () => {
    const s = checkoutSetup();
    const no = { origin: 'https://pokejam.xyz' };
    expect((await s.post({ sku: 'shield_7', ageConfirmed: true }, no)).status).toBe(401);
    expect((await s.post({ sku: 'shield_7', ageConfirmed: true }, { ...no, authorization: 'Bearer forged' })).status).toBe(401);
    expect((await s.post({ sku: 'shield_7' })).status).toBe(400);
    expect((await s.post({ sku: 'shield_7', ageConfirmed: 'true' })).status).toBe(400);
    expect((await s.post({ sku: 'x; drop', ageConfirmed: true })).status).toBe(400);
    expect((await s.post({ ageConfirmed: true })).status).toBe(400);
    expect((await s.post(null)).status).toBe(400);
    const g = checkoutSetup({ anonymous: true });
    expect((await g.post({ sku: 'shield_7', ageConfirmed: true })).status).toBe(403);
    expect(s.calls.length + g.calls.length).toBe(0);
    expect(s.checks).toHaveLength(0);
  });

  it('turns the database refusals into player messages and creates no session', async () => {
    for (const [code, status] of [['hold_cap', 409], ['season_cap', 409], ['rate_limited', 429], ['blocked', 403], ['inactive', 409], ['unknown_sku', 400], ['guest', 401]] as const) {
      const s = checkoutSetup({ check: { ok: false, code, message: `no: ${code}` } });
      const r = await s.post({ sku: 'shield_7', ageConfirmed: true });
      expect(r.status).toBe(status);
      expect(await r.json()).toEqual({ error: `no: ${code}`, code });
      expect(s.calls).toHaveLength(0);
    }
  });

  it('allows only the configured origins (default https://pokejam.xyz), and answers the preflight', async () => {
    const s = checkoutSetup({ env: { SHIELD_ALLOWED_ORIGINS: 'https://pokejam.xyz, https://test.example' } });
    const bad = await s.post({ sku: 'shield_7', ageConfirmed: true }, { origin: 'https://evil.example', authorization: 'Bearer jwt' });
    expect(bad.status).toBe(403);
    expect(bad.headers.get('access-control-allow-origin')).toBe('null');
    expect((await s.post({ sku: 'shield_7', ageConfirmed: true }, { authorization: 'Bearer jwt' })).status).toBe(403);
    const pre = await s.post(null, { origin: 'https://test.example' }, 'OPTIONS');
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe('https://test.example');
    expect((await s.post(null, { origin: 'https://evil.example' }, 'OPTIONS')).status).toBe(403);
    expect((await s.post(null, { origin: 'https://pokejam.xyz' }, 'GET')).status).toBe(405);
    expect(checkoutConfig(() => undefined).origins).toEqual(['https://pokejam.xyz']);
    expect(checkoutConfig(() => undefined).siteUrl).toBe('https://pokejam.xyz');
  });

  it('hides Stripe errors from the client and logs them without the key', async () => {
    const s = checkoutSetup({ stripe: () => Response.json({ error: { message: 'No such price' } }, { status: 400 }) });
    const r = await s.post({ sku: 'shield_7', ageConfirmed: true });
    expect(r.status).toBe(502);
    expect(await r.json()).toEqual({ error: 'Could not start checkout' });
    expect(s.logs.join()).toContain('No such price');
    expect(s.logs.join()).not.toContain('sk_test');
  });
});
