import { defineConfig, type Plugin } from 'vite';

/**
 * Content Security Policy for the deployed site. GitHub Pages can't send response headers, so the policy
 * ships as a <meta> tag (build only: the dev server needs inline scripts and websockets for hot reload).
 * Everything the game uses comes from its own origin; inline style attributes carry team colors.
 */
const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self'",
  "manifest-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "object-src 'none'",
  'upgrade-insecure-requests',
].join('; ');

const securityHeaders = (): Plugin => ({
  name: 'security-meta',
  apply: 'build',
  transformIndexHtml: () => [
    { tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' },
    { tag: 'meta', attrs: { name: 'referrer', content: 'no-referrer' }, injectTo: 'head-prepend' },
  ],
});

export default defineConfig({
  base: './',
  plugins: [securityHeaders()],
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
});
