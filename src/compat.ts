// Imported by main.ts right after ./framed: runs before any other module, so everything below is in place before the game loads.

declare global {
  interface Window { __bootOk?: boolean }
}
/** Tells public/boot.js the bundle started, so its 'couldn't load' message never shows over a working game. */
if (typeof window !== 'undefined') window.__bootOk = true;

/** CanvasRenderingContext2D.roundRect is missing before Safari 16 / Chrome 99 and throws there: draw the same path with arcTo. */
export function ensureRoundRect(proto: { roundRect?: unknown } = CanvasRenderingContext2D.prototype) {
  if (typeof proto.roundRect === 'function') return;
  proto.roundRect = function (this: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, radius = 0) {
    const r = Math.max(0, Math.min(Array.isArray(radius) ? Number(radius[0]) : Number(radius), w / 2, h / 2));
    this.moveTo(x + r, y);
    this.arcTo(x + w, y, x + w, y + h, r);
    this.arcTo(x + w, y + h, x, y + h, r);
    this.arcTo(x, y + h, x, y, r);
    this.arcTo(x, y, x + w, y, r);
    this.closePath();
  };
}
if (typeof CanvasRenderingContext2D !== 'undefined') ensureRoundRect();
