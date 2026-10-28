# Multiplayer handoff (to thepaypay420)

> **Update (Stage 1, kfd/social):** the leftover test rows below were removed (the project has 0 users, profiles and matches). Migration `pokejam_social` (supabase/migrations/20261022_pokejam_social.sql) was applied on top. See docs/multiplayer.md, "Stage 1".

## On `main` (phase 1, PR #3, commit eb4594f)
- `src/multiplayer/rank.ts`: pure ladder rules.
  - Hidden Elo MMR, start 1000.
  - K = 64 for 5 placement games, K = 24 afterwards.
  - "Unranked, placements X/5" until placed.
  - Ladder MMR thresholds:

    | Tier | MMR |
    |---|---|
    | Bronze (floor) | 700 |
    | Silver | 1000 |
    | Gold | 1300 |
    | Platinum | 1600 |
    | Diamond | 1900 |
    | Pokémon Master | 2200+ |

  - Bronze through Diamond have divisions III/II/I, 100 MMR each. RP is 0–99 within a division.
  - Pokémon Master has no divisions; its RP is the points above 2200.
  - Demotion shield: 2 losses held at 0 RP, the 3rd demotes, and a win resets it.
  - `TIER_COLORS` holds placeholder text/colour badges. Final art will come from the image generator.
- `src/multiplayer/matchService.ts`:
  - The `MatchService` interface: `getRank`, `findMatch(queue)`, `reportResult(queue, opp, result)`.
  - `LocalMockMatchService`: simulated opponent within ±75 MMR. Ranked results persist in localStorage key **`pokejam.rank`**; Social never changes rank.
- `src/screens/packBattles.ts`: the multiplayer hub, opened from the title button "MULTIPLAYER (TEST)".
  - Social offers a quick match; "Play a friend" is a disabled placeholder.
  - Ranked shows the rank badge and a find-match button.
  - Matches play vs the CPU with random 5-mon rosters, or use "Sim result (test)" to resolve instantly.
  - The results screen shows rank changes and promotion messages.
- Tests: vitest, `npm test`. 21 tests in `rank.test.ts` and `matchService.test.ts`.
- Design notes: `docs/multiplayer.md`.

## In progress on `kfd/online` (unfinished, not merged)
- `supabase/migrations/20261021_pokejam_online.sql` is exactly what was applied to the shared DB (below).
- **Not started:** `SupabaseMatchService`, `@supabase/supabase-js`, Realtime host/guest sync, and the room-code UI. No client code changes are on this branch.
- Sync plan, from reading the engine:
  - `Game` only supports one human (team 0, `userInput`). Add a `remote` player plus `remoteInput` for team 1.
  - In `update()`: `p.intent = p.human ? userIntent : p === remote ? remoteInput : think(...)`.
  - Treat `remote` like human for shot release (`release = p.human ? !it.shootHeld : ...`).
  - Set `away.human = true` online, which disables the CPU difficulty boost.
  - The guest builds a `Game` from the same cfg (host sends rosters by dex). It overwrites player/ball/score/clock fields from 15–20 Hz snapshots, interpolates, and calls `renderer.draw`. It sends `Intent` back.

## Supabase changes in the SHARED gauntlet-legends project (ref `ruxbufynuzmversxmptw`)
Gauntlet's existing tables, functions and policies were listed and left untouched:
- Tables: `leaderboard_all_time`, `leaderboard_weekly`, `harambe_scores`, `scores`, `harambe_wallets`, `gauntlet_scores`.
- Functions: `max_plausible_score`, `delete_score`, `hide_score`, `submit_score`, `top_scores`, `set_wallet`, `top_gauntlet_scores`, `submit_gauntlet_score`.
- Policy: `scores: public can read visible scores`.

Migration applied: **`pokejam_online`** (one earlier attempt failed with a syntax error and applied nothing). It created:
- **Tables:** `public.pokejam_profiles`, `public.pokejam_queue`, `public.pokejam_matches`.
  - RLS is enabled on all three.
  - Indexes `pokejam_matches_host_idx` and `pokejam_matches_guest_idx`.
  - All privileges revoked from anon/authenticated/public, then `SELECT` granted to authenticated.
- **Policies:**
  - `pokejam profiles readable by signed-in players` (profiles, select, authenticated).
  - `pokejam own queue row` (queue, select own).
  - `pokejam match participants` (matches, select if host or guest).
- **Functions** (SECURITY DEFINER, `search_path=public`):
  - Internal, no grants: `pokejam_rank_view(int,int)` and `pokejam_apply_rank(uuid,int,boolean)`, the SQL port of rank.ts.
  - Execute granted to authenticated only:
    - `pokejam_ensure_profile(text)`
    - `pokejam_find_match(text)`: pairs by closest MMR; the window is 100 + 25/sec waited, max 1000.
    - `pokejam_leave_queue()`
    - `pokejam_create_room()` and `pokejam_join_room(text)`: 6-char social codes.
    - `pokejam_report_result(uuid, boolean host_won)`: rank applies only when both reports agree; host-only after 120s; disagreement voids the match; social never ranks.
    - `pokejam_match_status(uuid)`
- **Test data left behind** (no cleanup was allowed after the stop order):
  - 2 rows in `auth.users`: ids `00000000-0000-4000-8000-00000000a001` and `…a002`.
  - Their `pokejam_profiles` rows: "E2E Host" and "E2E Guest".
  - 1 `pokejam_matches` row `19bc0e3a-3351-4daf-86ad-64cbe3d36b0b` (ranked, host a001 / guest a002).
  - A security-check script was interrupted mid-call. It may have recorded a guest/host report on that match; if both ran, ratings were applied to the two test profiles.
  - To clean up, delete the two auth.users rows; the cascade removes the profiles, queue and match.
- **Auth settings:** NOT changed. Anonymous sign-ins are **disabled** on this project (`anonymous_provider_disabled`).
  - Gauntlet has 0 auth users, so enabling them shouldn't affect Gauntlet.
  - Turn it on in Dashboard → Authentication → Sign In / Providers → Allow anonymous sign-ins.
- Verified so far: two players queue and pair through the RPCs into a ranked match.
- **Not verified:** direct-update rejection and the report/rating flow.
  - Expected result: `UPDATE pokejam_profiles` as authenticated is denied, because there is no UPDATE grant or policy.

## Vercel (`pokejam-test`)
- **No env vars set.** Set `VITE_SUPABASE_URL` = `https://ruxbufynuzmversxmptw.supabase.co` and `VITE_SUPABASE_ANON_KEY` = the project's publishable key (public by design). Never commit the service-role key.
- The project is protected by Vercel Authentication on all deployments. Other devs need to be added to the Vercel team to open it.

## Next steps / gotchas
1. Enable anonymous sign-in (see above), then run a two-client node E2E. Also re-run the security checks and clean up the test rows.
2. Write `SupabaseMatchService`:
   - `findMatch` polls `pokejam_find_match` every ~2s.
   - After ~30s with no opponent, offer "Play CPU instead", which uses `LocalMockMatchService`.
3. Realtime: use broadcast channel `pokejam:match:<matchId>`. Match ids are unguessable, but consider private channels plus `realtime.messages` RLS.
4. Keep the rank constants in `rank.ts` and the SQL in sync. Add a parity test.
5. `PLACING` is a reserved word in Postgres, so don't use it as a plpgsql variable name.
6. The shared DB is free tier: everything must stay `pokejam_`-prefixed, and nothing of Gauntlet's may be touched.
