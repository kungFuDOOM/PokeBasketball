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

**Mainnet, only on kungFuDOOM's OK:**
- Set `ADS_CLUSTER=mainnet-beta` and `ADS_ALLOW_MAINNET=approved-by-kungfudoom`. The mint is then always the official $PJAM, `GQe9QiBBV4G6bRUCxx2JgKrzT7G7RD17FJquBWgVpump` (Token-2022), and the faucet is off whatever is set.
- Use a paid RPC (`ADS_RPC_URL`): the public mainnet RPC rate-limits the history lookups.
- Set prices for the token's market at the time.

**Test it locally against devnet:**
1. Run the devnet smoke test: `bun --use-system-ca scripts/ads-devnet-smoke.ts <mint> <faucet-keypair.json>`. It makes real burns every way they can arrive (relayed, wallet-sent, page closed, never confirmed, short, second, paid by a friend), plus one the node refuses, and checks that the supply fell by exactly what was burned.
2. To try the whole page:
   1. `VITE_MODE_ADS=true VITE_ADS_API=http://localhost:8787/api/ads npm run build`
   2. `AD_MINT=<mint> AD_FAUCET_SECRET_FILE=<keypair.json> bun --use-system-ca scripts/ads-dev-server.ts`
   3. Open http://localhost:8787/#advertise.

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
