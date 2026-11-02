# Pack Battles Edge Functions

Step 3 of the plan on issue #4: after a battle has a winner, buy the winner's Collector Crypt pull, then send the card, sell it back for cash, or credit the pot if CC won't sell. **Devnet only** until kungFuDOOM approves real money; the code refuses any other cluster (see `_shared/pack/config.ts`).

**Nothing here has been applied or deployed.** The shared gauntlet-legends project (`ruxbufynuzmversxmptw`) changes only when kungFuDOOM says so.

## What's here

| Path | What it does |
| --- | --- |
| `../migrations/20261023_pokejam_pack_payouts.sql` | `pokejam_pack_machines`, `pokejam_pack_ledger`, `pokejam_pack_prizes`, and their functions. RLS is on: players read only their own prizes and ledger rows. Every write goes through service-role functions. |
| `../migrations/20261024_pokejam_pack_keep_or_sell.sql` | Keep it or sell it back at the reveal: the `revealed` state, `choice` / `choose_by` / `sell_estimate`, and `pokejam_pack_choose_prize`, the one prize write a player makes. |
| `pokejam-pack-payouts/` | The prize worker. Each run recovers stuck prizes, then settles up to 5. |
| `pokejam-ads/` | Billboard ads: book the courtside LED board by burning $PJAM (below). |
| `pokejam-judge-worker/` | Judges the next Ranked match in the queue, one per run, and decides it if it's disputed and `judge_authoritative` is on. See "The judge queue" below. |
| `pokejam-pack-machines/` | Refreshes `pokejam_pack_machines` from CC's live prices, odds and stock, for the lobby. |
| `_shared/pack/` | Ported from the devnet-verified Bun prototype: CC client, Solana RPC, Core transfer, signing, machines and the worker. Imports use explicit `.ts` extensions, so the same files run in Deno and in vitest. |

How a prize moves:
1. The battle flow (in the escrow PR, after `judge()` in `src/multiplayer/shared/winnerCheck.ts`) calls `pokejam_pack_queue_prize(battle, user, wallet, tier, pot, prefer_cash)`.
2. The worker checks CC's live machine: it must exist, be in stock, and cost no more than the pot. It also checks that the house holds enough USDC.
3. It buys and opens the pull with `generatePack` → house signs → `submitTransaction` → `openPack`. The memo is saved the moment the purchase is paid, so a retry resumes and never buys twice.
4. The card is open and in the house wallet, so the prize waits as `revealed` for `PRIZE_CHOICE_SECONDS` (default 120). The winner sees the card with **Keep it** and **Sell it back** (about `sell_estimate`: insured value × the machine's buyback rate; the credit is CC's actual quote). The client calls `sb.rpc('pokejam_pack_choose_prize', { p_id, p_choice: 'keep' | 'sell' })`. It returns false if the prize isn't theirs or isn't waiting any more, and the prize row says which. The next run (at most a minute later on the every-minute cron) settles it. With no pick, the winner's saved preference (`prefer_cash`) applies once `choose_by` passes. CC's buyback window is 72 hours, so the wait costs nothing.
5. It then either sends the card (a Core transfer, after checking the owner on-chain) or sells it back and credits the buyback.
6. If CC refuses to sell `PRIZE_FALLBACK_ATTEMPTS` times (default 3), the winner is credited the whole pot. A house short of USDC keeps retrying instead.

## Billboard ads (`pokejam-ads/`, `../migrations/20261203_pokejam_ads.sql`)

Advertisers put their message on the courtside LED board in every game, and pay by **burning $PJAM** from their own wallet. **Devnet only** until kungFuDOOM approves mainnet; the code refuses any other cluster (see `_shared/ads/config.ts`).

**How a booking moves.**
1. On the Advertise page (`src/ads/screen.ts`), the advertiser writes the ad (24 characters, filtered like trainer names), picks one of 8 colour themes, a plan and a start.
2. `prepare` checks their balance and books it as unpaid. Unpaid bookings hold no space, so nobody can block the board without burning.
3. It returns one unsigned transaction: SPL Token `BurnChecked` of the price from the advertiser's own token account, plus the memo `pokejam-ad:<code>`. Their wallet signs it.
4. `confirm` reads the landed transaction from the chain with the RPC's own parser and checks it before the ad is paid for:
   - it succeeded;
   - its memo names this booking;
   - the booking's wallet signed;
   - the burns of this mint under its token program, from that wallet, add up to at least the price.
   - One signature pays for one booking.
5. The ad gets the first opening from its start.

**The server never signs a burn and holds no key on mainnet.** The tokens leave the supply; nobody receives them.

| Plan | Price (base units in `pokejam_config`) | |
| --- | --- | --- |
| 1 hour | `ad_price_hour` = 100,000 PJAM | |
| 1 day | `ad_price_day` = 1,500,000 PJAM | 37% off 24 hours |
| 1 week | `ad_price_week` = 7,500,000 PJAM | 55% off 168 hours |

Prices and the number of spots (`ad_spots`, default 3) change with one `update public.pokejam_config …`, no deploy. Live ads take turns on the ticker, one per repeat; with none booked it shows YOUR AD HERE.

**Never lose a burn.** Every successful burn of the token whose memo names a booking becomes airtime. It's found three independent ways:

1. **The page:** it confirms the burn the moment the wallet signs, and asks again on its next visit if it closed first.
2. **The wallet:** connecting it on any device settles that wallet's unpaid bookings from its own history.
3. **The chain:** the sweeper walks the mint's own history (`ad_scan_cursor`) every few minutes. It needs no page, and spam bookings can't crowd it out.

| What happens | What the advertiser gets |
| --- | --- |
| The board fills up (or this wallet already holds a spot) while they sign | The ad moves to the next opening, for the full time, and says so. |
| The node's reply is lost after it sent the burn | Still found and paid. |
| The page gave up waiting, then the burn landed | Paid by the sweeper or the next visit. |
| A burn lands days late (a durable nonce) | Paid: bookings are never deleted, and the price is locked when booked. |
| A second burn for an ad that's already paid | An extra run of the same ad, straight after. |
| A hand-made burn of more or less than the price | Airtime in proportion, at the locked rate. Under a minute's worth is recorded as dust. |
| Someone else burns for the ad | It runs: anyone may pay for an ad. |
| The node refuses the burn, it fails on-chain, or it expires unsent | Nothing was burned, and the page says exactly that. |
| The page showed an old price | Refused before signing (`expect`), so the wallet never shows a surprise amount. |

**What may run** (`pokejam_ad_verdict`, checked live as the advertiser types and again before anything is burned):
- **Characters:** the board only has capitals, digits, spaces and `$ ! ? . , & + @ # : ' / % -`, so look-alike letters, invisible characters and emoji can't get in.
- **Disguises:** each word is compared with look-alikes undone (`5H1T`, `$H!T`), repeated letters and plurals allowed. Runs of short pieces are joined (`F U C K`, `SH IT`, `KISS MY A S S`), slurs and phrases are also checked with spaces removed, and a few words backwards.
- **No false alarms:** ordinary phrases that only run together by accident are left alone (`PUSH IT`, `WHO RULES`, `KUNG FU`, `TEAM ROCKET`, `THERAPIST`).
- **Also refused:** links and spelled-out domains (`@handle` and `$ticker` are fine), giveaway and wallet-drainer scams (`FREE SOL`, `AIRDROP`, `SEED PHRASE`, `CONNECT WALLET`, `DM ME`), posing as staff (`OFFICIAL`, `ADMIN`, `KUNGFUDOOM`), and hate numbers.
- The tests list what's blocked and what's allowed (`supabase/tests/ads.test.ts`).

**Griefing:**
- Unpaid bookings hold no space, and each wallet may have 10 an hour.
- One spot per advertiser at a time, so one wallet can't take the whole board.
- Every action is rate-limited per caller, a salted hash of the IP (`pokejam_ad_allow`).
- The board is cached. The devnet faucet gives one claim a day per wallet and three per caller.
- Reports only flag an ad for moderators, one per person, so a crowd can't take a paid ad down. With `ADS_ALERT_WEBHOOK_URL` set, the 1st, 3rd and 10th report post to Slack or Discord.

**Moderation** (admin.html, **Ads** tab: what's live and coming up, most-reported first):
- **Take down:** its spot frees up. The advertiser keeps the time it had left, and puts new text on it from **Your ads**, signed by their wallet (`replace`). The text passes the same check.
- **Take down + ban:** every ad from that wallet comes down for good, and it can't book again. This is the one case where burned tokens buy nothing, kept for abuse. **Lift** undoes the ban.
- **Stop new bookings** (burns already sent still settle): `update public.pokejam_config set value = 'true' where key = 'ads_paused';`

### On kungFuDOOM's "Merge" (devnet, the test site)

1. **Migration:** `20261203_pokejam_ads`.
2. **The test token:**
   - `bun --use-system-ca scripts/ads-devnet-setup.ts <faucet-keypair.json>` makes "PJAM (devnet)": a Token-2022 mint with $PJAM's 6 decimals, whose mint authority is a new faucet keypair.
   - The faucet needs about 1 devnet SOL. Devnet's RPC airdrop is closed, so use https://faucet.solana.com.
   - Keep the keypair file out of the repo.
3. **Deploy:** `supabase functions deploy pokejam-ads --no-verify-jwt` (the page calls it without signing in).
4. **Secrets:**
   - `ADS_CLUSTER=devnet`
   - `AD_MINT=<the test mint>`
   - `AD_FAUCET_SECRET=<the faucet keypair file's contents>`: the "Get free test $PJAM" button, 25M test PJAM and a little test SOL per wallet a day.
   - `ADS_ALLOWED_ORIGINS=<test site>`
5. **Schedule:** POST `{"action":"sweep"}` to `pokejam-ads` with the service key every 2 minutes (pg_cron + pg_net). Optional: `ADS_ALERT_WEBHOOK_URL` for reports.
6. **Vercel `pokejam-test`:** `VITE_MODE_ADS=true`. This adds Courtside Ads to the title screen, the page at `#advertise`, and booked ads on every court.

**Mainnet, only on kungFuDOOM's OK:** (this is the devnet function's own switch. The live site doesn't use it: it uses `pokejam-ads-live`, below.)
- Set `ADS_CLUSTER=mainnet-beta` and `ADS_ALLOW_MAINNET=approved-by-kungfudoom`. The mint is then always the official $PJAM, `GQe9QiBBV4G6bRUCxx2JgKrzT7G7RD17FJquBWgVpump` (Token-2022), and the faucet is off whatever is set.
- Use a paid RPC (`ADS_RPC_URL`): the public mainnet RPC rate-limits the history lookups.
- Set prices for the token's market at the time.

**Test it locally against devnet:**
1. Run the devnet smoke test: `bun --use-system-ca scripts/ads-devnet-smoke.ts <mint> <faucet-keypair.json>`. It makes real burns every way they can arrive (relayed, wallet-sent, page closed, never confirmed, short, second, paid by a friend), plus one the node refuses, and checks that the supply fell by exactly what was burned.
2. To try the whole page:
   1. `VITE_MODE_ADS=true VITE_ADS_API=http://localhost:8787/api/ads npm run build`
   2. `AD_MINT=<mint> AD_FAUCET_SECRET_FILE=<keypair.json> bun --use-system-ca scripts/ads-dev-server.ts`
   3. Open http://localhost:8787/#advertise.

## Billboard ads on the live site (`pokejam-ads-live/`, `../migrations/20261204_pokejam_ads_live.sql`)

The live site (pokejam.xyz) books the same courtside LED board on **Solana mainnet**, through its own function. It runs the same handler as the devnet `pokejam-ads` above (`_shared/ads/handler.ts`), configured by `adsConfigLive` in `_shared/ads/config.ts`. The devnet function, its secrets and its tables are unchanged. The client (`src/ads/api.ts`) only ever calls `pokejam-ads-live`. Advertisers pay from their own wallet in one of two ways:
- **Burn $PJAM** (an hour, a day or a week), like the devnet flow above except that the burn must cover the price and come from the booking's wallet.
- **Pay in USDC** (a week or a month), sent to kungfudoom.sns.

More detail, including the open questions, is in `docs/ads-live.md`.

**Its own rows.** Live bookings use separate tables (`pokejam_live_ads`, `pokejam_live_ad_reports`, `pokejam_live_ad_usdc_intents`) and `pokejam_live_ad_*` functions. The ban list (`pokejam_ad_bans`) is shared on purpose, so a wallet banned on either board is banned on both. Its settings sit in `pokejam_config` under `live_` plus the devnet key (`live_ad_price_week`, `live_ad_usdc_month`, `live_ad_spots`, `live_ads_paused`, …). `adsConfigLive.dbName` maps every SQL call to the live names, so devnet and mainnet bookings never mix. The migration is additive only: it drops nothing and doesn't change any function the devnet site uses.

**Secrets.** Edge Function secrets are shared by the whole project, so anything the devnet function also reads gets an `ADS_LIVE_` name here:

| Secret | | |
| --- | --- | --- |
| `ADS_ALLOW_MAINNET` | required on mainnet | Must be exactly `true`. Anything else, such as `TRUE`, ` true`, `1` or the devnet function's approval phrase, and the function refuses to start. |
| `ADS_LIVE_CLUSTER` | optional | `devnet` runs this function against devnet (for a staging copy). Anything else, or unset, means `mainnet-beta`. This is the live counterpart of `ADS_CLUSTER`, which stays the devnet function's own and doesn't affect this one. |
| `ADS_PJAM_MINT` | optional on mainnet | The token burned. It defaults to the official $PJAM, `GQe9QiBBV4G6bRUCxx2JgKrzT7G7RD17FJquBWgVpump`. It must be a valid address, and the mint must have 6 decimals. It's required on a devnet staging copy, which has no default. |
| `ADS_USDC_RECEIVER` | optional | The wallet paid in USDC. It defaults to kungfudoom.sns, `FPwoDYkHTFef4Fg45o1wzReXiVoYGP6KXEgRyfqqBpyk`. Changing it also needs a client rebuild, because the page refuses to sign a transfer to any other receiver than `USDC_RECEIVER` in `_shared/ads/usdc-chain.ts`. The payment must land in that wallet's USDC associated token account. The USDC mint is never configurable: on mainnet it is Circle's `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`. |
| `ADS_LIVE_RPC_URL` | strongly advised | A paid mainnet RPC. The public one rate-limits history lookups. All chain reads happen here; the browser never calls an RPC. |
| `ADS_LIVE_ALLOWED_ORIGINS` | advised | `https://pokejam.xyz` (comma-separated exact origins). If it's empty, any origin may call. |
| `ADS_LIVE_PRIORITY_MICROLAMPORTS` | optional | The priority fee on the burn. Default 20,000 on mainnet. |
| `ADS_ALERT_WEBHOOK_URL` | optional | Shared with the devnet function: report alerts to Slack or Discord. |

**No faucet on mainnet**, whatever is set: `AD_FAUCET_SECRET` is ignored, the `faucet` action answers 404, the board reports `faucet: false` and the page hides the button.

**Plans and prices.** Only the bookable courtside half is self-serve. The ticker ($75/week, $250/month) and the ticker + courtside combo ($650/month) are arranged by DM (X @pokejamsol or t.me/PokeJamSol) and paid in SOL. The Advertise page lists them with no checkout.

Prices are rows in `public.pokejam_live_ad_plans` (`method`, `plan`, `amount`, `enabled`), in whole tokens. The Edge Function reads the table on every quote, booking and intent, and the page draws its plans from the board's `plans`, so a change needs no deploy and no client rebuild. The board is cached for 10 seconds.

| Plan | Burn $PJAM (`burn`) | USDC (`usdc`) |
| --- | --- | --- |
| 1 hour (`hour`) | 100,000 | not on sale |
| 1 day (`day`) | 1,500,000 | not on sale |
| 1 week (`week`) | 7,500,000 | 150 |
| 1 month, 720 h (`month`) | not on sale | 500 |

```sql
-- Change a price
update public.pokejam_live_ad_plans set amount = 200000 where method = 'burn' and plan = 'hour';
-- Stop selling a plan
update public.pokejam_live_ad_plans set enabled = false where method = 'usdc' and plan = 'month';
-- Sell a plan another way (plan is one of hour, day, week, month)
insert into public.pokejam_live_ad_plans(method, plan, amount) values ('burn', 'month', 20000000);
```

A check constraint refuses a zero or negative price. The table has row-level security on and no grants to `anon` or `authenticated`. Re-applying the migration keeps any price you set.

A booking keeps the price it was made at for one day. After that, and for any extra run, the current price applies if it's higher. `public/contact.html` also states the $150 and $500 prices as static text, so update it by hand if they change.

**How a burn is checked** (`_shared/ads/verify.ts`, on the live board's strict settings, `strictBurn` in `adsConfigLive`):
- The transaction succeeded, and is read at `finalized` commitment on mainnet (`confirmed` on a devnet staging copy).
- Its top-level memo is exactly `pokejam-ad:<code>` for this booking, and it's no older than the booking.
- The booking's wallet signed it, and only burns that wallet authorised from its own token account count (the owner comes from the chain's token balances). A delegate's, a multisig's or a stranger's burn doesn't count.
- The token is the configured mint under the program that owns it. The mint must have 6 decimals, or the function refuses to sell, because the prices assume them.
- `pokejam_live_ad_pay` compares the amount with the price. **Less than the price runs nothing:** it's recorded as `dust` and the tokens stay burned. This differs from the devnet board, which pro-rates: on the live board a pro-rated burn would buy hours at the week's cheaper rate. The server builds the exact amount, so only a hand-crafted transaction can be short. More than the price runs longer at the plan's rate.
- `burn_sig` is unique and payments take an advisory lock, so a signature pays once, across burns and USDC.

**How a USDC payment works** (`_shared/ads/usdc-*.ts`, adapted from the USDC payment pattern on `origin/claude/shield-usdc-only`, copied, not merged):
1. `usdc-intent` first runs every check that could refuse the ad: the text filter, a ban, paused sales, the price the page showed, and the wallet's USDC and SOL. It then saves a one-time intent with an exact amount, a reference key and a memo, which expires in 15 minutes. It returns an unsigned SPL `TransferChecked` to the receiver's USDC account. The page rebuilds that transaction itself and checks it matches before the wallet signs.
2. `usdc-confirm` reads the payment from the chain at `finalized` commitment on mainnet (`confirmed` on devnet) and checks that:
   - the mint is USDC;
   - the destination is the associated token account of the receiver;
   - the amount is at least the price;
   - the advertiser's wallet signed;
   - the transaction succeeded.
3. A signature books only once, because `usdc_sig` and the intent's signature are unique. With no signature, `usdc-confirm` finds the payment by the intent's reference key, so a page closed mid-payment still books on its next visit. A payment that really landed after its intent expired still books.
4. **Recovery with no page open:** the live `sweep` reads the receiver's USDC account history past a cursor (`live_ad_usdc_scan_cursor`, at `finalized`, at most 3 pages and 25 checks a run, 3 days back on the first run). It matches each intent memo with `pokejam_live_ad_usdc_find` and checks it as in step 2. It then re-checks the last day's open intents (at most 20, `pokejam_live_ad_usdc_open`) by reference key. If it hits a cap, the cursor stops at the last payment checked, so nothing is skipped. The sweep's reply carries a `usdc` summary.

**Layout.** The board keeps two halves. The `$PJAM · OFFICIAL POKEJAM TOKEN` half stays a fixed house ad. Booked ads replace only the "YOUR AD HERE" half (`src/game/ledBoard.ts`, `houseAds()` / `bookableHalfOn()` in `src/data/ads.ts`), and that half shows YOUR AD HERE when nothing is booked. The board is part of the court scenery, and the Advertise page is its own screen (title menu → Courtside Ads, `#advertise`), so no ad UI ever covers the game.

**Moderation.** admin.html's Ads tab has a Devnet / Live (mainnet) switch. Live calls `pokejam_admin_live_ads` and `pokejam_admin_live_ad_remove`, which work like the devnet ones and are logged in `pokejam_admin_log`. The ban list is shared by both boards, so **Lift** is `pokejam_admin_ad_unban` on either. To stop new bookings: `update public.pokejam_config set value = 'true' where key = 'live_ads_paused';` Payments already sent still settle.

### On kungFuDOOM's OK (mainnet, the live site)

1. **Migrations**, in this order, after every other migration: `20261203_pokejam_ads`, then `20261204_pokejam_ads_live`. Both are additive and safe to re-apply.
2. **Check the prices:** `select * from public.pokejam_live_ad_plans;`. They're seeded with the confirmed amounts.
3. **Secrets:**
   ```sh
   supabase secrets set ADS_ALLOW_MAINNET=true ADS_LIVE_RPC_URL=<paid mainnet RPC> ADS_LIVE_ALLOWED_ORIGINS=https://pokejam.xyz
   ```
   Add `ADS_PJAM_MINT` and `ADS_USDC_RECEIVER` only to change their defaults.
4. **Deploy:** `supabase functions deploy pokejam-ads-live --no-verify-jwt`. The page calls it without signing in.
5. **Schedule:** POST `{"action":"sweep"}` to `pokejam-ads-live` with the service key every few minutes (pg_cron + pg_net), as for devnet.
6. **The site's build:** `VITE_MODE_ADS=true`. The client calls `<VITE_SUPABASE_URL>/functions/v1/pokejam-ads-live`, whose origin is already in the CSP's `connect-src`. Set `VITE_ADS_API` only for a function hosted elsewhere: it must be https, and its origin is added to `connect-src`. No Solana RPC is added, and no inline script.

## Online play: TURN credentials (`pokejam-ice/`)

Online matches play over a WebRTC data channel relayed by Cloudflare TURN, so Supabase Realtime only carries the handshake (see `docs/multiplayer.md`). `pokejam-ice` mints one-hour TURN credentials for a player in an active match (`pokejam_ice_ok`, in `../migrations/20261026_pokejam_launch.sql`, which also rate-limits). Without it, games stay on Realtime.

1. In Cloudflare: Realtime → TURN, create a TURN key. Its id and API token are the secrets.
2. Set the secrets: `supabase secrets set TURN_KEY_ID=<id> TURN_KEY_API_TOKEN=<token> ICE_ALLOWED_ORIGINS=https://pokejam.xyz,<test site>`.
3. Deploy: `supabase functions deploy pokejam-ice`. It verifies the player's JWT (the default), so keep JWT verification on.

## Rank Shield shop: Stripe Checkout (`shield-create-checkout/`, `shield-stripe-webhook/`)

Players can buy Rank Shields with Stripe Checkout (**test mode only** until the owner flips it; the checkout function refuses a key that isn't `sk_test_...` unless `STRIPE_LIVE_MODE=true`). No Stripe SDK: both functions use `fetch` and Web Crypto, and the logic is in `_shared/shield/` (explicit `.ts` imports, tested in vitest). Setup, test cards and the going-live checklist: [`docs/rank-shield-stripe.md`](../../docs/rank-shield-stripe.md). Migration: `../migrations/20261118_pokejam_shield_shop.sql` (after `20261117`).

| Function | JWT | Secrets | What it does |
| --- | --- | --- | --- |
| `shield-create-checkout` | verified (default) | `STRIPE_SECRET_KEY`, `SHIELD_SITE_URL`, `SHIELD_ALLOWED_ORIGINS`; optional `STRIPE_PRICE_SHIELD_3/7/14`, `STRIPE_LIVE_MODE` | Takes `{ sku, ageConfirmed }` from a signed-in, non-guest player, runs `pokejam_shield_checkout_check` (caps, rate limit), creates a Checkout Session with the price from `pokejam_shield_products`, returns `{ url }`. |
| `shield-stripe-webhook` | **off** (`--no-verify-jwt`) | `STRIPE_WEBHOOK_SECRET`; optional `STRIPE_LIVE_MODE` | Verifies `Stripe-Signature`, then credits (`pokejam_shield_credit_purchase`) or revokes (`pokejam_shield_revoke`). Idempotent; 400 on a bad signature, 500 on a database error so Stripe retries. |

```sh
supabase secrets set STRIPE_SECRET_KEY=sk_test_... STRIPE_WEBHOOK_SECRET=whsec_... SHIELD_SITE_URL=https://pokejam.xyz SHIELD_ALLOWED_ORIGINS=https://pokejam.xyz
supabase functions deploy shield-create-checkout
supabase functions deploy shield-stripe-webhook --no-verify-jwt
```

Tests: `npx vitest run supabase/functions/_shared/shield supabase/tests/shield-shop.test.ts`.

## Rank Shield shop: USDC via Phantom (`shield-usdc-intent/`, `shield-usdc-confirm/`)

Phantom-signed-in players can pay for a Rank Shield pack in USDC on Solana (**devnet USDC-Dev only** until kungFuDOOM approves real money; `mainnet-beta` is refused unless `SHIELD_USDC_ALLOW_MAINNET=approved-by-kungfudoom`). The house only receives to a public address: no private key exists in this feature. The wallet always comes from the verified JWT user, never from the client. Logic is in `_shared/shield/usdc-*.ts` (explicit `.ts` imports, tested in vitest with mocked RPC). Setup, devnet test steps and the mainnet checklist: [`docs/rank-shield-usdc.md`](../../docs/rank-shield-usdc.md). Migration: `../migrations/20261119_pokejam_shield_usdc.sql` (after `20261117` and `20261118`). The receiver's USDC token account for the cluster's mint must already exist.

| Function | JWT | Secrets | What it does |
| --- | --- | --- | --- |
| `shield-usdc-intent` | verified (default) | `SHIELD_USDC_RECEIVER`; optional `SHIELD_USDC_CLUSTER` (default `devnet`), `SHIELD_USDC_ALLOW_MAINNET`, `SHIELD_USDC_RPC_URL`, `SHIELD_ALLOWED_ORIGINS` | Takes `{ sku, ageConfirmed }` from a Phantom-signed-in player, runs `pokejam_shield_checkout_check` (caps shared with Stripe), stores a one-time 15-minute intent (`pokejam_shield_usdc_intent`), reads a recent blockhash and checks the receiver's token account (the browser never calls an RPC), returns `{ intentId, reference, receiver, mint, amount, cluster, memo, blockhash }`. |
| `shield-usdc-confirm` | verified (default) | same | Takes `{ intentId, signature }`, reads the transaction from the RPC, checks mint, exact amount, recipient, signer, reference, memo and time window, then credits (`pokejam_shield_credit_usdc`). `202 pending` until confirmed; idempotent by intent and by signature. |

```sh
supabase secrets set SHIELD_USDC_RECEIVER=<house public address> SHIELD_USDC_CLUSTER=devnet
supabase functions deploy shield-usdc-intent
supabase functions deploy shield-usdc-confirm
```

Tests: `npx vitest run supabase/functions/_shared/shield supabase/tests/shield-usdc.test.ts`.

## Online play: the human check (`pokejam-human/`)

When it's switched on, quick match, making a room and joining one each need a short "human" pass (issue #20). The game shows a Cloudflare Turnstile check, `pokejam-human` verifies the token with Cloudflare's Siteverify, and the function grants a 20-minute pass (`pokejam_grant_human`, in `../migrations/20261027_pokejam_human_check.sql`). It's off until all three steps are done, so local and preview builds keep working.

1. In Cloudflare, create a Turnstile widget (managed or invisible) for the game's domains. Put the site key in Vercel as `VITE_TURNSTILE_SITE_KEY`.
2. Set the secret on the function, not in the repo or the client, and deploy it:
   ```sh
   supabase secrets set TURNSTILE_SECRET_KEY=<secret> HUMAN_ALLOWED_ORIGINS=https://pokejam.xyz,<test site>
   supabase functions deploy pokejam-human
   ```
   Optionally set `HUMAN_PASS_MINUTES` (default 20, maximum 60).
3. Turn the check on: `update public.pokejam_config set value = 'true' where key = 'require_human';` Setting `'false'` turns it off again at once.

## Moderation: the winner check on demand (`pokejam-judge/`)

The moderation page's Reported tab shows a cheat-check tag per reported player. `pokejam-judge` makes those verdicts: given up to 20 `match_ids`, it skips matches already judged or with no uploads (Social matches have none), then for each of the rest reads both players' uploads with the service role, merges their signed inputs under the setup and keys from the match row (`pokejam_match_setup` in `../migrations/20261128_pokejam_match_setup.sql`, `mergeEvidence` in `src/multiplayer/shared/evidence.ts`, so an uploader can't choose the seed, rosters or keys), replays the match with `judge()` and saves the result with `pokejam_record_verdict`. An upload that can't be read, has more than `MAX_UPLOAD_BATCHES` batches, or carries a different engine version from this judge is ignored with a note, its sender is recorded as `at_fault`, and the match is judged on the other upload. With no usable upload the verdict is `invalid`. Only moderators (`pokejam_is_admin`) get an answer; anyone else gets 403. One bad or oversized match is reported as skipped or an error and doesn't stop the rest.

It imports the game engine from `src/` (the replay must be the game's own code), and `deno.json` turns on sloppy imports for those extensionless imports.

Everything it imports must load without Vite: no `import.meta.env` or browser globals at module level. `_shared/judge/denoSafe.test.ts` guards that in Node. For a check in Deno itself, load the modules that `index.ts` imports with `npx deno@2.5.4 run --config supabase/functions/pokejam-judge/deno.json --allow-read <script>`, where the script imports them.

One call costs about 1 s of CPU per match, so judge one match per call. Numbers and open risks are in `docs/multiplayer.md` ("What judging costs, and where it runs").

1. Apply `20261122_pokejam_match_verdicts.sql` and `20261128_pokejam_match_setup.sql` first.
2. Deploy it with JWT verification on (the default; never `--no-verify-jwt`): `supabase functions deploy pokejam-judge`. Optionally `supabase secrets set JUDGE_ALLOWED_ORIGINS=https://pokejam.xyz,<test site>`.

## The judge queue: every Ranked match (`pokejam-judge-worker/`)

Each run claims one ready job from `pokejam_judge_jobs` and judges that match with the same code as `pokejam-judge`, then calls `pokejam_judge_apply`. A match in `judging` is decided by the verdict; any other match stays in shadow mode, with no change to its rating, winner or status. Only a caller holding the service key gets an answer. Rules for jobs are in `docs/multiplayer.md`, and each judging logs its duration.

1. Apply `20261129_pokejam_judge_jobs.sql`. From then on every Ranked match that ends gets a job, and they wait harmlessly until the worker runs.
2. Deploy it: `supabase functions deploy pokejam-judge-worker`.
3. Add two vault secrets, `pokejam_service_key` (the service role key) and `pokejam_functions_url` (`https://<project ref>.supabase.co/functions/v1`), then apply `20261130_pokejam_judge_cron.sql`. It schedules the every-minute job only if `pg_cron`, `pg_net` and both secrets are there; otherwise it raises a notice and changes nothing, so add what's missing and run it again. No key is stored in SQL, and a minute with nothing ready makes no Edge Function call.
4. Deploy the moderation page for the "Judge, shadow mode" table. It reads `pokejam_admin_judge_shadow`, and says "unavailable" if the migration isn't applied yet.

5. Apply `20261201_pokejam_judge_decides.sql` before redeploying the worker or deploying the client that reports resyncs. Disputes stay on the old rules until `update public.pokejam_config set value = 'true' where key = 'judge_authoritative';`. Then deploy a build with `VITE_JUDGE_AUTHORITATIVE=true`, which lowers the Ranked resync limit from 12 to 3. Setting the config back to `'false'` is the kill switch; redeploy without the build flag as well. Before an engine bump, turn it off until the matches in play have ended.

To stop it: `select cron.unschedule('pokejam-judge-worker');`. Jobs keep queueing and are judged when it's back, unless the uploads have passed their 30-day retention.

## Test locally

```sh
npm install
npx vitest run supabase        # real Postgres (PGlite) running the migration, fake CC and Solana
npx deno@2.5.4 check supabase/functions/pokejam-pack-payouts/index.ts supabase/functions/pokejam-pack-machines/index.ts
```

Against **real devnet** (CC's devnet gacha, Solana devnet, a funded devnet house wallet), with a local Postgres standing in for Supabase. It spends devnet USDC-Dev only, three $25 pulls:

```sh
bun supabase/functions/_shared/pack/test/devnet-smoke.ts <house keypair.json> <house USDC-Dev token account> <recipient wallet>
```

It queues four prizes. Three are opened and wait at the reveal with the card in the house wallet. The winner then picks Sell it back on one and Keep it on another (over a saved preference for cash), and lets the third run out of time (preference: cash). The fourth's pot is below CC's live price, so it is refused before paying and its pot is refunded.

Passed on 2026-10-23:
- **Sell it back:** a Zubat PSA 9 was sold back for $29.75, matching its estimate.
- **Keep it:** a Tea Party Pikachu PSA 10 was delivered on-chain.
- **Time ran out:** a Double Gust PSA 9 was sold back for $29.75.
- **Pot too small:** the $20 pot was refused against the $25 machine and refunded.
- **House wallet:** 694.1 → 678.6 USDC-Dev.

## Deploy (when kungFuDOOM approves)

1. Apply the migrations to the project, in order: `supabase db push`, or run the SQL in the dashboard.
2. Set the secrets. The house secret goes here and **never in the repo**:
   ```sh
   supabase secrets set CLUSTER=devnet HOUSE_SECRET_KEY='[...]' HOUSE_USDC_ACCOUNT=<house USDC-Dev token account>
   # optional: RPC_URL, CC_BASE_URL, CC_API_KEY, PRIZE_FALLBACK_ATTEMPTS, PRIZE_CHOICE_SECONDS (0 = no wait)
   ```
   `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` come with the Edge runtime. On devnet, CC charges its own USDC-Dev (`Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr`). `HOUSE_USDC_ACCOUNT` is the house's token account for that mint.
3. Deploy the functions: `supabase functions deploy pokejam-pack-payouts pokejam-pack-machines`.
4. Schedule them with the service key. One option, if `pg_cron` and `pg_net` are enabled (still to confirm with kfd):
   ```sql
   select cron.schedule('pokejam-pack-payouts', '* * * * *', $$
     select net.http_post(url := 'https://ruxbufynuzmversxmptw.supabase.co/functions/v1/pokejam-pack-payouts',
       headers := jsonb_build_object('authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'pokejam_service_key')))
   $$);
   select cron.schedule('pokejam-pack-machines', '*/10 * * * *', $$ ... same, /pokejam-pack-machines ... $$);
   ```
   Both functions reject any caller that doesn't hold the service key.

Admin: `select pokejam_pack_retry_prize('<prize id>')` re-queues a parked prize, after checking CC that a first purchase didn't land. Pulls are only bought after a result, so there is no "voided pull" to buy back.
