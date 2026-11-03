# Sign in with Phantom on phones

Phantom injects `window.phantom.solana` only in its desktop extension and its in-app browser, and the in-app browser can't do landscape.
On iOS Safari, the iOS home-screen app and Android Chrome, sign-in now hands off to the Phantom app through its universal links.
Where the wallet is injected, nothing changed: `signInWithPhantom` in `src/wallet/phantom.ts` still runs.

| File | What it does |
| --- | --- |
| `src/wallet/phantomLink.ts` | The rules: links, encryption, callback parsing, state, expiry, the sign-in message, relay calls. No DOM. |
| `src/wallet/phantomHandoff.ts` | The home-screen app path: the app's handoff, Safari finishing the sign-in alone, and the sealed refresh token between them. No DOM. |
| `src/wallet/phantomDiag.ts` | Step-specific messages, the diagnostic code, and the numeric code Safari leaves in the relay. No DOM. |
| `src/wallet/staleBuild.ts` | Reloads before a sign-in if a newer build is live (see below). |
| `src/wallet/nacl.ts` | x25519 + xsalsa20-poly1305. WebCrypto has neither on the browsers we support, and this avoids a dependency. |
| `src/wallet/phantomSheet.ts`, `phantomView.ts` | The status sheet and what the page does on return. |
| `public/phantom-return.js` | Takes the callback out of the URL before analytics load. |
| `supabase/migrations/20261202_pokejam_phantom_relay.sql` | The relay. |

## The flow

1. The tap on **Sign in with Phantom** makes a fresh x25519 key and a one-time id, and follows `phantom.com/ul/v1/connect`.
2. Phantom approves and redirects to `https://pokejam.xyz/?pj_phantom=<id>&...` with an encrypted `{public_key, session}`.
3. The page builds the Sign in with Solana message (with `Chain ID: solana:mainnet`, see below) and shows a **Sign in Phantom** button. It must be a button: a universal link opens
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
   Safari verifies wallet, nonce and expiry and calls `signInWithWeb3` on a **throwaway client** (`ephemeralAuthClient()`:
   memory storage, `persistSession: false`, `autoRefreshToken: false`, `detectSessionInUrl: false`), so Safari stores nothing, never
   rotates the token, and leaves its own `pokejam.auth` guest session alone.
4. **Hand-over.** Safari seals `{rt: <refresh token>}` (nothing else) to the handoff public key with a one-use key and a fresh nonce, and
   puts `{k, n, d}` in the relay under the handoff id. It **never** signs out: Supabase's `/logout`, even with `scope: 'local'`,
   revokes that session on the server, so the app's refresh failed with `refresh_token_not_found` (PJ-RF-400). The throwaway
   client simply goes away with the page. Safari says "Signed in — go back to the PokeJam app on your home screen."
5. **App restores.** It takes the row (deleted by the read), wipes its handoff, opens the box and calls
   `supabase.auth.refreshSession({ refresh_token })` (only one restore runs at a time, so the poll and `visibilitychange` cannot
   race to spend the single-use token), then reloads into Ranked/Profile like the other paths. Rotation means Safari's copy
   of the token is dead anyway.

Cancel, failure and expiry wipe both sides. If Safari fails or the player cancels there, it leaves an error code in the relay so the app
stops waiting.

## iOS: the return link always opens Safari (honest note)

On iOS, Phantom's `redirect_link` opens **Safari**, never the home-screen app, and there is no way to make it do otherwise. So a sign-in
started in the home-screen app always has a Safari step (the app can't finish it alone), and the player has to switch back to the
home-screen app **by hand** afterwards. The app picks the result up within a few seconds of becoming visible. That is a limit of iOS and of
Phantom's deeplinks, not something this code can hide; the copy on both screens says so.

## The Chain ID bug (live, fixed)

`buildSiwsMessage` used to write `Chain ID: mainnet`. Supabase Auth validates it with `^solana:(main|dev|test|local)net$` and answered
`400 validation_failed "siws: Chain ID is not valid"`, so the deeplink path never signed anyone in. It now writes `Chain ID: solana:mainnet`
(`SIWS_CHAIN_ID`). The extension path doesn't pass a `chainId`, so supabase-js leaves the line out, which the server accepts.

`src/wallet/siwsServerRules.test.ts` encodes the server's rules and checks our message against them: Chain ID regexp (or absent), https URI
(or localhost) on the redirect allow list, Domain equal to the URI host, RFC 3339 Issued At within 10 minutes of now either way, Expiration
Time and Not Before respected, at most 20 KB, and a 64-byte signature (checked in `advance`).

## Diagnostic codes

Every failure the player sees in this flow shows a plain sentence and, under it, a small code:

    PJ-<step>[-<HTTP status>-<reason>] · <context> · <standalone signal> · b<build>        e.g.  PJ-W3-400-CHAIN · app · sa:nav · b1a2b3c

- **context**: `app` = the standalone home-screen app, `safari` = the landing page finishing (or passing on) a handoff, `tab` = the normal in-tab flow.
- **standalone signal**: what `isStandalone()` saw on *this* page: `sa:nav` (`navigator.standalone`, checked first), `sa:standalone`, `sa:fullscreen`,
  `sa:minimal-ui` (the `display-mode` media query), or `sa:no`. Safari's own page is normally `sa:no`.
- **build**: the first 7 characters of `VITE_BUILD_ID` (`b` + id), or `bdev`. An old bundle resumed from memory shows up here.
- The code never contains ids, keys, wallet addresses, nonces, tokens or server text; an unknown key prints as `UNK`.

| Step key | Message | Meaning | Relay code |
| --- | --- | --- | --- |
| `CN-READ` | Phantom's connect answer couldn't be read | Missing, undecryptable or wrong-shaped connect answer | 100 |
| `CN-PH` | Phantom couldn't finish connecting | Phantom returned an error code on connect | 101 |
| `SG-READ` | Phantom's signature answer couldn't be read | Missing, undecryptable, or not 64 bytes | 110 |
| `SG-PH` | Phantom couldn't finish signing | Phantom returned an error code on sign | 111 |
| `EXP` | This sign-in expired | Older than 10 minutes | 120 |
| `MIS` | That sign-in didn't match | Message wallet or nonce differs from the trip | 130 |
| `STATE` | This sign-in couldn't be continued | Saved state missing or from an older build | 131 |
| `CXL` | Cancelled in Phantom | The player said no (error 4001). Not shown in red | 4001 |
| `PH-UNK` | Phantom couldn't finish that | An error code we don't know (older builds always send this) | 1 |
| `W3-<status>-<reason>` | Signing in was refused by the server | `signInWithWeb3` failed (Safari, or the in-tab flow) | 20000 + reason index × 1000 + status |
| `RF-<status>-<reason>` | The app couldn't use the handed-back sign-in | `refreshSession` failed in the app | local |
| `HO-PUT` | Couldn't hand the sign-in back to the app | Safari signed in but the relay write failed | local |
| `HO-PASS` | Couldn't pass Phantom's answer back to PokeJam | A landing tab couldn't leave the answer for the tab that holds the key | local |
| `HB-READ` | The app couldn't read the handed-back sign-in | The sealed box didn't open | local |
| `UNK` | Couldn't sign in with Phantom | Anything unexpected | local (sent as 1) |

Reason tokens for `W3`/`RF`, from the HTTP status and Supabase's `error_code`/message (raw text is never kept): `CHAIN` (Chain ID), `URI`
(redirect URI), `DOMAIN`, `EXPIRED` (expiration / Issued At window), `SIG` (signature), `RATE` (429), `NET` (status 0, no answer), `SRV` (5xx),
`DISABLED` (Web3 provider off), `OTHER`. Reason indexes, in that order of the list in `phantomDiag.ts`: OTHER 0, CHAIN 1, URI 2, DOMAIN 3, EXPIRED 4,
SIG 5, RATE 6, NET 7, SRV 8, DISABLED 9. "Local" steps happen on one page and can't be reported through the relay, so a waiting app that
gets `1` shows `PH-UNK`. Relay codes always match `^-?[0-9]{1,6}$`, so no migration is needed.

## Stale bundle guard

An iOS home-screen app can be resumed from memory with a JavaScript bundle from before the last deploy (`assets/game.js` isn't hashed and is
cached for 10 minutes), which would run old sign-in code. `vite.config.ts` writes `build-id.txt` (the `VITE_BUILD_ID`, or a timestamp) next to
`index.html`, and bakes the same id into the bundle (`__PJ_BUILD__`). When the sign-in panel (the one with the Phantom button) is drawn, and
whenever the page becomes visible again while that button is on screen, `staleBuild.ts` fetches it with `cache: 'no-store'` and reloads once if it
differs. It never runs during a match, skips while a sign-in is under way, is throttled to once per 20 s, stays silent on any network problem, and
won't reload twice for the same live build (so a cache that keeps serving old code can't loop). `dev` builds never reload. A pending/handoff
record left by an older build is validated field by field and wiped if unusable; if anything still throws, the sheet shows `STATE`.

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

## Paying from Safari and the home-screen app

Courtside ads (burn $PJAM or pay USDC) and Rank Shield USDC use the same deeplink when no wallet is injected. Inside Phantom's browser and on desktop with the extension, the injected `signAndSendTransaction` is unchanged.

`src/wallet/phantomPay.ts` builds the links. A saved Phantom session (from sign-in, or from a payment connect) skips connect. Otherwise the first tap opens `/ul/v1/connect`. The server still builds the transaction (the browser never calls a Solana RPC). A second tap opens `/ul/v1/signAndSendTransaction` with `{transaction, session}` encrypted to Phantom's key. That link is rebuilt if it is older than 45 seconds, because the blockhash goes stale. Phantom's docs mark this deeplink deprecated in favour of `signTransaction`, which does not submit; we still use it so Phantom submits and the existing confirm endpoints can read the payment. A phone test has to confirm the app still does.

The redirect always opens Safari. If Safari holds the trip it decrypts the signature and confirms. If it doesn't (the home-screen app, or a new tab), it leaves Phantom's encrypted reply in the same relay and shows the 4-character check code. The starter polls every 2.5 seconds, decrypts, and confirms that trip's own booking or intent. The relay still accepts only `{k, n, d}` or an error code: no session token and no signature in the clear. One player's reply cannot confirm another's booking, because the booking id is the one stored on the device that started the payment, and the server still checks signer, amount, memo and reference.

The signature is written to the same pending records as the injected flow (`pokejam.adPending`, `pokejam.adUsdcPending`, `pokejam.shop.usdc.<intentId>`), and confirm is the existing `pokejam-ads-live` or `shield-usdc-confirm` call. No new migration.

### What only a real iPhone can confirm

- A tap from Safari and from the home-screen app opens Phantom for connect and for signAndSendTransaction, and Phantom still submits the transaction (the deeplink is marked deprecated).
- The return lands in Safari, the check codes match, and switching back to the home-screen app confirms the ad or the shields within a few seconds.
- Paying again reuses the session and does not ask to connect.
- Rejecting in Phantom leaves the player uncharged, and the injected wallet on desktop still pays as before.
