// Every Pokémon in the game with every rating: sortable, filterable, tap a row for its full card.
import { EVOLUTIONS, POKEMON, POSITIONS, TYPE_COLORS, bodyOf, monByDex, spriteUrl, type Mon, type PokeType, type Pos, type Ratings } from '../data/pokemon';
import { staminaOf } from '../game/game';
import { esc, tier } from '../util';
import { detailHtml, typeChips } from './draft';

type Key = 'name' | 'pos' | 'ovr' | keyof Ratings | 'sta' | 'h';

const COLS: { k: Key; label: string; title?: string }[] = [
  { k: 'name', label: 'Pokémon' },
  { k: 'pos', label: 'Pos' },
  { k: 'ovr', label: 'OVR' },
  { k: 'spd', label: 'Spd', title: 'Speed' },
  { k: 'sht', label: 'Sht', title: 'Shooting' },
  { k: 'ins', label: 'Fin', title: 'Finishing' },
  { k: 'pas', label: 'Pas', title: 'Passing' },
  { k: 'def', label: 'Def', title: 'Perimeter defense' },
  { k: 'blk', label: 'Blk', title: 'Blocking' },
  { k: 'reb', label: 'Reb', title: 'Rebounding' },
  { k: 'hnd', label: 'Hnd', title: 'Handles' },
  { k: 'sta', label: 'Sta', title: 'Stamina' },
  { k: 'h', label: 'Height', title: 'Real height' },
];

/** What a Pokémon evolves from and into, in franchise levels. */
const PREV: Record<number, number> = {};
for (const [from, e] of Object.entries(EVOLUTIONS)) for (const t of e.to) PREV[t] = Number(from);

function evoLine(m: Mon): string {
  const e = EVOLUTIONS[m.dex];
  const prev = PREV[m.dex];
  const parts: string[] = [];
  if (prev) parts.push(`Evolves from ${esc(monByDex(prev).name)}.`);
  if (e) parts.push(`Evolves into ${e.to.map((t) => `${esc(monByDex(t).name)} (${monByDex(t).ovr})`).join(' or ')} at franchise level ${e.level}.`);
  if (!parts.length) parts.push('Does not evolve.');
  return parts.join(' ');
}

export function rosterScreen(root: HTMLElement, onBack: () => void) {
  const host = root;
  root = document.createElement('div');
  host.replaceChildren(root);
  let sort: Key = 'ovr';
  let dir = -1;
  let pos: Pos | '' = '';
  let type = '';
  let q = '';
  let open: Mon | null = null;

  const value = (m: Mon, k: Key): number | string =>
    k === 'name' ? m.name : k === 'pos' ? POSITIONS.indexOf(m.pos) : k === 'ovr' ? m.ovr : k === 'sta' ? staminaOf(m) : k === 'h' ? bodyOf(m.dex).h : m.r[k];

  root.innerHTML = `
    <div class="rosterdex">
      <header class="draft-head">
        <button class="btn ghost small" data-a="back">Menu</button>
        <div class="status"><span class="round">POKé JAM</span><span class="otc">Full roster</span></div>
      </header>
      <div class="rd-controls">
        <div class="filters" role="group" aria-label="Position">
          ${(['', ...POSITIONS] as const).map((p) => `<button data-p="${p}" class="${p === '' ? 'on' : ''}">${p || 'All'}<small>${p ? POKEMON.filter((m) => m.pos === p).length : POKEMON.length}</small></button>`).join('')}
        </div>
        <input type="search" id="rd-q" placeholder="Search a Pokémon, type or archetype" aria-label="Search" autocomplete="off">
        <select id="rd-type" aria-label="Type"><option value="">All types</option>${(Object.keys(TYPE_COLORS) as PokeType[]).sort().map((t) => `<option value="${t}">${t}</option>`).join('')}</select>
      </div>
      <p class="note rd-count"></p>
      <div class="tbl-scroll rd-scroll">
        <table class="tbl rd-tbl">
          <thead><tr>${COLS.map((c) => `<th data-k="${c.k}" ${c.title ? `title="${c.title}"` : ''} scope="col" class="${c.k === 'name' ? 'rd-name' : ''}">${c.label}</th>`).join('')}<th class="opt">Type</th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <p class="note">OVR weighs each rating by position: passing and handles count most for a point guard, blocking and rebounding for a center. STA is stamina, how long a Pokémon plays before it needs a rest in franchise games. Tap a column to sort, or a Pokémon to see its card.</p>
      <div class="rd-sheet"></div>
    </div>`;
  const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;

  const render = () => {
    const needle = q.trim().toLowerCase();
    const shown = POKEMON.filter((m) => (!pos || m.pos === pos) && (!type || m.types.includes(type as PokeType))
      && (!needle || [m.name, m.archetype, ...m.types, `#${m.dex}`].join(' ').toLowerCase().includes(needle)))
      .sort((a, b) => {
        const x = value(a, sort);
        const y = value(b, sort);
        return (typeof x === 'string' ? x.localeCompare(y as string) : x - (y as number)) * dir || b.ovr - a.ovr || a.dex - b.dex;
      });
    const cell = (v: number) => `<td class="rd-r t-${tier(v)} ${v < 50 ? 'lo' : ''}"><b>${v}</b></td>`;
    $('tbody').innerHTML = shown.length ? shown.map((m) => `
      <tr data-dex="${m.dex}" tabindex="0">
        <th class="rd-name" scope="row"><div><img src="${spriteUrl(m.dex)}" alt="" loading="lazy"><span>${esc(m.name)}<small>#${m.dex}</small></span></div></th>
        <td class="rd-pos">${m.pos}</td>
        <td class="rd-ovr t-${tier(m.ovr)}"><b>${m.ovr}</b></td>
        ${(['spd', 'sht', 'ins', 'pas', 'def', 'blk', 'reb', 'hnd'] as const).map((k) => cell(m.r[k])).join('')}
        ${cell(staminaOf(m))}
        <td>${bodyOf(m.dex).h ? `${bodyOf(m.dex).h.toFixed(1)} m` : '–'}</td>
        <td class="opt"><span class="types">${typeChips(m)}</span></td>
      </tr>`).join('') : `<tr><td colspan="${COLS.length + 1}" class="rd-empty">No Pokémon match. Clear the search or pick another position or type.</td></tr>`;
    $('.rd-count').textContent = `Showing ${shown.length} of ${POKEMON.length} Pokémon`;
    root.querySelectorAll<HTMLElement>('thead th[data-k]').forEach((th) => {
      if (th.dataset.k === sort) th.setAttribute('aria-sort', dir < 0 ? 'descending' : 'ascending');
      else th.removeAttribute('aria-sort');
    });
    $('.rd-sheet').innerHTML = open ? `
      <div class="sheet-bg">
        <div class="sheet detail rd-card" role="dialog" aria-label="${esc(open.name)}">
          <button class="close" data-a="close" aria-label="Close">×</button>
          ${detailHtml(open, null)}
          <p class="note">${evoLine(open)} Stamina ${staminaOf(open)}. ${bodyOf(open.dex).h ? `${bodyOf(open.dex).h} m, ${bodyOf(open.dex).w} kg.` : ''}</p>
        </div>
      </div>` : '';
  };

  root.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const a = t.closest<HTMLElement>('[data-a]')?.dataset.a;
    if (a === 'back') return onBack();
    if (a === 'close' || t.classList.contains('sheet-bg')) { open = null; render(); return; }
    const th = t.closest<HTMLElement>('thead th[data-k]');
    if (th) {
      const k = th.dataset.k as Key;
      if (sort === k) dir = -dir;
      else { sort = k; dir = k === 'name' || k === 'pos' ? 1 : -1; }
      render();
      return;
    }
    const p = t.closest<HTMLElement>('[data-p]');
    if (p) {
      pos = p.dataset.p as Pos | '';
      root.querySelectorAll('[data-p]').forEach((x) => x.classList.toggle('on', x === p));
      render();
      return;
    }
    const row = t.closest<HTMLElement>('tbody tr[data-dex]');
    if (row) { open = monByDex(Number(row.dataset.dex)); render(); }
  });
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && open) { open = null; render(); return; }
    const row = (e.target as HTMLElement).closest<HTMLElement>('tbody tr[data-dex]');
    if (row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); row.click(); }
  });
  $<HTMLInputElement>('#rd-q').addEventListener('input', (e) => { q = (e.target as HTMLInputElement).value; render(); });
  $<HTMLSelectElement>('#rd-type').addEventListener('change', (e) => { type = (e.target as HTMLSelectElement).value; render(); });
  render();
}
