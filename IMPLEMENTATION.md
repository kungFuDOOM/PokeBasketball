# Pack Battles: implementation guide

This is the handoff for finishing and launching Pack Battles. It says what is built and tested, and lists what is left as concrete tasks with the files involved and how to know each is done. Read `server/README.md` first for how the server works.

## The feature

Two players split the cost of one Collector Crypt (CC) gacha pull. Each pays half into escrow when they post or accept a battle. They snake-draft five Pokémon each, live, then play one game of Poké Jam against each other online. The winner gets the pull: the server buys it from CC's public Gacha Machine API with the escrowed money and CC sends it to the winner's Solana wallet.

## Already built and tested

| Area | Where | Tested by |
| --- | --- | --- |
| Deterministic engine: seeded RNG, a human on each team, `viewTeam` for rendering, snapshot/restore, state hash | `src/game/game.ts`, `src/game/types.ts`, `src/game/sync.ts`, `src/game/render.ts`, `src/game/hud.ts` | Same seed + inputs give identical state on every tick of a full game; a game restored mid-way finishes identically |
| Shared protocol, lockstep client, match config | `src/net/protocol.ts`, `src/net/lockstep.ts`, `src/net/match.ts` | Server end-to-end test (both clients end on the server's exact score, zero desyncs) |
| Server: wallet sign-in, ledger, deposit scanner, battles and escrow, eligibility, live draft, lockstep match rooms, forfeits, no-shows, restart safety, proofs, CC payouts, admin API | `server/` | `cd server && bun test`: 21 tests |
| House wallet signing without an SDK (legacy and v0 transactions) | `server/lib/solana-tx.ts`, `server/lib/ed25519.ts` | Unit tests verify every signature in the result |
| Collector Crypt client: `generateGift`, `generatePack` + `openPack`, `submitTransaction`, polling `WAITING_FOR_WEBHOOK`, resume by memo | `server/collector-crypt.ts` | Tests against a fake CC that checks signatures |
| Client: wallet connect (Phantom, Solflare, Backpack, injected), sign-in, balance, deposit sheet (Solana Pay link + address), withdraw request, eligibility, team name, lobby, live draft, online game with reconnect, results with proof link | `src/screens/battles.ts`, `src/screens/online.ts`, `src/net/http.ts`, `src/net/wallet.ts` | Two headless browsers signed in with test wallets, drafted, played and finished a battle against the real server |
| Offline preview (no server configured): play money and CPU challengers | `src/battles/local.ts` | Browser test of the whole preview flow |
| CI | `.github/workflows/server.yml`; `pages.yml` passes `VITE_API_URL` | |
| Proof verifier anyone can run | `server/verify.ts` | Test: real proof passes, forged seed fails |

## Left to do, in order

### 1. Devnet dry run (do this first)

- Create a devnet house wallet and its devnet USDC account (`server/README.md` → The house wallet). Get devnet USDC from a faucet.
- Run the server with `CLUSTER=devnet` and the game with `?api=http://localhost:8787`.
- Play a battle between two real wallets (Phantom on two browsers, both set to devnet).
- Confirm the winner receives the pull from `dev-gacha.collectorcrypt.com`, both in `gift` and in `PAYOUT_MODE=open`.
- **Check:** in `server/lib/solana-tx.ts`, real CC transactions parse, the house wallet is one of the signers, and `submitTransaction` succeeds. If CC's transaction makes the house the fee payer, keep SOL in the house wallet.
- **Done when:** a devnet battle pays out end to end, and `bun verify.ts <battle-id>` passes.

### 2. Collector Crypt account

- Ask CC for an API key (`CC_API_KEY`) so packs carry your memo prefix and show up under your slug.
- Ask about `can_adopt` if you want a per-pack fee. Note that a fee comes out of the pull's expected value, not the players' entry.
- Confirm the three machines (`pokemon_25`, `pokemon_50`, `pokemon_100`) and their prices.
- **Task:** have the server refresh prices and odds from `GET /api/machines` on startup and every hour, and refuse to create a battle if the machine's price no longer matches `PACK_TIERS` in `src/battles/service.ts` (or update the tiers). Show the live odds in the accept sheet (`confirmSheet` in `src/screens/battles.ts`).

### 3. Deploy

- Host the server (Fly.io, Railway or a VPS with Caddy) with a persistent volume for SQLite, HTTPS and WSS.
- Store `HOUSE_SECRET_KEY` and `ADMIN_TOKEN` as secrets, set `CLIENT_ORIGIN` to the game's URL, and use a paid RPC.
- Set the `VITE_API_URL` repo variable so the Pages build points at it (and so the Content Security Policy allows it).
- Keep it to one instance: match rooms are in memory.
- Back up the database daily.

### 4. Deposits from desktop wallets

The deposit sheet offers a Solana Pay link, which mobile wallets open, plus the address to copy.

- **Task:** add a "Send with Phantom" button that builds a USDC transfer to `HOUSE_USDC_ACCOUNT` and calls `signAndSendTransaction` on the injected provider. Use `@solana/web3.js` and `@solana/spl-token` (`createTransferCheckedInstruction`). Add the RPC origin to `connect-src` in `vite.config.ts`.
- **Task:** show a QR code of the Solana Pay link on desktop.
- Deposits are credited by sender wallet, so these must be sent from the signed-in wallet. That is already the case for both.

### 5. Automated withdrawals

Right now a withdrawal is debited immediately and queued as `requested`, and an admin sends the USDC and marks it sent (`POST /api/admin/withdrawals/:id`).

- **Task:** a worker that sends approved withdrawals automatically: an SPL `transferChecked` from the house USDC account to the player's associated token account, creating it if needed. Record the signature and mark the withdrawal `sent`.
- Keep a size limit above which an admin must approve.
- **Done when:** a devnet withdrawal under the limit arrives without admin action, and one over it waits.

### 6. Alerts and an admin page

- **Task:** a small admin page (or Discord webhook alerts) for failed or parked prizes, house USDC balance below liabilities plus a buffer, unmatched deposits, and pending withdrawals. Everything is already exposed by `GET /api/admin/summary`.

### 7. Player notifications

When someone accepts your battle, you have `ACCEPT_TIMEOUT_SECONDS` (default 3 minutes) to show up, or it's called off and refunded. The lobby polls while it's open.

- **Task:** add a browser notification (Notification API) and a sound when your battle is accepted, and optionally a Discord or email ping.

### 8. Gameplay polish for online play

- The draft screen (`draft()` in `src/screens/online.ts`) is deliberately simple. Port over the offline draft's position tracker, type filter and detail card.
- Lockstep adds about half a round trip of input delay. If it feels sluggish, add local input prediction for your own player only, rewinding on each confirmed tick with `snapshot`/`restore` from `src/game/sync.ts`.
- Add a short "3, 2, 1" before the tip-off once both clients are ready (`beginTicking` in `server/match.ts`).

### 9. Abuse and limits

- Detect the same two wallets playing each other repeatedly, which can be used to launder money or farm pulls.
- Limit battles per wallet per hour.
- Cap how long a battle can sit open.

### 10. Policies

- `public/privacy.html` says the game has no accounts or payments. Rewrite it for wallet sign-in, balances, deposits, and the data the server stores (wallet address, state, team name, battle records).
- Add terms for Pack Battles: rules, refunds, forfeits, and that pull value is random.
- `RESTRICTED_REGIONS` in the server config sets the states where paid battles are off. Set it per your counsel before launch.
- The game uses Pokémon names and sprites. Prizes for money make it commercial, which is a different footing from a free fan game.

## Conventions

- **Money** is always an integer in USDC base units (`MICRO = 1_000_000`). Post every balance change through `post()` in `server/db.ts` with a unique `(kind, ref)`.
- **The engine is shared by client and server.** Anything that affects the simulation must use `game.rng`, never `Math.random`, and must not depend on `viewTeam`. Run `server/test` after any change in `src/game/`.
- **Never trust the client** for results, scores or balances. The client only sends stick and button input.
