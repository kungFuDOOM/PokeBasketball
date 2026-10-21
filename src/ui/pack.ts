import { PACK_TIERS, type PackTier } from '../battles/service';

let n = 0;

// Wrapper outline with crimped foil edges, top and bottom (viewBox 100×150).
const xs = Array.from({ length: 21 }, (_, i) => i * 5);
const BODY = `M0 3${xs.slice(1).map((x) => `L${x} ${x % 10 ? 8 : 3}`).join('')}`
  + `${[...xs].reverse().map((x) => `L${x} ${x % 10 ? 142 : 147}`).join('')}Z`;

/** A prize pack: foil wrapper in the tier's colors with the Poké Jam ball on the front. Original art, no card-game branding. */
export function packSvg(tier: PackTier, width = 96, cls = ''): string {
  const t = PACK_TIERS[tier];
  const id = `pk${++n}`;
  const ink = tier === 'pokemon_100' ? '#1a1400' : '#f2f0e6';
  const body = BODY;
  return `
    <svg class="pack-svg ${cls}" viewBox="0 0 100 150" width="${width}" height="${Math.round(width * 1.5)}" role="img" aria-label="${t.label}">
      <defs>
        <linearGradient id="${id}g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="${t.color}"/><stop offset="0.55" stop-color="${t.color}"/><stop offset="1" stop-color="${t.color2}"/>
        </linearGradient>
        <clipPath id="${id}c"><path d="${body}"/></clipPath>
      </defs>
      <path d="${body}" fill="url(#${id}g)" stroke="${t.color2}" stroke-width="2"/>
      <g clip-path="url(#${id}c)">
        <rect class="pack-shine" x="-60" y="-10" width="26" height="180" fill="#fff" opacity="0.28" transform="rotate(20)"/>
        <rect y="14" width="100" height="3" fill="${ink}" opacity="0.18"/>
        <rect y="133" width="100" height="3" fill="${ink}" opacity="0.18"/>
      </g>
      <text x="50" y="31" text-anchor="middle" font-family="'Press Start 2P', monospace" font-size="7.5" fill="${ink}">POKé JAM</text>
      <g transform="translate(50 70)">
        <circle r="23" fill="#e8742a" stroke="#1b1b1b" stroke-width="2.5"/>
        <path d="M-23 0H23M0 -23V23M-16 -16C-6 -6 -6 6 -16 16M16 -16C6 -6 6 6 16 16" fill="none" stroke="#1b1b1b" stroke-width="2"/>
        <circle cx="-8" cy="-10" r="4" fill="#fff" opacity="0.35"/>
      </g>
      <rect x="10" y="104" width="80" height="22" rx="3" fill="#000" opacity="0.32"/>
      <text x="50" y="119.5" text-anchor="middle" font-family="'Press Start 2P', monospace" font-size="8" fill="#fff">${t.short}</text>
    </svg>`;
}

const RARITY_COLORS: Record<string, string> = { Epic: '#ffcb05', Rare: '#e3350d', Uncommon: '#3b6fd8', Common: '#9aa0c8' };

/** A pulled card, shown like a graded slab: label with grade and insured value over the card image. */
export function cardHtml(p: { name: string; image: string | null; grade: string | null; rarity: string | null; insuredValue: number | null }, size: 'small' | 'big' = 'big'): string {
  const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
  const rc = RARITY_COLORS[p.rarity ?? ''] ?? '#9aa0c8';
  return `
    <figure class="slab ${size}" style="--rc:${rc}">
      <figcaption class="slab-label">
        <span class="slab-name">${esc(p.name)}</span>
        <span class="slab-meta">${p.grade ? `<b>${esc(p.grade)}</b>` : ''}${p.rarity ? `<i>${esc(p.rarity)}</i>` : ''}${p.insuredValue !== null ? `<em>$${Math.round(p.insuredValue)}</em>` : ''}</span>
      </figcaption>
      <div class="slab-window">${p.image ? `<img src="${esc(p.image)}" alt="${esc(p.name)}" loading="lazy" referrerpolicy="no-referrer">` : '<span class="slab-none">Card image unavailable</span>'}</div>
    </figure>`;
}
