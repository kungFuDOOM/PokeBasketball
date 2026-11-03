# Burn credit review

Reviewed the live-board burn credit (`pokejam-ads-live`, `20261205_pokejam_ads_burn_credit.sql`) on `claude/ads-live`. Commit `029b27c` was an unfinished pass: it had already stopped whole credit rows from turning into extra airtime, and it had fixed the receipt, the one-base-unit display, and the "already settled" answer. This pass checked that work and finished what it left open. The migration is still edited in place. It has not been applied anywhere.

Verification ran against a pretend chain that mimics the RPC's `jsonParsed` output, and against PGlite. PGlite serves one connection, so the "same moment" tests run one after another. They do not prove the lock under real parallelism. The lock is the same advisory lock both pay functions take before their first read. Nothing here ran on mainnet, against a real wallet, or on a Supabase project.

## Blockers fixed

| # | Problem | What could happen | Fix |
| --- | --- | --- | --- |
| 1 | Credit rows were spent whole. Anything left over became airtime at that booking's rate. | A large short burn, then a cheap plan, used the whole row. The ad ran longer than the page quoted, and anything past the 366-day cap was lost. | Credit pays exactly what the burn is short of, oldest rows first. The rest stays. `remaining` is the unspent part. Credit never adds airtime. A burn above the price still runs longer, as before. |
| 2 | Amounts at checkout used a 2-decimal cut. One base unit showed as "0.00". | The number on the button was not the amount the wallet was asked to sign. | `exactTokens` shows every decimal on the plan price, the wallet balance, the checkout, and the receipt. |
| 3 | The receipt always said the full price was burned. | A top-up overstated the burn. | The receipt shows the burn that landed and, when credit was used, "Burn credit used". |
| 4 | A short burn naming an ad that was already settled was stored as credit, and `confirm` answered 400. | The server kept the credit and told the wallet the burn was refused. | `confirm` answers 200. The burn is credit. The ad is unchanged. |
| 5 | The database only refused a short burn from the wrong wallet. A full-price burn from anyone else still booked the ad. | A direct call to `pokejam_live_ad_pay` could pay someone else's booking. The Edge Function already refused this. The database did not. | Every burn, short or full, must name the booking's wallet as the burner. Otherwise nothing is booked and nothing is credited. |
| 6 | Credit was spent to extend an ad moderators had already taken down. The new run was then removed. | The credit was consumed and the ad did not run. | A short burn on a taken-down ad joins the credit. No new run is booked. A full-price burn still follows the old rule: it is recorded and the ad stays down, and it does not spend credit. A banned wallet's short burn does the same (it joins the credit). |
| 7 | `NaN` was refused. `Infinity` was not. | A non-finite amount compared above zero and booked the 366-day cap. Chain amounts cannot be infinite. A direct call could pass one. | `Infinity` and `-Infinity` are refused with zero, negatives, and fractions. Nothing is credited. |
| 8 | The booking was marked paid, with `credit_used` set, before the credit rows were reduced. | If the rows no longer covered that amount, the booking could commit while the same credit stayed spendable. | The spend is in the same transaction. Each row must still hold what was read. If anything is left unspent, the function raises and the booking rolls back. |
| 9 | The page said it only builds a burn of exactly the price, and that a burn is "the price". | That is false once the wallet has credit. The burn is the price minus the credit. | The How it works list and the payments note say so. They also say a balance that already covers the price still needs a burn of one base unit (0.000001 $PJAM), and that only the price is taken from the credit. |

## The one-base-unit burn

Kept. There is no redeem action.

A paid burn booking has to carry a real burn signature. The table requires it. Creating a booking does not prove you own the wallet: anyone can create one in your name, with their text. A redeem action that only named the wallet would spend your credit on that text.

A safe redeem would need a second proof, a signed message bound to that booking, its text, and its price, plus replay handling, and a change so a paid burn can exist with no chain signature. The one-base-unit burn is the proof already in use: the wallet's own finalized transaction, naming that booking, with the same mint, decimals, age, signer, and token-account checks as any other burn. One signature still counts once.

If the credit is gone by the time that burn lands, the one base unit joins the credit and nothing else is spent. The cost is 0.000001 $PJAM and a network fee. A wallet whose credit covers the plan but which holds no $PJAM is told why, and the credit stays.

## Checked and sound

- **No shorter slot.** A short burn books nothing. Credit plus a new burn books the whole plan or nothing. A week filled this way runs 168 hours.
- **Whose credit.** Only a burn signed by the booking's wallet, from a token account that wallet owns. A delegate, a stranger, or a second booking named in the same memo does not receive it. One transaction that names two bookings counts for one of them.
- **One signature, once.** Across burns, credit, USDC payments, and intents, including two requests for the same signature.
- **No double-spend.** Both pay functions take the shared advisory lock before they read. Credit is reduced in the same transaction as the booking. A failure in either half leaves both unchanged, and the same burn can still pay.
- **Price.** Credit is a number of tokens. For a fresh booking the locked price holds for a day. After that, and for an extra run, the higher of the locked price and the current price applies. A rise after the credit was earned is paid in full. A fall does not let a fresh booking undercut its lock.
- **Amounts.** Base units stay `numeric(39, 0)` in SQL and `bigint` in TypeScript, passed as text. Amounts above 2^53 keep every digit. Zero, negative, fractional, and non-finite amounts are refused.
- **The page.** It builds, and will sign, only the price minus the credit it just showed (one base unit when the credit already covers the price). A smaller burn, or a credit balance that changed, is blocked before the wallet opens.
- **The sweep and Your ads.** A short burn the sweep finds is credited once. A repeat changes nothing. One transaction that names two of your own bookings no longer makes Your ads fail: the first booking keeps the burn, and the other stays unpaid.
- **RLS and grants.** `pokejam_live_ad_burn_credit` has row level security on and no `anon` or `authenticated` access. `pokejam_live_ad_credit` and the replaced pay and view functions are service role only. The catalog test starts from Supabase's default privileges, which grant new tables and functions to `anon`, and checks that this migration takes that access back.
- **Prices stay easy to change.** One update of `pokejam_live_ad_plans.amount`, in whole tokens. No deploy. The written $150 and $500 on `public/contact.html`, and the DM-only ticker prices, are unchanged.
- **`NET_VERSION` is still 3.** The only control change on this branch is the joystick resting spot already committed: `left` and `top` of `.stick-base` add the safe-area insets. Size, knob, and touch zone are unchanged.

## Non-blockers

1. **Credit cannot book with no $PJAM at all.** See the one-base-unit burn above. The credit stays.
2. **A short burn with no booking memo, or naming a booking that never existed, cannot be credited.** Nothing ties it to a booking.
3. **Two tabs at once.** Both can be built against the same credit. The second burn books nothing and joins the credit. The advertiser books again. No tokens are lost.
4. **Board totals.** A short burn on an ad that was already settled is not in the public "burned" total, and a `dust` booking counts in "ads". Display only.
5. **Re-applying `20261204` alone after `20261205` restores the old pay function**, which does not credit short burns. Re-apply both, in order.
6. **Which row a part-spend came from is not stored per booking.** The booking's `credit_used` is the total. The row's `used_for` names the booking that finished it. The totals reconcile.
7. **The credit balance is public to anyone who asks** (rate limited). Burns and memos are already public on chain.
8. **The client does not check the decimals byte.** The token program rejects a wrong value, so nothing burns. The server refuses to sell unless the mint has 6 decimals.
9. **A full-price burn on an ad that was taken down is still recorded and stays down.** It does not spend credit. That is the same rule as any other full burn on a removed ad.
10. **CORS is open if `ADS_LIVE_ALLOWED_ORIGINS` is unset. The public RPC is the default if `ADS_LIVE_RPC_URL` is unset. The mint scan is capped at 50 pages per sweep. Rate limits are per IP.** Unchanged from the earlier review.
