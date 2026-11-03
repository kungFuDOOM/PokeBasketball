/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MODE_SOCIAL?: string;
  readonly VITE_MODE_RANKED?: string;
  readonly VITE_MODE_PACK_BATTLES?: string;
  readonly VITE_MODE_ADS?: string;
  /**
   * Full URL of the live ads Edge Function (pokejam-ads-live). Optional: unset, the client uses
   * VITE_SUPABASE_URL + /functions/v1/pokejam-ads-live. Set it for local development or a function hosted elsewhere;
   * builds require https and add its origin to the CSP's connect-src (vite.config.ts adsApiOrigin).
   */
  readonly VITE_ADS_API?: string;
  /** "true" once judge_authoritative is on in pokejam_config: Ranked stops a game after 3 resyncs instead of 12. */
  readonly VITE_JUDGE_AUTHORITATIVE?: string;
  /** "true" shows the Rank Shield shop (needs Ranked). Stripe keys never go in the build: they are Supabase secrets. */
  readonly VITE_SHIELD_SHOP?: string;
  /** "true" adds "Pay with USDC" to the shop for players signed in with Phantom (needs the shop). */
  readonly VITE_SHIELD_USDC?: string;
  /** "mainnet-beta" shows real USDC; anything else is devnet test USDC. Display only: the server decides the cluster. */
  readonly VITE_SHIELD_USDC_CLUSTER?: string;
  /** "true" offers Discord sign-in for Ranked next to Phantom; anything else is Phantom-only. */
  readonly VITE_SIGNIN_DISCORD?: string;
  /** Supabase project URL and publishable (anon) key for online play. Public by design; never the service-role key. */
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** Which build a crash report came from (e.g. the commit); set by the deploy. */
  readonly VITE_BUILD_ID?: string;
  /** Cloudflare Turnstile site key: when set, a bot check runs before a first anonymous sign-in. */
  readonly VITE_TURNSTILE_SITE_KEY?: string;
}

/** Replaced at build time (vite.config.ts): VITE_BUILD_ID, or a timestamp when that is unset. Also written to build-id.txt for the stale-bundle check. */
declare const __PJ_BUILD__: string | undefined;
