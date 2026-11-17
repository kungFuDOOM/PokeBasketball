// Which video format to record the Play of the Game in, and what to do with the finished clip. Pure, so it can be tested.

/** Best first: MP4 where the browser records it (Safari/iOS, recent Chrome), else WebM with VP9, then VP8. */
export const CLIP_TYPES = [
  'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
  'video/mp4;codecs=avc1',
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
  /** Hand the video file to the native share sheet. */
  | 'native'
  /** Show the video with Download, Post on X and Copy link. */
  | 'panel';

export function planShare(clip: { file: File | null; canShareFile: boolean }): SharePlan {
  if (!clip.file) return 'text';
  return clip.canShareFile ? 'native' : 'panel';
}
