/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_MODE_SOCIAL?: string;
  readonly VITE_MODE_RANKED?: string;
  readonly VITE_MODE_PACK_BATTLES?: string;
  /** "true" shows the Rank Shield shop (needs Ranked). Stripe keys never go in the build: they are Supabase secrets. */
  readonly VITE_SHIELD_SHOP?: string;
  /** Supabase project URL and publishable (anon) key for online play. Public by design; never the service-role key. */
  readonly VITE_SUPABASE_URL?: string;
  readonly VITE_SUPABASE_ANON_KEY?: string;
  /** Which build a crash report came from (e.g. the commit); set by the deploy. */
  readonly VITE_BUILD_ID?: string;
  /** Cloudflare Turnstile site key: when set, a bot check runs before a first anonymous sign-in. */
  readonly VITE_TURNSTILE_SITE_KEY?: string;
}
