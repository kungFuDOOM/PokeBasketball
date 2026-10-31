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
| `pokejam-pack-machines/` | Refreshes `pokejam_pack_machines` from CC's live prices, odds and stock, for the lobby. |
| `_shared/pack/` | Ported from the devnet-verified Bun prototype: CC client, Solana RPC, Core transfer, signing, machines and the worker. Imports use explicit `.ts` extensions, so the same files run in Deno and in vitest. |

How a prize moves:
1. The battle flow (in the escrow PR, after `judge()` in `src/multiplayer/shared/winnerCheck.ts`) calls `pokejam_pack_queue_prize(battle, user, wallet, tier, pot, prefer_cash)`.
2. The worker checks CC's live machine: it must exist, be in stock, and cost no more than the pot. It also checks that the house holds enough USDC.
3. It buys and opens the pull with `generatePack` → house signs → `submitTransaction` → `openPack`. The memo is saved the moment the purchase is paid, so a retry resumes and never buys twice.
4. The card is open and in the house wallet, so the prize waits as `revealed` for `PRIZE_CHOICE_SECONDS` (default 120). The winner sees the card with **Keep it** and **Sell it back** (about `sell_estimate`: insured value × the machine's buyback rate; the credit is CC's actual quote). The client calls `sb.rpc('pokejam_pack_choose_prize', { p_id, p_choice: 'keep' | 'sell' })`. It returns false if the prize isn't theirs or isn't waiting any more, and the prize row says which. The next run (at most a minute later on the every-minute cron) settles it. With no pick, the winner's saved preference (`prefer_cash`) applies once `choose_by` passes. CC's buyback window is 72 hours, so the wait costs nothing.
5. It then either sends the card (a Core transfer, after checking the owner on-chain) or sells it back and credits the buyback.
6. If CC refuses to sell `PRIZE_FALLBACK_ATTEMPTS` times (default 3), the winner is credited the whole pot. A house short of USDC keeps retrying instead.

## Billboard ads (`pokejam-ads/`, `../migrations/20261104_pokejam_ads.sql`)

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

1. **Migration:** `20261104_pokejam_ads`.
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

## Billboard ads on the live site (`pokejam-ads-live/`, `../migrations/20261124_pokejam_ads_live.sql`)

The live site (pokejam.xyz) books the same courtside LED board on **Solana mainnet**, through its own function. It runs the same handler as the devnet `pokejam-ads` above (`_shared/ads/handler.ts`), configured by `adsConfigLive` in `_shared/ads/config.ts`. The devnet function, its secrets and its tables are unchanged. The client (`src/ads/api.ts`) only ever calls `pokejam-ads-live`. Advertisers pay from their own wallet in one of two ways:
- **Burn $PJAM**, exactly as above (an hour, a day or a week).
- **Pay in USDC** (a week or a month), sent to kungfudoom.sns.

More detail, including the open questions, is in `docs/ads-live.md`.

**Its own rows.** Live bookings use separate tables (`pokejam_live_ads`, `pokejam_live_ad_reports`, `pokejam_live_ad_usdc_intents`) and `pokejam_live_ad_*` functions. The ban list (`pokejam_ad_bans`) is shared on purpose, so a wallet banned on either board is banned on both. Its settings sit in `pokejam_config` under `live_` plus the devnet key (`live_ad_price_week`, `live_ad_usdc_month`, `live_ad_spots`, `live_ads_paused`, …). `adsConfigLive.dbName` maps every SQL call to the live names, so devnet and mainnet bookings never mix. The migration is additive only: it drops nothing and doesn't change any function the devnet site uses.

**Secrets.** Edge Function secrets are shared by the whole project, so anything the devnet function also reads gets an `ADS_LIVE_` name here:

| Secret | | |
| --- | --- | --- |
| `ADS_ALLOW_MAINNET` | required on mainnet | Must be exactly `true`. Anything else, such as `TRUE`, ` true`, `1` or the devnet function's approval phrase, and the function refuses to start. |
| `ADS_LIVE_CLUSTER` | optional | `devnet` runs this function against devnet (for a staging copy). Anything else, or unset, means `mainnet-beta`. This is the live counterpart of `ADS_CLUSTER`, which stays the devnet function's own and doesn't affect this one. |
| `ADS_PJAM_MINT` | optional on mainnet | The token burned. It defaults to `GQe9QiBBV4G6bRUCxx2JgKrzT7G7RD17FJquBWgVpump`, hard-coded in #45. **Needs user confirmation:** kungFuDOOM must confirm this is the official $PJAM before mainnet is turned on. It is required on devnet, where there is no default. |
| `ADS_USDC_RECEIVER` | optional | The wallet paid in USDC. It defaults to kungfudoom.sns, `FPwoDYkHTFef4Fg45o1wzReXiVoYGP6KXEgRyfqqBpyk`. The payment must land in that wallet's USDC associated token account. The USDC mint is never configurable: on mainnet it is Circle's `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`. |
| `ADS_LIVE_RPC_URL` | strongly advised | A paid mainnet RPC. The public one rate-limits history lookups. All chain reads happen here; the browser never calls an RPC. |
| `ADS_LIVE_ALLOWED_ORIGINS` | advised | `https://pokejam.xyz` (comma-separated exact origins). If it's empty, any origin may call. |
| `ADS_LIVE_PRIORITY_MICROLAMPORTS` | optional | The priority fee on the burn. Default 20,000 on mainnet. |
| `ADS_ALERT_WEBHOOK_URL` | optional | Shared with the devnet function: report alerts to Slack or Discord. |

**No faucet on mainnet**, whatever is set: `AD_FAUCET_SECRET` is ignored, the `faucet` action answers 404, the board reports `faucet: false` and the page hides the button.

**Plans and prices.** Only the bookable courtside half is self-serve. The ticker and the ticker + courtside combo stay contact-sales, priced in USD and paid in SOL (`public/contact.html`).

| Plan | Burn $PJAM | USDC |
| --- | --- | --- |
| 1 hour | `live_ad_price_hour` (default 100,000 PJAM) | n/a |
| 1 day | `live_ad_price_day` (default 1,500,000 PJAM) | n/a |
| 1 week | `live_ad_price_week` (default 7,500,000 PJAM) | `live_ad_usdc_week` = $150 |
| 1 month (720 h) | n/a | `live_ad_usdc_month` = $500 |

The USDC prices match the courtside banner half's list price on the contact page. The PJAM defaults are the devnet ones: set real prices for the token's market before launch (`update public.pokejam_config …`, no deploy). The amounts are stored in base units (6 decimals for both tokens).

**How a USDC payment works** (`_shared/ads/usdc-*.ts`, adapted from the USDC payment pattern on `origin/claude/shield-usdc-only`, copied, not merged):
1. `usdc-intent` first runs every check that could refuse the ad: the text filter, a ban, paused sales, the price the page showed, and the wallet's USDC and SOL. It then saves a one-time intent with an exact amount, a reference key and a memo, which expires in 15 minutes. It returns an unsigned SPL `TransferChecked` to the receiver's USDC account. The page rebuilds that transaction itself and checks it matches before the wallet signs.
2. `usdc-confirm` reads the payment from the chain at `finalized` commitment on mainnet (`confirmed` on devnet) and checks that:
   - the mint is USDC;
   - the destination is the associated token account of the receiver;
   - the amount is at least the price;
   - the advertiser's wallet signed;
   - the transaction succeeded.
3. A signature books only once, because `usdc_sig` and the intent's signature are unique. With no signature, `usdc-confirm` finds the payment by the intent's reference key, so a page closed mid-payment still books on its next visit. A payment that really landed after its intent expired still books.

**Layout.** The board keeps two halves. The `$PJAM · OFFICIAL POKEJAM TOKEN` half stays a fixed house ad. Booked ads replace only the "YOUR AD HERE" half (`src/game/ledBoard.ts`, `houseAds()` / `bookableHalfOn()` in `src/data/ads.ts`), and that half shows YOUR AD HERE when nothing is booked. The board is part of the court scenery, and the Advertise page is its own screen (title menu → Courtside Ads, `#advertise`), so no ad UI ever covers the game.

**Moderation.** `pokejam_admin_live_ads` and `pokejam_admin_live_ad_remove` work like the devnet ones and are logged in `pokejam_admin_log`. To stop new bookings: `update public.pokejam_config set value = 'true' where key = 'live_ads_paused';` Payments already sent still settle.

### On kungFuDOOM's OK (mainnet, the live site)

1. **Migration:** `20261124_pokejam_ads_live`, applied after `20261104_pokejam_ads`.
2. **Confirm the $PJAM mint** (see `ADS_PJAM_MINT` above), and set the PJAM burn prices.
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

The moderation page's Reported tab shows a cheat-check tag per reported player. `pokejam-judge` makes those verdicts: given up to 20 `match_ids`, it skips matches already judged or with no uploads (Social matches have none), then for each of the rest reads both players' uploads with the service role, merges them under the keys registered on the match row (`mergeEvidence` in `src/multiplayer/shared/evidence.ts`, so an uploader can't choose their own keys), replays the match with `judge()` and saves the result with `pokejam_record_verdict` (`../migrations/20261122_pokejam_match_verdicts.sql`). Only moderators (`pokejam_is_admin`) get an answer; anyone else gets 403. One bad or oversized match is reported as skipped or an error and doesn't stop the rest.

It imports the game engine from `src/` (the replay must be the game's own code), and `deno.json` turns on sloppy imports for those extensionless imports.

1. Apply `20261122_pokejam_match_verdicts.sql` first.
2. Deploy it with JWT verification on (the default; never `--no-verify-jwt`): `supabase functions deploy pokejam-judge`. Optionally `supabase secrets set JUDGE_ALLOWED_ORIGINS=https://pokejam.xyz,<test site>`.

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
