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
/**
 * Rank Shield shop, paid by card (Stripe Checkout, test mode first): the build flag, or (dev server only) `?shop=1`, like Ranked above.
 * Needs Ranked. Off by default: with the flag off no card button is drawn and nothing calls the checkout function.
 */
export const MODE_SHIELD_STRIPE = MODE_RANKED && (import.meta.env.VITE_SHIELD_SHOP === 'true'
  || (import.meta.env.DEV && typeof location !== 'undefined' && new URLSearchParams(location.search).get('shop') === '1'));
/**
 * Pay for Rank Shields in USDC from a Phantom wallet: VITE_SHIELD_USDC=true (or, dev server only, `?usdc=1`). Needs Ranked,
 * works with or without Stripe. Devnet unless VITE_SHIELD_USDC_CLUSTER says otherwise; the server decides the real cluster.
 */
export const MODE_SHIELD_USDC = MODE_RANKED && (import.meta.env.VITE_SHIELD_USDC === 'true'
  || (import.meta.env.DEV && typeof location !== 'undefined' && new URLSearchParams(location.search).get('usdc') === '1'));
/** The Shop button and sheet show when either payment is on. */
export const MODE_SHIELD_SHOP = MODE_SHIELD_STRIPE || MODE_SHIELD_USDC;
export const SHIELD_USDC_CLUSTER: 'devnet' | 'mainnet-beta' = import.meta.env.VITE_SHIELD_USDC_CLUSTER === 'mainnet-beta' ? 'mainnet-beta' : 'devnet';
export const MODE_PACK_BATTLES = import.meta.env.VITE_MODE_PACK_BATTLES === 'true';
export const ANY_MULTIPLAYER = MODE_SOCIAL || MODE_RANKED || MODE_PACK_BATTLES;
