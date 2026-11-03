// "Link Phantom to buy" sheet. Menus and the shop only: never over the court.
import { esc } from '../util';
import { handoffCode } from './phantomHandoff';

export type LinkSheet =
  | { kind: 'wait'; code: string }
  | { kind: 'approve' }
  | { kind: 'sign'; href: string; code?: string }
  | { kind: 'done'; code: string }
  | { kind: 'failed'; text: string };

function inner(s: LinkSheet): string {
  switch (s.kind) {
    case 'wait':
      return `<p class="ph-msg">Approve in Phantom. It finishes in Safari, then come back here.</p>
        <p class="note center ph-code">Check code <b>${esc(s.code)}</b></p>
        <p class="note center">Linking does not move funds. Your rank stays on this account.</p>
        <button class="btn ghost" type="button" data-a="link-cancel">Cancel</button>`;
    case 'approve':
      return `<p class="ph-msg">Approve in Phantom, then come back.</p>
        <p class="note center">Linking does not move funds.</p>
        <button class="btn ghost" type="button" data-a="link-cancel">Cancel</button>`;
    case 'sign':
      return `<p class="ph-msg">Connected. Tap to sign the link in Phantom.</p>
        ${s.code ? `<p class="note center ph-code">Check code <b>${esc(s.code)}</b></p>` : ''}
        <p class="note center">This does not move funds. Your rank stays on this account.</p>
        <div class="ph-btns"><a class="btn primary big" data-a="link-sign" href="${esc(s.href)}">Link Phantom</a>
        <button class="btn ghost" type="button" data-a="link-cancel">Cancel</button></div>`;
    case 'done':
      return `<p class="ph-msg">Go back to the PokeJam app. The wallet links to the account you signed in with.</p>
        <p class="note center ph-code">Check code <b>${esc(s.code)}</b></p>
        <button class="btn ghost" type="button" data-a="link-close">Close</button>`;
    case 'failed':
      return `<p class="ph-msg" data-tone="bad" role="alert">${esc(s.text)}</p>
        <button class="btn ghost" type="button" data-a="link-close">Close</button>`;
    default: {
      const _never: never = s;
      return _never;
    }
  }
}

export const linkBodyHtml = inner;
export const linkSheetHtml = (s: LinkSheet): string =>
  `<div class="shop-sheet ph-sheet" data-link-sheet><div class="shop-panel ph-panel" role="dialog" aria-modal="true" aria-label="Link Phantom to buy"><h2 class="ph-title">LINK PHANTOM</h2><div data-link-body aria-live="polite">${inner(s)}</div></div></div>`;

export const linkCode = handoffCode;
