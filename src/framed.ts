// Imported first by every page entry. public/framebust.js sets window.__framed when the page is inside another
// site's frame and shows its own overlay; throwing here stops the rest of the module graph from evaluating, so
// the game, audio, network and storage never start behind it. public/boot.js ignores the error while framed.

declare global {
  interface Window { __framed?: boolean }
}
if (typeof window !== 'undefined' && window.__framed) throw new Error('Poké Jam is framed by another site: not starting.');

export {};
