export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

/** Three-letter scorebug abbreviation from a team name. */
/** Scoreboard abbreviation typed by the player: A-Z and 0-9 only, uppercase, at most 3. */
export const cleanAbbr = (v: string) => v.toUpperCase().replace(/[^A-Z]/g, '').slice(0, 3);
export const abbr = (name: string) => (name.replace(/[^a-z]/gi, '').slice(0, 3) || 'YOU').toUpperCase();

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
    if (v === el.value) return;
    const caret = typingLetters(el.value.slice(0, el.selectionStart ?? el.value.length)).length;
    el.value = v;
    try { el.setSelectionRange(caret, caret); } catch { /* not focusable */ }
  }, true);
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
