import { copyText, SHARE_URL, xIntentUrl } from './share';

export const shareButtonHtml = () => `
  <div class="share" data-share>
    <button class="btn share-btn" type="button" data-share-btn aria-haspopup="menu" aria-expanded="false">Share</button>
    <div class="share-menu" role="menu" data-share-menu hidden>
      <a class="btn" role="menuitem" data-share-x target="_blank" rel="noopener noreferrer">Post on X</a>
      <button class="btn" role="menuitem" type="button" data-share-copy>Copy link</button>
    </div>
    <p class="share-toast" role="status" data-share-toast hidden></p>
  </div>`;

/** Wires up the markup from shareButtonHtml inside `root`. Uses the native share sheet when there is one, else a small menu. */
export function bindShare(root: HTMLElement, text: string) {
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

  btn.addEventListener('click', async () => {
    if (!menu.hidden) return close();
    if (typeof navigator.share === 'function') {
      try {
        await navigator.share({ title: 'PokeJam', text, url: SHARE_URL });
        return;
      } catch (err) {
        if ((err as DOMException)?.name === 'AbortError') return;
      }
    }
    open();
  });
  x.addEventListener('click', close);
  wrap.querySelector('[data-share-copy]')!.addEventListener('click', async () => {
    close();
    try {
      await navigator.clipboard.writeText(copyText(text));
      say('Copied!');
    } catch {
      say('Could not copy');
    }
  });
}
