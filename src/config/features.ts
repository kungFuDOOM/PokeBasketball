// Build-time feature flags for the multiplayer modes. Default OFF: a mode ships only when its env var is exactly "true".
// Vite inlines import.meta.env at build time, so code behind a false flag (dynamic imports) is dropped from the bundle.
export const MODE_SOCIAL = import.meta.env.VITE_MODE_SOCIAL === 'true';
/**
 * Ranked: the build flag, or (dev server only) `?ranked=1` in the URL, so the screens can be worked on without a flagged
 * build. `import.meta.env.DEV` is false in a production build, so that branch is dropped there and the live site can't
 * switch Ranked on from the address bar.
 */
export const MODE_RANKED = import.meta.env.VITE_MODE_RANKED === 'true'
  || (import.meta.env.DEV && typeof location !== 'undefined' && new URLSearchParams(location.search).get('ranked') === '1');
export const MODE_PACK_BATTLES = import.meta.env.VITE_MODE_PACK_BATTLES === 'true';
export const ANY_MULTIPLAYER = MODE_SOCIAL || MODE_RANKED || MODE_PACK_BATTLES;
