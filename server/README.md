# Pack Battles server

Two players split the cost of a Collector Crypt gacha pull, draft five Pokémon each, and play one game of Poké Jam for it. The server holds the money and runs the draft. After the draft it buys and opens the pull so both players see the card, then runs the game, decides the winner, and transfers the card to them. Collector Crypt's VRF picks the card and also seeds the game.

It's a single [Bun](https://bun.sh) process with SQLite, and needs no packages at runtime: wallet signatures, Solana transaction signing and the WebSocket server all use what Bun ships with.

## Run it locally

```sh
cd server
cp .env.example .env      # fill in at least HOUSE_SECRET_KEY, HOUSE_USDC_ACCOUNT, ADMIN_TOKEN
bun install               # dev types only
bun run dev               # http://localhost:8787
```

Then run the game with `npm run dev` in the repo root and open `http://localhost:5173/?api=http://localhost:8787`. The `?api=` choice is remembered; for a deployed build, set `VITE_API_URL` when building instead (the GitHub Pages workflow reads the `VITE_API_URL` repo variable).

Start on **devnet** (`CLUSTER=devnet`): devnet USDC, Collector Crypt's devnet gacha (`https://dev-gacha.collectorcrypt.com`), no real money.

## Tests

```sh
bun test            # unit tests + a full two-player battle over WebSockets
bun run typecheck
```

The end-to-end test signs in two players with real Ed25519 keys and has them post and accept a battle and draft live. It checks both players are shown the same card before tip-off, plays a full lockstep game, and checks both clients' copies finished on the server's exact score. The card is transferred on a fake chain that accepts only a correctly signed Core transfer, and the proof is verified, including a live check of the VRF record against a fake Collector Crypt.

## How it works

| Piece | File | What it does |
| --- | --- | --- |
| Sign-in | `auth.ts` | Server issues a one-time message; the wallet signs it; Ed25519 check; 30-day session token. No transaction, no cost. |
| Money | `db.ts` | Append-only ledger in USDC base units (6 decimals). Balance = sum of rows. `UNIQUE(kind, ref)` makes every credit and debit idempotent. |
| Deposits | `deposits.ts`, `solana.ts` | Polls the house USDC account; credits each transfer to the signed-in player who sent it. Unknown senders are kept for a manual credit. |
| Battles | `battles.ts` | open → ready → drafting → playing → done. Each side's entry (half the machine price) is debited when they post or accept. Cancel before acceptance refunds; a no-show, a server restart or both players leaving voids and refunds both. |
| Fairness | `battles.ts`, `verify.ts` | The game seed mixes four sources: the server seed (only its sha256 is published at creation), a seed from each player, and Collector Crypt's VRF output for the battle's own pull, which nobody knows until the pull is opened after the draft. The proof at `/api/battles/:id/proof` has every seed, the CC memo and VRF record, the draft and every tick of input; `bun verify.ts <id>` checks it all and asks CC to confirm the VRF. |
| Live match | `match.ts` | Snake draft (auto-pick on the clock), then the pull is bought, opened and shown to both players for 8 seconds, then lockstep: the server owns the clock, merges both inputs each tick, runs its own copy of the game, and streams inputs to both clients. Hash checks every 2 seconds, with snapshot resync if a client drifts. A disconnect pauses the game; not back in `FORFEIT_SECONDS` = forfeit. |
| Pulls and prizes | `collector-crypt.ts`, `payouts.ts`, `lib/core-transfer.ts` | The pull is bought from Collector Crypt's public Gacha Machine API (`generatePack` with the house as buyer, house signs, `submitTransaction`, `openPack`), and the card lands in the house wallet. After the game the card, a Metaplex Core asset, is transferred to the winner. It never buys twice (the memo is saved the moment CC has the payment) and never sends twice (ownership is checked on-chain before each transfer). A voided battle's card stays with the house and can be sold back (`/api/admin/prizes/:id/buyback`). |
| API | `app.ts` | REST + `/ws`. Admin endpoints under `/api/admin/*` with `ADMIN_TOKEN`. |

## The house wallet

The house wallet receives deposits, pays for each battle's pull, holds the card during the game, and sends it to the winner. Each battle's two entries add up to exactly one pull, so the house USDC balance should always cover the open liabilities (`GET /api/admin/summary` → `liabilities`).

1. Create a keypair (`solana-keygen new -o house.json`) and keep the file out of the repo. Put its contents in `HOUSE_SECRET_KEY` through your host's secret manager.
2. Create its USDC token account (`spl-token create-account <USDC mint> --owner <house address>`) and put that address in `HOUSE_USDC_ACCOUNT`.
3. Keep some SOL in the house wallet for transaction fees.

## Admin API

All need `Authorization: Bearer $ADMIN_TOKEN`.

| Call | Use |
| --- | --- |
| `GET /api/admin/summary` | Liabilities, battle and prize counts, failed prizes, pending withdrawals |
| `GET /api/admin/unmatched-deposits` | Transfers from wallets nobody signed in with |
| `POST /api/admin/credit {wallet, amount, note, ref}` | Manual credit or debit (base units); `ref` makes it idempotent |
| `POST /api/admin/withdrawals/:id {state: "sent", signature}` | Mark a withdrawal paid after sending the USDC |
| `POST /api/admin/withdrawals/:id {state: "rejected", note}` | Reject and refund it |
| `POST /api/admin/prizes/:id/retry` | Send a parked prize again, after checking Collector Crypt (`GET /api/pack/status?memo=`) that the first try didn't land |
| `POST /api/admin/prizes/:id/buyback` | Sell a voided battle's card (listed under `houseCards` in the summary) back to Collector Crypt, within 72 hours of the pull |

## Deploying

- One instance. Match rooms live in memory; battles mid-game when the process stops are voided and refunded on the next start, and `SIGTERM` does the same before exiting.
- Persistent disk for `DB_PATH` (SQLite in WAL mode), backed up.
- HTTPS and WSS in front (Fly.io, Railway, Render, or a VPS with Caddy). Set `CLIENT_ORIGIN` to the game's URL.
- A paid Solana RPC for `RPC_URL`.
