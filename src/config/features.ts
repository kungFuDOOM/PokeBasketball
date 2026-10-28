// Build-time feature flags for the multiplayer modes. Default OFF: a mode ships only when its env var is exactly "true".
// Vite inlines import.meta.env at build time, so code behind a false flag (dynamic imports) is dropped from the bundle.
export const MODE_SOCIAL = import.meta.env.VITE_MODE_SOCIAL === 'true';
export const MODE_RANKED = import.meta.env.VITE_MODE_RANKED === 'true';
export const MODE_PACK_BATTLES = import.meta.env.VITE_MODE_PACK_BATTLES === 'true';
export const ANY_MULTIPLAYER = MODE_SOCIAL || MODE_RANKED || MODE_PACK_BATTLES;
