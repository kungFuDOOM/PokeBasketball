// The Phantom hand-off sheet as an HTML string. Pure, so it unit-tests in node. Opened from sign-in panels on menus only: nothing
// here is drawn over a match. phantomSheet.ts wires it.
import { esc } from '../util';

export type SheetState =
  | { kind: 'opening' }
  | { kind: 'approve'; step: 1 | 2 }
  | { kind: 'sign-ready'; href: string; newTab: boolean; code?: string }
  | { kind: 'wait-safari'; code: string }
  | { kind: 'safari-done'; code: string }
  | { kind: 'working'; text: string }
  | { kind: 'failed'; text: string; tone: 'warn' | 'bad'; diag?: string }
  | { kind: 'go-back'; app: boolean; code?: string };

const CANCEL = '<button class="btn ghost" type="button" data-a="phantom-cancel">Cancel</button>';
const codeLine = (code: string) => `<p class="note center ph-code">Check code <b>${esc(code)}</b> — the PokeJam app shows the same one.</p>`;
const CLOSE = '<button class="btn ghost" type="button" data-a="phantom-close">Close</button>';

function inner(s: SheetState): string {
  switch (s.kind) {
    case 'opening': return `<p class="ph-msg">Opening Phantom…</p>${CANCEL}`;
    case 'approve': return `<p class="ph-step">Step ${s.step} of 2</p><p class="ph-msg">Approve in Phantom, then come back.</p>${CANCEL}`;
    case 'sign-ready': return `<p class="ph-step">Step 2 of 2</p><p class="ph-msg">Connected. Now sign in with Phantom.</p>
      <p class="note center">Signing costs nothing and never moves funds.</p>
      ${s.code ? codeLine(s.code) : ''}
      <div class="ph-btns"><a class="btn primary big" data-a="phantom-sign" href="${esc(s.href)}"${s.newTab ? ' target="_blank" rel="noopener"' : ''}>Sign in Phantom</a>${CANCEL}</div>`;
    case 'wait-safari': return `<p class="ph-msg">Approve in Phantom. It finishes in Safari, then come back here.</p>
      <p class="note center ph-code">Check code <b>${esc(s.code)}</b></p>${CANCEL}`;
    case 'safari-done': return `<p class="ph-msg">Signed in — go back to the PokeJam app on your home screen.</p>
      <p class="note center ph-code">Check code <b>${esc(s.code)}</b></p>${CLOSE}`;
    case 'working': return `<p class="ph-msg">${esc(s.text)}</p>`;
    case 'failed': return `<p class="ph-msg" data-tone="${s.tone}" role="alert">${esc(s.text)}</p>${s.diag ? `<p class="ph-diag" data-diag>${esc(s.diag)}</p>` : ''}${CLOSE}`;
    case 'go-back': return `<p class="ph-msg">Phantom answered.</p>${s.code ? `<p class="note center ph-code">Check code <b>${esc(s.code)}</b>. It should match the page you started from.</p>` : ''}<p class="note center">${s.app
      ? 'Go back to the PokeJam app on your home screen to continue.'
      : 'Go back to the PokeJam tab you started from to continue.'}</p>${CLOSE}`;
    default: {
      const _never: never = s;
      return _never;
    }
  }
}

export const sheetBodyHtml = inner;
export const sheetHtml = (s: SheetState): string =>
  `<div class="shop-sheet ph-sheet" data-phantom-sheet><div class="shop-panel ph-panel" role="dialog" aria-modal="true" aria-label="Sign in with Phantom"><h2 class="ph-title">PHANTOM</h2><div class="ph-body" data-ph-body aria-live="polite">${inner(s)}</div></div></div>`;
