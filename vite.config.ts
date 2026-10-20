import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    rollupOptions: {
      output: {
        entryFileNames: 'assets/game.js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
});
