// The moderation page (admin.html) as its own build, so the game's bundle and file names stay exactly as they are.
// It runs after the game build and adds admin.html and assets/admin-*.{js,css} to the same dist/.
// It isn't linked from the game, and it shows nothing to anyone who isn't a listed moderator.
import { defineConfig, mergeConfig } from 'vite';
import game from './vite.config';

export default defineConfig((env) => mergeConfig(typeof game === 'function' ? game(env) : game, {
  build: {
    emptyOutDir: false,
    rollupOptions: {
      input: { admin: 'admin.html' },
      output: { entryFileNames: 'assets/admin-[hash].js', chunkFileNames: 'assets/admin-[hash].js', assetFileNames: 'assets/admin-[hash][extname]' },
    },
  },
}));
