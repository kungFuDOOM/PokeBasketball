# Rank Shield shop (Stripe, test mode)

Players can buy Rank Shields (3, 7 or 14) with Stripe Checkout. **Nothing here is applied, deployed or switched on.** It ships behind `VITE_SHIELD_SHOP`, and the Edge Function refuses any key that isn't a Stripe **test** key (`sk_test_...`) unless you also set `STRIPE_LIVE_MODE=true`.

> **Read this before anything else: IP risk.** PokeJam is a fan game that uses Pokémon names, art and characters. Charging real money inside a Pokémon-derived game is the most likely thing to trigger a takedown, a Stripe account closure (funds can be held) and a rights-holder claim against you personally. Nintendo, The Pokémon Company and Game Freak enforce actively, and paid items weaken any "free fan tribute" argument. Stripe's restricted-business rules also cover sales that infringe IP. Only go live if you accept this risk or replace/license the Pokémon assets. Get real legal advice before live mode. This doc is not legal advice.

## How it works

1. The player (signed in with Google or Phantom, never a guest) opens **Ranked → Rank Shield → Shop**, ticks "I'm 18+ or have a parent's permission", and taps a pack.
2. The browser calls the Edge Function **`shield-create-checkout`** with only `{ sku, ageConfirmed }`. The function verifies the Supabase JWT, runs `pokejam_shield_checkout_check` (held + pack <= 14, at most 42 bought per season including pending checkouts, 5 sessions per user per hour, no open dispute), reads the Stripe price id from `pokejam_shield_products`, and creates a Checkout Session (`mode=payment`, `client_reference_id` = the user id, metadata `{sku, user_id, units}`). It returns `{ url }` and the browser goes there.
3. **The success page never credits.** Back on the site (`/?shop=success`) the game only waits ("Waiting for payment confirmation") and polls `pokejam_shield_me` until the count rises.
4. Stripe calls **`shield-stripe-webhook`**. It verifies the `Stripe-Signature` (HMAC-SHA256 over the raw body, 300 s tolerance, constant-time compare), then calls the database:
   - `checkout.session.completed` / `checkout.session.async_payment_succeeded` with `payment_status=paid` → `pokejam_shield_credit_purchase`. Units come from the product row, not from the metadata. If the credit would pass the hold cap of 14, it credits up to the cap and marks the purchase `needs_refund = true` with `credit_short` set.
   - `charge.refunded` (full refunds only) → `pokejam_shield_revoke(..., 'refund')`.
   - `charge.dispute.created` → `pokejam_shield_revoke(..., 'dispute')`, which also blocks that user from buying again.
   - Anything else → 200, no-op. A database error → 500, so Stripe retries. 2xx is returned only after the database commit.
5. Everything is idempotent: the Stripe event id is inserted first (`pokejam_stripe_events`), the purchase is unique per session, and the ledger row is unique per `(user, reason, ref)`. Replaying an event, or a second event for the same session, credits once.

No Stripe key or price id is in the repo. Keys are Supabase secrets; price ids live in the database.

## Owner setup (test mode)

1. **Stripe account.** Create it in your own name with 2FA. Stay in **Test mode** (the toggle in the Stripe dashboard). Stripe asks you for your legal name, address and ID privately; none of that goes on the site.
2. **Product and prices.** In Test mode: Products → add **Rank Shield** with three **one-time** prices: **$1.99**, **$3.99**, **$6.99** (USD). Copy the three price ids (`price_...`).
3. **Statement descriptor.** Settings → Business → Public details: set the statement descriptor to `POKEJAM*SHIELD` (max 22 characters, no Pokémon marks), so card statements don't cause disputes.
4. **Apply the migrations, in order**, in the Supabase SQL editor (or `supabase db push`): `20261117_pokejam_rank_shield.sql`, then `20261118_pokejam_shield_shop.sql`.
5. **Put the price ids in the database and switch the packs on** (SQL editor):
   ```sql
   update public.pokejam_shield_products set stripe_price_id = '<price_id for $1.99>', active = true where sku = 'shield_3';
   update public.pokejam_shield_products set stripe_price_id = '<price_id for $3.99>', active = true where sku = 'shield_7';
   update public.pokejam_shield_products set stripe_price_id = '<price_id for $6.99>', active = true where sku = 'shield_14';
   ```
   Packs stay hidden and can't be bought while `active = false`. (Instead of the column you may set the secrets `STRIPE_PRICE_SHIELD_3`, `STRIPE_PRICE_SHIELD_7`, `STRIPE_PRICE_SHIELD_14`; a secret wins over the column. The pack still needs `active = true`.)
6. **Secrets** (never in the repo, chat or the build):
   ```sh
   supabase secrets set STRIPE_SECRET_KEY=sk_test_... SHIELD_SITE_URL=https://pokejam.xyz SHIELD_ALLOWED_ORIGINS=https://pokejam.xyz
   ```
   `SHIELD_ALLOWED_ORIGINS` is a comma-separated list of the sites that may call the function (default `https://pokejam.xyz`; add a test site if you use one). `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` come with the Edge runtime.
7. **Deploy the functions.** The checkout function keeps JWT verification on (the default); the webhook must not have it, because Stripe sends no JWT:
   ```sh
   supabase functions deploy shield-create-checkout
   supabase functions deploy shield-stripe-webhook --no-verify-jwt
   ```
8. **Register the webhook.** Stripe dashboard (Test mode) → Developers → Webhooks → Add endpoint: `https://<project-ref>.supabase.co/functions/v1/shield-stripe-webhook`, events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `charge.refunded`, `charge.dispute.created`. Copy its signing secret and set it:
   ```sh
   supabase secrets set STRIPE_WEBHOOK_SECRET=whsec_...
   ```
9. **Turn the shop on in the build.** Set `VITE_SHIELD_SHOP=true` next to `VITE_MODE_RANKED=true` in the build environment and redeploy the site. With it unset, no Shop button is drawn and nothing calls the checkout function. (On the dev server, `?shop=1` shows it too.)
10. **Publish the legal pages.** `public/terms.html` (terms of sale and refunds) and `public/privacy.html` are already updated; deploy them with the site. Contact is only `kungfudoom@mail.grokbot.com` and the name kungFuDOOM.

## Test it (test mode)

Use Stripe's test cards: https://docs.stripe.com/testing

- **Buy:** sign in with Google, open the shop, tick the box, buy a pack, pay with `4242 4242 4242 4242` (any future date, any CVC, any ZIP). You land on `/?shop=success`, see "Waiting for payment confirmation", and then "+N Rank Shields". Check `select * from pokejam_shield_purchases order by created_at desc limit 5;`.
- **Replay:** Stripe dashboard → Developers → Webhooks → your endpoint → the event → **Resend**. The count must not change (`duplicate_event`).
- **Declined / failed:** `4000 0000 0000 0002` (declined). Nothing is credited.
- **Refund:** Payments → the payment → **Refund** (full). The shields it paid for disappear; if some were used, `clawback_short` on the purchase shows how many couldn't be taken back. A partial refund does nothing automatically.
- **Dispute:** pay with `4000 0000 0000 0259` (creates a dispute right away). The shields are removed, the purchase is `disputed`, and the user can't start another checkout (`select * from pokejam_shield_flags;`). To let them buy again: `update pokejam_shield_flags set purchase_blocked = false where user_id = '<id>';`.
- **Caps:** with 12 held, the 3, 7 and 14 packs show "Max 14 held". Six checkouts in an hour: the sixth is refused.
- **Over the cap at credit time** (two tabs, both paid): the second purchase credits up to 14 and shows `needs_refund = true`, `credit_short > 0`. Refund that part by hand in Stripe, and look for these rows now and then: `select * from pokejam_shield_purchases where needs_refund;`.
- Logs: Supabase dashboard → Edge Functions → the function → Logs. They never contain keys.

Locally, the same logic is covered by `npx vitest run supabase src/multiplayer/ranked` (signed mock payloads against a real Postgres, PGlite).

## Going live checklist

- [ ] You've decided to accept the **IP risk** above (or replaced/licensed the Pokémon assets) and got legal advice.
- [ ] Stripe account fully activated in your own name, 2FA on, payout bank account added.
- [ ] Live-mode product, three prices, and the `POKEJAM*SHIELD` descriptor created; the **live** price ids go into `pokejam_shield_products.stripe_price_id`.
- [ ] A **live** webhook endpoint registered with the same four events; its `whsec_` set as `STRIPE_WEBHOOK_SECRET`.
- [ ] `supabase secrets set STRIPE_SECRET_KEY=sk_live_... STRIPE_LIVE_MODE=true`. Without `STRIPE_LIVE_MODE=true` the functions refuse live keys and live events on purpose.
- [ ] Terms of sale, Refunds and the privacy update are live on the site and you are happy with the refund wording (14 days for unused shields).
- [ ] Tax: digital goods can owe US sales tax / EU VAT. Consider Stripe Tax (monitor mode first) or a merchant of record (costs more, and they screen for IP too).
- [ ] A real purchase, refund and dispute test with a small live payment of your own.
- [ ] You watch the Stripe dashboard and `needs_refund` rows. A free Supabase project that pauses can't take webhooks (Stripe retries for a few days).
- [ ] You know the costs: about 2.9% + $0.30 per card payment (a $1.99 pack nets ~$1.63), and a dispute costs a flat fee (~$15) even when you win.

## Limits and known gaps

- Partial refunds and a dispute that you later win are not handled automatically (`charge.dispute.closed` is not subscribed). Do those by hand in SQL if needed.
- Rank points a used shield saved are never reversed.
- The checkout rate limit and caps are per account; they don't stop someone with many accounts, but each account needs its own sign-in and card.
