// The page going away or to the background while a player is online. A closed tab or a swiped-away Safari sends
// nothing by itself, so the online screens hook these to leave the queue or the match with a keepalive request.

/** The bits of `window` / `document` used here (tests pass an EventTarget). */
export interface PageEvents {
  addEventListener(type: string, fn: () => void): void;
  removeEventListener(type: string, fn: () => void): void;
}
export interface VisibilityEvents extends PageEvents {
  readonly visibilityState: string;
}

/** Runs `fn` when the page is being closed or navigated away from (pagehide). Returns the undo. */
export function onPageExit(fn: () => void, win: PageEvents = window): () => void {
  win.addEventListener('pagehide', fn);
  return () => win.removeEventListener('pagehide', fn);
}

const aborted = () => new DOMException('aborted', 'AbortError');

/**
 * Searches only while the page is visible. When it goes to the background (another app, a locked phone) the search
 * is cancelled and `onHide` runs (leave the queue); when it comes back, the search starts again. Resolves with the
 * first result found while visible; rejects with an AbortError once `outer` aborts, or with the search's own error.
 */
export function searchWhileVisible<T>(outer: AbortSignal, search: (signal: AbortSignal) => Promise<T>,
  o: { onHide?: () => void; onResume?: () => void; doc?: VisibilityEvents } = {}): Promise<T> {
  const doc = o.doc ?? document;
  return new Promise<T>((resolve, reject) => {
    if (outer.aborted) return reject(aborted());
    let running: AbortController | null = null;
    let settled = false;
    const settle = (f: () => void) => {
      if (settled) return;
      settled = true;
      doc.removeEventListener('visibilitychange', onVisibility);
      outer.removeEventListener('abort', onAbort);
      f();
    };
    const start = () => {
      if (settled || running) return;
      const c = (running = new AbortController());
      search(c.signal).then((v) => { if (running === c) settle(() => resolve(v)); },
        (e) => { if (running === c) settle(() => reject(e)); }); // else: paused, and a new search starts when visible
    };
    const onVisibility = () => {
      if (doc.visibilityState === 'hidden') {
        if (!running) return;
        const c = running;
        running = null;
        c.abort();
        o.onHide?.();
      } else if (!running) {
        o.onResume?.();
        start();
      }
    };
    const onAbort = () => {
      running?.abort();
      running = null;
      settle(() => reject(aborted()));
    };
    outer.addEventListener('abort', onAbort);
    doc.addEventListener('visibilitychange', onVisibility);
    if (doc.visibilityState !== 'hidden') start();
  });
}
