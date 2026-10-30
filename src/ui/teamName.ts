// Team-name editing after a draft: an inline rename (tap the name or the pencil) and the
// "Are you sure you want this name?" confirm shown before any new franchise starts.
import { TEAM_NAME_MAX, abbr, cleanAbbr, esc, isAbbr, lettersName as cleanName, showNameError } from '../util';
import { isNameBlocked } from '../nameFilter';

export const NAME_MAX = TEAM_NAME_MAX;

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
    const input = host.querySelector<HTMLInputElement>('.rn-input');
    const name = cleanName(input?.value ?? '');
    // A blocked name stays in the editor with its error showing: nothing is saved.
    if (input && isNameBlocked(name)) { showNameError(input); input.focus(); return; }
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
 * a clear note that it will be replaced. The 3-character scoreboard abbreviation follows the name until edited.
 * Resolves to the confirmed name and abbreviation, or null when cancelled.
 */
export function confirmFranchiseName(opts: { name: string; abbr?: string; replacing: boolean }): Promise<{ name: string; abbr: string } | null> {
  return new Promise((resolve) => {
    const el = document.createElement('div');
    el.className = 'fc-dialog';
    el.innerHTML = `
      <div class="fc-box" role="dialog" aria-modal="true" aria-labelledby="fc-title">
        <p class="eyebrow" id="fc-title">Are you sure you want this name?</p>
        <p class="fc-big"></p>
        <div class="fc-row">
          <label class="field fc-field" for="fc-input">Change name
            <input id="fc-input" maxlength="${NAME_MAX}" autocomplete="off" value="${esc(opts.name)}">
          </label>
          <label class="field fc-field fc-abbr" for="fc-abbr">Scoreboard
            <input id="fc-abbr" maxlength="3" autocomplete="off" autocapitalize="characters" spellcheck="false" aria-label="Scoreboard abbreviation, 3 letters" value="${esc(cleanAbbr(opts.abbr ?? '') || abbr(opts.name))}">
          </label>
        </div>
        <p class="fc-hint" hidden>Pick 3 letters</p>
        ${opts.replacing ? '<p class="fc-warn"><b>This replaces your saved franchise.</b> Its season, roster and progress will be erased. This can\'t be undone.</p>' : ''}
        <div class="actions center">
          <button class="btn primary big" data-fc="yes">Yes, start franchise</button>
          <button class="btn ghost big" data-fc="cancel">Cancel</button>
        </div>
      </div>`;
    const input = el.querySelector<HTMLInputElement>('#fc-input')!;
    const ab = el.querySelector<HTMLInputElement>('#fc-abbr')!;
    // Follows the name (the old derived abbreviation) until the player types their own.
    let abEdited = !!opts.abbr && cleanAbbr(opts.abbr) !== abbr(opts.name);
    const result = () => ({ name: cleanName(input.value), abbr: cleanAbbr(ab.value) });
    const hint = el.querySelector<HTMLElement>('.fc-hint')!;
    const big = el.querySelector<HTMLElement>('.fc-big')!;
    const yes = el.querySelector<HTMLButtonElement>('[data-fc="yes"]')!;
    const sync = () => {
      const n = cleanName(input.value);
      if (!abEdited) ab.value = abbr(n);
      big.textContent = n || '—';
      check();
    };
    /** Start stays off until there is a name and exactly three scoreboard letters. */
    const check = () => {
      const abBad = isAbbr(ab.value) && isNameBlocked(ab.value);
      const ok = isAbbr(ab.value) && !abBad;
      hint.hidden = ok;
      hint.textContent = abBad ? 'Pick 3 other letters' : 'Pick 3 letters';
      ab.setAttribute('aria-invalid', String(!ok));
      const bad = isNameBlocked(cleanName(input.value));
      showNameError(input);
      yes.disabled = !cleanName(input.value) || !ok || bad;
    };
    const done = (v: { name: string; abbr: string } | null) => {
      el.remove();
      window.removeEventListener('keydown', onKey, true);
      resolve(v);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); done(null); }
      else if (e.key === 'Enter' && (document.activeElement === input || document.activeElement === ab) && !yes.disabled) { e.preventDefault(); done(result()); }
    };
    input.addEventListener('input', sync);
    ab.addEventListener('input', () => {
      const v = cleanAbbr(ab.value);
      if (ab.value !== v) ab.value = v;
      abEdited = v !== '';
      if (!abEdited) ab.value = '';
      check();
    });
    ab.addEventListener('blur', () => { if (!ab.value) { abEdited = false; ab.value = abbr(cleanName(input.value)); check(); } });
    el.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>('[data-fc]')?.dataset.fc;
      if (a === 'yes' && !yes.disabled) done(result());
      else if (a === 'cancel' || e.target === el) done(null);
    });
    window.addEventListener('keydown', onKey, true);
    sync();
    document.body.appendChild(el);
    yes.focus();
  });
}
