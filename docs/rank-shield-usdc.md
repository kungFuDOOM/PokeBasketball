# Rank Shield shop: pay with USDC (Phantom, devnet)

Players signed in with **Phantom** can pay for a Rank Shield pack in USDC on Solana, next to the Stripe buttons. **Nothing here is applied, deployed or switched on.** It runs on **devnet (USDC-Dev) only** until kungFuDOOM approves real money; the server refuses mainnet unless two secrets say otherwise (see [Going to mainnet](#going-to-mainnet-checklist)).

The house only **receives**. The receiver is the owner's **public** wallet address, set as a secret. There is no private key anywhere in this feature: not in the repo, not in a secret, not in the functions.

> **IP risk applies here too.** Everything in [`rank-shield-stripe.md`](rank-shield-stripe.md) about charging real money in a Pokémon-derived fan game applies the same way to USDC. Paying in crypto does not lower the takedown or rights-holder risk. This doc is not legal advice.

## How it works

1. The player (signed in with Phantom, never a guest or a Google-only account) opens **Ranked → Rank Shield → Shop**, ticks the same "I'm 18+ or have a parent's permission" box, and taps **Pay 1.99 USDC** (3.99 / 6.99 for the bigger packs). On devnet the shop shows a **Devnet test USDC** badge.
2. The browser calls **`shield-usdc-intent`** with only `{ sku, ageConfirmed }`. The function verifies the JWT, reads the wallet **from the verified Supabase user** (never from the client), runs `pokejam_shield_checkout_check` (14 held, 42 per season across Stripe and USDC including pending, 5 per hour, no dispute block), and stores a one-time intent (`pokejam_shield_usdc_intents`): a random reference key, a memo, the amount from `pokejam_shield_products.usdc_amount` (1990000 / 3990000 / 6990000, 6 decimals), and a 15-minute expiry. It returns `{ intentId, reference, receiver, mint, amount, cluster, memo }`.
3. The browser builds one transaction: a `TransferChecked` from the player's USDC token account to the **receiver's USDC token account**, with the reference key as a read-only extra key, plus a Memo instruction. Phantom shows it ("Approve in Phantom") and sends it (`signAndSendTransaction`).
4. The browser calls **`shield-usdc-confirm`** with `{ intentId, signature }` ("Confirming on Solana..."). The function reads the transaction from the RPC (`getTransaction`, jsonParsed) and checks: no error, `confirmed` (devnet) / `finalized` (mainnet), the reference and memo are present, exact mint, **exact** amount, destination = the receiver's token account, authority = the player's linked wallet and a signer, block time inside the intent's window. Only then does it call `pokejam_shield_credit_usdc`, which uses the same crediting as Stripe (same caps, same ledger).
5. Not confirmed yet → `202 { status: 'pending' }` and the browser asks again. Over the hold cap at credit time → credits up to 14 and marks the purchase `needs_refund = true` with `credit_short`, exactly like Stripe.
6. Idempotent: one credit per intent, and each transaction signature is unique across purchases. Re-sending the same signature returns `credited` with `duplicate: true` and credits nothing. A signature for another intent is refused (`signature_used`).

Error codes the client shows: `guest`, `no_wallet`, `age`, `bad_request`, `no_intent`, `wrong_signer`, `cluster_changed`, `intent_done`, `signature_used`, `expired`, `rpc`, `db`, plus the cap codes from `pokejam_shield_checkout_check`. Mint, amount, recipient, reference and memo mismatches are refused and never credited.

## Secrets

Set them on the project, never in the repo, chat or the build. All are read only by the two Edge Functions.

| Secret | Required | What it is |
| --- | --- | --- |
| `SHIELD_USDC_RECEIVER` | yes | The house wallet's **public** address (the owner of the receiving USDC token account). Without a valid address USDC payments are off. |
| `SHIELD_USDC_CLUSTER` | no | `devnet` (default) or `mainnet-beta`. Anything else turns USDC payments off. |
| `SHIELD_USDC_ALLOW_MAINNET` | mainnet only | Must be exactly `approved-by-kungfudoom` (the same phrase Pack Battles uses). Without it, `mainnet-beta` is refused. |
| `SHIELD_USDC_RPC_URL` | no | A Solana RPC URL. Default: the public cluster RPC (`https://api.devnet.solana.com` / `https://api.mainnet-beta.solana.com`). Use a private RPC on mainnet; if its URL holds an API key, it stays a secret. |

The mint is fixed per cluster in the code, never taken from a secret or the client: devnet USDC-Dev `Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr`, mainnet USDC `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`. `SHIELD_ALLOWED_ORIGINS` (CORS) is shared with the Stripe checkout function. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` come with the Edge runtime.

## The receiver's USDC token account must exist

The player's transaction sends to the receiver's **associated token account** (ATA) for the cluster's USDC mint, and it does **not** create that account. If it doesn't exist the transfer fails in Phantom and nothing is paid. Create it once per cluster before switching USDC on, for example by sending yourself a little USDC-Dev on devnet (most wallets create the ATA on first receipt), or with the Solana CLI:

```sh
spl-token create-account Gh9ZwEmdLJ8DscKNTkTqPbNwLNNBjuSzaG9Vp2KGtKJr --owner <SHIELD_USDC_RECEIVER> --url devnet
```

Check it: `spl-token accounts --owner <SHIELD_USDC_RECEIVER> --url devnet` lists the USDC-Dev account. Do the same for the mainnet mint before going to mainnet.

## Owner setup (devnet)

1. **Apply the migrations, in order** (SQL editor or `supabase db push`): `20261117_pokejam_rank_shield.sql`, `20261118_pokejam_shield_shop.sql`, then `20261119_pokejam_shield_usdc.sql`. It is additive and safe to run twice. It sets `usdc_amount` on the three packs; a pack also needs `active = true` (see the Stripe doc).
2. **Receiver token account**: create it as above.
3. **Secrets**:
   ```sh
   supabase secrets set SHIELD_USDC_RECEIVER=<house public address> SHIELD_USDC_CLUSTER=devnet
   # optional: SHIELD_USDC_RPC_URL=<devnet RPC>
   ```
4. **Deploy both functions**, JWT verification on (the default):
   ```sh
   supabase functions deploy shield-usdc-intent
   supabase functions deploy shield-usdc-confirm
   ```
5. **Turn it on in the build**: `VITE_SHIELD_SHOP=true` and `VITE_SHIELD_USDC=true` (next to `VITE_MODE_RANKED=true`), optionally `VITE_SHIELD_USDC_CLUSTER=devnet` (the default; the server's cluster always wins). Redeploy the site. Without `VITE_SHIELD_USDC`, no USDC button is drawn and nothing calls these functions.
6. **Legal pages**: `public/terms.html` and `public/privacy.html` already cover USDC payments; deploy them with the site.

## Test it (devnet)

You need a Phantom wallet set to **Devnet** (Settings → Developer settings → Testnet mode → Solana Devnet), a little devnet SOL for fees (`solana airdrop 1 <address> --url devnet` or https://faucet.solana.com) and some USDC-Dev for the payment (https://faucet.circle.com, Solana Devnet).

- **Buy:** sign in with Phantom, open the shop, tick the box, tap **Pay 1.99 USDC**. Approve in Phantom. You see "Confirming on Solana..." and then "+3 Rank Shields". Check `select * from pokejam_shield_purchases where rail = 'usdc' order by created_at desc limit 5;` (it holds the wallet and `usdc_signature`) and the receiver's USDC-Dev balance.
- **Reject in Phantom:** nothing is sent or credited; the intent just expires.
- **Replay:** call `shield-usdc-confirm` again with the same `intentId` and `signature`: `duplicate: true`, count unchanged.
- **Google or guest account:** no USDC buttons.
- **Caps:** with 12 held, every pack shows "Max 14 held", as with Stripe. Over the cap at credit time (two tabs) → `needs_refund = true`, `credit_short > 0`. Refund that part in USDC by hand and look for `select * from pokejam_shield_purchases where needs_refund;`.
- Logs: Supabase dashboard → Edge Functions → the function → Logs. They never contain secrets.

Locally, without any network: `npx vitest run supabase/functions/_shared/shield supabase/tests/shield-usdc.test.ts src/multiplayer/ranked` (mocked RPC transactions, a real Postgres in PGlite).

## Refunds

On-chain payments are final: there are no chargebacks. Refunds follow the same policy as Stripe ([terms](../public/terms.html#refunds)) but are done **by hand**: send the USDC back from the house wallet to the wallet stored on the purchase, then remove the unused shields in SQL. The purchase row's `wallet` and `usdc_signature` show who paid and with which transaction.

## Going to mainnet checklist

- [ ] kungFuDOOM approves real money, has read the **IP risk** above and in the Stripe doc, and has had legal advice.
- [ ] The house wallet is a wallet you control with a hardware key or a secure seed backup. Only its public address goes into secrets.
- [ ] The receiver's **mainnet** USDC token account exists (`EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v`).
- [ ] A private mainnet RPC set as `SHIELD_USDC_RPC_URL` (the public one rate-limits).
- [ ] `supabase secrets set SHIELD_USDC_CLUSTER=mainnet-beta SHIELD_USDC_ALLOW_MAINNET=approved-by-kungfudoom`. Without both, mainnet is refused on purpose. Pending devnet intents stop working (`cluster_changed`).
- [ ] Build with `VITE_SHIELD_USDC_CLUSTER=mainnet-beta` so the devnet badge is gone.
- [ ] Terms, refunds and the privacy update are live.
- [ ] **Tax:** USDC received for digital goods is income at its USD value when received, and sales tax / VAT on digital goods can still apply. Keep a record of each payment (the purchases table has the amount, time, wallet and signature) and talk to a tax adviser. Stripe Tax does not cover these payments.
- [ ] One real purchase of your own, a replay, and a manual refund, before announcing it.
- [ ] You watch `needs_refund` rows and the house wallet.

## Limits and known gaps

- Refunds are manual; nothing reverses a credit automatically.
- A payment sent after the intent expired (past the 10-minute grace) is not credited automatically. Find it by its memo or reference on-chain, then refund it or credit it by hand.
- Caps are per account, as with Stripe.
