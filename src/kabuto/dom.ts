// DOM helpers for Kabuto King: crowned sprite + gold name tag, applied to screens we don't want to fork (the draft).
import { spriteUrl } from '../data/pokemon';
import { KING_KABUTO, kingKabutoActive } from './config';
import { crownedSpriteUrl } from './crown';

/** Swap a dex-140 sprite <img> for the crowned data URL once it is ready (the plain sprite shows meanwhile). */
export function crownImg(img: HTMLImageElement): void {
  const plain = img.getAttribute('src') ?? '';
  void crownedSpriteUrl(plain).then((u) => { if (u !== plain && img.getAttribute('src') === plain) img.src = u; });
}

/** Crown every Kabuto King sprite under `root` and wrap exact "Kabuto King" name text in the gold tag. */
export function decorateKing(root: ParentNode): void {
  const url = spriteUrl(KING_KABUTO.dex);
  root.querySelectorAll<HTMLImageElement>('img').forEach((img) => { if (img.getAttribute('src') === url) crownImg(img); });
  const walker = document.createTreeWalker(root as Node, NodeFilter.SHOW_TEXT);
  const hits: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const el = n.parentElement;
    if (n.nodeValue?.trim() === KING_KABUTO.name && el && !el.closest('.king-tag, option, title, script, style')) hits.push(n as Text);
  }
  for (const t of hits) {
    const s = document.createElement('span');
    s.className = 'king-tag';
    s.textContent = KING_KABUTO.name;
    t.replaceWith(s);
  }
}

/** While the window is open, keep `root` decorated as the screen re-renders. Returns a disposer. No-op when closed. */
export function watchKing(root: HTMLElement, now: number = Date.now()): () => void {
  if (!kingKabutoActive(now) || typeof MutationObserver === 'undefined') return () => {};
  decorateKing(root);
  const mo = new MutationObserver(() => decorateKing(root));
  mo.observe(root, { childList: true, subtree: true });
  return () => mo.disconnect();
}
