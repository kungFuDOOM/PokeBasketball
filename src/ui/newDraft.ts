// "Start a new draft? This will replace your saved team." Shown before a Season Draft starts while a
// My Drafted Team is saved. The saved team is only replaced when the new draft finishes.
import { spriteUrl } from '../data/pokemon';
import { teamGrade } from '../season/grade';
import { draftedMons, loadDrafted, type DraftedTeam } from '../season/team';
import { esc } from '../util';

export type NewDraftChoice = 'new' | 'keep' | 'quick' | 'franchise';

const ordinal = (n: number) => `${n}${['th', 'st', 'nd', 'rd'][n % 100 > 10 && n % 100 < 14 ? 0 : n % 10 < 4 ? n % 10 : 0]}`;

/** With no saved team there is nothing to lose, so it resolves to 'new' straight away. */
export function confirmNewDraft(saved: DraftedTeam | null = loadDrafted()): Promise<NewDraftChoice> {
  if (!saved) return Promise.resolve('new');
  return new Promise((resolve) => {
    const mons = draftedMons(saved);
    const { grade } = teamGrade(mons);
    const facts = [
      saved.record ? `${saved.record.w}-${saved.record.l}` : '',
      saved.rank ? `${ordinal(saved.rank)} of 10` : '',
      `Grade ${grade}`,
    ].filter(Boolean).join(' · ');
    const el = document.createElement('div');
    el.className = 'fc-dialog nd-dialog';
    el.innerHTML = `
      <div class="fc-box nd-box" role="dialog" aria-modal="true" aria-labelledby="nd-title" aria-describedby="nd-text">
        <p class="eyebrow">Your saved team</p>
        <p class="fc-big nd-name" style="color:${saved.colors.color}">${esc(saved.name)}</p>
        <p class="nd-facts">${esc(facts)}</p>
        <ul class="nd-sprites" aria-hidden="true">${mons.map((m) => `<li><img src="${spriteUrl(m.dex)}" alt="" title="${esc(m.name)}"></li>`).join('')}</ul>
        <h2 class="nd-title" id="nd-title">Start a new draft?</h2>
        <p class="fc-warn" id="nd-text">This will replace your saved team. It stays saved until the new draft is finished.</p>
        <div class="actions center nd-actions">
          <button class="btn danger big" data-nd="new">Start new draft</button>
          <button class="btn primary big" data-nd="keep">Keep my team</button>
        </div>
        <div class="nd-use">
          <button class="btn ghost small" data-nd="use" aria-expanded="false">Use saved team ▸</button>
          <span class="nd-use-btns" hidden>
            <button class="btn small" data-nd="quick">Quick Play</button>
            <button class="btn small" data-nd="franchise">Franchise</button>
          </span>
        </div>
      </div>`;
    const done = (v: NewDraftChoice) => {
      el.remove();
      window.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); done('keep'); }
    };
    el.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>('[data-nd]')?.dataset.nd;
      if (a === 'use') {
        const btns = el.querySelector<HTMLElement>('.nd-use-btns')!;
        btns.hidden = !btns.hidden;
        (e.target as HTMLElement).setAttribute('aria-expanded', String(!btns.hidden));
      } else if (a === 'new' || a === 'keep' || a === 'quick' || a === 'franchise') done(a);
      else if (e.target === el) done('keep');
    });
    window.addEventListener('keydown', onKey, true);
    document.body.appendChild(el);
    el.querySelector<HTMLButtonElement>('[data-nd="keep"]')!.focus();
  });
}
