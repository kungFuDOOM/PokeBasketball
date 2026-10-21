// Draft presentation only: trading-card markup, the draft-complete summary, confetti. No draft rules live here.
import { RATING_LABELS, TYPE_COLORS, spriteUrl, type Mon, type Pos, type Ratings } from '../data/pokemon';
import { bestLineup, teamOvr } from '../game/game';
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

/** Display-only letter grade for a starters overall. */
export function gradeOfOvr(ovr: number): string {
  const steps: [number, string][] = [[92, 'A+'], [91, 'A'], [90, 'A-'], [89, 'B+'], [88, 'B'], [87, 'B-'], [86, 'C+'], [84, 'C'], [82, 'C-']];
  return steps.find(([min]) => ovr >= min)?.[1] ?? 'D';
}

/** Where each position stands on the mini court (percent from left / top of a half court, basket at the top). */
const SPOT: Record<Pos, [number, number]> = { PG: [50, 78], SG: [80, 56], SF: [20, 56], PF: [68, 30], C: [34, 24] };

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
  const { starters, bench } = bestLineup(o.picks);
  const ovr = teamOvr(starters);
  const rank = 1 + o.others.filter((x) => x > ovr).length;
  const seen: Record<string, number> = {};
  const players = starters.map((m, k) => {
    const n = seen[m.pos] = (seen[m.pos] ?? -1) + 1;
    const [x, y] = SPOT[m.pos];
    return `<span class="cp t-${tier(m.ovr)}" style="--x:${Math.min(92, x + n * 14)}%;--y:${Math.min(88, y + n * 10)}%;--k:${k}"><img src="${spriteUrl(m.dex)}" alt="${esc(m.name)}"><b>${m.pos}</b><small>${esc(m.name)}</small></span>`;
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
        <div class="court" aria-label="Starting five">
          <span class="key"></span><span class="arc"></span>${players}
        </div>
        ${bench.length ? `<ul class="sum-bench">${bench.map((m) => `<li title="${esc(m.name)} (${m.pos}, ${m.ovr})"><img src="${spriteUrl(m.dex)}" alt="${esc(m.name)}"></li>`).join('')}</ul>` : ''}
        ${o.customize ? `
        <div class="sum-name">
          <label for="sum-name">Team name</label>
          <input id="sum-name" type="text" maxlength="20" value="${esc(o.teamName)}" autocomplete="off" spellcheck="false">
          <div class="swatches" role="group" aria-label="Team colors">${swatches}</div>
        </div>` : `<p class="sum-team">${esc(o.teamName)}</p>`}
        <button class="btn primary big" data-a="continue">Continue</button>
      </div>
    </div>`;
}
