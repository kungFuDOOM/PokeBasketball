// Which video format to record the Play of the Game in, and what to do with the finished clip. Pure, so it can be tested.

/** Best first: MP4 where the browser records it (Safari/iOS, recent Chrome), else WebM with VP9, then VP8. */
export const CLIP_TYPES = [
  // Bare avc1 first: Safari picks the audio codec itself (AAC). Naming mp4a explicitly is only a fallback.
  'video/mp4;codecs=avc1',
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4',
  'video/webm;codecs=vp9,opus',
  'video/webm;codecs=vp8,opus',
  'video/webm;codecs=vp9',
  'video/webm;codecs=vp8',
  'video/webm',
] as const;

/** The first type the browser can record, or null (record with the browser's default then, or don't). */
export function pickClipType(isSupported: (type: string) => boolean): string | null {
  for (const t of CLIP_TYPES) {
    try { if (isSupported(t)) return t; } catch { /* some browsers throw on odd strings */ }
  }
  return null;
}

export const clipExt = (type: string): 'mp4' | 'webm' => (type.startsWith('video/mp4') ? 'mp4' : 'webm');

/** The container only ("video/mp4"), as a File type wants it. */
export const baseType = (type: string): string => type.split(';')[0] || 'video/webm';

/** Whether this browser can record a canvas at all. */
export function canRecordClip(env: {
  MediaRecorder?: { isTypeSupported?: (t: string) => boolean } | undefined;
  captureStream?: unknown;
}): boolean {
  return !!env.MediaRecorder && typeof env.captureStream === 'function';
}

export type SharePlan =
  /** No clip (unsupported, failed or timed out): the plain text/link share. */
  | 'text'
  /** Show the clip preview card; the user taps Save / Share Video with a fresh gesture (never auto-open the sheet). */
  | 'panel';

export function planShare(clip: { file: File | null }): SharePlan {
  return clip.file ? 'panel' : 'text';
}

/** Where the clip is saved from: the share sheet (its "Save Video" puts it in Photos) or a plain download link. */
export type SaveRoute = 'sheet' | 'download';

/** Touch phones/tablets that can share a file save through the sheet; a plain <a download> only reaches Files on iOS. */
export function planSave(env: { canShareFile: boolean; touch: boolean }): SaveRoute {
  return env.canShareFile && env.touch ? 'sheet' : 'download';
}

export const saveLabel = (route: SaveRoute): string => (route === 'sheet' ? 'Save / Share Video' : 'Download Video');

export type XRoute =
  /** Open the text intent and tell the user to attach the saved video themselves (an X web intent cannot attach a file). */
  | 'intent-hint'
  /** Not offered: on a phone the share sheet already lists X. */
  | 'hidden';

export const planPostOnX = (env: { canShareFile: boolean; touch: boolean }): XRoute =>
  env.canShareFile && env.touch ? 'hidden' : 'intent-hint';

export const X_HINT = 'Save the video, then attach it in X';

/** The share payload for the sheet: the file ONLY. Mixing files with title/text/url breaks iOS Safari's sheet. */
export const sheetPayload = (file: File): { files: File[] } => ({ files: [file] });

/** The video as a File with the right container type, whatever the recorder reported. */
export function clipFile(blob: Blob, mime: string): File {
  const base = baseType(mime);
  return new File([blob], `pokejam-play-of-the-game.${clipExt(base)}`, { type: base });
}

/** A still of the peak moment (a data: URL, which the CSP allows for images) for clips made by the WebCodecs encoder. */
export const clipPosters = new WeakMap<File, string>();
