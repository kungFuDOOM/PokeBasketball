// Imported first by every page entry. public/framebust.js sets window.__framed when the page is inside another
// site's frame and shows its own overlay; throwing here stops the rest of the module graph from evaluating, so
// the game, audio, network and storage never start behind it. public/boot.js ignores the error while framed.
// This module also runs its own check (src/frameGuard.ts) so the game refuses to boot on a foreign host or in a
// foreign frame even if framebust.js was stripped or never ran.
import { frameGuardVerdict, type FrameGuardInput } from './frameGuard';

declare global {
  interface Window { __framed?: boolean }
}

function gatherInput(): FrameGuardInput {
  const input: FrameGuardInput = { hostname: '', isTop: false };
  try {
    input.hostname = location.hostname;
    input.isTop = window.top === window.self;
  } catch {
    input.isTop = false; // treat as framed by an unknown parent
  }
  try {
    const ao = location.ancestorOrigins;
    if (ao) input.ancestorOrigins = Array.from(ao);
  } catch {
    // no ancestorOrigins: fall back to the referrer
  }
  try {
    input.referrer = document.referrer;
  } catch {
    input.referrer = null;
  }
  try {
    input.sameOriginTopOrigin = window.top ? window.top.location.origin : null;
  } catch {
    input.sameOriginTopOrigin = null; // cross-origin top throws
  }
  return input;
}

function showBlockedNotice(framed: boolean): void {
  try {
    if (document.getElementById('framebust')) return; // framebust.js already drew it
    const px = "'Press Start 2P', ui-monospace, monospace";
    const box = document.createElement('div');
    box.id = 'framebust';
    Object.assign(box.style, {
      visibility: 'visible', position: 'fixed', top: '0', right: '0', bottom: '0', left: '0', zIndex: '2147483647',
      display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box',
      padding: '16px', background: '#0a0d1f', color: '#f2f0e6', textAlign: 'center', fontFamily: px,
    });
    const msg = document.createElement('p');
    msg.textContent = 'Poké Jam only plays at pokejam.xyz';
    Object.assign(msg.style, { margin: '0 0 1.5em', maxWidth: '24em', fontSize: 'min(4.5vw,6vh,26px)', lineHeight: '1.6' });
    const link = document.createElement('a');
    link.href = 'https://pokejam.xyz/';
    link.target = framed ? '_top' : '_self';
    link.rel = 'noopener';
    link.textContent = 'Play at pokejam.xyz';
    Object.assign(link.style, {
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', boxSizing: 'border-box',
      minWidth: 'min(320px,80vw)', minHeight: '64px', padding: '16px 24px', fontSize: 'min(4vw,5vh,20px)',
      background: '#ffcb05', color: '#0a0d1f', textDecoration: 'none', border: '4px solid #f2f0e6',
      boxShadow: '4px 4px 0 #3b4cca', fontFamily: px,
    });
    const plain = document.createElement('p');
    plain.textContent = 'pokejam.xyz';
    Object.assign(plain.style, { margin: '1.5em 0 0', fontSize: 'min(3.5vw,4.5vh,16px)', userSelect: 'all' });
    box.append(msg, link, plain);
    document.documentElement.appendChild(box);
  } catch {
    // the throw below still stops the boot
  }
}

if (typeof window !== 'undefined' && !window.__framed) {
  const input = gatherInput();
  const verdict = frameGuardVerdict(input);
  if (!verdict.ok) {
    window.__framed = true;
    showBlockedNotice(!input.isTop);
  }
}
if (typeof window !== 'undefined' && window.__framed) throw new Error('Poké Jam is framed by another site: not starting.');

export {};
