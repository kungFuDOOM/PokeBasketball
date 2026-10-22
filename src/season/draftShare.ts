// "Share my team" on the draft-complete screen (Season Draft, Franchise and Quick Play drafts).
// Same behaviour as the Season Draft results: the phone share sheet with the image, text and link,
// or download the image and copy the link where the share sheet can't take files.
import type { Mon } from '../data/pokemon';
import { SWATCHES } from '../screens/draftView';
import { shareUrl, type SharedTeam } from './share';
import { lettersName } from '../util';
import { renderDraftCard, shareTeam, toPngBlob } from './shareImage';

/** A full-size look at a share card; tap anywhere or press Esc to close. */
export function openCardPreview(dataUrl: string) {
  const el = document.createElement('div');
  el.className = 'ss-preview';
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-label', 'Share card');
  el.innerHTML = `<img src="${dataUrl}" alt="Your share card"><p class="note">Tap anywhere to close</p>`;
  const close = () => { el.remove(); window.removeEventListener('keydown', onKey); };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  el.addEventListener('click', close);
  window.addEventListener('keydown', onKey);
  document.body.appendChild(el);
}

/** A drafted team with no season played yet, as a share-link payload. */
export const draftShared = (name: string, color: string, color2: string, picks: Mon[]): SharedTeam => ({
  name, color, color2, dex: picks.map((m) => m.dex), w: 0, l: 0, rank: 0, teams: 0, seed: 0, playoff: 'missed', noRecord: true,
});

/**
 * Wires the share button and preview thumbnail inside the draft-complete summary in `host`. The card follows the
 * name field and color swatches as they change.
 */
export function wireDraftShare(host: HTMLElement, picks: Mon[], team: { name: string; color: string; color2: string }) {
  const thumb = host.querySelector<HTMLElement>('[data-a="preview-draft"]');
  const status = host.querySelector<HTMLElement>('.sum-share-status');
  if (!thumb || !status) return;
  const current = (): SharedTeam => {
    const name = lettersName(host.querySelector<HTMLInputElement>('#sum-name')?.value ?? '') || team.name;
    const sw = host.querySelector<HTMLElement>('.sw.on');
    const [color, color2] = sw ? SWATCHES[Number(sw.dataset.sw)] : [team.color, team.color2];
    return draftShared(name, color, color2, picks);
  };
  let shared = current();
  let card: Promise<{ canvas: HTMLCanvasElement; blob: Blob | null }> | null = null;
  let dataUrl = '';
  const draw = () => {
    shared = current();
    dataUrl = '';
    thumb.innerHTML = '<span class="ss-thumb-ph">Drawing…</span>';
    const mine = (card = renderDraftCard(shared).then(async (canvas) => ({ canvas, blob: await toPngBlob(canvas) })));
    mine.then(({ canvas }) => {
      if (card !== mine) return;
      // data: URL, since the CSP allows data: images but not blob: ones.
      dataUrl = canvas.toDataURL('image/png');
      thumb.innerHTML = `<img src="${dataUrl}" alt="Your share card">`;
    }).catch(() => { if (card === mine) { card = null; thumb.hidden = true; } });
  };
  let timer = 0;
  const redrawSoon = () => { window.clearTimeout(timer); timer = window.setTimeout(draw, 350); };
  host.querySelector('#sum-name')?.addEventListener('input', redrawSoon);
  host.addEventListener('click', async (e) => {
    const t = e.target as HTMLElement;
    // The swatch handler runs on the same click; redraw once it has moved the selection.
    if (t.closest('[data-sw]')) return void window.setTimeout(draw, 0);
    if (t.closest('[data-a="preview-draft"]')) { if (dataUrl) openCardPreview(dataUrl); return; }
    if (!t.closest('[data-a="share-draft"]')) return;
    try {
      if (!card) draw();
      const { canvas, blob } = await card!;
      const url = shareUrl(shared);
      const done = await shareTeam(canvas, blob, shared, url);
      status.textContent = done === 'shared' ? 'Shared!' : done === 'saved+copied' ? 'Link copied, image saved' : done === 'saved' ? 'Image saved.' : '';
    } catch { status.textContent = 'Could not make the image on this browser.'; }
  });
  draw();
}
