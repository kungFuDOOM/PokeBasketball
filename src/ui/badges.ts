// Small inline SVG badges for the badge case. Shapes and colors nod to the Kanto, Johto and Hoenn badges.

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
  // Johto.
  Zephyr: `<path d="M4 26 C10 10 24 5 37 6 C31 11 30 15 33 18 C27 18 24 21 26 25 C19 23 13 26 11 33 C9 30 6 28 4 26z" fill="#c9ced6" stroke="#5d6470" stroke-width="2"/>
    <path d="M12 26 C17 18 24 13 32 10" fill="none" stroke="#8a919c" stroke-width="2"/>`,
  Hive: `<ellipse cx="20" cy="21" rx="15" ry="16" fill="#d83a2e" stroke="#6e130d" stroke-width="2"/>
    <line x1="20" y1="6" x2="20" y2="37" stroke="#2b1210" stroke-width="2"/>
    <circle cx="13" cy="16" r="3" fill="#2b1210"/><circle cx="27" cy="16" r="3" fill="#2b1210"/><circle cx="13" cy="27" r="3" fill="#2b1210"/><circle cx="27" cy="27" r="3" fill="#2b1210"/>`,
  Plain: `<rect x="7" y="7" width="26" height="26" rx="5" transform="rotate(45 20 20)" fill="#f2c94c" stroke="#8a6a0e" stroke-width="2"/>
    <rect x="14" y="14" width="12" height="12" rx="2" transform="rotate(45 20 20)" fill="#fff1b8"/>`,
  Fog: `<circle cx="20" cy="20" r="16" fill="#6b4fa8" stroke="#2c1a52" stroke-width="2"/>
    <path d="M9 17 q5.5-5 11 0 t11 0 M9 24 q5.5-5 11 0 t11 0" fill="none" stroke="#d9cdf5" stroke-width="2.5" stroke-linecap="round"/>`,
  Storm: `<polygon points="14,3 26,3 26,14 37,14 37,26 26,26 26,37 14,37 14,26 3,26 3,14 14,14" fill="#b5653a" stroke="#5a2a10" stroke-width="2"/>
    <circle cx="20" cy="20" r="5" fill="#f2c08a"/>`,
  Mineral: `<polygon points="20,3 35,12 35,28 20,37 5,28 5,12" fill="#aeb8c4" stroke="#4a5562" stroke-width="2"/>
    <polygon points="20,10 28,15 28,25 20,30 12,25 12,15" fill="#e6ebf0"/>`,
  Glacier: `<polygon points="20,3 35,12 35,28 20,37 5,28 5,12" fill="#8fd8f0" stroke="#2a7894" stroke-width="2"/>
    <path d="M20 9 V31 M11 14.5 L29 25.5 M29 14.5 L11 25.5" stroke="#ffffff" stroke-width="2.5" stroke-linecap="round"/>`,
  Rising: `<path d="M20 3 L34 30 L20 24 L6 30z" fill="#3d6fd8" stroke="#13265a" stroke-width="2"/>
    <path d="M20 12 L27 27 L20 24 L13 27z" fill="#e8483c"/><circle cx="20" cy="34" r="3" fill="#f5c518"/>`,
  // Hoenn.
  Stone: `<polygon points="20,3 31,9 37,21 30,34 14,37 4,26 7,11" fill="#9c8a6e" stroke="#4a3e2c" stroke-width="2"/>
    <polygon points="20,10 27,14 29,22 24,29 15,30 11,22 13,14" fill="#c9b892"/>`,
  Knuckle: `<rect x="6" y="12" width="28" height="20" rx="7" fill="#e08a4a" stroke="#6a2f0c" stroke-width="2"/>
    <path d="M13 12 V20 M20 12 V20 M27 12 V20" stroke="#6a2f0c" stroke-width="2"/><rect x="10" y="5" width="20" height="8" rx="4" fill="#f2b07a" stroke="#6a2f0c" stroke-width="2"/>`,
  Dynamo: `<circle cx="20" cy="20" r="16" fill="#f5c518" stroke="#6e5600" stroke-width="2"/>
    <circle cx="20" cy="20" r="9" fill="none" stroke="#6e5600" stroke-width="2" stroke-dasharray="4 3"/><path d="M22 9 L14 22 H20 L18 31 L26 18 H20z" fill="#fff6c2" stroke="#6e5600" stroke-width="1.2"/>`,
  Heat: `<path d="M20 3 C26 12 34 16 32 27 C30 34 25 37 20 37 C15 37 9 34 8 27 C7 19 13 16 14 9 C17 13 18 15 20 3z" fill="#e2492f" stroke="#6a160a" stroke-width="2"/>
    <path d="M20 17 C23 22 26 24 25 29 C24 32 22 33 20 33 C17 33 15 31 15 28 C15 24 18 22 20 17z" fill="#ffc24a"/>`,
  Balance: `<rect x="5" y="5" width="30" height="30" rx="4" fill="#c9c3a3" stroke="#57523a" stroke-width="2"/>
    <rect x="9" y="9" width="10" height="22" fill="#e3463a"/><rect x="21" y="9" width="10" height="22" fill="#f2e7c2"/>`,
  Feather: `<path d="M8 34 C10 20 20 8 34 5 C33 17 26 28 12 33z" fill="#8fd0f2" stroke="#1f5d82" stroke-width="2"/>
    <path d="M8 34 L28 12 M15 26 L22 25 M19 21 L26 19" stroke="#1f5d82" stroke-width="1.8" stroke-linecap="round"/>`,
  Mind: `<circle cx="14" cy="20" r="10" fill="#f28ab8" stroke="#6a1a42" stroke-width="2"/><circle cx="26" cy="20" r="10" fill="#f5d04a" stroke="#6a4e0a" stroke-width="2"/>
    <circle cx="14" cy="20" r="3.5" fill="#6a1a42"/><circle cx="26" cy="20" r="3.5" fill="#6a4e0a"/>`,
  Rain: `<path d="M20 3 C27 14 33 20 33 26 C33 33 27 37 20 37 C13 37 7 33 7 26 C7 20 13 14 20 3z" fill="#2f78d0" stroke="#0c2a52" stroke-width="2"/>
    <path d="M15 24 C15 29 18 31 21 31" fill="none" stroke="#bfe0ff" stroke-width="2.5" stroke-linecap="round"/>`,
  /** Any badge without its own design: a plain medal, never mistaken for the Elite emblem. */
  Neutral: `<circle cx="20" cy="20" r="16" fill="#9aa3ad" stroke="#4d555e" stroke-width="2"/>
    <circle cx="20" cy="20" r="9" fill="none" stroke="#e3e7eb" stroke-width="2"/>`,
  Elite: `<polygon points="4,30 7,10 14,20 20,6 26,20 33,10 36,30" fill="#e8b923" stroke="#7a5a00" stroke-width="2"/>
    <rect x="4" y="30" width="32" height="6" fill="#c99a12" stroke="#7a5a00" stroke-width="2"/>
    <circle cx="20" cy="22" r="3" fill="#e3350d"/>`,
};

/** `earned: false` draws the empty slot in the case. Unknown names get a neutral medal. */
export function badgeSvg(name: string, earned: boolean, size = 40): string {
  const body = shapes[name] ?? shapes.Neutral;
  return `<svg xmlns="http://www.w3.org/2000/svg" class="badge-svg ${earned ? 'earned' : 'locked'}" viewBox="0 0 40 40" width="${size}" height="${size}" role="img" aria-label="${name} Badge${earned ? '' : ' (not earned)'}">${body}</svg>`;
}
