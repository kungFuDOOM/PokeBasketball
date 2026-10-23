/** Content for the viewport meta: no pinch or double-tap zoom anywhere (the game is a fixed-size screen). */
export const VIEWPORT = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';

/**
 * Taps on the court and the held on-screen controls (they use pointer events, which a cancelled touchend leaves alone).
 * Not click-driven buttons like pause: cancelling a touchend suppresses the click that follows it.
 */
const CONTROLS = '.touch, .stick-zone, .tb, canvas.court';
const DOUBLE_TAP_MS = 350;

interface Target {
  addEventListener(type: string, fn: (e: Event) => void, opts?: AddEventListenerOptions | boolean): void;
}

/** True when a touchend lands on a control within DOUBLE_TAP_MS of the previous one. */
export const isDoubleTap = (last: number, now: number) => last > 0 && now - last < DOUBLE_TAP_MS;

/** Re-applies the viewport meta, which makes iOS snap back to scale 1. */
export function resetZoom(doc: Document = document, vv: { scale: number } | null | undefined = window.visualViewport) {
  if (!vv || vv.scale <= 1.01) return false;
  const meta = doc.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if (!meta) return false;
  meta.content = 'width=device-width, initial-scale=1, maximum-scale=1';
  requestAnimationFrame(() => { meta.content = VIEWPORT; });
  return true;
}

/**
 * Stops iOS (including a Home Screen web app) from zooming: pinch gestures, double-tap on the controls and
 * dblclick are cancelled, and a page that is already zoomed is reset on resume or rotation.
 */
export function guardZoom(win: Target & { visualViewport?: Target | null } = window, doc: Target & { querySelector: Document['querySelector'] } = document) {
  const stop = (e: Event) => e.preventDefault();
  for (const t of ['gesturestart', 'gesturechange', 'gestureend']) doc.addEventListener(t, stop, { passive: false });
  doc.addEventListener('dblclick', (e) => {
    if (!(e.target as HTMLElement | null)?.closest?.('input, textarea')) e.preventDefault();
  }, { passive: false });
  let last = 0;
  doc.addEventListener('touchend', (e) => {
    if (!(e.target as HTMLElement | null)?.closest?.(CONTROLS)) return;
    if (e.cancelable && isDoubleTap(last, e.timeStamp)) e.preventDefault();
    last = e.timeStamp;
  }, { passive: false });
  const reset = () => { resetZoom(doc as unknown as Document); };
  win.addEventListener('orientationchange', () => setTimeout(reset, 300));
  win.addEventListener('pageshow', reset);
  doc.addEventListener('visibilitychange', reset);
  win.visualViewport?.addEventListener('resize', reset);
}
