# Weekly challenges and the Pokémon card raffle

A signed-in player who finishes every weekly challenge gets **1 base entry** in that week's drawing for a Pokémon card, plus up to **5** grind entries. A linked wallet that holds PJAM gets holder entries with no challenges: 1 per 1,000,000 whole tokens, counting at most 5,000,000, so 5 from one balance. The two totals add. No purchase is required. The game does not take payment and does not ship the card. A moderator draws the winner and the operator sends the prize by hand.

This is not applied or deployed by the repo. Apply the migration and deploy the function yourself after review. `NET_VERSION` stays 3.

## Week

Monday 00:00 **America/Los_Angeles** through the next Monday 00:00. That is `pokejam_raffle_week_start()`. The Rank Shield challenge is a different clock (Monday 00:00 UTC) and is unchanged.

## What counts

Progress is counted on the server. The client never sends a total.

| Challenge | Default | Where it is counted |
| --- | --- | --- |
| Offline games played | 3 | `pokejam_raffle_note_offline`, one row per played Quick Play or Franchise finish. Sim and watch are not sent. At most one credit a minute, and 40 a day. |
| Online games finished | 3 | `pokejam_matches` with status `done` and `finished_at` in the week. Voids are ignored. |
| Social | 1 | A finished social match, or one `pokejam_raffle_note_share` per use of Share, up to the goal. |
| Rank climb | 1 | A `promoted` or `zenith` event on `pokejam_ranked_matches`, or already being at Zenith (`div_idx` 24) so there is no further rank. |

Offline games are not simulated on the server. The existing anonymous log (`pokejam_log_offline`) has no account on it, so a signed-in finish is stored as its own row and the rows are counted. Online games and rank climbs come only from match rows the server already wrote.

Guests (`is_anonymous`) are not entered and cannot record a finish or a share.

## Entries

Challenge entries are unchanged when the balance is under one step, or there is no wallet: 1 after every base challenge, plus grind entries capped at `bonus_cap` (default 5).

Holder entries need no challenges. For each balance, `floor(min(balance, pjam_counted_cap) / pjam_per_entry)`. Defaults: 1,000,000 per entry, 5,000,000 counted, so 5. The draw reads each balance and adds those counts to the challenge total.

- **Holder:** mint `GQe9QiBBV4G6bRUCxx2JgKrzT7G7RD17FJquBWgVpump`. Wallets are `pokejam_linked_wallets` and a Phantom sign-in address (`auth.identities` provider `web3`). Read at draw time from Solana (`finalized`), and on the challenges screen by `pokejam-raffle-holder`. The browser does not call an RPC. Decimals come from the mint account. Frozen token accounts are skipped. Classic SPL and Token-2022 are both read.
- **Grind:** each entry takes `grind_online_per_entry` online games **past** the weekly online goal (default 10) **and** `grind_wins_per_entry` online wins that week (default 3). Both gates apply. Wins are every win that week, not only wins in the extra games. Grind still requires the base challenges.

A player with none of the token needs the challenges for an entry, and 50 extra online games plus 15 wins for 5 grind entries. The free route is heavy and doable.

## Config

One row, `pokejam_config.key = 'raffle'`. A missing or out-of-range value falls back to the default. Change it with an update; do not edit the migration after it has been applied.

| Key | Default |
| --- | --- |
| `offline_games` | 3 |
| `online_games` | 3 |
| `social` | 1 |
| `rank_steps` | 1 |
| `pjam_per_entry` | 1000000 |
| `pjam_counted_cap` | 5000000 |
| `pjam_mint` | `GQe9QiBBV4G6bRUCxx2JgKrzT7G7RD17FJquBWgVpump` |
| `grind_online_per_entry` | 10 |
| `grind_wins_per_entry` | 3 |
| `bonus_cap` | 5 |

The challenges screen reads the live config. `public/raffle-rules.html` states these defaults and says the screen wins if they change.

## Drawing

There is no cron. On the moderation page, the **Raffle** tab lists who has finished every challenge. PJAM is not read until you press **Draw a winner**, and only for a week that has ended.

`pokejam-raffle-draw` (service role, after `pokejam_is_admin`):

1. `pokejam_raffle_draw_prep(week)` returns the mint and each qualifier's linked wallet.
2. The function reads whole-token balances.
3. `pokejam_raffle_commit_draw(week, balances, admin)` generates a 32-byte seed in the database, scores entries, and picks.

The pick is `uint64be-mod-v1`: the first 8 bytes of the seed, unsigned big-endian, modulo the total entries. Entrants are ordered by user id. A player with 4 entries is four tickets wide. The seed, the ticket, the config, and the entrant list are stored on `pokejam_raffle_draws`. A second draw for that week returns the same row.

To check a winner: sort the snapshot's entrants by `user_id`, walk `entries`, and stop when the running total passes `ticket`.

## Apply (owner, after merge)

1. Run `supabase/migrations/20261210_pokejam_weekly_raffle.sql` if it is not already applied, then `20261218_pokejam_wallet_link_nonce.sql` and `20261219_pokejam_raffle_holders_qualify.sql`. They are additive. They do not schedule a job.
2. Deploy `pokejam-raffle-draw`, `pokejam-raffle-holder`, and `pokejam-link-wallet`.
3. Optional secret: `RAFFLE_RPC_URL` (defaults to `https://api.mainnet-beta.solana.com`). Optional: `RAFFLE_ALLOWED_ORIGINS`, same shape as the judge allow-list. `SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are already on the Edge runtime.
4. `pgcrypto` / `extensions.gen_random_bytes` must exist (it does on Supabase). The draw uses it for the seed.
5. Ship the site so `public/raffle-rules.html` and the challenges screen are live. No env file is required in the repo.

The client calls `pokejam_raffle_me` when the challenges screen opens and once after a game ends. It does not poll.
