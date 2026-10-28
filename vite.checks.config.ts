// Builds browser check pages (not part of the game build): npx vite build -c vite.checks.config.ts
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  publicDir: false,
  build: { outDir: 'checks-out', emptyOutDir: true, rollupOptions: { input: { 'rtc-check': 'rtc-check.html' } } },
});
