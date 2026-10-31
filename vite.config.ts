import { defineConfig, loadEnv, type Plugin } from 'vite';

/**
 * Content Security Policy for the deployed site. GitHub Pages can't send response headers, so the policy
 * ships as a <meta> tag (build only: the dev server needs inline scripts and websockets for hot reload).
 * Everything the game uses comes from its own origin; inline style attributes carry team colors.
 */
const TURNSTILE = 'https://challenges.cloudflare.com';
const CF_ANALYTICS = 'https://static.cloudflareinsights.com';
// Google Analytics 4 (public/ga.js), on the public pages only: the admin page keeps the policy without it.
const GA = 'https://www.googletagmanager.com https://*.google-analytics.com https://*.analytics.google.com';
/**
 * The extra connect-src origin for the ads endpoint (pokejam-ads-live), when VITE_ADS_API points somewhere other than the
 * Supabase project, whose origin is already allowed. The client never calls a Solana RPC itself (the wallet sends the
 * transaction and the Edge Function does all chain reads), so no RPC host is added. Fails the build on a URL that isn't
 * https: the policy below upgrades insecure requests, so a plain-http endpoint would silently break booking.
 */
export const adsApiOrigin = (adsApi: string | undefined, supabaseUrl: string | undefined): string | undefined => {
  if (!adsApi) return undefined;
  let url: URL;
  try { url = new URL(adsApi); } catch { throw new Error(`VITE_ADS_API is not a valid URL: ${adsApi}`); }
  if (url.protocol !== 'https:') throw new Error(`VITE_ADS_API must be https in a build: ${adsApi}`);
  return supabaseUrl && new URL(supabaseUrl).origin === url.origin ? undefined : url.origin;
};

export const csp = (supabaseUrl: string | undefined, captcha: boolean, analytics: boolean, adsApi?: string) => [
  "default-src 'none'",
  // The bot check before a first online sign-in (Cloudflare Turnstile) loads its script and widget frame. Cloudflare Web Analytics loads its beacon script and reports to cloudflareinsights.com.
  `script-src 'self' ${CF_ANALYTICS}${captcha ? ` ${TURNSTILE}` : ''}${analytics ? ` ${GA}` : ''}`,
  ...(captcha ? [`frame-src ${TURNSTILE}`] : []),
  "style-src 'self' 'unsafe-inline'",
  `img-src 'self' data:${analytics ? ` ${GA}` : ''}`,
  "font-src 'self'",
  // Online play talks to the configured Supabase project only (REST over https, Realtime over wss), plus the analytics beacon.
  // Courtside ads go through the project's pokejam-ads-live Edge Function, or VITE_ADS_API when it lives elsewhere (adsApiOrigin).
  `connect-src 'self' https://cloudflareinsights.com${supabaseUrl ? ` ${new URL(supabaseUrl).origin} ${new URL(supabaseUrl).origin.replace(/^https:/, 'wss:')}` : ''}${analytics ? ` ${GA}` : ''}${adsApiOrigin(adsApi, supabaseUrl) ? ` ${adsApiOrigin(adsApi, supabaseUrl)}` : ''}`,
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
  'upgrade-insecure-requests',
].join('; ');

const securityHeaders = (supabaseUrl: string | undefined, captcha: boolean, adsApi?: string): Plugin => ({
  name: 'security-meta',
  apply: 'build',
  transformIndexHtml: (_html, ctx) => [
    // admin.html (vite.admin.config.ts) gets no analytics, so its policy stays without the GA hosts.
    { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: csp(supabaseUrl, captcha, !/(^|[\\/])admin\.html$/.test(ctx.filename), adsApi) }, injectTo: 'head-prepend' },
    { tag: 'meta', attrs: { name: 'referrer', content: 'no-referrer' }, injectTo: 'head-prepend' },
  ],
});

export default defineConfig(({ mode }) => ({
  base: './',
  plugins: [(() => {
    // '.' is the working directory, as process.cwd() (spelled this way so src/csp.test.ts can type-check this file without Node types).
    const env = loadEnv(mode, '.', 'VITE_');
    return securityHeaders(env.VITE_SUPABASE_URL, !!env.VITE_TURNSTILE_SITE_KEY, env.VITE_ADS_API || undefined);
  })()],
  build: {
    // Older iPads (iPadOS 13/14, Safari 12-14) and Android WebViews: lower ?. ?? ??= instead of shipping them as written.
    target: ['es2019', 'chrome70', 'safari12', 'firefox68', 'edge79'],
    rollupOptions: {
      output: {
        entryFileNames: 'assets/game.js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
}));
