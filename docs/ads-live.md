# Courtside ads on the live site (pokejam.xyz)

This ports the courtside LED-board booking from pokejam-test (#45, devnet) to the live site, on Solana mainnet. Advertisers book the board on the Advertise page and pay from their own wallet in one of two ways:

- **Burn $PJAM.** The tokens leave the supply and nobody receives them.
- **Pay in USDC** (mainnet SPL USDC, `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`), sent to kungfudoom.sns (`FPwoDYkHTFef4Fg45o1wzReXiVoYGP6KXEgRyfqqBpyk`).

The operator's reference, covering secrets, the deploy steps and how a payment is checked, is in [`supabase/functions/README.md`](../supabase/functions/README.md), under "Billboard ads on the live site".

## The pieces

| Part | Where |
| --- | --- |
| Live Edge Function | `supabase/functions/pokejam-ads-live/index.ts`. It uses the same handler as the devnet `pokejam-ads`, which is unchanged. |
| Config | `adsConfigLive` in `supabase/functions/_shared/ads/config.ts`. Mainnet only when `ADS_ALLOW_MAINNET` is exactly `"true"`. The faucet is hard-off on mainnet. |
| USDC payment | `supabase/functions/_shared/ads/usdc-{chain,verify,handlers}.ts`, adapted from `origin/claude/shield-usdc-only` (copied, not merged). |
| Database | `supabase/migrations/20261204_pokejam_ads_live.sql`. It is additive: it adds `pokejam_live_*` tables (including the prices, `pokejam_live_ad_plans`) and functions and `live_*` config keys. `20261203_pokejam_ads.sql` is byte-identical to pokejam-test's, which is already applied. |
| Client | `src/ads/` (`api.ts` calls `pokejam-ads-live` only, `usdcPay.ts`, `screen.ts`), `src/game/ledBoard.ts`, `src/data/ads.ts`. |
| CSP | `vite.config.ts`. Nothing new by default, because the endpoint is on the Supabase origin and the browser never calls a Solana RPC. There are no inline scripts. |

## Plans and prices

| Plan | Burn $PJAM | USDC |
| --- | --- | --- |
| 1 hour | 100,000 | not on sale |
| 1 day | 1,500,000 | not on sale |
| 1 week | 7,500,000 | $150 |
| 1 month (720 h) | not on sale | $500 |

- These are rows in `public.pokejam_live_ad_plans`, so a price changes with one SQL update and no client rebuild. The commands are in the [README](../supabase/functions/README.md).
- The page draws its plans from the board. Before the board loads it shows the plan names with no price, and paying stays off.
- The ticker ($75/week, $250/month) and the combo ($650/month) aren't self-serve. They're arranged by DM (X @pokejamsol or t.me/PokeJamSol) and paid in SOL. The Advertise page lists them with no checkout.

## Layout decision

Main's board has two fixed halves: `$PJAM · OFFICIAL POKEJAM TOKEN` and `YOUR AD HERE`. #45's design gives the whole sponsor area to booked ads. The least invasive merge:

- The **$PJAM half stays a fixed house ad**, drawn as before.
- Booked ads take **only the "YOUR AD HERE" half**. With several booked, they take turns, one per repeat of the ticker. With none booked, it shows YOUR AD HERE.

On the Advertise page the music button sits in the page header and the page pads for every safe area, so nothing floats over the plans or checkout. The HUD banner starts below the board.

The board is part of the court scenery. The Advertise page is a separate screen, reached from the title menu (Courtside Ads) or `#advertise`, so no ad UI ever covers the game. `NET_VERSION` stays 3, because the board is drawn locally and isn't part of the netcode.

## Legal copy

The ad sections of `public/privacy.html` and `public/terms.html` now say:

- Spots can be paid by burning $PJAM or in USDC, from your own wallet.
- Bookings are final, with no refunds unless the law requires one.
- What a booking stores, and that booked ads and their wallets are public.

## No browser RPC, and retrying a confirm

The same class of bug as the Rank Shield fix in #94 doesn't apply here. The ad page never calls a Solana RPC: the server builds the burn or the transfer, the wallet sends it (or the server relays it, for a wallet that only signs), and `pokejam-ads-live` does every chain read. The site's CSP allows no Solana host, on purpose. `src/csp.test.ts` fails if the ad client names an RPC method or host, fetches anything but its endpoint, or if the endpoint's origin isn't in `connect-src`.

From the moment the wallet signs, money may have moved, so the page saves a record (`src/ads/settle.ts`: booking or intent id, wallet, signature) and keeps it until the server gives an answer that asking again can't change:

- **Not final:** no connection, a 5xx, a 429, or a Supabase gateway answer with no `error` in its body. The page keeps asking, including on its next visit and every 15 seconds in the background.
- **Final:** a 400, 404, 409 or 410 from the function, or a burn answer that carries an error. If the answer doesn't rule out that money moved, the page names who to contact.
- **While a record is open,** that wallet's pay buttons are off (both burn and USDC) and the page offers **Check my payment again**, so nobody pays twice by retrying. The hold ends when the server says so: a burn when its blockhash expires, a USDC payment at the intent's 15-minute expiry.
- **Repeats are safe.** The database books once per booking and once per signature. A wallet that only signs has its signed bytes resent until the server has answered once, and the server won't say "nothing was sent" about a refused copy unless the chain has no record of the signature.

If the wallet sends a payment but the page never gets the signature (the tab dies during the prompt, or the wallet reports an error after sending), the page has nothing to hold. The `sweep` still books it from the chain, once it's scheduled.

## Before mainnet

Nothing here has been deployed. No migration has been applied and no secret set. See the README's "On kungFuDOOM's OK (mainnet, the live site)" steps.

## Follow-ups closed (task 10)

- **Moderation UI.** admin.html's Ads tab has a **Devnet (test site) / Live (mainnet)** switch (`src/admin/adsView.ts`, remembered per device). Live uses `pokejam_admin_live_ads` and `pokejam_admin_live_ad_remove` (Take down, Take down + ban). **Lift** is the shared `pokejam_admin_ad_unban`, because both boards read one ban list (`pokejam_ad_bans`). Every action button carries the board it was drawn for, so switching mid-click can't hit the other board.
- **USDC recovery.** The live `sweep` also books USDC payments whose page closed before `usdc-confirm` (`usdcSweep` in `_shared/ads/usdc-handlers.ts`). It is bounded and makes two passes:
  1. It reads the receiver's USDC account history since a cursor (`live_ad_usdc_scan_cursor`), at most 3 pages of 1,000 signatures and 25 checks a run, at `finalized`. Each memo of the form `pokejam-ad-usdc:<16 hex>` is matched to its intent (`pokejam_live_ad_usdc_find`) and checked exactly as `usdc-confirm` checks it. When it hits the cap, the cursor stops after the last checked payment. The first run looks back 3 days.
  2. It re-checks up to 20 open intents from the last day by their reference key (`pokejam_live_ad_usdc_open`), in case the listing omits memos or more than 3 pages arrived.

  Both new SQL functions are added to the not-yet-applied `20261204` migration (additive, service role only). Nothing books twice: an intent and a signature each book once.
- **Contact page.** The courtside half is now self-serve on the Advertise page (burn $PJAM or USDC). The ticker and the combo are still arranged by DM and paid in SOL.
