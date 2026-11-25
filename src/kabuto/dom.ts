// DOM helpers for a saved King Kabuto: crowned sprite + gold name tag, used only on franchise screens.
import { spriteUrl } from '../data/pokemon';
import { KING_KABUTO } from './config';
import { crownedSpriteUrl } from './crown';

/** Swap a dex-140 sprite <img> for the crowned data URL once it is ready (the plain sprite shows meanwhile). */
export function crownImg(img: HTMLImageElement): void {
  const plain = img.getAttribute('src') ?? '';
  void crownedSpriteUrl(plain).then((u) => { if (u !== plain && img.getAttribute('src') === plain) img.src = u; });
}

/**
 * Crown every dex-140 sprite under `root` and wrap exact "Kabuto King" name text in the gold tag. Plain Kabuto
 * sprites share the dex-140 url, so only call this where a saved King is on screen (see `watchKing`).
 */
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

/**
 * Keep `root` decorated as a franchise screen re-renders. Only for a franchise that holds a saved King: a
 * franchise has one dex-140 player, so every Kabuto sprite on its screens is him. Returns a disposer.
 */
export function watchKing(root: HTMLElement, when: () => boolean = () => true): () => void {
  if (typeof MutationObserver === 'undefined') return () => {};
  const run = () => { if (when()) decorateKing(root); };
  run();
  const mo = new MutationObserver(run);
  mo.observe(root, { childList: true, subtree: true });
  return () => mo.disconnect();
}
