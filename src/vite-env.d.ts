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
  /** Supabase project URL and publishable (anon) key for online play. Public by design; never the service-role key. */
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** Which build a crash report came from (e.g. the commit); set by the deploy. */
  readonly VITE_BUILD_ID?: string;
  /** Cloudflare Turnstile site key: when set, a bot check runs before a first anonymous sign-in. */
  readonly VITE_TURNSTILE_SITE_KEY?: string;
}
