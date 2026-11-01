# Ranked plan (design only)

Status: proposal, nothing implemented. Target: pokejam.xyz Ranked, currently "coming soon".
Hard rules: `NET_VERSION` stays **3** (no change to the lockstep protocol), migrations are additive only, Supabase free plan.
Launch = **Season 1**, 6 weeks.

## 1. Current state (from the repo)

- `src/config/features.ts`: `MODE_RANKED` build flag (`VITE_MODE_RANKED === 'true'`), default off. Ranked ships behind it.
- `src/multiplayer/shared/netplay.ts:73`: `NET_VERSION = 3`, checked in the handshake along with `ENGINE_VERSION`. Ranked reuses the same netplay, so it needs no bump.
- `src/multiplayer/shared/matchService.ts`: `Queue = 'social' | 'ranked'`; `findMatch(queue)` and `reportResult(queue, ...)` already exist, with a local mock for offline. Ranked uses `ratings.mmr()` and `ratings.apply()`.
- **Online play is 1v1.** Two humans are paired (`pokejam_find_match` returns one opponent), one is `host` (side 0) and one `guest` (side 1), each controls one team (`match.side`, `g.teams[1 - match.side]` in `onlineGame.ts`). There is no party or 2v2 path in `src/multiplayer`. Everything below (pairing, leavers, forfeits) assumes exactly two players per match.
- **What a match report carries** (`MatchResult` in `matchService.ts:14`, sent at `onlineGame.ts:182`): `won`, `score: [mine, theirs]`, `engineVersion`, `seed`. That is all the server gets.
- **Per-player stats that exist:** `PStats` (`src/game/types.ts:119`: pts, fgm/fga, tpm/tpa, reb, ast, stl, blk, dnk, sec, gs) are tracked per player in the client game (`game.ts`), but they are **not** in the report, and nothing server-side can verify them (the signed evidence log lets `winnerCheck.ts` replay a match in JS, not in SQL). So the performance factor uses **only the final score**, which both players report and which must agree for the match to count. Box-score stats (FG%, steals, blocks) are deliberately not used; see "Possible later" in section 3.
- `supabase/migrations/20261021_pokejam_online.sql` (test-build ladder):
  - `pokejam_profiles` has `mmr, ladder, placements, shield, tier, division, rp`.
  - `pokejam_apply_rank` is an Elo (K 64 / 24) ladder. It has 5 tiers x 3 divisions plus Pokémon Master, with 100-point divisions and a 2-game shield.
  - `pokejam_report_result` reconciles both players' reports. If they disagree the match is `void`. If the guest never reports, the host's report wins after 120 s. It calls `pokejam_apply_rank` for `queue = 'ranked'`.
  - `pokejam_leave_match` currently **voids** the match. Ranked needs different behaviour (section 8.2).
- `20261104_pokejam_queue_heartbeat.sql`: `pokejam_find_match(p_queue)` runs as a poll every 2 s, and each poll is a heartbeat (`last_seen`, 15 s). The window is `100 + 25*s` capped at 1000 on `mmr`. Pairing skips blocked and banned users. The 15 s heartbeat is why ghosts no longer match.
- Already in place and reusable: `pokejam_human_ok` (human check), `pokejam_banned`, `pokejam_rate_ok`, `pokejam_cleanup_maybe`, match evidence (`20261028`), game heartbeat (`20261106`), draft presence (`20261105`), requeue-stale (`20261107`), admin stats (`20261109`).
- The trailer already advertises the ladder as Bronze ... Pokémon Master (`RANK_TIERS`, 6 badges). It needs a refresh for Prism, Eclipse and Zenith.

The test-build Elo ladder is replaced by the points system below. Its columns stay in place, unused. Nothing is dropped.

## 2. Tiers and divisions

Order, **lowest to highest** (24 divisions, index 0..23, then one points-only tier):

> Bronze 3 -> Bronze 2 -> Bronze 1 -> Silver 3 -> 2 -> 1 -> Gold 3 -> 2 -> 1 -> Platinum 3 -> 2 -> 1 -> Diamond 3 -> 2 -> 1 -> **Prism** 3 -> 2 -> 1 -> **Eclipse** 3 -> 2 -> 1 -> **Pokémon Master 3 -> 2 -> 1** -> **Zenith**

Division 3 is the lowest in a tier and division 1 the highest. Prism, Eclipse and Zenith are original names (generic metals and gems, plus the user's own Pokémon Master).

Every division is **100 points** (0..99). Reaching 100 promotes you with the remainder carried over. Dropping below 0 demotes you to 75 in the division below, unless the rank shield blocks it (section 5).

**Ladder score** (used for matchmaking, seeding and the leaderboard): `div_idx * 100 + points`, so Bronze 3 0 pts = 0 and Pokémon Master 1 99 pts = 2399. Zenith adds `2400 + zenith_points`.

### Zenith (points-only top tier, no divisions)

- **Entry:** promote out of Pokémon Master 1 (reach 100 points there). You enter Zenith with **100 Zenith points**. The buffer stops a single loss from bouncing you straight back out.
- **Points:** open-ended, no divisions, no cap. Uses the Pokémon Master base values (win 20, loss 22) and the same performance formula (section 3). Zenith players carry `div_idx = 24` and `points = zenith points`.
- **Exit:** a loss that takes Zenith points below 0 demotes you to Pokémon Master 1 with 75 points. The rank shield does not exist at this level (Gold and below only).
- **Inactivity:** after 7 days without a ranked game, lose 25 Zenith points per further 7 days (floor 50, applied lazily when the profile or leaderboard is read). This keeps the board live without a cron job.
- **Leaderboard:** the Top 100 (section 8.3) is ordered by ladder score across every tier, so Zenith players sit on top ordered by Zenith points, and Pokémon Master players fill the rest until Zenith has enough entrants.

## 3. Points per win and per loss, with performance

A win is worth more than a loss costs on average, so a 50% player still climbs. The gap shrinks as the tier rises.

### Performance input (server-side only)

Computed in `pokejam_ranked_apply` from the final score both players reported and the server accepted:

```
m = (winner_score - loser_score) / (winner_score + loser_score)      -- 0 < m <= 1, margin share
```

Example: 42-38 gives m = 0.05, 60-30 gives m = 0.33, 70-20 gives m = 0.56. A share, not raw margin, so a slow game and a fast game compare fairly. Scores are validated (integers, 0..300, winner > loser). Clients never send a performance number.

### Formula

```
Mw = clamp(0.8 + 1.4 * m, 0.8, 1.5)                 -- win multiplier: close win 0.8, dominant win (m >= 0.5) 1.5
c  = 1 - min(m, 0.25) / 0.25                        -- closeness of a loss: 1 = photo finish, 0 = blowout (m >= 0.25)
Ml = 1 - 0.4 * c                                    -- loss multiplier: close loss 0.6, blowout loss 1.0
adj = clamp(opp_idx - my_idx, -3, +3)               -- opponent-division modifier (div_idx difference)

win_gain  = clamp(round(W * Mw) + adj, round(0.8 * W), round(1.5 * W))
loss_cost = clamp(round(L * Ml) - adj, round(0.6 * L), L)
```

- Base values `W` and `L` come from the tier table below (the tier you are in when the match is scored). `L` is the *full-cost* loss; the average realised loss is about `0.8 L`, so the bases were raised from the earlier table to keep the same pace.
- Everything is clamped, so no input can push a result outside the table's min/max columns. `adj` cannot exceed those bounds either.
- `round` is half-up, in SQL `floor(x + 0.5)`.
- Leavers, forfeits and voids bypass this formula (section 8.2).

### Per-tier table

| Tier band | Base W | Base L | **Win gain min..max** | **Loss cost min..max** | Avg net per W+L pair | Wins to climb 1 division at 50% (~) |
|---|---|---|---|---|---|---|
| Bronze | 30 | 19 | **24..45** | **11..19** | ~+14 | 7 |
| Silver | 27 | 19 | **22..41** | **11..19** | ~+11 | 9 |
| Gold | 25 | 19 | **20..38** | **11..19** | ~+9 | 11 |
| Platinum | 24 | 20 | **19..36** | **12..20** | ~+7 | 14 |
| Diamond | 23 | 20 | **18..35** | **12..20** | ~+6 | 17 |
| Prism | 22 | 21 | **18..33** | **13..21** | ~+4 | 25 |
| Eclipse | 21 | 21 | **17..32** | **13..21** | ~+3 | 33 |
| Pokémon Master | 20 | 22 | **16..30** | **13..22** | ~+2 | 50 |
| Zenith (points) | 20 | 22 | **16..30** | **13..22** | ~+2 | n/a |

Avg net assumes winners average m ~ 0.12 (Mw ~ 0.97) and losers average m ~ 0.12 (Ml ~ 0.8). A player who wins more than half their games and wins big climbs much faster; a player who loses blowouts pays the full `L`.

Reading it: a 50% player needs a bit over 20 wins to climb a whole tier in Bronze and about 100 in Eclipse. Bronze 3 to Pokémon Master 3 is around 340 wins at 50%. Below ~45% in Gold or higher you slowly sink, and blowout losses sink you faster than close ones. In Pokémon Master, you need about 10 wins per 9 losses to stand still.

Streaks give no extra points, so the ladder is not tilt-bait.

### Possible later (not in this plan)

Using box-score stats (FG%, steals, blocks, assists) would need the report RPC to carry them and the server to cross-check both players' versions or replay the match. Neither exists and it adds a new trust surface, so it is out of scope. If wanted: add an optional `p_box jsonb` to `pokejam_report_result`, and only count a stat when both reports agree on it.

## 4. Win/loss bookkeeping

- `div_idx` (0..24) and `points` are the visible rank (hidden while placing). Matchmaking uses the ladder score only; there is no separate hidden MMR.
- A draw cannot happen (overtime until a winner). A `void` match (reports disagree, or both sides disconnect) changes nothing.
- Placement matches never touch `points`; they feed a separate `placement_raw` sum (section 6).

## 5. Rank shield (Gold and below)

Replaces the earlier tier-entry "shield games". There is no per-tier shield and none in Platinum or above.

- **One charge** per player per season. It blocks **one demotion**: when a loss would take `points` below 0 and drop you to a lower division, you instead stay in the division at **0 points** and the charge is consumed. This applies to any division, including the drop from Gold 3 to Silver 1.
- **Only active in Gold and below:** the shield works while your current division is Gold 1 or lower (`div_idx <= 8`). Platinum 3 falling to Gold 1 is not protected, because you are in Platinum when the loss lands. Zenith has no shield.
- **Recharge:** after the charge is consumed it comes back after **N = 3 ranked losses** (only losses count while the charge is empty, wins do not; leaves count as losses). Stored as `shield_charge` (0/1) and `shield_losses` (0..3).
- **Bronze 3 is the absolute floor:** losses cost nothing at 0 points, so the shield is not spent there.
- **Leaver losses are not shielded** (section 8.2): the charge is not consumed and the demotion goes through, so quitting is never a free way to dodge a loss.
- **UI:** a small shield icon next to the points bar: full, empty with "recharges in 2 losses", or hidden above Gold.

## 6. Seasons, placements, and seeding

- A season is **6 weeks** by default, and **Season 1 is 6 weeks**. Length is configurable per season. Table `pokejam_seasons(id, number, starts_at, length_weeks int not null default 6, ends_at timestamptz not null, status)`. Exactly one is `active`.
- **`ends_at` is set in the open-season RPC, not as a column default or generated column.** Postgres defaults cannot reference other columns, and a generated column `starts_at + length_weeks * interval '1 week'` would be rejected because `timestamptz + interval` is only STABLE (it depends on the session time zone), not IMMUTABLE. `pokejam_ranked_open_season(p_length_weeks int default 6)` inserts `ends_at = starts_at + p_length_weeks * interval '1 week'`; a check constraint `ends_at > starts_at` guards it. An admin RPC can edit `length_weeks` and `ends_at` together while a season is active.
- The rollover is lazy and runs inside the first ranked RPC that sees `now() > ends_at`, so there is no cron job (the free plan works, and `pokejam_cleanup_maybe` already uses this pattern).
- **Season number in the UI:** a `S1` badge on the rank chip, "Season 1 - 31 days left" on the Season screen, and "Season 1" on the post-match screen.

### Placements

- **Every season each player plays 5 placement matches**, in the ranked queue like any other game. While placing, the UI shows only "Placement 2 / 5" (no tier, no points, no points bar), and the post-match screen shows only the W/L and progress, never a number.
- Each placement match adds to `placement_raw`:

```
q   = min(m, 0.25) / 0.25                         -- same margin share m as section 3 (0..1)
w_i = (0.6 + 0.4 * q) * (1 + clamp((opp_score - seed_score) / 1000, -0.2, +0.2))
raw += (won ? +1 : -1) * w_i                      -- leaver: -1 * 1.0; opponent of a leaver: +1 * 0.6
shift = clamp(round(20 * raw), -100, +100)        -- -100 .. +100 ladder points
start_score = clamp(seed_score + shift, 0, 2299)  -- Bronze 3 0 pts .. Pokémon Master 1 99 pts
```

  A 5-0 sweep with strong margins gives about +100, a 0-5 gives about -100, a 3-2 about +20. `w_i` is bounded to about 0.48..1.2, so `raw` is within -6..+6 and the clamp is what limits `shift`.
- On the fifth placement the server converts `start_score` into `div_idx`/`points` (Zenith is never granted by placements). The profile leaves `placing` state and the player sees the result screen "Placed: Gold 2 - 40 pts".
- During placements matchmaking uses `seed_score` as the player's ladder score (the visible rank stays hidden).

### Seed

```
seed_score = clamp(last_final_score - 600, 0, 1400)       -- last_final_score = ladder score at the end of your last archived season
```

- A Zenith player counts as `2400 + zenith_points`, so everyone from Pokémon Master 3 and up seeds at the cap, 1400 (Diamond 1 0 pts). With the maximum +100 shift they can place no higher than Prism 3.
- A Gold 2 0 pts player (700) seeds at 100 and a Platinum 1 (1100) at 500 (Silver 1).
- **New players** (no archived season): `seed_score = 0` (Bronze 3, 0 pts). Placements move them by 0..+100 at most, since the floor is 0.
- A player who skipped a season uses the most recent archived final (no extra decay).
- Players with fewer than 10 ranked games in a season are not archived for peak badges, but their final ladder score is still stored, so their next seed works.

**This replaces the old fixed "-6 divisions, cap Platinum 1" soft reset.** There is no fixed reset step any more; the seed rule plus placements decide where you start.

### Season 1 -> Season 2 transition

1. First ranked RPC after `ends_at` of Season 1 closes it (`status = 'closed'`) and calls `pokejam_ranked_open_season()`, which creates **Season 2** (`number = 2`, `starts_at` = Season 1's `ends_at`, same length unless an admin set a different next-season length).
2. Season 1 results are archived in `pokejam_ranked_season_results(user_id, season_id, peak_idx, final_score, wins, losses)`. The Season 1 leaderboard is kept as a frozen snapshot (`pokejam_ranked_leaderboard(p_season)`).
3. Nobody is changed in place. Each player's Season 2 profile is created lazily on their next ranked action with `status = placing`, `placements_left = 5`, `seed_score = clamp(final_S1 - 600, 0, 1400)`, `shield_charge = 1`, and wins/losses/streak at zero.
4. The first time they open the Ranked screen in Season 2 they see "Season 2 has started. Play 5 placement matches to find your rank", with last season's peak badge. They are matched by `seed_score` until the fifth game ends.
5. Kept forever: each season's peak tier and final rank, shown as profile badges. Nothing else carries over.

## 7. Matchmaking by rank

Use the existing `pokejam_find_match` queue and its 2 s polling heartbeat, with no client protocol change. For `p_queue = 'ranked'`, `pokejam_queue.mmr` is set to the player's ladder score (`seed_score` while placing), so the existing columns and the `last_seen` index are reused. Replace the window expression with:

| Time in queue | Allowed gap (ladder score) | Approx. divisions |
|---|---|---|
| 0-10 s | 100 | +/- 1 |
| 10-30 s | 100 + 15/s up to 400 | +/- 2 -> 4 |
| 30-60 s | up to 700 | +/- 7 |
| 60 s+ | up to 900, hard stop | +/- 9 |

- Hard rules: Eclipse and above never match more than 3 tiers down; a Bronze player never faces Platinum or higher (a gap of 9 divisions).
- After 90 s with no match the client shows "No opponent right now" with **Keep waiting / Play CPU instead**. The queue does not silently stall.
- The same two players are not paired twice in a row, and at most 3 times per 24 h (win-trade guard).
- Skip pairing across a banned/blocked pair exactly as today. `find_match` keeps `for update skip locked`, so there are no double matches.
- Social queue code stays unchanged. The change is a branch inside one `create or replace function` with the same name, arguments and return, so older cached clients keep working.

## 8. Supabase backend (free plan, additive only)

One new migration, e.g. `2026xxxx_pokejam_ranked.sql`, idempotent (`if not exists`, `create or replace`), prefix `pokejam_`.

### 8.1 Tables and RPCs

Tables (all `enable row level security`, clients get SELECT only on their own rows, no client INSERT/UPDATE/DELETE policies):

- `pokejam_seasons(id, number, starts_at, length_weeks int not null default 6, ends_at timestamptz not null, status)`. `ends_at` is written by `pokejam_ranked_open_season` (section 6).
- `pokejam_ranked_profiles(user_id, season_id, status 'placing'|'ranked', div_idx, points, seed_score, placement_raw, placements_left, shield_charge, shield_losses, wins, losses, streak, peak_idx, leaves_24h, leave_window_start, cooldown_until, last_game_at, updated_at, pk(user_id, season_id))`. Index on `(season_id, status, div_idx desc, points desc)` for the leaderboard.
- `pokejam_ranked_matches(match_id pk references pokejam_matches, season_id, host_id, guest_id, winner, reason 'score'|'forfeit'|'leave'|'void', margin_share, host_before/after, guest_before/after, host_delta, guest_delta, created_at)`. The primary key on `match_id` makes scoring idempotent: a match can only be scored once.
- `pokejam_ranked_season_results(user_id, season_id, peak_idx, final_score, wins, losses)`.
- `pokejam_ranked_leaderboard_cache(season_id, built_at, rows jsonb)`: one row per season.

RPCs (all `security definer`, `set search_path = public`, `auth.uid()` checks, `revoke ... from public`, `grant execute to authenticated`):

- `pokejam_ranked_open_season(p_length_weeks int default 6)` is internal/admin. Creates the next season and sets `ends_at`.
- `pokejam_ranked_apply(p_match uuid)` is internal. It computes points **server-side** from the formula in section 3, locks both profile rows `for update` in a fixed (sorted id) order, applies placements, shield and Zenith rules, and writes `pokejam_ranked_matches` plus both profiles in one transaction. Clients never send points, only a result report.
- `pokejam_report_result` (replaced, same signature): keeps the current reconciliation. Both reports are required and must agree on `won` and on the score; a disagreement means `void`, no points, evidence kept and flagged for moderation. On `final` it calls `pokejam_ranked_apply` instead of `pokejam_apply_rank` for ranked matches.
- `pokejam_ranked_me()` returns my rank (or placement progress only), season number and days left, shield state and cooldown; `pokejam_ranked_match_result(p_match)` returns my before/after, delta and event (`promoted/demoted/shielded/placed/zenith`) for the post-match screen, with numbers withheld during placements.
- `pokejam_ranked_leaderboard(p_season int default null)` and `pokejam_ranked_my_position()` (section 8.3).
- `pokejam_ranked_forfeit(p_match)` and `pokejam_leave_match` changes (section 8.2).

### 8.2 1v1 leaver handling

Format: exactly two humans, so a leaver is unambiguous.

- **Definition:** a leaver is the player who calls leave / closes the tab (`leaveOnExit`) after tip-off, or whose game heartbeat (`20261106`) is stale for more than **45 s** with no result. Before tip-off (draft, connect), see "Dodge" below.
- **Reconnect window: 45 s.** If the player's heartbeat resumes within 45 s the match continues and nothing is penalised. A lag spike does not count against you.
- **Leaver result:** a **loss at the maximum loss cost** `L` for their tier (Ml fixed at 1.0, no `adj`, **no performance reduction**, the score is ignored). The rank shield is not spent and cannot block a demotion caused by a leave. In placements it counts as a loss with `w = 1.0`.
- **Remaining player:** a **win at the minimum gain** `round(0.8 * W)` (no performance bonus, because the game did not finish). They are never penalised, and their streak and shield state are unchanged. In placements it is a win with `w = 0.6`. The score at the moment of leaving makes no difference.
- **Both vanish:** `void`, nothing changes (existing behaviour of the game heartbeat).
- **Dodge (before tip-off):** leaving after a match is found, or not appearing in the draft in 30 s (draft presence, `20261105`), is a leave with a loss at max `L` for the dodger and **no change at all** for the other player, who is requeued without cooldown.
- **Repeat leavers:** `leaves_24h` counts leaves in a rolling 24 h window (`leave_window_start`). Queue cooldown after the leave: 1st = none (warning), 2nd = 5 min, 3rd = 15 min, 4th+ = 60 min plus an admin-panel flag. From the 3rd leave in a window, the loss cost is also x1.25 (still capped at the tier's `L * 1.25`). The counter decays after 24 h with no new leave.
- **Source of truth:** `pokejam_leave_match` for a ranked match after tip-off records `left_by = auth.uid()` and starts the 45 s clock instead of voiding the match; `pokejam_ranked_forfeit(p_match)` lets the stayer claim the win once the 45 s expires; a lazy sweep of stale ranked matches also runs in `pokejam_cleanup_maybe`. The leave RPC and `leaveOnExit` stay call-compatible, so cached clients keep working.
- **Evidence:** if the stayer's claim and the leaver's returning report conflict, the match goes to the existing evidence flag path and is `void` while pending.

### 8.3 Leaderboard (Top 100)

- **N = 100.** `pokejam_ranked_leaderboard(p_season int default null)` returns the top 100 (rank, name, tier, division, points, Zenith flag, season number), ordered by ladder score (`div_idx desc, points desc`, ties by earlier `updated_at`). Only players who finished placements and have at least 10 ranked games this season appear.
- Computed on request and cached for 60 s in `pokejam_ranked_leaderboard_cache`; a closed season's board is a frozen snapshot.
- `pokejam_ranked_my_position()` returns my numeric position so a player outside the top 100 sees "#412 of 3,100" instead of a blank. It is not cached per user; it uses the same index.
- **Placement in the UI:** a "Top 100" tab on the Season screen (opened from the rank chip in the main menu / online hub), a Zenith crest on entries from Zenith, and a "Your position" row pinned at the bottom of the list. Nothing is shown on the court or HUD.

### 8.4 Anti-abuse and footprint

- Human check (`pokejam_human_ok`), rate limits (`pokejam_rate_ok`, 60/min on find), bans and the evidence log all stay enforced.
- Win-trading: pair limit in section 7; moderation sees flags in the admin panel (extend admin stats with ranked counts, leaves and Zenith entrants).
- Free-plan footprint: about 200 bytes per match row and one profile row per player per season, so even 100k matches is well under the 500 MB DB limit. `pokejam_ranked_matches` is pruned after 2 seasons. No new Edge Functions, no Realtime channels beyond the existing netplay ones.

## 9. UI

Rules: nothing from Ranked is drawn over the court or HUD during play. No rank toasts, banners or overlays in a live game. Anything about rank is shown in menu screens or after the final whistle.

- **Rank badge chip** in the main menu / online hub header (tier icon, "Gold 2", points bar, shield icon, **season badge "S1"**), and next to the trainer name in the lobby and results. While placing it shows "Placement 2/5" and no tier or points. Zenith shows a crest and "Zenith 340".
- **Queue screen** (menu only): rank (or "Placement 2/5"), wait time, current search range text ("Searching nearby ranks..."), Cancel, and the 90 s fallback buttons.
- **Post-match points screen** (replaces the normal result panel for ranked after the final whistle): +/- points count-up, the division bar animating, shield icon states, and a reason line ("Opponent disconnected"). During placements it shows W/L and "3 more matches to your rank" with no numbers. One primary "Continue".
- **Rank-up / rank-down / placed animation:** badge flip with a short particle burst, 2 s, **Skip** button, `prefers-reduced-motion` honoured. It plays only on the post-match screen. The placed animation reveals the rank after match 5.
- **Season screen:** "Season 1 - N days left", peak tier, shield state, **Top 100 tab** with "Your position" pinned, plus an explainer of points per tier (the table above) including the win/loss min..max ranges. After a season ends, a "Season 1 final" card with your final rank and a prompt to place in Season 2.
- Layout targets, all checked with screenshots (the repo already has Playwright scripts, e.g. `scripts/e2e-social.mjs`):
  - **844x390 / 932x430 (landscape phone):** two-column, with badge and bar on the left and numbers/buttons on the right. No scrolling needed, heights from `clamp()`/`dvh`, safe-area insets. The leaderboard scrolls inside its own panel.
  - **390x844 (portrait):** single column, badge on top, buttons at the bottom within thumb reach.
- Reuse the existing menu CSS and the scoreboard-visible-on-small-screens fix (#54); add tier colours (including Prism, Eclipse, Zenith) as CSS variables. Gate with `MODE_RANKED`.

## 10. Build estimate (real Claude Code turnaround)

Wall-clock agent time, including test runs, screenshot passes and fix-ups, but not review waits.

| Phase | Work | Time |
|---|---|---|
| 0 | Pure TS `rank` module: tier tables, performance formula, `applyResult`, shield, placements, seed, Zenith, with unit tests; constants shared with SQL | 45-60 min |
| 1 | Migration part 1: tables, RLS, `open_season` (sets `ends_at`), `ranked_apply` (formula, shield, placements, Zenith), lazy rollover, SQL tests like `supabase/tests/*` | 100-130 min |
| 2 | Migration part 2: replaced `report_result`, ranked `leave_match`, forfeit/leaver penalties, cooldowns, `me` / `match_result`, matchmaking window branch and pair limits | 70-90 min |
| 3 | UI: chip with season badge and shield, queue, placement states, post-match, rank-up/placed animation, season screen; screenshots at the 3 sizes | 110-140 min |
| 4 | Leaderboard RPC, cache, Top 100 tab and position row, Season 1 -> 2 simulated rollover test, admin counters, trailer tier refresh | 50-70 min |
| 5 | Two-browser e2e (including a leaver case), `/code-review` pass, flag-gated deploy, smoke test | 60-75 min |

Total about **7.5-10.5 hours** of agent work (up from 5-7 h: performance formula, placements, shield recharge, Zenith, leaver handling and the leaderboard are new). Add review and approval time between PRs. Apply the migration by hand in the Supabase SQL editor, then flip `VITE_MODE_RANKED`.

### PR split (4 small PRs, each behind `MODE_RANKED`)

1. **Rank core + schema:** TS rank module with tests (phase 0) and the first migration: seasons, profiles, `open_season`, `ranked_apply`, rollover (phase 1).
2. **Report, leavers, matchmaking:** `report_result`, leave/forfeit/penalties, `me` / `match_result`, rank-window branch (phase 2).
3. **UI:** chip, season badge, queue, placement and post-match screens, animations, season screen without leaderboard (phase 3).
4. **Leaderboard + polish:** Top 100 RPC and tab, admin counters, trailer refresh, e2e and deploy (phases 4-5).

## Summary

1. **Formula:** `m = (W_score - L_score) / (W_score + L_score)` from the agreed final score only (no box stats are reported). `win = clamp(round(W * clamp(0.8 + 1.4m, 0.8, 1.5)) + adj, round(0.8W), round(1.5W))`; `loss = clamp(round(L * (1 - 0.4 * (1 - min(m, 0.25)/0.25))) - adj, round(0.6L), L)`; `adj = clamp(opp_idx - my_idx, -3, +3)`.
2. **Tier ranges (win min..max / loss min..max):** Bronze 24..45 / 11..19, Silver 22..41 / 11..19, Gold 20..38 / 11..19, Platinum 19..36 / 12..20, Diamond 18..35 / 12..20, Prism 18..33 / 13..21, Eclipse 17..32 / 13..21, Pokémon Master and Zenith 16..30 / 13..22.
3. **Rank shield:** one charge blocks one demotion, Gold and below only, recharges after **N = 3** losses; leaver losses are not shielded; Bronze 3 floor stays. The old 3 tier-entry shield games are removed.
4. **Placements and seeding:** 5 hidden-point placement matches per season; shift = `clamp(round(20 * Σ ±w_i), -100, +100)`; `seed = clamp(last_final_score - 600, 0, 1400)`; new players seed Bronze 3 0 pts. This replaces the fixed -6 division / Platinum 1 cap reset.
5. **Top tier:** **Zenith**, points-only above Pokémon Master 1, entered at 100 points on promotion from PM 1, out below 0, 7-day inactivity decay. Leaderboard **Top 100** by ladder score, via `pokejam_ranked_leaderboard` + `my_position`, in a Top 100 tab on the Season screen.
6. **Seasons:** Season 1 launches at 6 weeks (`length_weeks` default 6, configurable); `ends_at` is set in `pokejam_ranked_open_season` (a generated column would fail because timestamptz + interval is not immutable); season number badge "S1" on the chip and Season screen; Season 2 starts by placements.
7. **Online format:** **1v1** (host and guest, one team each). Leaver = max-cost loss with no performance reduction, 45 s reconnect, stayer wins at min gain (or no change if before tip-off), repeat leavers get 0/5/15/60 min cooldowns and x1.25 loss cost from the 3rd.
8. **Estimate and PRs:** about **7.5-10.5 h** of agent work in 6 phases, shipped as **4 PRs** (rank core + schema, report/leavers/matchmaking, UI, leaderboard + polish), `NET_VERSION` stays 3.
