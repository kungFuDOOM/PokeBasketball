// Records the Play of the Game to a video file on the device: replays the clip in a hidden-under-a-progress-card
// modal, composes the (camera-cropped) game canvas plus a caption and watermark into a recording canvas, and
// captures that with MediaRecorder, with the game's sound if the browser allows. Gameplay only: no HUD, scores,
// wallet or wager, so it is safe from every mode (Pack Battles too). Nothing is uploaded.
import { CLIP_FPS, createClipPacer } from '../ui/clipPacer';
import { canRecordClip, clipFile, pickClipType } from '../ui/clipFormat';
import { VH, VW } from '../game/render';
import type { Game } from '../game/game';
import { playOfTheGame, savedPlay } from './potg';

/** Longest clip, and how long we wait for the whole thing before giving up. */
export const MAX_CLIP_SECONDS = 15;
const TIMEOUT_MS = (MAX_CLIP_SECONDS + 8) * 1000;
/** Modest bitrate so Safari does not default to ~25 Mbps for a 6s clip. */
const VIDEO_BPS = 7_000_000;
const OUT_W = VW * 2;
const OUT_H = VH * 2;

export function clipSupported(g: Game): boolean {
  if (typeof document === 'undefined' || !savedPlay(g)) return false;
  const c = document.createElement('canvas') as HTMLCanvasElement & { captureStream?: unknown };
  return canRecordClip({ MediaRecorder: (window as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder, captureStream: c.captureStream });
}

/** Handle for a clip in progress: `cancel()` resolves the promise with null. */
export interface ClipJob { done: Promise<File | null>; cancel: () => void }

export function recordPlayClip(g: Game): ClipJob {
  let cancel = () => {};
  const done = new Promise<File | null>((resolve) => {
    const s = savedPlay(g);
    const MR = (window as { MediaRecorder?: typeof MediaRecorder }).MediaRecorder;
    if (!s || !MR) return resolve(null);
    const out = document.createElement('canvas') as HTMLCanvasElement & { captureStream?: (fps?: number) => MediaStream };
    out.width = OUT_W;
    out.height = OUT_H;
    const octx = out.getContext('2d');
    if (!octx || typeof out.captureStream !== 'function') return resolve(null);
    octx.imageSmoothingEnabled = false;

    let modal: HTMLElement | null = null;
    let rec: MediaRecorder | null = null;
    let cap: ReturnType<typeof s.audio.captureStream> = null;
    let player: ReturnType<typeof playOfTheGame> | null = null;
    let finished = false;
    let raf = 0;
    let timeout = 0;
    const chunks: Blob[] = [];
    let type = '';

    const cleanup = () => {
      cancelAnimationFrame(raf);
      clearTimeout(timeout);
      player?.skip();
      modal?.remove();
      cap?.stop();
      s.voice.captureTo(null);
    };
    const end = (file: File | null) => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(file);
    };
    cancel = () => { try { if (rec && rec.state !== 'inactive') rec.onstop = null; rec?.stop(); } catch { /* ignore */ } end(null); };

    try {
      modal = document.createElement('div');
      modal.className = 'game potg-modal potg-clip';
      modal.innerHTML = '<div class="stage"><canvas class="court" aria-hidden="true"></canvas></div>';
      document.body.appendChild(modal);
      const canvas = modal.querySelector('canvas')!;
      const caption = `${s.best.name.toUpperCase()} · ${s.best.title.toUpperCase()}`;

      // Paint `out` at a fixed 30fps (not every rAF): Safari emits a captured frame per paint, bursty on 120Hz screens.
      const pacer = createClipPacer();
      let video: MediaStreamTrack & { requestFrame?: () => void };
      const compose = (cam: { zoom: number; x: number; y: number }) => {
        if (!pacer.accept(performance.now())) return;
        const sw = VW / cam.zoom;
        const sh = VH / cam.zoom;
        octx.drawImage(canvas, cam.x - sw / 2, cam.y - sh / 2, sw, sh, 0, 0, OUT_W, OUT_H);
        octx.fillStyle = 'rgba(0,0,0,0.55)';
        octx.fillRect(0, OUT_H - 64, OUT_W, 64);
        octx.textBaseline = 'middle';
        octx.fillStyle = '#ffd23f';
        octx.font = 'bold 22px monospace';
        octx.textAlign = 'left';
        octx.fillText(caption, 20, OUT_H - 32);
        octx.fillStyle = '#ffffff';
        octx.textAlign = 'right';
        octx.fillText('POKEJAM · pokejam.xyz', OUT_W - 20, OUT_H - 32);
        if (manual) video.requestFrame?.();
      };

      let manual = false;
      player = playOfTheGame(modal, canvas, s.clip, s.best, s.teamName, s.audio, s.voice, { compose });

      // Manual capture (requestFrame after each paint) where supported, else the browser's own 30fps capture.
      let stream = out.captureStream(0);
      video = stream.getVideoTracks()[0] as typeof video;
      manual = typeof video?.requestFrame === 'function';
      if (!manual) { stream.getTracks().forEach((t) => t.stop()); stream = out.captureStream(CLIP_FPS); video = stream.getVideoTracks()[0] as typeof video; }
      cap = s.audio.captureStream();
      if (cap) {
        for (const t of cap.stream.getAudioTracks()) stream.addTrack(t);
        s.voice.captureTo(cap.node);
      }
      type = pickClipType((t) => MR.isTypeSupported?.(t) ?? false) ?? '';
      rec = type ? new MR(stream, { mimeType: type, videoBitsPerSecond: VIDEO_BPS }) : new MR(stream, { videoBitsPerSecond: VIDEO_BPS });
      if (!type) type = rec.mimeType || 'video/webm';
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      rec.onerror = () => end(null);
      rec.onstop = () => {
        // Prefer what the recorder says it actually produced (rec.mimeType) over what we asked for.
        const blob = new Blob(chunks);
        end(blob.size ? clipFile(blob, rec?.mimeType || type) : null);
      };
      // No timeslice: timesliced output is a fragmented MP4 that Safari's <video> and Quick Look cannot play.
      rec.start();

      const started = performance.now();
      let last = started;
      const stop = () => { try { rec?.stop(); } catch { end(null); } };
      const tick = (now: number) => {
        if (finished) return;
        const dt = Math.max(0, Math.min(0.1, (now - last) / 1000));
        last = now;
        const alive = player!.frame(dt);
        if (!alive || now - started >= MAX_CLIP_SECONDS * 1000) return stop();
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
      timeout = window.setTimeout(() => end(null), TIMEOUT_MS);
    } catch {
      end(null);
    }
  });
  return { done, cancel: () => cancel() };
}
