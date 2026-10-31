/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MODE_SOCIAL?: string;
  readonly VITE_MODE_RANKED?: string;
  readonly VITE_MODE_PACK_BATTLES?: string;
  readonly VITE_MODE_ADS?: string;
  /** The pokejam-ads endpoint, when it isn't the Supabase project's Edge Function (local development). */
  readonly VITE_ADS_API?: string;
  /** Supabase project URL and publishable (anon) key for online play. Public by design; never the service-role key. */
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** Which build a crash report came from (e.g. the commit); set by the deploy. */
  readonly VITE_BUILD_ID?: string;
  /** Cloudflare Turnstile site key: when set, a bot check runs before a first anonymous sign-in. */
  readonly VITE_TURNSTILE_SITE_KEY?: string;
}
