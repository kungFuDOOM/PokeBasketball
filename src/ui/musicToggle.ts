import type { Music } from '../music/music';

const NOTE_SVG = `<svg viewBox="0 0 16 16" width="18" height="18" aria-hidden="true" shape-rendering="crispEdges">
  <path fill="currentColor" d="M6 2h8v2h-6v7H6zM12 4h2v7h-2zM3 10h4v4H3zM10 9h4v4h-4z"/>
  <g class="slash" shape-rendering="auto" stroke-linecap="round">
    <line x1="2" y1="2" x2="14.5" y2="14.5" stroke="#0a0d1f" stroke-width="4"/>
    <line x1="2" y1="2" x2="14.5" y2="14.5" stroke="#ff5a4e" stroke-width="2"/>
  </g>
</svg>`;

/**
 * Floating music on/off button (top-right corner, hidden during games, which keep their own sound toggle).
 * `unlock` runs first so the very first tap can start the music on iPhone.
 */
export function musicToggle(music: Music, unlock: () => void) {
  const btn = document.createElement('button');
  btn.className = 'music-btn';
  btn.type = 'button';
  btn.innerHTML = NOTE_SVG;
  const label = () => {
    btn.classList.toggle('off', !music.enabled);
    btn.setAttribute('aria-pressed', String(music.enabled));
    btn.setAttribute('aria-label', music.enabled ? 'Music on. Tap to pause the music' : 'Music off. Tap to play the music');
    btn.title = music.enabled ? 'Pause music' : 'Play music';
  };
  label();
  music.onChange(label);
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    unlock();
    music.setEnabled(!music.enabled);
  });
  document.body.appendChild(btn);
  return btn;
}
