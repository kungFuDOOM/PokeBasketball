// Rank Shield emblem. The ranked crests (public/ranks, built by scripts/make-rank-badges.py) are geometric
// badges: a near-black outline, a metal gradient lit from the top left, a dark well, and a basketball.
// This is the same recipe in the gold crest's palette, drawn as one inline SVG so it stays sharp from a
// 14px count up to a shop card. It is original art: a heater shield, not a recolor of the Silver crest.
// Menus and results only. Nothing here is drawn over the court or the in-game HUD.

let seq = 0;

/**
 * One Rank Shield. Each call gets its own gradient ids so several emblems on a page (shop packs, the
 * hub chip, a result line) do not share a `url(#…)` and break when one of them is removed.
 */
export function shieldEmblemHtml(): string {
  const id = `rkSh${++seq}`;
  return `<svg xmlns="http://www.w3.org/2000/svg" class="rk-shield-ico" viewBox="0 0 128 128" width="1em" height="1em" aria-hidden="true" focusable="false">
    <defs>
      <linearGradient id="${id}-body" x1="34" y1="18" x2="102" y2="116" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#fff4cc"/><stop offset="0.16" stop-color="#ffe08a"/>
        <stop offset="0.4" stop-color="#f6c445"/><stop offset="0.66" stop-color="#d8921e"/><stop offset="1" stop-color="#7a4c12"/>
      </linearGradient>
      <linearGradient id="${id}-spike" x1="8" y1="30" x2="32" y2="66" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#fff1c2"/><stop offset="0.55" stop-color="#e8b03a"/><stop offset="1" stop-color="#6a4010"/>
      </linearGradient>
      <radialGradient id="${id}-ball" cx="38%" cy="34%" r="70%">
        <stop offset="0" stop-color="#ffc48a"/><stop offset="0.42" stop-color="#ee8434"/><stop offset="1" stop-color="#9a4814"/>
      </radialGradient>
      <linearGradient id="${id}-well" x1="50" y1="42" x2="86" y2="96" gradientUnits="userSpaceOnUse">
        <stop offset="0" stop-color="#3a2814"/><stop offset="1" stop-color="#120c08"/>
      </linearGradient>
    </defs>
    <path fill="#ffcb05" opacity="0.4" d="M64 4 L94 16 L112 36 L112 66 L96 92 L78 112 L64 124 L50 112 L32 92 L16 66 L16 36 L34 16 Z"/>
    <path fill="#ffcb05" opacity="0.4" d="M28 30 L4 44 L12 66 L30 54 Z"/>
    <path fill="#ffcb05" opacity="0.4" d="M100 30 L124 44 L116 66 L98 54 Z"/>
    <path fill="url(#${id}-body)" stroke="#120c08" stroke-width="7" stroke-linejoin="miter" stroke-miterlimit="2.5" d="M64 10 L90 22 L104 40 L104 66 L90 90 L74 108 L64 118 L54 108 L38 90 L24 66 L24 40 L38 22 Z"/>
    <path fill="url(#${id}-spike)" stroke="#120c08" stroke-width="5" stroke-linejoin="miter" stroke-miterlimit="2.2" d="M30 34 L8 48 L16 66 L32 54 Z"/>
    <path fill="url(#${id}-spike)" stroke="#120c08" stroke-width="5" stroke-linejoin="miter" stroke-miterlimit="2.2" d="M98 34 L120 48 L112 66 L96 54 Z"/>
    <path fill="#fff6d0" opacity="0.92" d="M64 16 L82 24 L74 28 L64 22 L50 30 L44 26 Z"/>
    <path fill="#5c3810" opacity="0.55" d="M104 48 L104 66 L90 90 L82 84 L92 66 L92 52 Z"/>
    <path fill="url(#${id}-well)" stroke="#f2c14a" stroke-width="2.4" stroke-linejoin="round" d="M64 38 L80 48 L84 66 L74 84 L64 94 L54 84 L44 66 L48 48 Z"/>
    <circle cx="64" cy="66" r="14.5" fill="url(#${id}-ball)" stroke="#2a1408" stroke-width="1.6"/>
    <g fill="none" stroke="#241208" stroke-width="1.35" stroke-linecap="round">
      <path d="M64 52.2 V79.8 M50.2 66 H77.8"/>
      <path d="M53.2 55.2 C58.2 62 58.2 70 53.2 76.8"/>
      <path d="M74.8 55.2 C69.8 62 69.8 70 74.8 76.8"/>
    </g>
    <ellipse cx="59" cy="60.5" rx="3.6" ry="2.2" fill="#fff8ea" opacity="0.6" transform="rotate(-30 59 60.5)"/>
    <path fill="#fff8e4" stroke="#8a5812" stroke-width="1.1" stroke-linejoin="miter" d="M64 18 L70 26 L64 34 L58 26 Z"/>
  </svg>`;
}
