// Small inline SVG badges for the badge case. Shapes and colors nod to the Kanto badges.

const shapes: Record<string, string> = {
  Boulder: `<polygon points="12,3 28,3 37,12 37,28 28,37 12,37 3,28 3,12" fill="#8d939c" stroke="#4b5058" stroke-width="2"/>
    <polygon points="12,9 28,9 31,20 20,31 9,20" fill="#b9bec6"/>`,
  Cascade: `<path d="M20 3 C20 3 7 19 7 26 a13 13 0 0 0 26 0 C33 19 20 3 20 3z" fill="#3fa9f5" stroke="#1b5f99" stroke-width="2"/>
    <ellipse cx="15" cy="25" rx="3" ry="5" fill="#bfe6ff"/>`,
  Thunder: `<polygon points="20,2 25,14 38,14 27,22 32,36 20,28 8,36 13,22 2,14 15,14" fill="#f6a623" stroke="#9a5d00" stroke-width="2"/>
    <circle cx="20" cy="19" r="5" fill="#ffe27a"/>`,
  Rainbow: `<circle cx="20" cy="11" r="8" fill="#e8483c"/><circle cx="29" cy="20" r="8" fill="#f5c518"/>
    <circle cx="20" cy="29" r="8" fill="#43b05c"/><circle cx="11" cy="20" r="8" fill="#3b82f6"/><circle cx="20" cy="20" r="5" fill="#fff"/>`,
  Soul: `<path d="M20 35 L5 20 a8 8 0 0 1 15-11 a8 8 0 0 1 15 11z" fill="#ec5fa1" stroke="#8f1f58" stroke-width="2"/>`,
  Marsh: `<circle cx="14" cy="20" r="11" fill="#e2b93b" stroke="#8a6a0e" stroke-width="2"/>
    <circle cx="26" cy="20" r="11" fill="#f3d36b" stroke="#8a6a0e" stroke-width="2"/>`,
  Volcano: `<polygon points="20,2 33,20 20,38 7,20" fill="#e2452b" stroke="#7d1a0b" stroke-width="2"/>
    <polygon points="20,12 26,20 20,29 14,20" fill="#ffb347"/>`,
  Earth: `<path d="M20 3 C33 10 35 27 20 37 C5 27 7 10 20 3z" fill="#4fae4a" stroke="#1f5e1c" stroke-width="2"/>
    <line x1="20" y1="9" x2="20" y2="33" stroke="#1f5e1c" stroke-width="2"/>`,
  Elite: `<polygon points="4,30 7,10 14,20 20,6 26,20 33,10 36,30" fill="#e8b923" stroke="#7a5a00" stroke-width="2"/>
    <rect x="4" y="30" width="32" height="6" fill="#c99a12" stroke="#7a5a00" stroke-width="2"/>
    <circle cx="20" cy="22" r="3" fill="#e3350d"/>`,
};

/** `earned: false` draws the empty slot in the case. */
export function badgeSvg(name: string, earned: boolean, size = 40): string {
  const body = shapes[name] ?? shapes.Elite;
  return `<svg class="badge-svg ${earned ? 'earned' : 'locked'}" viewBox="0 0 40 40" width="${size}" height="${size}" role="img" aria-label="${name} Badge${earned ? '' : ' (not earned)'}">${body}</svg>`;
}
