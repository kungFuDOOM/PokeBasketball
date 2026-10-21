import { defineConfig, type Plugin } from 'vite';

/**
 * Content Security Policy for the deployed site. GitHub Pages can't send response headers, so the policy
 * ships as a <meta> tag (build only: the dev server needs inline scripts and websockets for hot reload).
 * Everything the game uses comes from its own origin; inline style attributes carry team colors.
 */
// The Pack Battles server, when the build targets one (VITE_API_URL=https://api.example.com npm run build).
const API = process.env.VITE_API_URL ? new URL(process.env.VITE_API_URL) : null;
const apiOrigins = API ? ` ${API.origin} ${API.protocol === 'https:' ? 'wss' : 'ws'}://${API.host}` : '';

const CSP = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  // Collector Crypt card images (the card a battle is played for).
  "img-src 'self' data: https://nft.collectorcrypt.com https://d1xpxki1g4htqu.cloudfront.net https://cdn.helius-rpc.com https://arweave.net",
  "font-src 'self'",
  `connect-src 'self'${apiOrigins}`,
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
    rollupOptions: {
      output: {
        entryFileNames: 'assets/game.js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
