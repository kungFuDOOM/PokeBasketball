# Pack Battles Edge Functions

Step 3 of the plan on issue #4: after a battle has a winner, buy the winner's Collector Crypt pull, then send the card, sell it back for cash, or credit the pot if CC won't sell. **Devnet only** until kungFuDOOM approves real money; the code refuses any other cluster (see `_shared/pack/config.ts`).

**Nothing here has been applied or deployed.** The shared gauntlet-legends project (`ruxbufynuzmversxmptw`) changes only when kungFuDOOM says so.

## What's here

| Path | What it does |
| --- | --- |
| `../migrations/20261023_pokejam_pack_payouts.sql` | `pokejam_pack_machines`, `pokejam_pack_ledger`, `pokejam_pack_prizes`, and their functions. RLS is on: players read only their own prizes and ledger rows. Every write goes through service-role functions. |
| `../migrations/20261024_pokejam_pack_keep_or_sell.sql` | Keep it or sell it back at the reveal: the `revealed` state, `choice` / `choose_by` / `sell_estimate`, and `pokejam_pack_choose_prize`, the one prize write a player makes. |
| `pokejam-pack-payouts/` | The prize worker. Each run recovers stuck prizes, then settles up to 5. |
| `pokejam-pack-machines/` | Refreshes `pokejam_pack_machines` from CC's live prices, odds and stock, for the lobby. |
| `_shared/pack/` | Ported from the devnet-verified Bun prototype: CC client, Solana RPC, Core transfer, signing, machines and the worker. Imports use explicit `.ts` extensions, so the same files run in Deno and in vitest. |

How a prize moves:
1. The battle flow (in the escrow PR, after `judge()` in `src/multiplayer/shared/winnerCheck.ts`) calls `pokejam_pack_queue_prize(battle, user, wallet, tier, pot, prefer_cash)`.
2. The worker checks CC's live machine: it must exist, be in stock, and cost no more than the pot. It also checks that the house holds enough USDC.
3. It buys and opens the pull with `generatePack` → house signs → `submitTransaction` → `openPack`. The memo is saved the moment the purchase is paid, so a retry resumes and never buys twice.
4. The card is open and in the house wallet, so the prize waits as `revealed` for `PRIZE_CHOICE_SECONDS` (default 120). The winner sees the card with **Keep it** and **Sell it back** (about `sell_estimate`: insured value × the machine's buyback rate; the credit is CC's actual quote). The client calls `sb.rpc('pokejam_pack_choose_prize', { p_id, p_choice: 'keep' | 'sell' })`. It returns false if the prize isn't theirs or isn't waiting any more, and the prize row says which. The next run (at most a minute later on the every-minute cron) settles it. With no pick, the winner's saved preference (`prefer_cash`) applies once `choose_by` passes. CC's buyback window is 72 hours, so the wait costs nothing.
5. It then either sends the card (a Core transfer, after checking the owner on-chain) or sells it back and credits the buyback.
6. If CC refuses to sell `PRIZE_FALLBACK_ATTEMPTS` times (default 3), the winner is credited the whole pot. A house short of USDC keeps retrying instead.

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
