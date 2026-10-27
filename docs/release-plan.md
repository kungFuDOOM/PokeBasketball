# PokeJam multiplayer release plan

Each mode ships separately behind its own build flag (`src/config/features.ts`). Flags default OFF; a mode is in the build only when its env var is exactly `"true"`.

| Mode | Flag | Code |
|---|---|---|
| Social | `VITE_MODE_SOCIAL` | `src/multiplayer/social/` |
| Ranked | `VITE_MODE_RANKED` | `src/multiplayer/ranked/` |
| Pack Battles | `VITE_MODE_PACK_BATTLES` | `src/multiplayer/packBattles/` |

The shared code (`MatchService`, match flow, types) is in `src/multiplayer/shared/`. No mode imports another mode.

The private test site (Vercel `pokejam-test`, behind Vercel Authentication) has all three flags ON. The public PokeBasketball repo, its Pages site and **pokejam.xyz** get nothing until **kungFuDOOM says "Merge" for that stage**. Even then, only that stage's flag is turned on.

## Stage 1: Social, to a small group of test users
- Real online play through the server `MatchService` (quick match plus "Play a friend" room code), with the "Play CPU instead" fallback.
- Accounts are set up (anonymous sign-in enabled on the Supabase project), and the RLS and security checks pass.
- Two-client end-to-end test passes. All unit tests, typecheck and build pass.
- Social results never touch ratings, enforced by both a test and the server.
- Testers get access, either through Vercel team access on the test site or an invite list.
- kungFuDOOM plays it and OKs it, then says "Merge" for Social.

Status (kfd/social): done except the boxes below.
- [x] Server MatchService, Quick match, Play a friend, CPU fallback. Netcode: lockstep with adaptive input delay (docs/multiplayer.md).
- [x] RLS and security checks pass (scripts/e2e-social.mjs). Social-never-rated is covered by a unit test, the server and the e2e.
- [x] Two-client e2e passes against the real project. Unit tests, typecheck and build pass.
- [x] Anti-griefing (`20261025_pokejam_social_guard.sql`): server-picked seed and rosters, name filter, rate limits, reports, blocks, bans, private match channels. 12 PGlite tests.
- [x] Launch hardening (#17): untrusted-peer netcode, TURN-relayed direct link, `NET_VERSION`. Turnstile before matchmaking (#22). Signed evidence for rated matches (#23).
- [x] Quick draft before every online Social match (#28): server-run snake draft, 12 s picks, random pick on timeout. 5 PGlite tests and 5 unit tests.
- [ ] Apply migrations `20261025` through `20261029`, set up TURN (`pokejam-ice`) and Turnstile (`pokejam-human`, `require_human`). The full list is in `docs/launch-readiness.md`.
- [ ] Rerun `scripts/e2e-social.mjs` against the real project (`E2E_CREDS` test accounts if Turnstile is on), then a load test.
- [ ] Anonymous sign-in on the Supabase project. This needs the dashboard toggle; the e2e ran with two temporary password test accounts, which were then deleted.
- [ ] Vercel env vars on `pokejam-test`: `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` (the publishable key).
- [ ] Testers get access.
- [ ] kungFuDOOM plays and says "Merge".

## Stage 2: Ranked
- Teams are random but **evenly matched** (#29): from the match seed, each five is rerolled until its best and worst starters are within `RANKED_MAX_SPREAD` (25 OVR) so neither is top-heavy, the pair is rerolled until their total OVR is within `RANKED_MAX_GAP` (3), then sides are flipped at random. Both caps sit together in `src/multiplayer/shared/roster.ts`. The cap means the six weakest Pokémon (Magikarp 25, and Sentret, Cleffa, Igglybuff, Sunkern and Wooper at 41–44) can't appear in Ranked. The legendaries too strong to balance (Mewtwo, Lugia, Ho-Oh, Mew, Rayquaza, Groudon, Kyogre, Latios, Latias) sit out of Ranked: `RANKED_EXCLUDED` in `src/multiplayer/shared/roster.ts`. The judge must rebuild a Ranked setup's rosters from the server seed (`rostersFor(seed, 'ranked')`) rather than trust an uploaded one.
- Ratings change only server-side: the SECURITY DEFINER RPC applies the rank.ts rules after both reports agree or a host report passes the sanity check. A direct client write is shown to be rejected.
- The SQL port of rank.ts matches the TS rules (parity test).
- The result is verified, either by replaying the match or by both players reporting the same result.
- Placements, promotion, demotion protection and Pokémon Master have been tried with real players.
- Final rank badge art is in (from the image generator).
- kungFuDOOM OKs it, then says "Merge" for Ranked.

## Stage 3: Pack Battles
- Follows the plan in pokejam-test issue 4 (thepaypay420), and needs an OK from both kungFuDOOM and thepaypay420.
- Devnet only until both humans decide on real money and regions.
- The deterministic engine and the replay-based winner check are in and tested.
- The pull, pot and delivery logic is reviewed. Nothing real is bought.
- kungFuDOOM OKs it, then says "Merge" for Pack Battles.

## Existing work to build on
- **`kfd/online` branch** (handoff, not merged) has `docs/multiplayer-handoff.md` and the Supabase migration.
- **Supabase project gauntlet-legends** (ref `ruxbufynuzmversxmptw`, shared, free tier) holds:
  - Tables `pokejam_profiles`, `pokejam_queue` and `pokejam_matches`, all with RLS.
  - The `pokejam_*` RPCs.
  - Anonymous sign-ins are still disabled.
  - The leftover test rows from the handoff doc are gone (0 users, profiles, matches).
