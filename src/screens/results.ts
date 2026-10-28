import { spriteUrl, type Pos } from '../data/pokemon';
import { replayOf, watchAgain } from './potg';
import type { Game } from '../game/game';
import type { Player, TeamId } from '../game/types';
import { esc } from '../util';

const gameScore = (p: Player) => {
  const s = p.stats;
  return s.pts + s.reb * 1.2 + s.ast * 1.5 + s.stl * 2 + s.blk * 2 - (s.fga - s.fgm) * 0.4;
};

/** A player's line in a box score, from a live game or one saved in franchise mode. */
export interface BoxRow {
  dex: number;
  name: string;
  pos: Pos;
  starter: boolean;
  sec: number;
  pts: number; fgm: number; fga: number; tpm: number; tpa: number;
  reb: number; ast: number; stl: number; blk: number; dnk: number;
}

const mins = (sec: number) => `${Math.floor(sec / 60)}:${String(Math.floor(sec % 60)).padStart(2, '0')}`;

/** One team's box score. `withBench` adds minutes and marks players who didn't play. */
export function boxHtml(name: string, color: string, score: number, rows: BoxRow[], withBench: boolean): string {
  const keys = ['pts', 'fgm', 'fga', 'tpm', 'tpa', 'reb', 'ast', 'stl', 'blk', 'dnk'] as const;
  const tot = Object.fromEntries(keys.map((k) => [k, rows.reduce((a, r) => a + r[k], 0)])) as Record<(typeof keys)[number], number>;
  const body = rows.map((r) => {
    const who = `<th><div class="who"><img src="${spriteUrl(r.dex)}" alt=""><div class="who-t"><b title="${esc(r.name)}">${esc(r.name)}</b><small>${r.pos}</small></div></div></th>`;
    if (withBench && r.sec === 0) return `<tr class="dnp">${who}<td class="dnp-l">DNP</td><td colspan="8"></td></tr>`;
    return `<tr class="${r.starter ? '' : 'bench'}">
      ${who}
      ${withBench ? `<td>${mins(r.sec)}</td>` : ''}
      <td>${r.pts}</td><td>${r.fgm}-${r.fga}</td><td>${r.tpm}-${r.tpa}</td>
      <td>${r.reb}</td><td>${r.ast}</td><td>${r.stl}</td><td>${r.blk}</td><td>${r.dnk}</td>
    </tr>`;
  }).join('');
  return `
    <div class="box" style="--tc:${color}">
      <h3>${esc(name)} <b>${score}</b></h3>
      <div class="box-scroll">
        <table>
          <thead><tr><th>Pokémon</th>${withBench ? '<th>MIN</th>' : ''}<th>PTS</th><th>FG</th><th>3PT</th><th>REB</th><th>AST</th><th>STL</th><th>BLK</th><th>DNK</th></tr></thead>
          <tbody>${body}</tbody>
          <tfoot><tr><th>Team</th>${withBench ? '<td></td>' : ''}<td>${tot.pts}</td><td>${tot.fgm}-${tot.fga}</td><td>${tot.tpm}-${tot.tpa}</td><td>${tot.reb}</td><td>${tot.ast}</td><td>${tot.stl}</td><td>${tot.blk}</td><td>${tot.dnk}</td></tr></tfoot>
        </table>
      </div>
    </div>`;
}

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
  const play = replayOf(g);
  const headline = opts.headline ?? (!h.human ? `${g.teams[winner].name} win` : userWon ? 'You win!' : `${a.name} win`);

  const withBench = g.bench.length > 0;
  const linesOf = (t: TeamId): BoxRow[] => g.rosterOf(t).map((p) => ({ dex: p.mon.dex, name: p.mon.name, pos: p.mon.pos, starter: p.starter, ...p.stats }));
  const table = (t: TeamId) => boxHtml(g.teams[t].name, g.teams[t].color, g.score[t], linesOf(t), withBench);

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
      ${play ? `<button class="potg-again" type="button" data-replay>
        <span class="lbl">▶ Watch the play of the game</span>
        <strong>${esc(play.name)}</strong><span>${esc(play.title)}</span>
      </button>` : ''}
      ${opts.extraHtml ?? ''}
      <div class="boxes">${table(0)}${table(1)}</div>
      <div class="actions center">
        ${opts.buttons.map((b) => `<button class="btn ${b.kind ?? ''} ${b.kind === 'primary' ? 'big' : ''}" data-a="${b.id}">${esc(b.label)}</button>`).join('')}
      </div>
    </div>`;
  root.querySelectorAll<HTMLButtonElement>('[data-a]').forEach((b) =>
    b.addEventListener('click', () => opts.onAction(b.dataset.a!)));
  root.querySelector('[data-replay]')?.addEventListener('click', () => watchAgain(g));
}
