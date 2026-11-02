# Sign in with Phantom on phones

Phantom injects `window.phantom.solana` only in its desktop extension and its in-app browser, and the in-app browser can't do landscape.
On iOS Safari, the iOS home-screen app and Android Chrome, sign-in now hands off to the Phantom app through its universal links.
Where the wallet is injected, nothing changed: `signInWithPhantom` in `src/wallet/phantom.ts` still runs.

| File | What it does |
| --- | --- |
| `src/wallet/phantomLink.ts` | The rules: links, encryption, callback parsing, state, expiry, the sign-in message, relay calls. No DOM. |
| `src/wallet/nacl.ts` | x25519 + xsalsa20-poly1305. WebCrypto has neither on the browsers we support, and this avoids a dependency. |
| `src/wallet/phantomSheet.ts`, `phantomView.ts` | The status sheet and what the page does on return. |
| `public/phantom-return.js` | Takes the callback out of the URL before analytics load. |
| `supabase/migrations/20261202_pokejam_phantom_relay.sql` | The relay. |

## The flow

1. The tap on **Sign in with Phantom** makes a fresh x25519 key and a one-time id, and follows `phantom.com/ul/v1/connect`.
2. Phantom approves and redirects to `https://pokejam.xyz/?pj_phantom=<id>&...` with an encrypted `{public_key, session}`.
3. The page builds the Sign in with Solana message and shows a **Sign in Phantom** button. It must be a button: a universal link opens
   the app reliably only from a tap, and this code isn't running in one.
4. That tap follows `phantom.com/ul/v1/signMessage`. Phantom redirects back with an encrypted `{signature}`.
5. The page checks wallet, nonce and expiry, then calls `signInWithWeb3({ chain: 'solana', message, signature })`. Supabase verifies the signature.

So a sign-in is always two trips to Phantom, because `signMessage` needs the session from `connect`.

## Which tab gets the answer

The tab Phantom lands in only sometimes holds the key:

- **Home-screen app:** the redirect opens in Safari, whose storage is separate.
- **Safari or Chrome:** an app opening a link commonly gets a *new tab*, and `sessionStorage` is per tab. So this isn't just a home-screen problem.

The landing page therefore decides by whether it holds the key, not by what browser it thinks it is:

- It holds the pending id: it carries on by itself.
- It doesn't: it posts the still-encrypted answer to the relay and says "Go back to the PokeJam app" (or tab). The tab that started the
  sign-in polls every 2.5 s and on `visibilitychange`/`pageshow`/`focus`, fetches the ciphertext, and decrypts it.

What a player does on the iPhone home-screen app: tap, approve in Phantom, land in Safari, switch back to PokeJam by hand, tap again,
approve in Phantom, land in Safari, switch back. Then they're signed in.

## Security

- The dapp key, the Phantom session and pending state live only in `sessionStorage` under `pokejam.phantom.pending`, and are wiped on
  success, failure, cancel and expiry (10 minutes). Nothing logs them. `localStorage` only gets the existing "reopen Ranked" marker.
- Each trip has a 32-byte random id, used up when its answer is applied. A forged or replayed callback goes nowhere: at worst it stores junk
  in the relay under an id nobody is polling. Local state isn't touched.
- Phantom's `errorMessage` is dropped, not shown: anyone can write it into a link.
- The callback leaves the URL (`replaceState`) in a classic script before Google Analytics, the Cloudflare beacon or the error reporter run.
- A hostile connect answer can't sign anyone in: the player's real Phantom can't decrypt a request sealed to another key, and Supabase checks the signature against the address in the message.

The relay stores ciphertext only: the SQL refuses any field but the Phantom key, nonce and box, or a numeric code. Rows last 5 minutes and are
deleted on read, the first write wins, and the table has no client access except the two functions, which never list. The caps are 4 KB per row,
20 live rows per client and 5,000 overall. The client key is an md5 of the IP, gone with the row. Expired rows are ignored at once and purged by
the next relay call, not by a timer.

## Setup

1. Apply `supabase/migrations/20261202_pokejam_phantom_relay.sql` **before** this ships. Without it, every sign-in that lands in another tab fails with "Could not pass that back".
2. Supabase Auth: Web3 Wallet with Solana stays on, and URL Configuration must allow `https://pokejam.xyz/` (see `docs/ranked-signin.md`). Nothing new is needed.

No Edge Function, no new secrets, no App ID.

## What only a real phone can confirm

Nothing here has been run against the real Phantom app. Check on an iPhone and an Android phone:

- A tap on the link opens Phantom from Safari, from Chrome and, the riskiest, from the home-screen app (where iOS may show an in-app browser sheet instead). If it doesn't, **Open PokeJam in Phantom** is still there.
- Phantom accepts a `redirect_link` that already has a query string, and appends its params properly. `parseCallback` tolerates a second `?`.
- Which tab the redirect lands in, and that the "go back" copy reads right there.
- Whether iOS keeps a backgrounded home-screen app's `sessionStorage`. If iOS kills the app while the player is in Phantom, the key is gone and the sign-in has to restart; no storage rule change can avoid that while the key is limited to `sessionStorage`.
- Phantom shows the message as text, and Supabase accepts the signature in production.

## Paying with USDC from a phone: not built yet

Sign-in only, on purpose. Phones without an injected wallet still get "Open PokeJam in the Phantom app or browser extension" in the shop. Production is
on mainnet with real USDC, this path can't be tested without a phone, and its failure mode is a player who paid and wasn't credited.

What it needs:

1. **Browser RPC access.** `prepareTransfer` calls `api.mainnet-beta.solana.com` from the browser, and the production CSP's `connect-src` doesn't list it. The public mainnet RPC also commonly refuses browser requests. Fetch the blockhash from a shield Edge Function, or add a paid RPC host to the CSP.
2. **A longer-lived session.** Sign-in wipes the Phantom session on success. Either keep it for a short time (a change to the wipe rule), or run `connect` again first, which is one more trip per purchase.
3. **Wallet match before signing.** Compare `public_key` from `connect` with the signed-in wallet, as `signAndSend` does with the injected provider.
4. **A `pay` step.** `/ul/v1/signAndSendTransaction` with `{transaction: base58, session}`, carrying `intentId` in the pending state. A button tap is required, and the blockhash lives about 60 to 90 s, so rebuild the transaction if the player waits.
5. **Lost-callback recovery.** Phantom may send the payment and the answer never reach us (a killed tab, a failed relay call). Before offering a retry, look up the intent's `reference` with `getSignaturesForAddress`, then go to `shield-usdc-confirm`. Without this a retry charges twice, because the server credits an intent once.
6. **On return:** store `{intentId, signature}` under `pokejam.shop.usdc`, and the existing `resumeUsdc` and server confirm finish it. The server already credits only after reading the payment on-chain.

The relay, `nacl.ts` and the callback code are reusable as they are, though the relay's `d` field would need checking against a transaction answer's size (it's just a signature, so 4 KB is plenty).
