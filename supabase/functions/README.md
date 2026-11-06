# Pack Battles Edge Functions

Step 3 of the plan on issue #4: after a battle has a winner, buy the winner's Collector Crypt pull, then send the card, sell it back for cash, or credit the pot if CC won't sell. **Devnet only** until kungFuDOOM approves real money: the code refuses any other cluster without the approval phrase, a paid RPC and the database's real-money switch (see `_shared/pack/config.ts` and **Real money** below).

**Nothing here has been applied or deployed.** The shared gauntlet-legends project (`ruxbufynuzmversxmptw`) changes only when kungFuDOOM says so.

## What's here

| Path | What it does |
| --- | --- |
| `../migrations/20261023_pokejam_pack_payouts.sql` | `pokejam_pack_machines`, `pokejam_pack_ledger`, `pokejam_pack_prizes`, and their functions. RLS is on: players read only their own prizes and ledger rows. Every write goes through service-role functions. |
| `../migrations/20261102_pokejam_pack_fail_safe.sql` | Fail-safes: every purchase and buyback recorded before it's submitted, the kill switch and hourly cap, the append-only ledger and `pokejam_pack_post`, health for alerts (below). |
| `../migrations/20261024_pokejam_pack_keep_or_sell.sql` | Keep it or sell it back at the reveal: the `revealed` state, `choice` / `choose_by` / `sell_estimate`, and `pokejam_pack_choose_prize`, the one prize write a player makes. |
| `pokejam-pack-payouts/` | The prize worker. Each run recovers stuck prizes, then settles up to 5. |
| `pokejam-ads/` | Billboard ads: book the courtside LED board by burning $PJAM (below). |
| `pokejam-judge-worker/` | Judges the next Ranked match in the queue, one per run, and decides it if it's disputed and `judge_authoritative` is on. See "The judge queue" below. |
| `pokejam-raffle-draw/` | Draws one closed week's card raffle. Reads PJAM balances; the database picks the winner. See `docs/weekly-challenges.md`. No cron. |
| `../migrations/20261103_pokejam_pack_battles.sql` | Pack Battles on the test site: entries paid from the ledger, the `pack` queue, battles, settling, test credits (below). |
| `pokejam-pack-judge/` | Judges finished battles from both players' signed inputs and settles them (below). |
| `../migrations/20261105_pokejam_pack_wallet.sql` | Money in and out: proven wallets, deposits credited once, withdrawals with limits and review, fee revenue, the real-money switch (below). |
| `pokejam-pack-wallet/` | Proves a wallet, builds and claims deposits; its every-minute run scans the house account for deposits and sends withdrawals (below). |
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
| A hand-made burn of more or less than the price | Devnet: airtime in proportion, at the locked rate. Under a minute's worth is recorded as dust. Live: a burn below the price books nothing and is kept as burn credit; more runs longer. |
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
- `pokejam_live_ad_pay` compares the amount with the price. **Less than the price books nothing, not even a shorter slot** (a pro-rated burn would buy hours at the week's cheaper rate; the devnet board still pro-rates). The server builds the exact amount, so only a hand-crafted transaction can be short. Burned tokens can't come back, so a short burn is kept as **burn credit** (`20261205_pokejam_ads_burn_credit.sql`, table `pokejam_live_ad_burn_credit`) for the wallet that signed it and owns the burned account, after the same checks as any burn (finalized, mint, decimals, age, one signature once). A booking is paid when its burn plus that wallet's unspent credit reaches the locked price. Credit pays exactly what the burn is short of, oldest rows first, and the rest stays credit. It's spent in the same transaction as the booking, under the same advisory lock as every pay function, and never by another wallet, a banned one, or an ad that was already taken down. The database also refuses a burn whose burner isn't the booking's wallet, and refuses a non-finite, zero, negative or fractional amount. `prepare` builds the burn for the price minus the wallet's credit (one base unit if credit already covers it), and the page refuses to sign any other amount. A burn above the price runs longer at the plan's rate, as before; credit never adds to that. Credit alone books nothing: the wallet's own finalized burn naming the booking is what authorises spending it, so there is no separate redeem action to guard. The sweep credits short burns it finds.
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
4. **Retries:** `usdc-confirm` and `confirm` are safe to repeat, and the page keeps asking until it gets a final answer (`docs/ads-live.md`). A wallet-sent USDC payment the chain has never seen is answered `410 expired` once its intent has expired, which frees the page. A relayed transaction counts as never sent only if a node refused it and the chain has no record of its signature.
5. **Recovery with no page open:** the live `sweep` reads the receiver's USDC account history past a cursor (`live_ad_usdc_scan_cursor`, at `finalized`, at most 3 pages and 25 checks a run, 3 days back on the first run). It matches each intent memo with `pokejam_live_ad_usdc_find` and checks it as in step 2. It then re-checks the last day's open intents (at most 20, `pokejam_live_ad_usdc_open`) by reference key. If it hits a cap, the cursor stops at the last payment checked, so nothing is skipped. The sweep's reply carries a `usdc` summary.

**Layout.** The board keeps two halves. The `$PJAM · OFFICIAL POKEJAM TOKEN` half stays a fixed house ad. Booked ads replace only the "YOUR AD HERE" half (`src/game/ledBoard.ts`, `houseAds()` / `bookableHalfOn()` in `src/data/ads.ts`), and that half shows YOUR AD HERE when nothing is booked. The board is part of the court scenery, and the Advertise page is its own screen (title menu → Courtside Ads, `#advertise`), so no ad UI ever covers the game.

**Moderation.** admin.html's Ads tab has a Devnet / Live (mainnet) switch. Live calls `pokejam_admin_live_ads` and `pokejam_admin_live_ad_remove`, which work like the devnet ones and are logged in `pokejam_admin_log`. The ban list is shared by both boards, so **Lift** is `pokejam_admin_ad_unban` on either. To stop new bookings: `update public.pokejam_config set value = 'true' where key = 'live_ads_paused';` Payments already sent still settle.

### On kungFuDOOM's OK (mainnet, the live site)

1. **Migrations**, in this order, after every other migration: `20261203_pokejam_ads`, then `20261204_pokejam_ads_live`, then `20261205_pokejam_ads_burn_credit`. All are additive and safe to re-apply.
2. **Check the prices:** `select * from public.pokejam_live_ad_plans;`. They're seeded with the confirmed amounts.
3. **Secrets:**
   ```sh
   supabase secrets set ADS_ALLOW_MAINNET=true ADS_LIVE_RPC_URL=<paid mainnet RPC> ADS_LIVE_ALLOWED_ORIGINS=https://pokejam.xyz
   ```
   Add `ADS_PJAM_MINT` and `ADS_USDC_RECEIVER` only to change their defaults.
4. **Deploy:** `supabase functions deploy pokejam-ads-live --no-verify-jwt`. The page calls it without signing in.
5. **Schedule:** POST `{"action":"sweep"}` to `pokejam-ads-live` with the service key every few minutes (pg_cron + pg_net), as for devnet.
6. **The site's build:** `VITE_MODE_ADS=true`. The client calls `<VITE_SUPABASE_URL>/functions/v1/pokejam-ads-live`, whose origin is already in the CSP's `connect-src`. Set `VITE_ADS_API` only for a function hosted elsewhere: it must be https, and its origin is added to `connect-src`. No Solana RPC is added, and no inline script.

## Fail-safes (`../migrations/20261102_pokejam_pack_fail_safe.sql`)

The house wallet holds everyone's money, so every way a payout can go wrong ends in one of two places: retried safely by the worker, or parked for a person with a note. Nothing is ever bought, sent or credited twice.

| What goes wrong | What happens |
| --- | --- |
| CC's reply to a purchase or a buyback is lost, or the run crashes after submitting | The transaction's id and blockhash are saved **before** it's submitted. The next run asks the chain: landed (resume it, or credit the buyback), failed or expired unseen (it can never land, so try again), or still landing (wait 20 s, using up no attempt). |
| A crash at any other point | Prizes stuck in `sending` for 10 minutes go back in the queue. Nothing can be charged without a saved record, so they're all safe to retry. |
| The house is short of USDC, or the hourly spending cap is reached | The prize is held and retried every 10 minutes without using up its attempts. |
| A card is held by someone who's neither the house nor the winner | Parked for a person. Nothing is credited. |
| CC hands the house a transaction it shouldn't sign | Never signed (`tx-guard.ts`); the prize is parked as a security event. |
| A bug or a bad CC response loops | The hourly cap (`pack_max_spend_per_hour`, default 1,000 USDC) stops it, and the alert fires. |

**Kill switch.** `update public.pokejam_config set value = 'true' where key = 'pack_payouts_paused';` stops every purchase, delivery and buyback on the next run. `'false'` starts them again. The cap: `update public.pokejam_config set value = '<base units>' where key = 'pack_max_spend_per_hour';`.

**The ledger** is append-only (a trigger refuses any update or delete, even from the service role), and `pokejam_pack_post(user, delta, kind, ref, note)` is the one way to move a balance: idempotent on `(kind, ref)`, an error if the same `(kind, ref)` comes back with a different user or amount, one player at a time, and never below zero.

**Health and alerts.** Every run returns `health` and `alerts`: what the house owes (every balance plus every pot not bought yet) against its USDC, prizes parked for a person, cards still in the house wallet after 48 hours (CC's buyback window is 72), and prizes waiting over an hour. Set `ALERT_WEBHOOK_URL` (a Slack or Discord incoming webhook) to get each alert at most hourly.

On mainnet the worker won't start without `HOUSE_USDC_ACCOUNT` and `CC_SIGNER` (CC's gacha wallet, confirmed with Collector Crypt), because without them it can't check where a payment goes.

## Money in and out (`../migrations/20261105_pokejam_pack_wallet.sql`, `pokejam-pack-wallet/`)

The escrow checklist, built. Every balance change goes through `pokejam_pack_post`. The chain side is `_shared/pack/wallet.ts`, and the books are the migration.

**Proving a wallet.** The player asks for a one-time message (`pokejam_pack_wallet_challenge`, good for 10 minutes) and signs it with their wallet. That costs nothing and sends no transaction. `pokejam-pack-wallet` (`prove`) checks the Ed25519 signature and links the wallet (`pokejam_pack_wallet_link`). Each player has one wallet, and each wallet belongs to one player. Every change is logged in `pokejam_pack_wallet_log`, and a change starts a cooldown (`pack_wallet_cooldown_hours`, default 48) before any withdrawal, so an account takeover can't link a new wallet and cash out.

**Deposits.**
- `deposit` builds an unsigned transfer from the player's USDC account to the house's, with a memo. The wallet signs it.
- `claim` sends it, for a wallet that only signs, but only if it's the proven wallet paying the house. Once Solana finalizes it, `claim` credits it.
- A deposit is credited once per transfer: ref = signature + instruction index, or `outer.inner` for one sent through a program.
- Only finalized transactions count, only TransferChecked or Transfer of the USDC mint, and only into the house's USDC account. Before reading anything, the worker checks that this account is the house's and holds USDC.
- A transaction the house signed (a purchase, a buyback, a withdrawal) is never a deposit.
- A transfer from a wallet nobody has proven is **held** for a person (`pokejam_pack_credit_deposit`). An exchange sends from a shared wallet, so the sender alone proves nothing. A transfer under `pack_min_deposit` (default $1) is recorded as dust.
- The cron's scan pages through the house account's finalized history from the last signature it finished (`pack_deposit_cursor`), oldest first. The cursor only moves past a signature once it's recorded, so an outage or a backlog never skips one. If the backlog is more than 20,000 signatures, the scan stops and alerts instead of guessing.

**Entries** (from 20261103): both players' entry and fee are debited from their balances as they join, one per player per battle. Every way a battle ends without a winner refunds both exactly once. A won battle's fee is booked as house revenue (`pokejam_pack_revenue`), so the books balance. A voided battle refunds it, and one under review holds it.

**Withdrawals.**
- `pokejam_pack_withdraw(amount)` debits the balance first and sends only to the proven wallet.
- There are limits: from `pack_min_withdrawal` (default $5), up to `pack_withdraw_daily_limit` per player in 24 hours (default $500), and nothing during a wallet cooldown.
- A withdrawal over `pack_withdraw_review_over` (default $250) waits for a person: `pokejam_pack_review_withdrawal(id, approve, note)`.
- The worker creates the wallet's USDC account if it has none, then sends a TransferChecked from the house with the memo `pokejam-withdrawal:<id>`. The house signs nothing else.
- Each transaction's id and blockhash are recorded before it's submitted. A lost reply is settled from the chain: landed means sent; failed, or expired unseen, means try again; still landing means wait.
- The node refusing a send, or a transaction failing on-chain, uses up an attempt. After 3, the withdrawal is credited back once.
- A house short of USDC or SOL, or over `pack_withdraw_house_daily_cap` (default $5,000 a day across all players), holds the withdrawal without using up an attempt.
- Kill switches: `pack_withdrawals_paused`, or `pack_payouts_paused` for everything.

**Health** adds withdrawals not sent yet to what the house owes. It alerts on deposits held for a person and withdrawals waiting for review, and reports fee revenue.

| What goes wrong | What happens |
| --- | --- |
| The page closes before the deposit finalizes | The scan finds it within a minute. |
| A player deposits from an exchange or another wallet | Held for a person, who checks it and credits it once. |
| The same deposit is claimed twice, or the scan sees it again | Credited once (ref = signature + instruction). |
| Someone relays another player's signed deposit | Refused: only the proven wallet's own deposit is relayed. |
| The RPC lists a signature it can't serve yet | The scan stops there and resumes on the next run. |
| A withdrawal's reply is lost | Settled from the chain on the next run. Never sent twice. |
| A withdrawal fails 3 times | Credited back once. |
| The account is taken over and the wallet changed | Withdrawals wait for the cooldown. Every change is logged. |
| A large withdrawal | Waits for a person. |
| The house runs short | Withdrawals wait, and the alert fires. |

**Operations** (people, not code): keep only working float in the hot wallet and the rest in a multisig (Squads), topped up by hand. Reconcile daily: `health` compares the house's USDC with every balance, unbought pot, entry and unsent withdrawal, live. Watch the house's SOL for fees and token-account rent (each first withdrawal to a wallet with no USDC account costs the house about 0.002 SOL).

### Real money (only on kungFuDOOM's "Merge")

Two switches, which must agree. The workers (`pokejam-pack-payouts`, `pokejam-pack-wallet`) refuse to run unless they do.

1. **The database:** `update public.pokejam_config set value = 'true' where key = 'pack_real_money';` and `update public.pokejam_config set value = 'false' where key = 'pack_test_credits';`. With real money on, test credits are refused whatever `pack_test_credits` says, and a battle's card goes only to the player's proven wallet.
2. **The functions:**
   ```sh
   supabase secrets set CLUSTER=mainnet-beta PACK_ALLOW_MAINNET=approved-by-kungfudoom \
     RPC_URL=<a paid RPC: Helius, Triton or QuickNode> HOUSE_SECRET_KEY='[...]' HOUSE_USDC_ACCOUNT=<the house's mainnet USDC account> \
     CC_SIGNER=<Collector Crypt's mainnet gacha wallet, confirmed with them>
   ```
   The functions refuse to start on mainnet without `HOUSE_USDC_ACCOUNT`, `CC_SIGNER` and a paid `RPC_URL`. The public endpoint is refused because it rate-limits the deposit scan's history lookups. `PRIORITY_MICROLAMPORTS` (default 20,000 on mainnet) is the priority fee on withdrawals.

A mainnet worker refuses to run while `pack_real_money` is off or `pack_test_credits` is on. A devnet worker refuses to run while `pack_real_money` is on. So a test balance can never buy a real pull or be withdrawn as real USDC.

**Deploy** `pokejam-pack-wallet` (players call it with their session, so keep JWT verification on): `supabase functions deploy pokejam-pack-wallet`, set `WALLET_ALLOWED_ORIGINS=<the game's sites>`, and schedule `{"action":"run"}` with the service key every minute (pg_cron + pg_net), like the payouts worker.

**Rehearsed on devnet** with two real wallets, money in and out (`test/devnet-wallet.ts`, below).

## Pack Battles on the test site (`../migrations/20261103_pokejam_pack_battles.sql`, `pokejam-pack-judge/`)

Devnet only. A player enters a tier and pays half the pot plus half the fee from their balance. Two players on the same tier, near each other's MMR, are paired into a `pack` match: the same online lockstep game as Ranked, with balanced teams and signed inputs. After the game, the judge replays both players' signed inputs and settles the battle:

| The judge finds | What happens |
| --- | --- |
| A winner at the buzzer | The winner's pack is queued for the payout worker (`pokejam_pack_queue_prize`), which buys, opens and reveals it. They keep the card or sell it back. |
| A player signed two versions of the same input | That player forfeits, and the other wins. |
| The game stopped early, and one player signed a resignation (they pressed Leave, or closed the page) | That player forfeits (`outcome = 'resigned'`). The resignation goes out with their goodbye, so the other player's upload is proof. |
| The game stopped early, and one player never uploaded | They left without a word (closed the app, or lost their connection for good) and forfeit (`'abandoned'`). |
| The game stopped early, and both players stayed and uploaded | Signed inputs can't tell a real disconnect from a player cutting the link to dodge a loss, so a person decides (`'review'`, outcome `'disconnect'`) from both connection logs. Nobody wins by cutting the link. |
| A tie, or a game that never got going (no keys, no uploads, or not one tick played with both inputs) | Both players get their entry back in full, fee included. |
| Evidence it can't judge | The battle is held for a person (`state = 'review'`). Nothing moves, and health flags it. |

The early-end rule is kungFuDOOM's: the player who quits forfeits, with no automatic refund, and a player who says it was a real disconnect contacts support, who look at it case by case. For that, each upload carries its player's connection log (`Evidence.log`: tip-off, stalls and how long they lasted, the page hiding, the device going offline, why the game stopped, and the netcode's stats), and Pack Battles uploads are kept 90 days, or for as long as a battle is unsettled or held for a person. The judge's note on the battle says who forfeited and why. In the game, the Leave button reads "Leave and forfeit", and the waiting banner tells players to stay.

Leaving the queue refunds the entry, and so does an entry nobody has polled for 30 seconds. With `pack_test_credits` on (devnet only), a player can take $100 of test USDC a day into their balance. Deposits and withdrawals are in **Money in and out**, above.

**The judge** (`pokejam-pack-judge/`) runs `src/multiplayer/shared/judgeMatch.ts`, bundled with the game engine into `judge.bundle.js` by `npm run build:judge`. A test fails if the committed bundle is stale. It builds the game from the match row (seed, quarter length, names), never from an upload. Each run refunds dead searches, then judges up to 5 due battles: both players uploaded, or one did 3 minutes ago, or an hour has passed. Players call it right after their game, and a one-minute cron covers the rest.

### What the `pokejam` project (`ksvfgxodbwfntqnahukn`) needs, on kungFuDOOM's "Merge"

1. **Migrations, in order:** `20261023_pokejam_pack_payouts`, `20261024_pokejam_pack_keep_or_sell`, `20261102_pokejam_pack_fail_safe` (#42), `20261103_pokejam_pack_battles`, `20261105_pokejam_pack_wallet`.
2. **Edge Functions:** `supabase functions deploy pokejam-pack-machines pokejam-pack-payouts pokejam-pack-judge pokejam-pack-wallet`.
3. **Schedules (pg_cron + pg_net, service key):** `pokejam-pack-machines` every 10 minutes, and `pokejam-pack-payouts`, `pokejam-pack-judge` and `pokejam-pack-wallet` (body `{"action":"run"}`) every minute.
4. **Secrets (`supabase secrets set …`):**
   - `CLUSTER=devnet`
   - `HOUSE_SECRET_KEY`: a devnet house wallet made for the test site. Never reuse a key from anywhere else, and keep it out of the repo.
   - `HOUSE_USDC_ACCOUNT`: its USDC-Dev token account.
   - `WALLET_ALLOWED_ORIGINS`: the test site, for `pokejam-pack-wallet`.
   - Optional: `ALERT_WEBHOOK_URL`, `PRIZE_CHOICE_SECONDS` (default 120).
5. **Fund the house:** a little devnet SOL (`solana airdrop`) and USDC-Dev for the pulls. Collector Crypt's devnet gacha charges USDC-Dev (mint `Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr`), which comes from spl-token-faucet.com.
6. **Config:** `update public.pokejam_config set value = 'true' where key = 'pack_test_credits';` The fee is `pack_fee_bps` (default 500, so 5% of the pot).
7. **Vercel `pokejam-test` only:** `VITE_MODE_PACK_BATTLES=true`. This build also lets the page show Collector Crypt's card images (CSP `img-src`).

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

The fail-safes on real devnet: lost replies and never-sent submits for purchases and buybacks (injected on the network between the worker and CC; CC and the chain are real), a crash, the kill switch, the hourly cap, a house short of USDC, a card that leaves the house, a pot below the price, and the health check. Seven $25 pulls, two sold back:

```sh
bun supabase/functions/_shared/pack/test/devnet-failsafe.ts <house keypair.json> <house USDC-Dev token account> <recipient wallet> <bystander wallet>
```

Run on 2026-10-29: all 32 checks passed, and the house's USDC-Dev moved by exactly seven pulls less the two buybacks.

Money in and out, with two real devnet wallets: link both by signing, deposit $30 from each (built by the server, signed by the wallet, credited once finalized), pair them in a Starter battle, buy and sell back the winner's real pull, then withdraw both whole balances to their wallets. It checks that nothing is credited twice, both wallets end with exactly what the ledger says, and the house's USDC moved by exactly the fee:

```sh
bun --use-system-ca supabase/functions/_shared/pack/test/devnet-wallet.ts <house keypair.json> <house USDC-Dev token account> <player 1 keypair.json> <player 2 keypair.json>
```

The house sends each player a little test SOL and $40 of USDC-Dev first. The game itself and its judge aren't replayed here: the battle is settled for player 1 directly, and #43 tested the judge on real played games.

Run on 2026-11-05: all 26 checks passed.
- Both wallets linked, and a signature from another key was refused for each.
- Both $30 deposits finalized within about 5 s and were credited once. Claiming again and the scan credited nothing more.
- The winner's pull was a Mew PSA 7 (insured at $18), sold back for $15.30.
- Withdrawals of $32.17 and $16.88 landed in the two wallets, which ended at $42.17 and $26.88.
- The scan read the pull, the buyback and both withdrawals, and found no deposit in them.
- The house went from $424.25 to $425.50: exactly the $1.25 fee.

Passed on 2026-10-23:
- **Sell it back:** a Zubat PSA 9 was sold back for $29.75, matching its estimate.
- **Keep it:** a Tea Party Pikachu PSA 10 was delivered on-chain.
- **Time ran out:** a Double Gust PSA 9 was sold back for $29.75.
- **Pot too small:** the $20 pot was refused against the $25 machine and refunded.
- **House wallet:** 694.1 → 678.6 USDC-Dev.

## Weekly card raffle (`pokejam-raffle-draw/`, `../migrations/20261210_pokejam_weekly_raffle.sql`)

A moderator draws the winner after the week ends (Monday 00:00 Pacific). The function reads whole PJAM from the linked wallet (`RAFFLE_RPC_URL`, or mainnet if unset) and calls `pokejam_raffle_commit_draw`. The seed is generated in Postgres. Nothing is paid or shipped. Details, defaults, and the apply steps are in `docs/weekly-challenges.md`. Do not schedule it; the Raffle tab on the moderation page runs it once per week.

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
