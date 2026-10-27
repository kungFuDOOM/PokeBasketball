# Multiplayer (test build) — design

## Phase 1 (this branch)
- **Hub** (title screen → MULTIPLAYER (TEST)): **Social** (casual, unranked quick match; friend invites come in phase 2) and **Ranked**.
- **`src/multiplayer/rank.ts`** — pure, unit-tested ladder:
  - Hidden MMR, Elo update, start 1000. K = 64 for the 5 placement games, 24 afterwards.
  - "Unranked, placements X/5" until 5 games; the visible ladder is then seeded from MMR.
  - Tiers by ladder MMR: Bronze <1000, Silver 1000, Gold 1300, Platinum 1600, Diamond 1900 (each 300 wide, divisions III/II/I of 100), Pokémon Master 2200+ (no divisions, RP = points above 2200). Ladder floor 700.
  - RP = position inside the division (0–99). Wins/losses move RP by the Elo delta; crossing a line promotes/demotes.
  - Demotion protection: at 0 RP of a division, the first 2 losses hold you there; the 3rd demotes. Any win resets it.
- **`src/multiplayer/matchService.ts`** — `MatchService` interface (`getRank`, `findMatch`, `reportResult`).
  `LocalMockMatchService` finds a simulated opponent within ±75 MMR, the game is played vs the CPU (difficulty scales with opponent MMR), or a test-only "Sim result" button resolves instantly. Ranked results are stored in `localStorage` (`pokejam.rank`); Social never changes rank.
- Rank badges are plain text + tier colour. **Final badge art will come from the image generator.**

## Phase 2 plan (real online play)
- **Supabase** (free tier): Auth accounts; tables `profiles`, `ranks`, `matches`; RLS on, client writes only through RPCs.
- **Matchmaking**: queue table + RPC/Edge Function pairing nearby MMR (widening window over time).
- **Match sync**: Supabase Realtime channels per match (host-authoritative sim, inputs/state broadcast).
- **Anti-cheat**: results and MMR updates are applied only server-side (Edge Function or `security definer` RPC running the same `rank.ts` logic), with both clients reporting and mismatches flagged — clients can never write their own rank.
- Swap `LocalMockMatchService` for `SupabaseMatchService`; UI is unchanged.
- **Before creating anything:** this would be a second Supabase project. The Free plan allows 2 active projects per organization and Botbook already uses one (Harambe's games project may also count) — verify the limit first; do not create a project or upgrade without approval.

## Open decisions
- Netcode model (host-authoritative vs lockstep) and latency tolerance for an arcade game.
- Draft format online (snake draft vs. pick from your own collection — ties into Pack Battles).
- Season length / rank resets; whether Pokémon Master gets a leaderboard.
- Friend invites: room codes vs. accounts/friends list.
- Which Supabase project hosts it (new free project vs. reusing an existing one).

## Stage 1: Social online play (`kfd/social`)

### Flow
- **Social** (flag `VITE_MODE_SOCIAL`): Quick match, Play a friend (6-character room code) and Play CPU.
  - Quick match polls `pokejam_find_match('social')` every 2 s. After 15 s with nobody around it offers **Play CPU instead** (the old simulated flow) and keeps searching until you pick.
  - Play a friend: the host makes a room (`pokejam_create_room`) and waits (`pokejam_room_match`), and the friend types the code (`pokejam_join_room`). Cancelling closes the room (`pokejam_close_room`).
  - If the build has no Supabase config, or sign-in fails, Social offers the CPU game instead.
  - **Quick draft (#28, migration `20261101_pokejam_social_draft.sql`):** every online Social match (Quick match and Play a friend) starts with a draft. The server runs it, so no client can invent a roster:
    - The pool is 6 random Pokémon per position from `pokejam_mons`. That table holds every Pokémon's dex and position, and a test keeps it equal to `src/data/pokemon.ts`.
    - A coin flip on the server picks who goes first. Picks run in snake order A B B A A B B A A B, one Pokémon per position, five each, with no duplicates.
    - Each pick gets 12 s (15 s for the first). When time runs out, the server makes a random legal pick. Picks are settled on every call (`pokejam_draft_state`, `pokejam_draft_pick`), so no timer job is needed. If both players go missing, the overdue picks are all made at once.
    - **Disconnects:** a player who drops just gets random picks. If the other player hasn't checked in for 25 s, the draft is called off and the match closed, with no result.
    - When the draft is done, `pokejam_match_info` returns `host_roster` and `guest_roster`. `setupFor` builds the game from them, so host, guest and the winner check play the same teams. Ranked and Pack Battles have no draft.
    - The UI is `src/multiplayer/social/draftScreen.ts`, and the shared rules are in `src/multiplayer/shared/draft.ts`.
- **Accounts:** Supabase anonymous sign-in, kept on the device (`localStorage` key `pokejam.auth`). The trainer name is the team name from settings, cleaned by the server (`pokejam_ensure_profile`; see Anti-griefing). With `VITE_TURNSTILE_SITE_KEY` set, a Cloudflare Turnstile bot check runs before a first anonymous sign-in.
- **Code:** `src/multiplayer/shared/` holds `onlineMatchService.ts` (`SupabaseMatchService`), `lockstep.ts`, `netplay.ts` (channel + handshake), `onlineGame.ts` (the match screen) and `supabase.ts`. The Social UI is in `src/multiplayer/social/index.ts`. The only engine-side change is an optional `online` driver in `src/screens/play.ts`; `src/game/` is untouched.

### Netcode: deterministic lockstep with input delay
- Both players run the full simulation (engine v3: the live game's odds, every roll on the match seed, fixed 60 Hz tick, `src/game/sync.ts`). Only inputs cross the wire, over the private Supabase Realtime broadcast channel `pokejam:match:<match id>`.
- Each side schedules its own input `delay` ticks ahead (start 8 ticks ≈ 133 ms) and sends it. Tick *t* runs only when both inputs for *t* are in, so both copies step through identical inputs. A late input makes the game wait, and a "Waiting for …" banner appears after 0.4 s.
- Inputs go out in run-length-encoded batches about 15 times a second. Each batch repeats everything the peer hasn't acknowledged, so a lost or reordered message can't drop an input.
- **Adaptive delay:** once a second each side tells the other how early its inputs arrive. The sender adds delay when they arrive late and trims it when there's slack (range 4–18 ticks). On the two-browser test against Supabase it settled at 8–13 ticks (≈130–220 ms).
- **Desync guard:** every 60 ticks both sides swap a state hash. On a mismatch, for example when browsers' floating point differs in the last bit, the host sends a full snapshot. The guest restores it and replays its stored inputs, so the host is the authority.
- **The game comes from the server.** The match row holds a server-picked seed and quarter length; both clients derive both rosters from the seed (`rostersFor` in `roster.ts`) and take names from the server, so neither player can stack the game.
- **Handshake:** both sides send `hi` with `ENGINE_VERSION` until they hear each other; a version mismatch stops with "refresh to update".
- Online games never pause. The menu opens over a running game, and hiding the tab doesn't pause it. Quitting sends `bye`. After 15 s of silence the game ends with "connection lost", the match is voided, and no result is recorded.
- Online games use fixed rules: Pro difficulty with no CPU assists (both teams human), and quarters of at most 2 minutes. The host's court and name are the home side.
- **Why lockstep:** the engine is deterministic and inputs are tiny, which keeps the message count low. A replay of the inputs gives the same game, which is what the Pack Battles winner check needs. Host-authoritative snapshots would cost far more Realtime messages.

### Results
- When the game ends, both players call `pokejam_report_result(match, host_won)`. The match is `done` when the two reports agree and `void` when they don't.
- **Social never touches ratings**, enforced in three places:
  - **Client:** the Social `SupabaseMatchService` is built with `queues = ['social']`. It refuses `ranked` and never returns a rank (`onlineMatchService.test.ts`).
  - **Server:** `pokejam_report_result` calls `pokejam_apply_rank` only for `queue = 'ranked'`, and `pokejam_apply_rank` has no client grant. Room-code matches are forced to Social by a CHECK constraint. Quick match only returns a pairing from the queue being searched.
  - **E2E:** `scripts/e2e-social.mjs` checks that both profiles' mmr, ladder, placements, wins and losses are unchanged after two Social games.

### Ranked online
- With `VITE_SUPABASE_*` set, Ranked uses a `SupabaseMatchService` with `queues = ['ranked']`: same anonymous sign-in, Turnstile and `pokejam-human` pass as Social. No migration is needed beyond the existing ones.
- **The rating is never computed or trusted on the client.** Both players report the host's result; the server rates the match in `pokejam_report_result` (when the two reports agree) via `pokejam_apply_rank`. The client then reads its own profile (`pokejam_ensure_profile` with no name) and shows the server's tier, division, RP and placements. The result screen's MMR change is the difference between the server profile read before the match and after it (`ranked/serverRank.ts`).
- If the other player hasn't reported yet, the result screen says so and polls `pokejam_match_status` for up to 30 s, then fills in the rating change. A disagreement voids the match with no rating change.
- No opponent after 30 s: a "Practice vs CPU (unranked)" button appears. It uses a `LocalMockMatchService` with no rating store, so it changes neither the server rating nor the local one.
- Without `VITE_SUPABASE_*`, Ranked keeps the local mock (CPU opponent, rating in localStorage `pokejam.rank`).

### Limits to know (Supabase free tier, shared project)
- **Realtime limits:** 100 messages/s and 2 M messages/month, project-wide. A sent message and its delivery both count.
  - **The direct link (default when TURN is set up).** Gameplay runs over a WebRTC data channel relayed by Cloudflare TURN (`rtc.ts`, relay-only, so players never see each other's IP addresses). Realtime carries only the handshake and signalling, about 40 billed messages per game. The browser check (`scripts/rtc-check.mjs`) measured 2 Realtime messages before the link opened.
  - **Fallback (no TURN, or the link fails or drops).** The game continues on Realtime at 10 batches a second, with the state hash riding inside the input batch. That's about 40 billed messages/s and 22k per game with 2-minute quarters, so Free fits only about 2 fallback games at once and Pro about 12.
  - TURN credentials come from the `pokejam-ice` Edge Function: one hour, only for the two players in an active match, 6 per 10 minutes. A game is a few MB of relay traffic, and Cloudflare includes 1,000 GB a month.
  - Peak connections (Free 200, Pro 500) cap concurrent matches at about 100 (Free) or 250 (Pro). Each player in a match holds one Realtime connection.
- **Netcode version:** the handshake carries `NET_VERSION` along with `ENGINE_VERSION`. A tab on an older build can't play a newer one; it's told to refresh.
- **Untrusted peer:** `Lockstep.receive` checks everything. Malformed messages, inputs outside the plausible tick window, oversized runs, sticks outside -1..1, bad buttons and floods over 80 messages a second are all dropped. A snapshot must match the game's own shape (no extra keys, no `__proto__`, the same players). The guest takes at most one resync every 1.5 s and 12 per game; past that, `problem` ends the game with no result.
- Channels are private: RLS on `realtime.messages` lets only the match's two players read or send on its topic, while the match is active (`pokejam_channel_ok`).

## Anti-griefing (migration `20261025_pokejam_social_guard.sql`)

- **Names.** The server keeps letters (accented too), digits, spaces and `. - _ ' !`, 1–20 characters, with invisible and direction-flipping characters removed. Slurs (including leetspeak and stretched letters), and names impersonating staff, the game or its partners become "Trainer". Renaming is limited to 6 an hour.
- **Rate limits.** Matchmaking 60 requests a minute, rooms 10 per 10 minutes, room codes 15 tries per 10 minutes (wrong codes count, so codes can't be guessed), reports 20 a day.
- **Reports and blocks.** After a match (or when it ends early), "Report or block" reports the opponent (name, cheating, quitting, other; one per match) or blocks them. Blocked pairs are never matched, and a blocked player can't join the blocker's room.
- **Bans.** `pokejam_ban(user, hours, reason)` / `pokejam_unban(user)` (service role). A player reported by 5 different opponents in 24 hours is suspended for 24 hours automatically, for a person to review (`pokejam_reports`, `pokejam_bans`).
- **Still open:** a modified host client can still push a fake state to the guest through a resync snapshot. That's harmless for Social (no ratings), but Ranked and Pack Battles must judge from the signed inputs (`winnerCheck.ts`).

### Running the two-browser end-to-end test
```
VITE_MODE_SOCIAL=true VITE_SUPABASE_URL=… VITE_SUPABASE_ANON_KEY=… npx vite --port 5173 &
VITE_SUPABASE_URL=… VITE_SUPABASE_ANON_KEY=… node scripts/e2e-social.mjs
```
- The script uses two separate headless Chrome instances.
- It plays one game through a room code and one through quick match, with 6-second quarters (`?ql=6` works in dev builds only).
- It checks that both finish with the same state hash and score, that the server's winner matches, that ratings are unchanged, and that RLS and grant rejections hold. It also checks that the CPU fallback shows up.
- It needs anonymous sign-in to be on. Until then, `E2E_CREDS` can point at two password test accounts.

## Pack Battles winner check (what the sync has to record)
Before a prize moves, the result comes from replaying the match's inputs, not from either player's report. The judge is `src/multiplayer/shared/winnerCheck.ts` (it runs in the browser and in an Edge Function). It only needs the online sync to keep and sign a little extra:

1. **Setup, fixed before tip-off:** a `MatchSetup` (match id, `ENGINE_VERSION`, seed, quarter length, both rosters by dex). Host and guest both build their `Game` with `gameConfigFor(setup)`.
2. **A key per player per match:** `matchKey()` makes an Ed25519 key; each player registers the public half (hex) on the match row before tip-off.
3. **Signed inputs.** This depends on the sync:
   - **Lockstep (`shared/lockstep.ts`, what Social ships with):** each `'in'` message's inputs (tick `s` onward, runs expanded) are also signed with `signTicks(key, matchId, side, s, inputs)`. Each player keeps every signed batch it sent and every one it received. Resends overlap, and that's fine. Evidence sets `lockstep: { emptyTicks: MIN_DELAY }` and needs no applied log, because tick t always uses both sides' input for tick t.
   - **Host-authoritative (if a mode ever uses it):** each player numbers its own frames 1, 2, 3…, signs batches with `signInputs`, and the host broadcasts an applied log (`[hostSeq, guestSeq]` per tick, 0 = none yet) signed with `signApplied`. `inputForTick(frames, seq, prevSeq)` turns a frame into that tick's input: a frame that stays applied keeps its stick and held buttons, but its presses only count on its first tick.
4. **After the game:** each player uploads everything signed it holds (an `Evidence`). `judge()` merges it and replays it.

**Wired into online play** (`shared/evidence.ts`, migration `20261028_pokejam_match_evidence.sql`):
- **Tip-off:** while the players find each other, each one makes its key, registers it with `pokejam_register_key` (once; it can never be changed), and waits until both keys show in `pokejam_match_info`.
- **During the game:** `MatchLink` signs every outgoing `'in'` batch (the signature rides in `g`) and keeps the other player's signed batches as they arrive.
- **After the game:** each player uploads once, whether the game finished or someone left, with `pokejam_submit_evidence`. The upload is gzipped and trimmed to the batches that cover every tick, keeping any that contradict each other. A full game with 2-minute quarters is about 0.5 MB per player.
- **The judge's game is the one played:** host, guest and judge all build it from `gameConfigFor(setupFor(match))`. Online games therefore use the judge's even settings (All-Star difficulty, auto-switch on).
- **Rated and paid matches only:** Social never signs or uploads, and the server refuses Social uploads. Uploads are kept 30 days (`pokejam_prune_evidence`, daily via pg_cron where it's on), which is long enough to judge and review a dispute.
- **Older setups degrade gracefully:** a browser without Ed25519, or a database without the migration, plays on without evidence. That's fine for Social; Ranked and Pack Battles must require it.
- **Still to build:** the judge as an Edge Function that reads `pokejam_match_evidence` and calls `judge()`.

What the judge rules:
- **`final`:** the replay reached the buzzer; `winner` comes from the replay.
- **`incomplete`:** the log stops early (someone left or went silent); the score is where it stopped, and the mode's forfeit rule applies.
- **`forfeit`:** a player signed two different versions of the same frame or tick, which is proof they rewrote history after the fact. That player loses.
- **`invalid`:** the evidence can't be judged (wrong engine version, a frame nobody signed, a log that goes backwards, bad keys or setup). Nothing moves.

Why this holds up:
- Nobody can invent the other player's moves, because they don't have the other player's key.
- Nobody can rewrite their own moves (or, as host, the applied log) after the game, because the other player holds the originals: two signed versions is a forfeit.
- A player who goes silent is judged on the other player's evidence. A loser has nothing to gain by not uploading.
