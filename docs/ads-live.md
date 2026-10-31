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
| Database | `supabase/migrations/20261124_pokejam_ads_live.sql`. It is additive: it adds `pokejam_live_*` tables and functions and `live_*` config keys. `20261104_pokejam_ads.sql` is byte-identical to pokejam-test's, which is already applied. |
| Client | `src/ads/` (`api.ts` calls `pokejam-ads-live` only, `usdcPay.ts`, `screen.ts`), `src/game/ledBoard.ts`, `src/data/ads.ts`. |
| CSP | `vite.config.ts`. Nothing new by default, because the endpoint is on the Supabase origin and the browser never calls a Solana RPC. There are no inline scripts. |

## Plan mapping

The contact page's USD price list covers the ticker ($75/week, $250/month), the courtside half ($150/week, $500/month) and the combo ($650/month). Only the courtside half maps cleanly onto the self-serve board, so:

| Plan | Burn $PJAM | USDC |
| --- | --- | --- |
| 1 hour | yes | n/a |
| 1 day | yes | n/a |
| 1 week | yes | $150 |
| 1 month (720 h) | n/a | $500 |

- The ticker and the ticker + courtside combo stay contact-sales (DM, paid in SOL), as on `public/contact.html`.
- The hour/day/week PJAM plans are #45's own. The month plan is USDC-only.
- Every price is a `pokejam_config` row (`live_ad_price_*`, `live_ad_usdc_*`), so it can change without a deploy.
- The PJAM defaults are #45's devnet numbers. Set real ones for the token's market before launch.

## Layout decision

Main's board has two fixed halves: `$PJAM · OFFICIAL POKEJAM TOKEN` and `YOUR AD HERE`. #45's design gives the whole sponsor area to booked ads. The least invasive merge:

- The **$PJAM half stays a fixed house ad**, drawn as before.
- Booked ads take **only the "YOUR AD HERE" half**. With several booked, they take turns, one per repeat of the ticker. With none booked, it shows YOUR AD HERE.

The board is part of the court scenery. The Advertise page is a separate screen, reached from the title menu (Courtside Ads) or `#advertise`, so no ad UI ever covers the game. `NET_VERSION` stays 3, because the board is drawn locally and isn't part of the netcode.

## Legal copy

The ad sections of `public/privacy.html` and `public/terms.html` now say:

- Spots can be paid by burning $PJAM or in USDC, from your own wallet.
- Bookings are final, with no refunds unless the law requires one.
- What a booking stores, and that booked ads and their wallets are public.

## Open questions before mainnet

1. **Confirm the $PJAM mint.** `GQe9QiBBV4G6bRUCxx2JgKrzT7G7RD17FJquBWgVpump` is hard-coded from #45 as the default. kungFuDOOM must confirm it is the official token, or set `ADS_PJAM_MINT`.
2. **Set the PJAM burn prices** for the token's market at launch.
3. Nothing here has been deployed. No migration has been applied and no secret set. See the README's "On kungFuDOOM's OK (mainnet, the live site)" steps.

## Follow-ups closed (task 10)

- **Moderation UI.** admin.html's Ads tab has a **Devnet (test site) / Live (mainnet)** switch (`src/admin/adsView.ts`, remembered per device). Live uses `pokejam_admin_live_ads` and `pokejam_admin_live_ad_remove` (Take down, Take down + ban). **Lift** is the shared `pokejam_admin_ad_unban`, because both boards read one ban list (`pokejam_ad_bans`). Every action button carries the board it was drawn for, so switching mid-click can't hit the other board.
- **USDC recovery.** The live `sweep` also books USDC payments whose page closed before `usdc-confirm` (`usdcSweep` in `_shared/ads/usdc-handlers.ts`). It is bounded and makes two passes:
  1. It reads the receiver's USDC account history since a cursor (`live_ad_usdc_scan_cursor`), at most 3 pages of 1,000 signatures and 25 checks a run, at `finalized`. Each memo of the form `pokejam-ad-usdc:<16 hex>` is matched to its intent (`pokejam_live_ad_usdc_find`) and checked exactly as `usdc-confirm` checks it. When it hits the cap, the cursor stops after the last checked payment. The first run looks back 3 days.
  2. It re-checks up to 20 open intents from the last day by their reference key (`pokejam_live_ad_usdc_open`), in case the listing omits memos or more than 3 pages arrived.

  Both new SQL functions are added to the not-yet-applied `20261124` migration (additive, service role only). Nothing books twice: an intent and a signature each book once.
- **Contact page.** The courtside half is now self-serve on the Advertise page (burn $PJAM or USDC). The ticker and the combo are still arranged by DM and paid in SOL.
