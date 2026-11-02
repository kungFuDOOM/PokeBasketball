# Sign in with Phantom on phones

Phantom injects `window.phantom.solana` only in its desktop extension and its in-app browser, and the in-app browser can't do landscape.
On iOS Safari, the iOS home-screen app and Android Chrome, sign-in now hands off to the Phantom app through its universal links.
Where the wallet is injected, nothing changed: `signInWithPhantom` in `src/wallet/phantom.ts` still runs.

| File | What it does |
| --- | --- |
| `src/wallet/phantomLink.ts` | The rules: links, encryption, callback parsing, state, expiry, the sign-in message, relay calls. No DOM. |
| `src/wallet/phantomHandoff.ts` | The home-screen app path: the app's handoff, Safari finishing the sign-in alone, and the sealed refresh token between them. No DOM. |
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

## The home-screen app (iPhone): Safari finishes, the app collects

Phantom's redirect **always opens Safari, never the standalone app**, and the two have separate storage. The old design bounced the
player app, Phantom, Safari, back by hand, tap, Phantom, Safari, back by hand, and relied on the app's `sessionStorage` surviving in
the background (iOS often kills or reloads a backgrounded home-screen app). So when `isStandalone` is true, Safari does the whole
sign-in and the app only collects the result:

1. **App, on the tap.** Makes a fresh *dapp* x25519 key for Phantom and a separate *handoff* x25519 key plus a random 32-byte handoff
   id. It keeps only `{id, handoff secret, returnTo, expiresAt}` in **localStorage** (`pokejam.phantom.handoff`, 10 minutes), so an iOS
   reload loses nothing. The connect `redirect_link` carries `pj_phantom` (trip id), `pj_h` (handoff id), `pj_hk` (handoff **public** key)
   and `pj_ds` (the dapp secret, which only decrypts this trip's connect and sign answers). The app shows "Approve in Phantom. It
   finishes in Safari, then come back here." with a 4-character check code, and polls the relay for the handoff id (every 2.5 s and on
   `visibilitychange`/`pageshow`/`focus`).
2. **Safari lands.** `public/phantom-return.js` strips every param before analytics. Safari decrypts the connect answer with `pj_ds`,
   keeps the trip (session, wallet, nonce, message) in **its own** localStorage (`pokejam.phantom.landing`, 10 minutes) and shows
   **Sign in Phantom** and the same check code. A tap is required.
3. **Second trip.** The tap follows `signMessage`; its `redirect_link` repeats the handoff params, so Safari needs nothing from the app.
   Safari verifies wallet, nonce and expiry and calls `signInWithWeb3`.
4. **Hand-over.** Safari seals `{rt: <refresh token>}` (nothing else) to the handoff public key with a one-use key and a fresh nonce, and
   puts `{k, n, d}` in the relay under the handoff id. It then signs itself out with `signOut({ scope: 'local' })`: that clears Safari
   only and does **not** revoke the session the app is about to use. Safari says "Signed in — go back to the PokeJam app on your home screen."
5. **App restores.** It takes the row (deleted by the read), wipes its handoff, opens the box and calls
   `supabase.auth.refreshSession({ refresh_token })`, then reloads into Ranked/Profile like the other paths. Rotation means Safari's copy
   of the token is dead anyway.

Cancel, failure and expiry wipe both sides. If Safari fails or the player cancels there, it leaves an error code in the relay so the app
stops waiting.

## Which tab gets the answer (everything that is not the home-screen app)

The tab Phantom lands in only sometimes holds the key. On Safari or Chrome an app opening a link commonly gets a *new tab*, and
`sessionStorage` is per tab. The landing page decides by whether it holds the key:

- It holds the pending id: it carries on by itself.
- It doesn't: it posts the still-encrypted answer to the relay and says "Go back to the PokeJam tab". The tab that started the
  sign-in polls, fetches the ciphertext, and decrypts it.

The in-tab and injected-provider paths are unchanged.

## Security

- In-tab sign-ins: the dapp key, the Phantom session and pending state live only in `sessionStorage` under `pokejam.phantom.pending`, and are wiped on
  success, failure, cancel and expiry (10 minutes). Nothing logs them.
- Home-screen sign-ins use localStorage on purpose, with a 10-minute expiry and a wipe on success, failure, cancel and expiry: the app holds
  only the handoff secret; Safari holds the dapp secret and Phantom session until the second trip ends. Plus the existing "reopen Ranked" marker.
- The dapp secret is in a URL, but only the URL Phantom already holds for this trip. It is **never sent to our server**: the relay gets the
  sealed token only. It decrypts one trip's connect and sign answers and signs nothing. `phantom-return.js` removes it from the address bar and
  history before analytics, and `resumePhantom` clears the in-memory copy.
- The relay payload is `{k, n, d}`: the refresh token never appears in the clear, and the handoff secret never leaves the app. A wrong key,
  tampered box or junk body all fail with the same message, and the handoff is wiped.
- **Residual risk (phishing).** Whoever builds a link with *their own* handoff key can send it to someone, who approves it in Phantom and signs,
  and the attacker's app would receive the victim's session. Phantom shows "pokejam.xyz", so it can't be ruled out in code. The check code
  is the mitigation: Safari shows the code of the sign-in it is finishing, the app shows its own, and a player who didn't just start one on
  their home-screen app sees no matching code. Don't remove the code from either screen.
- Each trip has a 32-byte random id, used up when its answer is applied. A forged or replayed callback goes nowhere: at worst it stores junk
  in the relay under an id nobody is polling. Local state isn't touched.
- Phantom's `errorMessage` is dropped, not shown: anyone can write it into a link.
- The callback leaves the URL (`replaceState`) in a classic script before Google Analytics, the Cloudflare beacon or the error reporter run.
- A hostile connect answer can't sign anyone in: the player's real Phantom can't decrypt a request sealed to another key, and Supabase checks the signature against the address in the message.

The relay stores ciphertext only: the SQL refuses any field but a public key, nonce and box, or a numeric code. The home-screen handoff fits that
shape (`k` is Safari's one-use key), so **it needs no new migration**; `supabase/tests/phantom-relay.test.ts` checks it, including that a token
in the clear is refused. Rows last 5 minutes and are
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
- The home-screen app no longer needs its page to survive in the background: its state is in localStorage, and polling resumes on reload. Confirm that.
- Phantom shows the message as text, and Supabase accepts the signature in production.

### Phone test steps (iPhone, home-screen app)

Needs a build with `VITE_MODE_RANKED=true`, the production relay migration applied, and Phantom installed. Add PokeJam to the home screen.

1. Open the **home-screen app**, go to Ranked, tap **Sign in with Phantom**. Phantom opens. The app (if you look back) shows "Approve in Phantom…" and a check code.
2. Approve the connection. You land in **Safari** on PokeJam with **Sign in Phantom** and the **same check code**. The address bar shows no `pj_` params.
3. Tap **Sign in Phantom**, approve the message in Phantom. You land in Safari: "Signed in — go back to the PokeJam app on your home screen."
4. Switch to the home-screen app by hand. Within a few seconds it reloads into Ranked, signed in. Safari is signed out.
5. Repeat, but force-quit the home-screen app between steps 1 and 4 and reopen it: it should still pick the sign-in up (for 10 minutes).
6. Repeat, tapping **Cancel** in Phantom on the first trip: the app should show "Sign-in cancelled".
7. Control: sign-in from plain Safari and from the Phantom in-app browser still work as before.

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
