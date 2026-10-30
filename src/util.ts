export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Scoreboard abbreviation as typed: A-Z only, uppercase, at most 3. */
export const cleanAbbr = (v: string) => v.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
/** A valid scoreboard abbreviation is exactly three letters A-Z. */
export const isAbbr = (v: string) => /^[A-Z]{3}$/.test(v);
/** Three-letter scorebug abbreviation from a team name: its first three letters, padded with X when shorter ('YOU' when it has none). */
export const abbr = (name: string) => {
  const l = name.replace(/[^a-z]/gi, '').slice(0, 3).toUpperCase();
  const out = l ? l.padEnd(3, 'X') : 'YOU';
  // "Assassins" or "Titans" must not put a rude word on the scoreboard.
  return isNameBlocked(out) ? `${out.slice(0, 2)}X` : out;
};
/** A stored abbreviation if it is already valid, else three letters derived from the team name (old saves held 1-2 or 4 letters). */
export const fixAbbr = (saved: unknown, name: string) => {
  const v = typeof saved === 'string' ? saved.trim().toUpperCase() : '';
  return isAbbr(v) && !isNameBlocked(v) ? v : abbr(name);
};

import { NAME_BLOCKED_MESSAGE, isNameBlocked } from './nameFilter';

/** Longest team name. */
export const TEAM_NAME_MAX = 20;
/** Team name while typing: letters A-Z / a-z and single spaces only; a trailing space is kept so the next word can follow. */
export const typingLetters = (v: string) => v.replace(/[^a-z ]/gi, '').replace(/ {2,}/g, ' ').replace(/^ /, '').slice(0, TEAM_NAME_MAX);
/** Final team name: letters and single spaces between words, trimmed. Empty when nothing usable is left. */
export const lettersName = (v: string) => v.replace(/[^a-z\s]/gi, '').replace(/\s+/g, ' ').trim().slice(0, TEAM_NAME_MAX).trim();

/** Inputs where a team name is typed. */
const NAME_INPUTS = '#team-name, .rn-input, #fc-input, #sum-name';

/**
 * Strips anything but letters and single spaces from every team-name field as it is typed or pasted.
 * Runs in the capture phase so each screen's own input handler already sees the clean value.
 */
export function guardNameInputs(doc: Document = document) {
  doc.addEventListener('input', (e) => {
    const el = e.target as HTMLInputElement | null;
    if (!el || el.tagName !== 'INPUT' || !el.matches(NAME_INPUTS)) return;
    const v = typingLetters(el.value);
    if (v !== el.value) {
      const caret = typingLetters(el.value.slice(0, el.selectionStart ?? el.value.length)).length;
      el.value = v;
      try { el.setSelectionRange(caret, caret); } catch { /* not focusable */ }
    }
    showNameError(el);
  }, true);
}

/** Shows (or clears) the "not allowed" note by a team-name field, per what is in it now. The screens refuse to save a blocked name. */
export function showNameError(el: HTMLInputElement) {
  const bad = isNameBlocked(el.value);
  el.setAttribute('aria-invalid', String(bad));
  const anchor = el.closest('.fc-row') ?? el;
  const parent = anchor.parentElement;
  if (!parent) return;
  let msg = parent.querySelector<HTMLElement>(':scope > .name-err');
  if (!bad) { msg?.remove(); return; }
  if (!msg) {
    msg = document.createElement('p');
    msg.className = 'name-err';
    msg.setAttribute('role', 'alert');
    msg.textContent = NAME_BLOCKED_MESSAGE;
    // Inline editors are flex rows that wrap, so the note goes last; elsewhere it sits right under the field.
    if (el.matches('.rn-input, #team-name')) parent.appendChild(msg);
    else anchor.after(msg);
  }
}

export function shuffle<T>(a: T[]): T[] {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** 2K-style card tier for an overall rating. */
export function tier(ovr: number): string {
  if (ovr >= 90) return 'dmd';
  if (ovr >= 85) return 'ame';
  if (ovr >= 80) return 'rby';
  if (ovr >= 75) return 'sap';
  if (ovr >= 70) return 'emr';
  if (ovr >= 60) return 'gld';
  return 'brz';
}
