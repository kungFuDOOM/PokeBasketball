// Draft presentation only: trading-card markup, the draft-complete summary, confetti. No draft rules live here.
import { RATING_LABELS, TYPE_COLORS, spriteUrl, type Mon, type Pos, type Ratings } from '../data/pokemon';
import { bestLineup, teamOvr } from '../game/game';
import { gradeOfOvr } from '../season/grade';
import { esc, tier } from '../util';

export function typeChips(m: Mon): string {
  return m.types.map((t) => `<i style="--tc:${TYPE_COLORS[t]}">${t}</i>`).join('');
}

const RATING_KEYS = Object.keys(RATING_LABELS) as (keyof Ratings)[];

/** A pick option as a trading card: art, name, position, types, rating bars, overall. `i` staggers the entrance. */
export function monCard(m: Mon, extra = '', i = -1): string {
  const bars = RATING_KEYS.map((k) => `<i style="--v:${m.r[k]}%" title="${RATING_LABELS[k]} ${m.r[k]}"></i>`).join('');
  return `
    <button class="mon-card t-${tier(m.ovr)} ${extra}" data-dex="${m.dex}" ${i >= 0 ? `style="--i:${i}"` : ''} aria-label="${esc(m.name)}, ${m.pos}, overall ${m.ovr}">
      <span class="ovr">${m.ovr}</span>
      <span class="pos">${m.pos}</span>
      <span class="art"><img src="${spriteUrl(m.dex)}" alt="" loading="lazy"></span>
      <span class="nm">${esc(m.name)}</span>
      <span class="types">${typeChips(m)}</span>
      <span class="bars" aria-hidden="true">${bars}</span>
    </button>`;
}

export { gradeOfOvr };

/** Where each position stands on the mini court (percent from left / top of a half court, basket at the top). */
const SPOT: Record<Pos, [number, number]> = { PG: [50, 78], SG: [82, 56], SF: [18, 56], PF: [68, 28], C: [32, 24] };

export const SWATCHES: [string, string][] = [
  ['#3b6fd8', '#16224a'], ['#e3350d', '#4a0f05'], ['#21a366', '#0b3a26'],
  ['#d4a017', '#4a3606'], ['#8b5cf6', '#2a1a5e'], ['#e8e8f0', '#2a2a3a'],
];

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** CSS/DOM confetti. Deterministic (no Math.random), skipped for reduced motion. */
export function confettiHtml(colors: string[]): string {
  if (reduced()) return '';
  const pal = [...colors, '#ffd866', '#ff7a59', '#5fe0a0', '#7aa2ff'];
  return `<div class="confetti" aria-hidden="true">${Array.from({ length: 44 }, (_, i) =>
    `<i style="--x:${(i * 37) % 100}%;--d:${((i * 53) % 18) / 10}s;--t:${2.4 + ((i * 29) % 15) / 10}s;--r:${(i * 71) % 360}deg;--c:${pal[i % pal.length]}"></i>`).join('')}</div>`;
}

export interface SummaryOpts {
  teamName: string;
  color: string;
  color2: string;
  picks: Mon[];
  size: number;
  /** Starters overalls of the other teams, for the rank line. */
  others: number[];
  customize: boolean;
}

/** Draft-complete screen: team on a mini court, overall + grade, and (optionally) rename and color swatches. */
export function summaryHtml(o: SummaryOpts): string {
  // One starter per slot (PG, SG, SF, PF, C) from the shared by-position rule; a cover player stands in their slot.
  const { starters, bench, slots } = bestLineup(o.picks);
  const ovr = teamOvr(starters);
  const rank = 1 + o.others.filter((x) => x > ovr).length;
  const players = starters.map((m, k) => {
    const [x, y] = SPOT[slots[k]];
    const cover = m.pos !== slots[k] ? ` title="${esc(m.name)} (${m.pos}) covers ${slots[k]}"` : '';
    return `<span class="cp t-${tier(m.ovr)}" style="--x:${x}%;--y:${y}%;--k:${k}"${cover}><img src="${spriteUrl(m.dex)}" alt="${esc(m.name)}"><b>${slots[k]}</b><small>${esc(m.name)}</small></span>`;
  }).join('');
  const swatches = SWATCHES.map(([a, b], i) =>
    `<button class="sw ${a === o.color ? 'on' : ''}" data-sw="${i}" style="--a:${a};--b:${b}" aria-label="Team colors ${i + 1}"></button>`).join('');
  return `
    <div class="sum-bg" style="--tc:${o.color};--tc2:${o.color2}">
      ${confettiHtml([o.color, o.color2])}
      <div class="sum" role="dialog" aria-label="Draft complete">
        <p class="eyebrow">Draft complete</p>
        <div class="sum-top">
          <div class="sum-grade" aria-label="Grade ${gradeOfOvr(ovr)}"><small>Grade</small><b>${gradeOfOvr(ovr)}</b></div>
          <div class="sum-ovr"><small>Team OVR</small><b>${ovr}</b><span>${rank === 1 ? 'Best in the league' : `#${rank} of ${o.others.length + 1} drafts`}</span></div>
        </div>
        <div class="mini-court" aria-label="Starting five">
          <span class="key"></span><span class="arc"></span>${players}
        </div>
        ${bench.length ? `<ul class="sum-bench">${bench.map((m) => `<li title="${esc(m.name)} (${m.pos}, ${m.ovr})"><img src="${spriteUrl(m.dex)}" alt="${esc(m.name)}"></li>`).join('')}</ul>` : ''}
        ${o.customize ? `
        <div class="sum-name">
          <label for="sum-name">Team name</label>
          <input id="sum-name" type="text" maxlength="20" value="${esc(o.teamName)}" autocomplete="off" spellcheck="false">
          <div class="swatches" role="group" aria-label="Team colors">${swatches}</div>
        </div>` : `<p class="sum-team">${esc(o.teamName)}</p>`}
        <div class="sum-actions">
          <button class="ss-thumb" data-a="preview-draft" aria-label="See the share card full size" title="What you'll share"><span class="ss-thumb-ph">Drawing…</span></button>
          <button class="btn big" data-a="share-draft">Share my team</button>
          <button class="btn primary big" data-a="continue">Continue</button>
        </div>
        <p class="note sum-share-status" role="status"></p>
      </div>
    </div>`;
}
