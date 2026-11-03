// The Google handoff sheet. Menus only: it is never drawn over the court. googleSheet.ts wires the buttons.
import { esc } from '../util';
import { handoffCode } from './phantomHandoff';

export type GoogleSheet =
  | { kind: 'wait'; code: string; url: string }
  | { kind: 'opening' }
  | { kind: 'done'; code: string }
  | { kind: 'failed'; text: string };

const codeLine = (code: string) => `<p class="note center ph-code">Check code <b>${esc(code)}</b> — it matches the other screen.</p>`;

export function googleBodyHtml(s: GoogleSheet): string {
  switch (s.kind) {
    case 'wait':
      return `<p class="ph-msg">Continue in Safari, then come back to this app.</p>
        ${codeLine(s.code)}
        <p class="note center">Safari opens Google and finishes the sign-in. This app picks it up when you come back.</p>
        <div class="ph-btns"><a class="btn primary big" data-a="google-open" href="${esc(s.url)}" target="_blank" rel="noopener">Open Safari</a>
        <button class="btn ghost" type="button" data-a="google-cancel">Cancel</button></div>`;
    case 'opening':
      return `<p class="ph-msg">Opening Google…</p><p class="note center">You'll come back here, then go back to the PokeJam app.</p>`;
    case 'done':
      return `<p class="ph-msg">Signed in — go back to the PokeJam app on your home screen.</p>
        ${codeLine(s.code)}
        <button class="btn ghost" type="button" data-a="google-close">Close</button>`;
    case 'failed':
      return `<p class="ph-msg" data-tone="bad" role="alert">${esc(s.text)}</p>
        <button class="btn ghost" type="button" data-a="google-close">Close</button>`;
    default: {
      const _never: never = s;
      return _never;
    }
  }
}

export const googleSheetHtml = (s: GoogleSheet): string =>
  `<div class="shop-sheet ph-sheet" data-google-sheet><div class="shop-panel ph-panel" role="dialog" aria-modal="true" aria-label="Continue with Google"><h2 class="ph-title">GOOGLE</h2><div data-google-body aria-live="polite">${googleBodyHtml(s)}</div></div></div>`;

export const googleCode = handoffCode;
