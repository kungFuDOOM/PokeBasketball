import { copyText, SHARE_URL, xIntentUrl } from './share';
import { clipPosters, planPostOnX, planSave, planShare, saveLabel, sheetPayload, X_HINT } from './clipFormat';

/** Makes a video for a share. `cancel` aborts it; `done` gives the file, or null when it can't be made. */
export interface ClipMaker { supported: () => boolean; start: () => { done: Promise<File | null>; cancel: () => void } }

const canShareFile = (file: File): boolean => {
  try { return typeof navigator.canShare === 'function' && navigator.canShare({ files: [file] }); } catch { return false; }
};

const isTouch = (): boolean => {
  try { return (navigator.maxTouchPoints ?? 0) > 0; } catch { return false; }
};

/** The finished clip. Phone (touch + file share): preview and ONE button, Save / Share Video (files-only share sheet).
 *  Desktop: Download Video and Post on X. The file stays on the device. */
export function showClip(file: File, text: string, onShared?: () => void) {
  const url = URL.createObjectURL(file);
  const sheet = typeof navigator.share === 'function' && canShareFile(file);
  const touch = isTouch();
  const saveRoute = planSave({ canShareFile: sheet, touch });
  const xRoute = planPostOnX({ canShareFile: sheet, touch });
  const poster = clipPosters.get(file) ?? '';
  const box = document.createElement('div');
  box.className = 'clip-panel';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-label', 'Your clip');
  box.innerHTML = `<div class="clip-card">
    <div class="clip-media"><video src="${url}"${poster ? ` poster="${poster}"` : ''} controls playsinline webkit-playsinline loop muted autoplay preload="auto"></video></div>
    <div class="clip-actions">
      <button class="btn primary" type="button" data-clip-save hidden>${saveLabel('sheet')}</button>
      <a class="btn primary" data-clip-dl download="${file.name}" href="${url}" hidden>${saveLabel('download')}</a>
      <a class="btn" data-clip-x target="_blank" rel="noopener noreferrer" hidden>Post on X</a>
      <button class="btn ghost" type="button" data-clip-close>Close</button>
    </div>
    <p class="clip-hint" data-clip-hint hidden></p>
    <p class="share-toast clip-toast" role="status" data-clip-toast hidden></p></div>`;
  document.body.appendChild(box);
  const q = <T extends HTMLElement>(sel: string) => box.querySelector<T>(sel)!;
  const toast = q('[data-clip-toast]');
  const hint = q('[data-clip-hint]');
  const say = (m: string) => { toast.textContent = m; toast.hidden = false; setTimeout(() => { toast.hidden = true; }, 1800); };
  const close = () => { box.remove(); URL.revokeObjectURL(url); document.removeEventListener('keydown', onKey, true); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey, true);
  const video = q<HTMLVideoElement>('video');
  video.muted = true;
  video.playsInline = true;
  // If the video cannot play here, show the still of the peak moment instead (a data: image, allowed by the CSP).
  video.addEventListener('error', () => {
    if (poster) {
      const img = document.createElement('img');
      img.src = poster;
      img.alt = 'Your play';
      video.replaceWith(img);
    } else {
      hint.textContent = 'Preview unavailable here. You can still save the video.';
      hint.hidden = false;
    }
  });
  void video.play?.()?.catch?.(() => { /* autoplay blocked: the controls still work */ });

  const dl = q<HTMLAnchorElement>('[data-clip-dl]');
  const save = q<HTMLButtonElement>('[data-clip-save]');
  if (saveRoute === 'sheet') {
    save.hidden = false;
    // Files only: adding title/text/url makes iOS Safari's share sheet fail. Needs this tap's fresh user gesture.
    save.addEventListener('click', async () => {
      try {
        await navigator.share(sheetPayload(file));
        onShared?.();
      } catch (err) {
        if ((err as DOMException)?.name !== 'AbortError') say('Could not open the share sheet');
      }
    });
  } else {
    dl.hidden = false;
    dl.addEventListener('click', () => onShared?.());
  }
  if (xRoute === 'intent-hint') {
    const x = q<HTMLAnchorElement>('[data-clip-x]');
    x.hidden = false;
    x.href = xIntentUrl(text);
    x.addEventListener('click', () => { hint.textContent = X_HINT; hint.hidden = false; onShared?.(); });
  }
  q('[data-clip-close]').addEventListener('click', close);
}

export const shareButtonHtml = (label = 'Share') => `
  <div class="share" data-share>
    <button class="btn share-btn" type="button" data-share-btn aria-haspopup="menu" aria-expanded="false">${label}</button>
    <div class="share-menu" role="menu" data-share-menu hidden>
      <a class="btn" role="menuitem" data-share-x target="_blank" rel="noopener noreferrer">Post on X</a>
      <button class="btn" role="menuitem" type="button" data-share-copy>Copy link</button>
    </div>
    <p class="share-toast" role="status" data-share-toast hidden></p>
  </div>`;

/** Wires up the markup from shareButtonHtml inside `root`. Uses the native share sheet when there is one, else a small menu.
 *  `onShared` runs after a share actually goes out (the sheet, Post on X, or a successful copy), not when it is cancelled. */
export function bindShare(root: HTMLElement, text: string, onShared?: () => void, clip?: ClipMaker) {
  const wrap = root.querySelector<HTMLElement>('[data-share]');
  if (!wrap) return;
  const btn = wrap.querySelector<HTMLButtonElement>('[data-share-btn]')!;
  const menu = wrap.querySelector<HTMLElement>('[data-share-menu]')!;
  const toast = wrap.querySelector<HTMLElement>('[data-share-toast]')!;
  const x = wrap.querySelector<HTMLAnchorElement>('[data-share-x]')!;
  x.href = xIntentUrl(text);
  let timer: number | undefined;

  const say = (msg: string) => {
    toast.textContent = msg;
    toast.hidden = false;
    clearTimeout(timer);
    timer = window.setTimeout(() => { toast.hidden = true; }, 1800);
  };
  const close = () => {
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', onKey, true);
  };
  const outside = (e: Event) => { if (!wrap.contains(e.target as Node)) close(); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { close(); btn.focus(); } };
  const open = () => {
    menu.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', onKey, true);
  };

  let making: { cancel: () => void } | null = null;
  const label = btn.textContent;
  /** Plain text/link share: the native sheet when there is one, else the small menu. */
  const shareText = async () => {
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: 'PokeJam', text, url: SHARE_URL });
        onShared?.();
        return;
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') return;
      }
    }
    open();
  };
  /** Records the play, then shares the video (native sheet with the file, or the preview with Download). */
  const shareClip = async (maker: ClipMaker) => {
    const job = maker.start();
    making = job;
    btn.textContent = 'Making your clip… (tap to cancel)';
    const file = await job.done;
    const cancelled = making !== job;
    making = null;
    btn.textContent = label;
    if (cancelled) return;
    // Always preview first: the user taps Save / Share Video with a fresh gesture (the tap that started encoding is long gone).
    if (planShare({ file }) === 'panel' && file) return showClip(file, text, onShared);
    say('Could not make the clip, sharing the link');
    await shareText();
  };
  btn.addEventListener('click', async () => {
    if (making) { making.cancel(); return; }
    if (!menu.hidden) return close();
    if (clip?.supported()) return shareClip(clip);
    await shareText();
  });
  x.addEventListener('click', () => { close(); onShared?.(); });
  wrap.querySelector('[data-share-copy]')!.addEventListener('click', async () => {
    close();
    try {
      await navigator.clipboard.writeText(copyText(text));
      say('Copied!');
      onShared?.();
    } catch {
      say('Could not copy');
    }
  });
}
