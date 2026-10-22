// Team-name editing after a draft: an inline rename (tap the name or the pencil) and the
// "Are you sure you want this name?" confirm shown before any new franchise starts.
import { cleanName } from '../season/share';
import { esc } from '../util';

export const NAME_MAX = 20;

/**
 * Turns `host` into an editable team name. Tapping the name or the pencil swaps in a text field;
 * Enter or Save keeps the change (sanitised with cleanName), Esc or Cancel drops it.
 */
export function inlineRename(host: HTMLElement, getName: () => string, onSave: (name: string) => void) {
  const view = () => {
    host.innerHTML = `<button class="rn-name" data-rn="edit" aria-label="Rename your team: ${esc(getName())}"><span class="rn-text">${esc(getName())}</span><span class="rn-pencil" aria-hidden="true">✎</span></button>`;
  };
  const edit = () => {
    host.innerHTML = `
      <span class="rn-edit">
        <input class="rn-input" maxlength="${NAME_MAX}" autocomplete="off" aria-label="Team name" value="${esc(getName())}">
        <button class="btn small primary" data-rn="save">Save</button>
        <button class="btn small ghost" data-rn="cancel">Cancel</button>
      </span>`;
    const input = host.querySelector<HTMLInputElement>('.rn-input')!;
    input.focus();
    input.select();
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); save(); }
      else if (e.key === 'Escape') { e.preventDefault(); view(); }
    });
  };
  const save = () => {
    const name = cleanName(host.querySelector<HTMLInputElement>('.rn-input')?.value ?? '');
    if (name && name !== getName()) onSave(name);
    view();
  };
  host.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('[data-rn]')?.dataset.rn;
    if (!a) return;
    e.stopPropagation();
    if (a === 'edit') edit();
    else if (a === 'save') save();
    else if (a === 'cancel') view();
  });
  view();
}

/**
 * One on-page dialog before a franchise starts: confirm (or change) the team name, and, when a save exists,
 * a clear note that it will be replaced. Resolves to the confirmed name, or null when cancelled.
 */
export function confirmFranchiseName(opts: { name: string; replacing: boolean }): Promise<string | null> {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'fc-dialog';
    el.innerHTML = `
      <div class="fc-box" role="dialog" aria-modal="true" aria-labelledby="fc-title">
        <p class="eyebrow" id="fc-title">Are you sure you want this name?</p>
        <p class="fc-big"></p>
        <label class="field fc-field" for="fc-input">Change name
          <input id="fc-input" maxlength="${NAME_MAX}" autocomplete="off" value="${esc(opts.name)}">
        </label>
        ${opts.replacing ? '<p class="fc-warn"><b>This replaces your saved franchise.</b> Its season, roster and progress will be erased. This can\'t be undone.</p>' : ''}
        <div class="actions center">
          <button class="btn primary big" data-fc="yes">Yes, start franchise</button>
          <button class="btn ghost big" data-fc="cancel">Cancel</button>
        </div>
      </div>`;
    const input = el.querySelector<HTMLInputElement>('#fc-input')!;
    const big = el.querySelector<HTMLElement>('.fc-big')!;
    const yes = el.querySelector<HTMLButtonElement>('[data-fc="yes"]')!;
    const sync = () => {
      const n = cleanName(input.value);
      big.textContent = n || '—';
      yes.disabled = !n;
    };
    const done = (v: string | null) => {
      el.remove();
      window.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
      else if (e.key === 'Enter' && document.activeElement === input && !yes.disabled) { e.preventDefault(); done(cleanName(input.value)); }
    };
    input.addEventListener('input', sync);
    el.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>('[data-fc]')?.dataset.fc;
      if (a === 'yes' && !yes.disabled) done(cleanName(input.value));
      else if (a === 'cancel' || e.target === el) done(null);
    });
    window.addEventListener('keydown', onKey, true);
    sync();
    document.body.appendChild(el);
    yes.focus();
  });
}
