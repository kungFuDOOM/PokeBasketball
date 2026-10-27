// iOS Safari ignores user-scalable=no: block pinch gestures ourselves, and the callout and text selection on the game.
// Double-tap zoom on the game controls is handled in noZoom.ts: cancelling a touchend here would swallow button clicks.
const NATIVE = 'input, textarea, select, [contenteditable], iframe';
const BLOCKED = ['gesturestart', 'gesturechange', 'gestureend', 'dblclick'];

// Taps on these keep their default behavior (focus, click, captcha).
const INTERACTIVE = `${NATIVE}, button, a, .cf-turnstile, [id*="turnstile"]`;

const matches = (t: EventTarget | null, sel: string) => !!t && typeof (t as Element).closest === 'function' && (t as Element).closest(sel) !== null;
const isNative = (t: EventTarget | null) => matches(t, NATIVE);

export function installTouchGuard(doc: Pick<Document, 'addEventListener' | 'removeEventListener'> = document): () => void {
  const block = (e: Event) => e.preventDefault();
  // Stop the iOS "Copy | Find" callout: no context menu or selection outside fields, and no touchstart
  // default on the game screen (the sim reads pointer events, which still fire).
  const blockUnlessNative = (e: Event) => { if (!isNative(e.target)) e.preventDefault(); };
  const onTouchStart = (e: Event) => { if (matches(e.target, '.game') && !matches(e.target, INTERACTIVE)) e.preventDefault(); };
  const onSelectionChange = () => {
    const el = (doc as Document).activeElement;
    if (!el || !el.matches?.('input, textarea, [contenteditable]')) window.getSelection()?.removeAllRanges();
  };
  doc.addEventListener('contextmenu', blockUnlessNative);
  doc.addEventListener('selectstart', blockUnlessNative);
  doc.addEventListener('touchstart', onTouchStart, { passive: false });
  doc.addEventListener('selectionchange', onSelectionChange);
  for (const g of BLOCKED) doc.addEventListener(g, block, { passive: false });
  return () => {
    for (const g of BLOCKED) doc.removeEventListener(g, block);
    doc.removeEventListener('contextmenu', blockUnlessNative);
    doc.removeEventListener('selectstart', blockUnlessNative);
    doc.removeEventListener('touchstart', onTouchStart);
    doc.removeEventListener('selectionchange', onSelectionChange);
  };
}
