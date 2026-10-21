# Pack Battles: play for Collector Crypt pulls

Two players split the cost of a Collector Crypt gacha pull, snake-draft five Pokémon each live, and play one online game of Poké Jam. The winner gets the pull, sent to their Solana wallet by Collector Crypt.

This PR adds the feature end to end: the game client, an authoritative battle server, wallet sign-in, a USDC ledger and escrow, real-time online play, provably fair results, and Collector Crypt payouts. It's built and tested here. What's left before launch, in order, is in **[IMPLEMENTATION.md](IMPLEMENTATION.md)**: a devnet dry run, a CC API key, deployment, and a few product tasks.

| | | |
| --- | --- | --- |
| ![Connect a wallet](docs/pack-battles/connect-wallet.png) | ![Lobby](docs/pack-battles/lobby.png) | ![Live draft](docs/pack-battles/live-draft.png) |
| ![Accept](docs/pack-battles/accept-phone.png) | ![Online game](docs/pack-battles/online-game-phone.png) | ![Win](docs/pack-battles/win-phone.png) |

## How a battle works

1. **Sign in.** Connect Phantom, Solflare or Backpack and sign a one-time message. This is free and sends no transaction. Players confirm they're 18+ and pick their state.
2. **Deposit.** Players send USDC from that wallet to the house wallet, using a Solana Pay link or the address. The server sees the transfer on chain and credits their balance.
3. **Post or accept.** Each side pays half the machine price into escrow: $12.50 for a $25 Starter pull, $25 for a $50 Elite pull, $50 for a $100 Bronze pull. These are Collector Crypt's real public Pokémon machines, and their odds are shown before anyone pays. Cancelling before someone accepts refunds you.
4. **Draft live.** It's a snake draft with a pick clock, and a missed clock auto-picks.
5. **Play.** The game runs in lockstep. The server runs its own copy of the game and decides the winner; clients only send stick and button input. Leaving forfeits after a grace period. If nobody shows up, or the server restarts mid-game, the battle is called off and both players are refunded.
6. **Get paid.** The server spends the pot on one pull for the winner through Collector Crypt's public Gacha Machine API, signed by the house wallet. It either gifts an unopened pack or opens it straight to their wallet. It never buys twice for one battle.
7. **Check it.** Every result has a proof: the seeds (commit-reveal, with the commitment published before the game) and every tick of input. `bun verify.ts <battle-id>` replays it through the real engine.

With no server configured, Pack Battles still works as an offline preview using play money and CPU challengers.

## What changed

**Engine (`src/game/`)**
- The simulation is deterministic. Every random roll comes from a seeded RNG (`game.rng`), so the same seed and inputs produce the identical game.
- One human per team, with `viewTeam` deciding whose HUD, ring and tip-off meter a screen shows.
- `sync.ts` adds input packing, a fixed tick, a state hash, and snapshot/restore.
- Single-player, franchise and simulated games behave as before.

**Client**
- `src/screens/battles.ts`: the lobby, including wallet, balance, deposit, withdraw, eligibility, create/accept and prizes.
- `src/screens/online.ts`: the waiting room, live draft, online game, reconnects and results.
- `src/net/`: protocol, lockstep client, wallet connector, HTTP backend and shared byte helpers.
- `src/battles/`: the Collector Crypt tiers, the backend interface, and the offline preview.

**Server (`server/`)**
- A Bun + SQLite server with no runtime packages: auth, ledger, deposit scanner, battles and escrow, match rooms, payout worker, Collector Crypt client, Solana transaction signing, admin API and proof verifier.
- See `server/README.md` for how it works, configuration (`server/.env.example`), the house wallet, and the admin API.

**CI and docs**
- `.github/workflows/server.yml` typechecks and runs the server tests.
- `pages.yml` passes the `VITE_API_URL` repo variable to the build, so the deployed game points at the server and its Content Security Policy allows it.
- The README is updated, plus `server/README.md` and `IMPLEMENTATION.md`.

## Testing

`cd server && bun test` runs 21 tests:
- **Unit:** base58, house-key loading, signing legacy and v0 transactions while keeping CC's signature, ledger idempotency and overdrafts, escrow (create, accept, cancel, void, finish), eligibility, deposit crediting by sender, and every payout path. The payout tests include retrying a refused purchase, resuming a paid one without buying again, parking an interrupted one, and waiting on a short house wallet.
- **End to end:**
  - Two players sign in with real Ed25519 keys and play a full lockstep game. Both clients end on the server's exact score with zero desyncs. The winner's pull goes through a fake Collector Crypt that verifies the house signature, the proof verifies, and a forged seed fails.
  - A mid-game quit forfeits.
  - A no-show refunds both players.
  - The API refuses bad input, missing funds, minors and non-admins.

Also checked:
- **Engine:** two copies with the same seed and inputs matched on every one of 10,620 ticks, and a copy restored from a mid-game snapshot finished identically.
- **Browsers:** two headless browsers with test wallets signed in, deposited (admin credit), posted and accepted a battle, drafted live, played, and finished by forfeit, with the prize delivered. Both screens showed the same game clock and there were no console errors. The offline preview flow was also re-run.

## Before merging or launching

See [IMPLEMENTATION.md](IMPLEMENTATION.md). In short:
1. Do a devnet dry run with real wallets and CC's devnet gacha.
2. Get a CC API key and confirm machine prices.
3. Deploy the server with secrets, a volume, HTTPS and a paid RPC.
4. Set the `VITE_API_URL` repo variable.
5. Update `public/privacy.html` and add terms.
6. Set `RESTRICTED_REGIONS` per your counsel.
