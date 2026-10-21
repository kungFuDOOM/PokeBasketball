# Pack Battles: build spec and handoff

This is the complete spec for finishing and launching Pack Battles. It's written so a coding agent can take it from here without other context. It covers what the feature is, how it's built, what's already done and tested, what's still unconfirmed about Collector Crypt's live API, and the remaining tasks in order, each with how to know it's done.

If you have this file, you have the repo: everything below refers to files in it. Run `cd server && bun install && bun test` first; all 26 tests should pass.

**Getting the code.** The work is five commits on a branch named `pack-battles`, based on `kungFuDOOM/PokeBasketball` branch `claude/poke-jam` at commit `d3c9f69` ("Buzzer beaters"). If it isn't pushed yet, apply the patch:

```sh
git checkout claude/poke-jam && git pull
git checkout -b pack-battles
git am pack-battles.patch          # five commits; or: git pull pack-battles.bundle pack-battles
npm install && npm run build       # client
cd server && bun install && bun test
```

---

## 1. The feature

Two players split the cost of one Collector Crypt (CC) gacha pull and play one game of Poké Jam for it.

1. **Sign in.** The player connects a Solana wallet (Phantom, Solflare, Backpack) and signs a one-time message. This is free and sends no transaction. They confirm they're 18+ and their state.
2. **Deposit.** They send USDC from that same wallet to the house USDC account, and the server credits their balance.
3. **Post or accept.** Each side pays half the machine price into escrow:
   - $12.50 each for the $25 Starter machine (`pokemon_25`)
   - $25 each for the $50 Elite machine (`pokemon_50`)
   - $50 each for the $100 Bronze machine (`pokemon_100`)
4. **Draft.** A live snake draft, five Pokémon each, with a 20-second pick clock; a missed clock auto-picks.
5. **Pull first.** The house wallet buys and opens the pull with the two entries. CC's VRF picks the card into the house wallet, and **both players see the exact card before tip-off.**
6. **Play.** One online game in lockstep. The server runs its own copy and decides the winner.
7. **Deliver.** The card (a Metaplex Core NFT) is transferred from the house wallet to the winner.
8. **Prove.** The proof is published at `/api/battles/:id/proof`. `bun verify.ts <id>` checks every seed, the CC VRF record, the draft and a full replay.

Leaving forfeits after a grace period. If nobody shows up, both players leave, or the server restarts mid-game, both players are refunded. If the card was already bought, it stays with the house and can be sold back to CC within 72 hours (admin API).

## 2. Fairness design (keep it this way)

| Random thing | Decided by | Can anyone bias it? | How it's checked |
| --- | --- | --- | --- |
| Which card the pot buys | Collector Crypt's VRF (RFC 9381 ECVRF-EDWARDS25519-SHA512-TAI over the house's payment signature). Committed on-chain by program `ccvrfu3fSpbnPLiUqdWAt85Zn9nq96ekwGTbHqGtdgQ`. | No. The house can't predict the VRF output (CC holds the key), and CC has no stake in the battle. | CC's `/verify-selection/<memo>` page, `GET /api/vrf/verify?memo=`, and the on-chain commit ([docs](https://docs.collectorcrypt.com/gacha/vrf)) |
| Who picks first in the draft | Lowest bit of `sha256("pokejam-draft-v1:" + serverSeed + ":" + hostSeed + ":" + guestSeed + ":" + battleId)[0]` | No. The server commits `sha256(serverSeed)` at create, before either player's seed exists. | `verify.ts` |
| Every random roll in the game | `seed` = first 4 bytes (big-endian) of `sha256("pokejam-seed-v2:" + serverSeed + ":" + hostSeed + ":" + guestSeed + ":" + battleId + ":" + vrfEntropy)`, where `vrfEntropy` is CC's 64-byte VRF output (beta, hex) for this battle's pull | No. Nobody knows `vrfEntropy` until the pull is paid and opened, after the draft. | `verify.ts` recomputes it and replays every tick |
| The game itself | The engine is deterministic: seeded RNG, fixed 1/60 s tick, and only stick and button inputs from players. The server's copy is authoritative. | No. Clients only send input, and results come from the server's copy. | `verify.ts` replays the published inputs |

Code: `server/battles.ts` (`deriveSeed`, `firstPick`, `recordPull`), `server/match.ts` (`buyPull`), `server/verify.ts`, `src/game/sync.ts`.

## 3. Architecture

```
src/game/          engine (shared by browser and server): game.ts (seeded via game.rng; a human per team;
                   viewTeam is display-only), sync.ts (input packing, TICK, stateHash, snapshot/restore)
src/net/           protocol.ts (all message and view types), lockstep.ts (client copy of the game),
                   match.ts (match config shared by both sides), http.ts (HttpBackend), wallet.ts, bytes.ts
src/battles/       service.ts (tiers = CC machines, PackSource/Pull types), backend.ts, local.ts (offline preview)
src/screens/       battles.ts (lobby, wallet, deposit, withdraw, create/accept, prizes),
                   online.ts (waiting room, live draft, buying, card reveal, online game, results)
src/ui/pack.ts     pack art and the graded-slab card component
server/            Bun + SQLite, no runtime packages:
  app.ts           HTTP + WebSocket routes (REST under /api, live match at /ws)
  auth.ts          wallet sign-in (Ed25519 over a nonce message), sessions
  db.ts            schema; ledger (integer USDC base units, UNIQUE(kind, ref) = idempotent)
  deposits.ts      scans the house USDC account and credits transfers by sender wallet
  battles.ts       lifecycle, escrow, eligibility, seeds, pull recording, void/finish
  match.ts         rooms: draft -> buy pull -> reveal -> lockstep game -> result; forfeits; reconnects
  collector-crypt.ts  CC Gacha Machine API: buy (generatePack -> sign -> submit -> openPack), VRF record,
                   deliver (Core transfer), buyback
  payouts.ts       delivers cards to winners; buys for forfeits-before-pull; crash-safe retries
  lib/             base58/bytes, Ed25519 (WebCrypto), Solana tx signing, Core TransferV1 builder
  verify.ts        proof checker (CLI and function)
  test/            unit + end-to-end tests with a fake chain and a fake CC that check every signature
```

Battle states are `open → ready → drafting → playing → done | cancelled | void`.
Prize states are `buying → held → pending → sending → sent`. A voided battle's prize goes `buying|held → house → bought_back`.

## 4. Built and tested here

- **Engine determinism:** same seed and inputs give identical state on all 10,620 ticks of a full game, and a snapshot restored mid-game finishes identically.
- **Server: 26 tests (`cd server && bun test`):**
  - **Basics:** keys, transaction signing (legacy and v0), and the Core `TransferV1` transaction.
  - **Money and battles:** ledger, escrow, eligibility, the seed mixing all four sources, deposits.
  - **Pulls:** buying a pull (the VRF output becomes entropy), delivering exactly once, buying for a forfeit, resuming a paid purchase without re-buying, crash recovery by checking card ownership, and buyback.
  - **End to end:**
    - Two players with real Ed25519 keys sign in, deposit (admin credit), post and accept, draft live, both see the same card, and play lockstep with zero desyncs. The card lands in the winner's wallet on the fake chain, and the proof verifies, including a live check against the fake CC's VRF record. Forging the server seed or the VRF output fails verification.
    - A mid-game quit forfeits.
    - Both leaving after the pull refunds both and keeps the card with the house, then buyback works.
    - A no-show refunds both.
    - The API refuses bad input, missing funds, minors and non-admins.
- **Browser:** two headless browsers with test wallets did the full flow: sign-in, eligibility, post, accept, live draft, buying, card reveal, online game (same clock on both), forfeit and win, and the card shown "In your wallet" in prizes. The offline preview flow was also re-run.

## 5. Unconfirmed against the live Collector Crypt API

The code follows CC's docs, but these weren't observable without a real purchase. Confirm each on devnet (`https://dev-gacha.collectorcrypt.com`) in task 7.1.

1. **`POST /api/generatePack` without `altPlayerAddress`** sends the card to `playerAddress` (the house). This is expected from the docs.
2. **The house's signer slot.** The returned `transaction` (base64) has the house as a required signer, and the house's slot is the only one left unsigned. `server/lib/solana-tx.ts` throws if the house isn't a signer.
3. **The `openPack` response shape.** Its fields are `nft_address`, `roll`, `rarity`, and `nftWon.content.metadata` with `name`, `json_name`, `insuredValue` and `attributes[The Grade]`, plus `content.files[0].cc_cdn` for the image. Mapping is in `CollectorCryptPackSource.buy`.
4. **The `GET /api/vrf/verify?memo=` response.** The docs describe it (proof, public key, alpha, beta, commit status, award signature, match flag) but give no field names.
   - `betaFrom()` finds the 64-byte beta under any key containing "beta" (hex or base64).
   - If beta isn't there, entropy falls back to `roll:<roll>:nft:<address>`. That still comes from CC's VRF, but beta is better.
   - **Task:** once you see the real response, read the exact field in `betaFrom()`, and make `verify.ts` check CC's match flag by name.
5. **The `/verify-selection/<memo>` host.** The docs give only the path; the code uses `https://gacha.collectorcrypt.com/verify-selection/<memo>` (`verifyUrl()` in `server/collector-crypt.ts`). Correct the host if needed.
6. **Card standard and transfer.** Cards are Metaplex Core assets (`nft_standard: "core"` in CC's winners feed).
   - `server/lib/core-transfer.ts` hand-builds `TransferV1`: discriminator 14, args `[0]`, accounts in the order asset, collection (or program id), payer, authority, new owner, program id, program id.
   - Do one devnet transfer and confirm it lands. If it doesn't, replace `buildTransfer` with `@metaplex-foundation/mpl-core`'s `transferV1`, keeping the ownership check in `deliver()`.
   - Also check whether CC's assets carry plugins (for example a freeze or transfer delegate) that block transfers.
7. **`POST /api/buyback`** returns `serializedTransaction` for the house to sign; the code submits it through `/api/submitTransaction`. Confirm where the signed buyback goes.

## 6. Configuration

All server settings live in `server/.env.example`:
- House wallet: `HOUSE_SECRET_KEY` and `HOUSE_USDC_ACCOUNT`.
- Collector Crypt: `CC_API_KEY` and `CC_BASE_URL`.
- Network: `CLUSTER` and `RPC_URL`.
- Admin: `ADMIN_TOKEN`.
- Rules: `RESTRICTED_REGIONS`, plus timers and limits.

The client points at the server via the `VITE_API_URL` build variable (the GitHub Pages workflow reads the repo variable of that name) or `?api=` at runtime. The Content Security Policy in `vite.config.ts` allows the API origin and CC's image hosts.

The house wallet needs:
- USDC for pulls, which the entries fund.
- SOL for transfer fees.
- A USDC token account, which goes in `HOUSE_USDC_ACCOUNT`.

## 7. Remaining tasks, in order

### 7.1 Devnet dry run (first)
- Create a devnet house keypair and its USDC account; fund it with devnet USDC and SOL.
- Run the server with `CLUSTER=devnet` and the game with `?api=http://localhost:8787`.
- Play one battle between two real wallets (Phantom set to devnet).
- Go through every item in section 5 and fix the code where reality differs.
- **Done when:**
  - A devnet battle buys the pull, both players see the card, and the winner owns the card on devnet afterwards (check an explorer).
  - `bun verify.ts <id> http://localhost:8787` passes every check, including the live CC VRF check.

### 7.2 Collector Crypt account
- Ask CC for an API key (`CC_API_KEY`) so pulls carry your memo prefix.
- Ask whether `/api/vrf/verify` will stay public, and for its documented response.
- **Task:** refresh machine prices and odds from `GET /api/machines` hourly. Refuse to create battles for a machine whose price no longer matches `PACK_TIERS`, or update the tiers, and show live odds in the accept sheet.
- **Done when:** changing a machine's price on devnet (or mocking it) blocks new battles for that tier with a clear message.

### 7.3 Deploy
- One instance (match rooms are in memory), a persistent volume for SQLite with daily backups, HTTPS and WSS, and a paid RPC.
- Store secrets in the host's secret manager.
- Set `CLIENT_ORIGIN`, and set the repo variable `VITE_API_URL` so Pages builds point at the server.
- **Done when:** the deployed game can sign in and see the lobby against the deployed server.

### 7.4 Desktop deposits
- Add "Send with wallet": build a USDC `transferChecked` to `HOUSE_USDC_ACCOUNT` with `@solana/web3.js` and `@solana/spl-token`, then call the injected provider's `signAndSendTransaction`. Add the RPC origin to `connect-src`.
- Show a QR code of the Solana Pay link on desktop.
- Deposits are credited by sender wallet, so they must come from the signed-in wallet. Both paths already do.
- **Done when:** a desktop Phantom user deposits in two clicks and sees the balance update.

### 7.5 Automated withdrawals
- Withdrawals are debited immediately and queued as `requested`. An admin currently sends them and marks them sent (`POST /api/admin/withdrawals/:id`).
- **Task:** a worker sends withdrawals under a size limit automatically, as an SPL `transferChecked` to the player's associated token account (creating it if needed), records the signature and marks it `sent`. Anything over the limit waits for an admin.
- **Done when:** a small devnet withdrawal arrives without admin action, and a large one waits.

### 7.6 Admin page and alerts
Build a page or Discord webhook over `GET /api/admin/summary` that covers:
- failed or parked prizes, and `houseCards` (voided battles' cards, with buyback buttons)
- house USDC balance below liabilities plus a buffer
- unmatched deposits
- pending withdrawals

### 7.7 Player notifications
Add a browser notification and sound when your posted battle is accepted. Players have `ACCEPT_TIMEOUT_SECONDS`, 3 minutes by default, to show up. Optionally add a Discord or email ping.

### 7.8 Online polish
- Port the offline draft's position tracker, type filter and detail card to `draft()` in `src/screens/online.ts`.
- Add a 3-2-1 countdown before tip-off.
- If input feels laggy, add local prediction for your own player only, rewinding with `snapshot`/`restore`.
- Add a fallback image when a CC card image fails to load. Inline `onerror` is blocked by the CSP, so attach the listener in code.

### 7.9 Abuse limits
- Flag the same two wallets playing each other repeatedly.
- Cap battles per wallet per hour.
- Expire open battles after a set time, with a refund.

### 7.10 Policies
- Rewrite `public/privacy.html`: it currently says there are no accounts or payments. The server now stores wallet addresses, state, team names, balances and battle records.
- Add Pack Battles terms: rules, refunds, forfeits, voids, and that pull value is random.
- Set `RESTRICTED_REGIONS` per your counsel.
- Note that the game uses Pokémon names and sprites.

## 8. Conventions

- **Money** is an integer number of USDC base units (`MICRO = 1_000_000`). Every balance change goes through `post()` in `server/db.ts` with a unique `(kind, ref)`.
- **Engine changes:** anything that affects the simulation must use `game.rng` and must not read `viewTeam`. Run `server/test` after any change in `src/game/`, since the end-to-end test catches desyncs.
- **Never trust the client.** Clients send only stick and button input; scores, winners and balances come from the server.
- **Never buy twice.** A purchase's memo is saved in `onPaid` before anything else can fail, and retries resume from it. A card transfer is retried only after checking on-chain who owns the card.
