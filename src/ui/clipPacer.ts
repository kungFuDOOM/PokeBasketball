// Fixed-rate gate for the clip recording canvas. Safari's canvas.captureStream() tends to emit a frame per paint (and
// to dump queued paints as bursts stamped 1/600s apart), so we only paint the recording canvas at 30fps no matter how
// fast requestAnimationFrame runs (120Hz on ProMotion iPhones). Pure, so it can be tested without a browser.

export const CLIP_FPS = 30;

/** Slack so a 60/120Hz rAF (16.7/8.3ms steps) lands on every 33.3ms slot instead of slipping to the next one. */
const SLACK_MS = 1.5;

export interface ClipPacer {
  /** True when a frame should be painted now; the first call always accepts. */
  accept(nowMs: number): boolean;
}

export function createClipPacer(fps: number = CLIP_FPS): ClipPacer {
  const interval = 1000 / fps;
  let next: number | null = null;
  return {
    accept(now) {
      if (next !== null && now < next - SLACK_MS) return false;
      // Keep the slot grid (no drift), but if we fell a whole slot behind, restart from now rather than burst.
      next = next === null || now - next >= interval ? now + interval : next + interval;
      return true;
    },
  };
}
