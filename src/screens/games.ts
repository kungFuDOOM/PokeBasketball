// Franchise game log: every week's results, and the box score of any game played this season.
import { monByDex, spriteUrl } from '../data/pokemon';
import { monOf, seasonWeeks, weekLabel, type BoxLine, type FGame, type Franchise } from '../franchise/league';
import { esc } from '../util';
import { boxHtml, type BoxRow } from './results';

const rowOf = (l: BoxLine): BoxRow => {
  const m = monByDex(l[1]);
  const [sec, pts, fgm, fga, tpm, tpa, reb, ast, stl, blk, dnk] = l.slice(4) as number[];
  return { dex: l[1], name: m.name, pos: m.pos, starter: l[3] === 1, sec, pts, fgm, fga, tpm, tpa, reb, ast, stl, blk, dnk };
};

/**
 * `onBack` leaves the log (to the hub, or to the results screen it was opened from); `backLabel` names
 * where that goes. Opens on `week`, or the latest week with a result.
 */
export function gamesScreen(root: HTMLElement, f: Franchise, onBack: () => void, backLabel = 'Hub', week?: number) {
  const host = root;
  root = document.createElement('div');
  host.replaceChildren(root);
  const weeks = [...new Set(f.games.map((g) => g.week))].sort((a, b) => a - b);
  const played = f.games.filter((g) => g.score);
  let wk = week ?? (played.length ? Math.max(...played.map((g) => g.week)) : weeks[0]);
  let open: FGame | null = null;

  const chip = (w: number) => w <= seasonWeeks(f) ? `W${w}` : w === seasonWeeks(f) + 1 ? 'Semis' : 'Final';
  const team = (id: number) => f.teams[id];

  const gameRow = (g: FGame, i: number) => {
    const [h, a] = [team(g.home), team(g.away)];
    const mine = g.home === 0 || g.away === 0;
    if (!g.score) {
      return `<li class="gl-row upcoming ${mine ? 'mine' : ''}"><span class="gl-team" style="--tc:${a.color}">${esc(a.name)}</span><span class="gl-at">at</span><span class="gl-team" style="--tc:${h.color}">${esc(h.name)}</span><small>Not played yet</small></li>`;
    }
    const [hs, as] = g.score;
    return `
      <li><button class="gl-row ${mine ? 'mine' : ''}" data-g="${i}">
        <span class="gl-team ${as > hs ? 'win' : ''}" style="--tc:${a.color}">${esc(a.name)} <b>${as}</b></span>
        <span class="gl-at">at</span>
        <span class="gl-team ${hs > as ? 'win' : ''}" style="--tc:${h.color}">${esc(h.name)} <b>${hs}</b></span>
        <small>${g.q && g.q > 4 ? `${g.q === 5 ? 'OT' : `${g.q - 4}OT`} · ` : ''}${g.pog ? `POG ${esc(monOf(f, g.pog).name)}` : ''} ${g.box ? '· Box score ›' : ''}</small>
      </button></li>`;
  };

  const boxView = (g: FGame) => {
    const [h, a] = [team(g.home), team(g.away)];
    const [hs, as] = g.score!;
    const lines = g.box ?? [];
    const side = (s: 0 | 1) => lines.filter((l) => l[2] === s).map(rowOf);
    const pog = g.pog ? lines.find((l) => l[0] === g.pog) : undefined;
    return `
      <div class="gl-box">
        <p class="final-tag">${esc(weekLabel(f, g.week))} · Final${g.q && g.q > 4 ? ` / ${g.q === 5 ? 'OT' : `${g.q - 4}OT`}` : ''}</p>
        <div class="final-score">
          <span style="--tc:${a.color}">${esc(a.abbr)} <b>${as}</b></span>
          <span class="dash">–</span>
          <span style="--tc:${h.color}"><b>${hs}</b> ${esc(h.abbr)}</span>
        </div>
        ${pog ? `<div class="pog"><img src="${spriteUrl(pog[1])}" alt=""><div><span class="lbl">Player of the game</span><strong>${esc(monByDex(pog[1]).name)}</strong><span>${pog[5]} PTS · ${pog[10]} REB · ${pog[11]} AST · ${pog[12]} STL · ${pog[13]} BLK</span></div></div>` : ''}
        ${lines.length
          ? `<div class="boxes">${boxHtml(a.name, a.color, as, side(1), true)}${boxHtml(h.name, h.color, hs, side(0), true)}</div>`
          : '<p class="note center">This game was played before box scores were saved, so only the final score is kept.</p>'}
        <div class="actions center">
          <button class="btn primary" data-a="week">Back to ${esc(chip(g.week) === 'Semis' ? 'the semifinals' : chip(g.week) === 'Final' ? 'the final' : weekLabel(f, g.week))}</button>
          <button class="btn ghost" data-a="back">${esc(backLabel)}</button>
        </div>
      </div>`;
  };

  const render = () => {
    window.scrollTo(0, 0);
    const games = f.games.filter((g) => g.week === wk);
    root.innerHTML = `
      <div class="results gamelog">
        <header class="draft-head">
          <button class="btn ghost small" data-a="back">${esc(backLabel)}</button>
          <div class="status"><span class="round">SEASON ${f.season}</span><span class="otc">${open ? 'Box score' : 'Games'}</span></div>
        </header>
        ${open ? boxView(open) : `
          <div class="filters gl-weeks" role="group" aria-label="Week">
            ${weeks.map((w) => `<button data-w="${w}" class="${w === wk ? 'on' : ''} ${f.games.some((g) => g.week === w && g.score) ? '' : 'later'}">${chip(w)}</button>`).join('')}
          </div>
          <h3 class="sec">${esc(weekLabel(f, wk))}</h3>
          <ul class="gl-list">${games.map((g) => gameRow(g, f.games.indexOf(g))).join('') || '<li class="note">No games this week.</li>'}</ul>
          <p class="note">Your games are highlighted. Tap a result for its box score.</p>`}
      </div>`;
  };

  root.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const a = t.closest<HTMLElement>('[data-a]')?.dataset.a;
    if (a === 'back') return onBack();
    if (a === 'week') { open = null; render(); return; }
    const w = t.closest<HTMLElement>('[data-w]')?.dataset.w;
    if (w) { wk = Number(w); render(); return; }
    const gi = t.closest<HTMLElement>('[data-g]')?.dataset.g;
    if (gi) { open = f.games[Number(gi)]; render(); }
  });
  render();
}
