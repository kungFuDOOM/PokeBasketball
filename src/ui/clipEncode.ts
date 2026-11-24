// Pure pieces of the deterministic WebCodecs clip encoder (H.264 in an MP4): frame timing, codec choice, capability.
// Kept free of the DOM so it can be unit tested. The encoder itself lives in screens/potgClip.ts.

export const ENC_FPS = 30;
/** A keyframe every second. */
export const KEY_EVERY = 30;
/** Modest on purpose: Safari has silently failed with very high bitrates. */
export const ENC_BPS = 7_000_000;

/** Microsecond timestamp of frame `i`, computed from the index so there is no drift or burst. */
export const frameTimestampUs = (i: number, fps: number = ENC_FPS): number => Math.round((i * 1_000_000) / fps);
/** Nominal frame duration in microseconds. */
export const frameDurationUs = (fps: number = ENC_FPS): number => Math.round(1_000_000 / fps);
/** Duration to mux for a chunk: the browser's own when it is finite and positive (Safari gives null), else the nominal one. */
export const chunkDurationUs = (reported: number | null | undefined, fps: number = ENC_FPS): number =>
  typeof reported === 'number' && Number.isFinite(reported) && reported > 0 ? reported : frameDurationUs(fps);

export const isEven = (n: number): boolean => Number.isInteger(n) && n > 0 && n % 2 === 0;
export function assertEvenSize(w: number, h: number): void {
  if (!isEven(w) || !isEven(h)) throw new Error(`H.264 needs even dimensions, got ${w}x${h}`);
}

/** Baseline first (most compatible), then Main, then High. All level 3.1 (fine for 960x540 at 30fps). */
export const H264_CODECS = ['avc1.42001f', 'avc1.4d001f', 'avc1.64001f'] as const;

export interface EncConfig {
  codec: string;
  width: number;
  height: number;
  bitrate: number;
  framerate: number;
  hardwareAcceleration?: 'prefer-hardware';
  avc: { format: 'avc' };
}

type Support = { supported?: boolean } | null | undefined;

/**
 * The first H.264 config this browser can encode at the real size/bitrate/fps: each codec with prefer-hardware, then
 * with the default. `avc: avc` gives avcC samples (what an MP4 wants), not Annex B. Null when none works.
 */
export async function pickEncoderConfig(
  isConfigSupported: (c: EncConfig) => Promise<Support>,
  size: { width: number; height: number },
  bitrate: number = ENC_BPS,
  framerate: number = ENC_FPS,
): Promise<EncConfig | null> {
  assertEvenSize(size.width, size.height);
  for (const codec of H264_CODECS) {
    for (const hw of [true, false]) {
      const cfg: EncConfig = { codec, ...size, bitrate, framerate, avc: { format: 'avc' }, ...(hw ? { hardwareAcceleration: 'prefer-hardware' as const } : {}) };
      try { if ((await isConfigSupported(cfg))?.supported) return cfg; } catch { /* odd config: try the next */ }
    }
  }
  return null;
}

/** Whether the pieces WebCodecs encoding needs exist (the codec check itself is async: pickEncoderConfig). */
export const hasWebCodecs = (env: { VideoEncoder?: unknown; VideoFrame?: unknown }): boolean =>
  typeof env.VideoEncoder === 'function' && typeof env.VideoFrame === 'function';

/** Which encoder a clip uses: WebCodecs if available, else the realtime recorder, else none. */
export type ClipEncoder = 'webcodecs' | 'recorder' | 'none';
export const planEncoder = (env: { webcodecs: boolean; recorder: boolean }): ClipEncoder =>
  env.webcodecs ? 'webcodecs' : env.recorder ? 'recorder' : 'none';
