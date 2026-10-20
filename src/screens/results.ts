import { spriteUrl } from '../data/pokemon';
import type { Game } from '../game/game';
import type { Player, TeamId } from '../game/types';
import { esc } from '../util';

const gameScore = (p: Player) => {
  const s = p.stats;
  return s.pts + s.reb * 1.2 + s.ast * 1.5 + s.stl * 2 + s.blk * 2 - (s.fga - s.fgm) * 0.4;
};

export interface ResultsOptions {
  /** Line above the headline, e.g. "Week 3 · Final". */
  tag: string;
  headline?: string;
  /** Extra section between the player of the game and the box scores. */
  extraHtml?: string;
  buttons: { id: string; label: string; kind?: 'primary' | 'ghost' }[];
  onAction: (id: string) => void;
}

export function resultsScreen(root: HTMLElement, g: Game, opts: ResultsOptions) {
  const [h, a] = g.teams;
  const winner: TeamId = g.score[0] > g.score[1] ? 0 : 1;
  const pog = [...g.rosterOf(winner)].sort((x, y) => gameScore(y) - gameScore(x))[0];
  const userWon = h.human && winner === 0;
  const headline = opts.headline ?? (!h.human ? `${g.teams[winner].name} win` : userWon ? 'You win!' : `${a.name} win`);

  const withBench = g.bench.length > 0;
  const mins = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;
  const table = (t: TeamId) => {
    const roster = g.rosterOf(t);
    const rows = roster.map((p) => {
      const s = p.stats;
      const name = `<th><img src="${spriteUrl(p.mon.dex)}" alt="">${esc(p.mon.name)}<small>${p.mon.pos}</small></th>`;
      if (withBench && s.sec === 0) return `<tr class="dnp">${name}<td>DNP</td><td colspan="8"></td></tr>`;
      return `<tr class="${p.starter ? '' : 'bench'}">
        ${name}
        ${withBench ? `<td>${mins(s.sec)}</td>` : ''}
        <td>${s.pts}</td><td>${s.fgm}-${s.fga}</td><td>${s.tpm}-${s.tpa}</td>
        <td>${s.reb}</td><td>${s.ast}</td><td>${s.stl}</td><td>${s.blk}</td><td>${s.dnk}</td>
      </tr>`;
    }).join('');
    const tot = roster.reduce((acc, p) => {
      for (const k of Object.keys(p.stats) as (keyof Player['stats'])[]) acc[k] = (acc[k] ?? 0) + p.stats[k];
      return acc;
    }, {} as Record<keyof Player['stats'], number>);
    return `
      <div class="box" style="--tc:${g.teams[t].color}">
        <h3>${esc(g.teams[t].name)} <b>${g.score[t]}</b></h3>
        <div class="box-scroll">
          <table>
            <thead><tr><th>Pokémon</th>${withBench ? '<th>MIN</th>' : ''}<th>PTS</th><th>FG</th><th>3PT</th><th>REB</th><th>AST</th><th>STL</th><th>BLK</th><th>DNK</th></tr></thead>
            <tbody>${rows}</tbody>
            <tfoot><tr><th>Team</th>${withBench ? '<td></td>' : ''}<td>${tot.pts}</td><td>${tot.fgm}-${tot.fga}</td><td>${tot.tpm}-${tot.tpa}</td><td>${tot.reb}</td><td>${tot.ast}</td><td>${tot.stl}</td><td>${tot.blk}</td><td>${tot.dnk}</td></tr></tfoot>
          </table>
        </div>
      </div>`;
  };

  root.innerHTML = `
    <div class="results">
      <p class="final-tag">${esc(opts.tag)} · Final${g.quarter > 5 ? ` / ${g.quarter - 4}OT` : g.quarter === 5 ? ' / OT' : ''}</p>
      <h2>${esc(headline)}</h2>
      <div class="final-score">
        <span style="--tc:${h.color}">${esc(h.abbr)} <b>${g.score[0]}</b></span>
        <span class="dash">–</span>
        <span style="--tc:${a.color}"><b>${g.score[1]}</b> ${esc(a.abbr)}</span>
      </div>
      <div class="pog">
        <img src="${spriteUrl(pog.mon.dex)}" alt="">
        <div>
          <span class="lbl">Player of the game</span>
          <strong>${esc(pog.mon.name)}</strong>
          <span>${pog.stats.pts} PTS · ${pog.stats.reb} REB · ${pog.stats.ast} AST · ${pog.stats.stl} STL · ${pog.stats.blk} BLK</span>
        </div>
      </div>
      ${opts.extraHtml ?? ''}
      <div class="boxes">${table(0)}${table(1)}</div>
      <div class="actions center">
        ${opts.buttons.map((b) => `<button class="btn ${b.kind ?? ''} ${b.kind === 'primary' ? 'big' : ''}" data-a="${b.id}">${esc(b.label)}</button>`).join('')}
      </div>
    </div>`;
  root.querySelectorAll<HTMLButtonElement>('[data-a]').forEach((b) =>
    b.addEventListener('click', () => opts.onAction(b.dataset.a!)));
}
