# Ranked sign-in: owner setup

Ranked needs a real account. Guests (Supabase anonymous users) can still play Social and offline; the Ranked screen shows a
sign-in panel instead of Find match, and the server refuses guests (migration `20261113_pokejam_ranked_signin.sql`).

Two ways to sign in:

- **Google** (OAuth). A guest who taps it is *linked* (`linkIdentity`), so their name and stats carry over. If linking is off
  or that Google account already has a PokeJam account, it falls back to a normal Google sign-in (that account opens instead).
- **Phantom** (Sign in with Solana, `signInWithWeb3`). Supabase cannot link a wallet to a guest account, so this is a fresh
  account. No transaction, no payment: the wallet only signs the login message.

**Launch flag:** Google is hidden unless the build sets `VITE_SIGNIN_GOOGLE=true` (`SIGNIN_GOOGLE` in `src/config/features.ts`);
by default Ranked sign-in is Phantom-only, so the Google setup in section 1 can wait until the flag is turned on.

Nothing below has been done for you. Do these by hand in the dashboards, **before** turning Ranked on.

## 1. Google Cloud (OAuth client)

1. Google Cloud console → pick or create a project → **APIs & Services → OAuth consent screen**: External, app name
   "PokeJam", support email, authorised domain `pokejam.xyz` and `supabase.co`. Scopes: `openid`, `email`, `profile` only.
   Publish the app (Testing mode limits sign-in to listed test users).
2. **APIs & Services → Credentials → Create credentials → OAuth client ID**, type **Web application**.
   - Authorised JavaScript origins: `https://pokejam.xyz`
   - **Authorised redirect URI: `https://ksvfgxodbwfntqnahukn.supabase.co/auth/v1/callback`**
3. Copy the Client ID and Client secret.

## 2. Supabase dashboard

Project `ksvfgxodbwfntqnahukn` (the shared gauntlet-legends project):

1. **Authentication → Sign In / Providers → Google**: enable, paste the Client ID and Client secret, save.
2. **Authentication → Sign In / Providers → Web3 Wallet**: enable **Solana**. (Wallet sign-in needs the Web3 provider on;
   with Auth CAPTCHA on, `signInWithWeb3` passes no token, so check wallet sign-in works on a preview first.)
3. **Authentication → URL Configuration**:
   - Site URL: `https://pokejam.xyz`
   - Redirect URLs: add `https://pokejam.xyz` and `https://pokejam.xyz/**` (add `http://localhost:5173/**` for local testing if wanted).
4. **Authentication → Sign In / Providers → Allow manual linking: ON.** `linkIdentity` (guest → Google, keeping stats)
   needs it. Without it the client falls back to a plain Google sign-in and a guest's stats stay on the guest account.
5. Keep **Anonymous sign-ins** on (guests still play Social).

## 3. Database

Run `supabase/migrations/20261113_pokejam_ranked_signin.sql` in the SQL editor, after `20261111` and `20261112`.
It is additive (`create or replace` only). It:

- adds `pokejam_ranked_require_member()` and calls it first in the Ranked queue path (`pokejam_ranked_find`) and in
  `pokejam_ranked_report_score`, `pokejam_report_result` (Ranked matches only) and `pokejam_ranked_forfeit`; a JWT with
  `is_anonymous = true` gets "Ranked needs a signed-in account". Social is untouched.
- closes the late dodge (see below).

## 4. Turning Ranked on

Ranked stays "Coming soon" until the build has `VITE_MODE_RANKED=true`. On the dev server only, `?ranked=1` shows it for
screenshots and work; a production build ignores that parameter. Order: Google + Supabase settings, migrations
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
