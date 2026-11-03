# Ranked sign-in: owner setup

Ranked needs a real account. Guests (Supabase anonymous users) can still play Social and offline; the Ranked screen shows a
sign-in panel instead of Find match, and the server refuses guests (migration `20261113_pokejam_ranked_signin.sql`).

Two ways to sign in. Both can play Ranked. The public name is the username picked in the game. The Discord email and the Discord
username are never shown.

- **Continue with Discord** (`signInWithOAuth`, provider `discord`, scopes `identify email`). A plain sign-in. It does not link the guest account.
  Set `VITE_SIGNIN_DISCORD=false` to hide the button. It is on otherwise.
- **Continue with Phantom** (Sign in with Solana, `signInWithWeb3`). Unchanged. No transaction, no payment: the wallet only
  signs the login message. Phones without an injected wallet hand off to the Phantom app: see
  [`phantom-mobile-signin.md`](phantom-mobile-signin.md).

Buying Rank Shields with USDC needs a Phantom wallet on that same account. A Discord player taps **Link Phantom to buy**.
`supabase-js` `linkIdentity` accepts OAuth and ID-token credentials only, not `signInWithWeb3`, so the wallet is not a second
Supabase identity. The player signs a one-time message, `pokejam-link-wallet` checks the signature, and
`pokejam_link_wallet` stores the address on that user id. Rank, history and shields stay, because they are already stored
under that id. One wallet, one account. Payments with no wallet are refused (`no_wallet`) and the shop shows the link step.

Nothing below has been done for you. Do the Discord steps by hand before this ships. The migration and the `pokejam-link-wallet` deploy (see "Linking Phantom") are still to do. Do not change anything else in Auth.

## 1. Discord Developer Portal (OAuth app)

1. [Discord Developer Portal](https://discord.com/developers/applications) → the application **PokeJam** (client ID
   `1567235435678408704`).
2. **OAuth2 → Redirects**: add **`https://ksvfgxodbwfntqnahukn.supabase.co/auth/v1/callback`** and save.
3. Scopes requested by the game: `identify` and `email` (the game asks for exactly these). Nothing else is needed.
4. **OAuth2 → Client Secret**: copy it (reset it if you no longer have it).

## 2. Supabase dashboard

Project `ksvfgxodbwfntqnahukn` (the shared gauntlet-legends project):

1. **Authentication → Sign In / Providers → Discord**: enable, paste the Client ID (`1567235435678408704`) and the Client
   Secret, save.
2. **Web3 Wallet / Solana** stays on. Do not change it.
3. **Authentication → URL Configuration** already allows `https://pokejam.xyz/**` and `https://www.pokejam.xyz/**`. Leave it.
   That covers the Discord return, including the `?pj_discord=` handoff query. (Add `http://localhost:5173/**` for local
   testing if wanted.)
4. Manual linking is not used and stays as it is. This flow does not use `linkIdentity`.
5. Keep **Anonymous sign-ins** on (guests still play Social). Web3 Solana stays on (Phantom sign-in).

## iPhone home screen and Safari

Discord's redirect always opens Safari, never the installed home-screen app, and the two do not share storage. The PKCE code
verifier has to be created in the browser that comes back, so the app does not start OAuth itself.

1. The app makes a handoff key, shows a 4-character check code, and opens Safari on `/?pj_discord=…&pj_gk=…`.
2. Safari starts `signInWithOAuth` and Discord returns to Safari. `public/discord-return.js` takes the code out of the address
   bar before analytics. A throwaway client (`pokejam.discord.oauth`, not `pokejam.auth`) exchanges it.
3. Safari seals the refresh token to the app's key and puts it in the existing Phantom relay. It does not sign out: that
   would revoke the session.
4. The player switches back to the app. The app calls `refreshSession` and reloads into Ranked.

A normal Safari or desktop tab just redirects in place. The check code is the same idea as Phantom sign-in: the Safari page
and the app show the same code, so a link the player did not start does not match. Phantom sign-in is a separate path and
is not changed.

## Linking Phantom, and abuse

Apply `supabase/migrations/20261209_pokejam_discord_signin.sql` (it is not applied by the repo), then deploy the
`pokejam-link-wallet` Edge Function. Without the function the link button cannot store a wallet. USDC payments read the
linked address with `pokejam_linked_wallet` after the identity check, and still refuse a player with neither.

Discord accounts are cheap. What already applied still applies, per user id: 5 placement matches before a rank is shown,
bans, the human check when it is on, the judge, and the matchmaking rate limit. On top of that, an account created in the
last 24 hours can start at most 10 ranked matches that day (enough to place and play a few). Every match that got an
opponent counts, so leaving does not reset it. After a day the cap is gone. A new Discord account is a new user id; the cap
slows a pile of new accounts, and a ban does not follow them. The email is not stored in our tables and is not on the
leaderboard.

## 3. Database

Run `supabase/migrations/20261113_pokejam_ranked_signin.sql` in the SQL editor, after `20261111` and `20261112`.
It is additive (`create or replace` only). It:

- adds `pokejam_ranked_require_member()` and calls it first in the Ranked queue path (`pokejam_ranked_find`) and in
  `pokejam_ranked_report_score`, `pokejam_report_result` (Ranked matches only) and `pokejam_ranked_forfeit`; a JWT with
  `is_anonymous = true` gets "Ranked needs a signed-in account". Social is untouched.
- closes the late dodge (see below).

## 4. Turning Ranked on

Ranked stays "Coming soon" until the build has `VITE_MODE_RANKED=true`. On the dev server only, `?ranked=1` shows it for
screenshots and work; a production build ignores that parameter. Order: Discord + Supabase settings, migrations
`20261111` → `20261113`, then flip the flag.

## The late dodge (migration 20261113)

PR 2 let anyone who left more than 30 s after the pairing, with nobody connected, walk away free. Now the server asks who
turned up (registered their evidence key, which the client does the moment it starts connecting, or sent a game heartbeat):

| Leave with no game heartbeat from anyone | Result |
|---|---|
| within 30 s of the pairing | the leaver takes the dodge (max-cost loss, leave count, cooldown ladder) |
| later, the leaver never showed up and the other did | the leaver takes the dodge |
| later, the leaver showed up and the other did not | match void; the one who never showed up takes the dodge; the stayer loses nothing |
| later, both or neither showed up | failed connection: void, nobody charged |

The 90 s sweep applies the same rule to a dodger who just sits there. Limit: the key is a client call, so someone who calls
it without connecting looks like they showed up and gets the "failed connection" result.

## Wallet helper

`src/wallet/phantom.ts` (no Pack Battles, token or payment code): `getPhantomProvider`, `isPhantomInstalled`, `isMobile`,
`phantomDeepLink`, `phantomAction`, `signInWithPhantom`, `getSolanaAddress`. Reusable by Pack Battles later.
