// Training menu: the drills with their best stars, "Run all", and Back. Offline, local only.
// Kept free of game/play imports so it stays light; the drill itself is src/screens/tutorial.ts.
import { DRILL_IDS, drill, type DrillId } from '../tutorial/drills';
import { loadBestStars, type BestStars } from '../tutorial/store';
import { esc } from '../util';

export interface TrainingActions {
  /** Play one drill. */
  drill(id: DrillId): void;
  /** Play every drill in order. */
  runAll(): void;
  back(): void;
}

/** Star grade as text glyphs (no art): filled then empty, always three. */
export const starText = (n: number): string => {
  const k = Math.max(0, Math.min(3, Math.floor(n)));
  return '★'.repeat(k) + '☆'.repeat(3 - k);
};

/** The menu's HTML for these best stars. Pure, so it is unit-tested without a DOM. */
export function trainingHtml(best: BestStars): string {
  const total = DRILL_IDS.reduce((s, id) => s + best[id], 0);
  const rows = DRILL_IDS.map((id, i) => {
    const d = drill(id);
    const n = best[id];
    return `
        <li><button class="btn trn-drill" data-drill="${id}" aria-label="${esc(d.title)}, drill ${i + 1} of ${DRILL_IDS.length}, best ${n} of 3 stars">
          <span class="trn-name">${esc(d.title)}</span>
          <span class="trn-stars" aria-hidden="true">${starText(n)}</span>
        </button></li>`;
  }).join('');
  return `
    <div class="training">
      <header class="draft-head">
        <button class="btn ghost small" data-trn="back">Menu</button>
        <div class="status"><span class="round">POKé JAM</span><span class="otc">Training</span></div>
      </header>
      <h1 class="trn-h" id="trn-h">Training</h1>
      <p class="note">Pick a drill or run all ${DRILL_IDS.length}. Earn up to 3 stars each · ${total}/${DRILL_IDS.length * 3} stars</p>
      <button class="btn primary big trn-all" data-trn="all">Run all</button>
      <ul class="trn-list" aria-labelledby="trn-h">${rows}
      </ul>
    </div>`;
}

/** Opens the Training menu in `root`. Escape goes back. */
export function trainingScreen(root: HTMLElement, act: TrainingActions): void {
  root.className = 'screen-training';
  window.scrollTo(0, 0);
  root.innerHTML = trainingHtml(loadBestStars());
  const el = root.querySelector<HTMLElement>('.training')!;
  let gone = false;
  const go = (f: () => void) => {
    if (gone) return;
    gone = true;
    document.removeEventListener('keydown', onKey);
    f();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') go(act.back);
  };
  document.addEventListener('keydown', onKey);
  el.addEventListener('click', (e) => {
    const b = (e.target as HTMLElement).closest<HTMLButtonElement>('button');
    if (!b) return;
    const id = b.dataset.drill as DrillId | undefined;
    if (id && DRILL_IDS.includes(id)) return go(() => act.drill(id));
    if (b.dataset.trn === 'all') go(act.runAll);
    if (b.dataset.trn === 'back') go(act.back);
  });
  el.querySelector<HTMLButtonElement>('[data-trn="all"]')!.focus();
}
