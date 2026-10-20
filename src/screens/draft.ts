import { POKEMON, POSITIONS, RATING_LABELS, SPECIALS, TYPE_COLORS, spriteUrl, type Mon, type Pos, type Ratings } from '../data/pokemon';
import type { Audio } from '../game/audio';
import { chemistry, teamOvr } from '../game/game';
import { esc, tier } from '../util';

/** CPU general manager: best available, nudged toward positions it hasn't filled. */
export function cpuPick(pool: Mon[], roster: Mon[]): Mon {
  const have = new Set(roster.map((m) => m.pos));
  let best = pool[0];
  let bs = -Infinity;
  for (const m of pool) {
    const s = m.ovr + (have.has(m.pos) ? 0 : 5) + Math.random() * 5;
    if (s > bs) { bs = s; best = m; }
  }
  return best;
}

export function typeChips(m: Mon): string {
  return m.types.map((t) => `<i style="--tc:${TYPE_COLORS[t]}">${t}</i>`).join('');
}

export function monCard(m: Mon, extra = ''): string {
  return `
    <button class="mon-card t-${tier(m.ovr)} ${extra}" data-dex="${m.dex}" aria-label="${esc(m.name)}, ${m.pos}, overall ${m.ovr}">
      <span class="ovr">${m.ovr}</span>
      <span class="pos">${m.pos}</span>
      <img src="${spriteUrl(m.dex)}" alt="" loading="lazy">
      <span class="nm">${esc(m.name)}</span>
      <span class="types">${typeChips(m)}</span>
    </button>`;
}

function detailHtml(m: Mon, canPick: boolean): string {
  const bars = (Object.keys(RATING_LABELS) as (keyof Ratings)[]).map((k) => {
    const v = m.r[k];
    return `<div class="rt"><span>${RATING_LABELS[k]}</span><b class="t-${tier(v)}">${v}</b><i style="--v:${v}%"></i></div>`;
  }).join('');
  return `
    <div class="detail-top t-${tier(m.ovr)}">
      <img src="${spriteUrl(m.dex)}" alt="">
      <div>
        <div class="detail-ovr">${m.ovr}<small>OVR</small></div>
        <h3>${esc(m.name)}</h3>
        <p class="arch">${m.pos} · ${m.archetype}</p>
        <span class="types">${typeChips(m)}</span>
      </div>
    </div>
    <div class="ratings">${bars}</div>
    <div class="special-box">
      <span class="lbl">Special: ${m.move}</span>
      <p>${SPECIALS[m.special].label}. ${SPECIALS[m.special].desc}</p>
    </div>
    <button class="btn primary big pick" ${canPick ? '' : 'disabled'}>${canPick ? `Draft ${esc(m.name)}` : 'Waiting for your pick'}</button>`;
}

export interface DraftTeam {
  name: string;
  abbr: string;
  color: string;
  color2: string;
  human: boolean;
}

function rosterHtml(t: DraftTeam, picks: Mon[]): string {
  const slots = Array.from({ length: 5 }, (_, i) => {
    const m = picks[i];
    return m
      ? `<li><img src="${spriteUrl(m.dex)}" alt=""><span class="nm">${esc(m.name)}</span><span class="pos">${m.pos}</span><b class="t-${tier(m.ovr)}">${m.ovr}</b></li>`
      : `<li class="empty"><span>Pick ${i + 1}</span></li>`;
  }).join('');
  const chem = picks.length === 5 && chemistry(picks) ? '<span class="chem">+2 Balanced lineup</span>' : '';
  return `<div class="roster you"><h4>${esc(t.name)} <span class="tovr">${picks.length ? teamOvr(picks) : '--'}</span>${chem}</h4><ul>${slots}</ul></div>`;
}

function boardHtml(teams: DraftTeam[], rosters: Mon[][]): string {
  const rows = teams.map((t, i) => t.human ? '' : `
    <li style="--tc:${t.color}">
      <span class="abbr">${esc(t.abbr)}</span>
      ${Array.from({ length: 5 }, (_, k) => rosters[i][k]
        ? `<img src="${spriteUrl(rosters[i][k].dex)}" alt="${esc(rosters[i][k].name)}" title="${esc(rosters[i][k].name)} (${rosters[i][k].ovr})">`
        : '<i></i>').join('')}
    </li>`).join('');
  return `<div class="board"><h4>League board</h4><ul>${rows}</ul></div>`;
}

/** Everything needed to resume a draft: who is in it, the round-one order, and every pick so far (dex numbers). */
export interface DraftState {
  teams: DraftTeam[];
  order: number[];
  taken: number[];
}

/** Positions a roster doesn't have yet, in PG..C order. */
const needs = (roster: Mon[]) => POSITIONS.filter((p) => !roster.some((m) => m.pos === p));

function teamBarHtml(roster: Mon[]): string {
  const need = needs(roster);
  return `
    <span class="tbar-lbl">My team <b>${roster.length}/5</b></span>
    <span class="tbar-slots">${Array.from({ length: 5 }, (_, i) => roster[i]
      ? `<img src="${spriteUrl(roster[i].dex)}" alt="${esc(roster[i].name)}">`
      : '<i></i>').join('')}</span>
    <span class="tbar-need">${roster.length ? `${teamOvr(roster)} OVR` : ''}${need.length && roster.length < 5 ? ` · Need ${need.join(' ')}` : ''}</span>`;
}

/**
 * Snake draft for any number of teams. `state.order` is the round-one pick order (team indexes);
 * rounds alternate direction. Picks already in `state.taken` are replayed, so a saved draft resumes
 * where it left off. Calls `onProgress` after every pick and `onDone` with each team's five picks
 * and the undrafted pool.
 */
export function draftScreen(
  root: HTMLElement,
  state: DraftState,
  audio: Audio,
  onDone: (rosters: Mon[][], leftovers: Mon[]) => void,
  onBack: () => void,
  onProgress: (state: DraftState) => void,
) {
  const { teams, order } = state;
  // Own container so listeners die with the screen.
  const host = root;
  root = document.createElement('div');
  host.replaceChildren(root);
  const pool = [...POKEMON].sort((a, b) => b.ovr - a.ovr);
  const rosters: Mon[][] = teams.map(() => []);
  const picks: number[] = [];
  for (let r = 0; r < 5; r++) picks.push(...(r % 2 ? [...order].reverse() : order));
  const me = teams.findIndex((t) => t.human);
  let pick = 0;
  let filter: Pos | 'ALL' = 'ALL';
  let selected: Mon | null = null;
  const log: string[] = [`Draft order: ${order.map((i) => (teams[i].human ? 'You' : teams[i].abbr)).join(', ')}`];
  let cpuTimer = 0;
  let done = false;
  let teamOpen = false;

  root.innerHTML = `
    <div class="draft">
      <header class="draft-head">
        <button class="btn ghost small" data-a="back">Menu</button>
        <div class="status"><span class="round"></span><span class="otc"></span></div>
        <div class="head-actions">
          <button class="btn small" data-a="auto">Auto-pick</button>
          <button class="btn small" data-a="sim">Sim rest</button>
        </div>
      </header>
      <div class="draft-body">
        <section class="pool">
          <div class="filters" role="tablist">
            ${(['ALL', ...POSITIONS] as const).map((p) => `<button data-f="${p}" class="${p === 'ALL' ? 'on' : ''}">${p}</button>`).join('')}
          </div>
          <div class="grid"></div>
        </section>
        <aside class="side">
          <div class="detail" hidden></div>
          <div class="rosters"></div>
          <ol class="log"></ol>
        </aside>
      </div>
      <button class="tbar" data-a="team" aria-label="Show my team"></button>
      <div class="sheet-bg team-sheet" hidden>
        <div class="sheet" role="dialog" aria-label="My team">
          <button class="close" data-a="team-close" aria-label="Close">×</button>
          <div class="team-sheet-body"></div>
        </div>
      </div>
    </div>`;
  const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const grid = $('.grid');
  const detail = $('.detail');

  const userTurn = () => !done && picks[pick] === me;

  const render = () => {
    const round = Math.floor(pick / teams.length) + 1;
    $('.round').textContent = done ? 'DRAFT COMPLETE' : `ROUND ${round} · PICK ${pick + 1} OF ${picks.length}`;
    const otc = $('.otc');
    const until = picks.indexOf(me, pick) - pick;
    otc.textContent = done ? '' : userTurn() ? "You're on the clock" : `${teams[picks[pick]].name} is picking… (you're up in ${until})`;
    otc.classList.toggle('you', userTurn());
    const shown = pool.filter((m) => filter === 'ALL' || m.pos === filter);
    grid.innerHTML = shown.map((m) => monCard(m, selected === m ? 'sel' : '')).join('');
    $('.rosters').innerHTML = rosterHtml(teams[me], rosters[me]) + boardHtml(teams, rosters);
    $('.log').innerHTML = log.slice(-6).reverse().map((l) => `<li>${esc(l)}</li>`).join('');
    $('.tbar').innerHTML = teamBarHtml(rosters[me]);
    const sheet = $('.team-sheet');
    sheet.hidden = !teamOpen;
    if (teamOpen) {
      const need = needs(rosters[me]);
      $('.team-sheet-body').innerHTML = rosterHtml(teams[me], rosters[me])
        + `<p class="note">${rosters[me].length >= 5 ? 'Your starting five is set.' : need.length ? `Still open: ${need.join(', ')}. Cover all five positions for the +2 lineup bonus.` : 'All five positions covered.'}</p>`
        + boardHtml(teams, rosters);
    }
    if (selected) {
      detail.hidden = false;
      detail.innerHTML = `<button class="close" aria-label="Close">×</button>` + detailHtml(selected, userTurn());
    } else detail.hidden = true;
    root.querySelectorAll<HTMLButtonElement>('[data-a="auto"], [data-a="sim"]').forEach((b) => (b.disabled = done));
  };

  const record = (m: Mon) => {
    const t = picks[pick];
    state.taken.push(m.dex);
    pool.splice(pool.indexOf(m), 1);
    rosters[t].push(m);
    log.push(`${teams[t].human ? 'You' : teams[t].name} selected ${m.name} (${m.pos}, ${m.ovr})`);
    pick++;
    if (selected === m) selected = null;
  };

  const finish = () => {
    done = true;
    selected = null;
    teamOpen = false;
    onProgress(state);
    render();
    window.setTimeout(() => onDone(rosters, pool), 900);
  };

  const take = (m: Mon) => {
    const human = picks[pick] === me;
    record(m);
    audio.blip(human);
    if (pick >= picks.length) return finish();
    onProgress(state);
    render();
    scheduleCpu();
  };

  const scheduleCpu = () => {
    window.clearTimeout(cpuTimer);
    if (!done && picks[pick] !== me) {
      cpuTimer = window.setTimeout(() => take(cpuPick(pool, rosters[picks[pick]])), 450);
    }
  };

  root.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const card = t.closest<HTMLElement>('.mon-card');
    if (card && grid.contains(card)) {
      selected = pool.find((m) => m.dex === Number(card.dataset.dex)) ?? null;
      audio.blip();
      render();
      return;
    }
    const f = t.closest<HTMLElement>('[data-f]');
    if (f) {
      filter = f.dataset.f as Pos | 'ALL';
      root.querySelectorAll('[data-f]').forEach((x) => x.classList.toggle('on', x === f));
      render();
      return;
    }
    if (t.closest('[data-a="team"]')) { teamOpen = true; selected = null; render(); return; }
    if (t.closest('[data-a="team-close"]') || t.classList.contains('team-sheet')) { teamOpen = false; render(); return; }
    if (t.closest('.close')) { selected = null; render(); return; }
    if (t.closest('.pick') && selected && userTurn()) { take(selected); return; }
    const a = t.closest<HTMLElement>('[data-a]')?.dataset.a;
    if (a === 'back') { window.clearTimeout(cpuTimer); done = true; onBack(); }
    if (a === 'auto' && userTurn()) take(cpuPick(pool, rosters[me]));
    if (a === 'sim' && !done) {
      window.clearTimeout(cpuTimer);
      while (pick < picks.length) record(cpuPick(pool, rosters[picks[pick]]));
      finish();
    }
  });

  // Replay saved picks to resume a draft in progress.
  const saved = state.taken.splice(0);
  for (const dex of saved) {
    const m = pool.find((x) => x.dex === dex);
    if (m && pick < picks.length) record(m);
  }
  if (saved.length) log.push(`Draft resumed at pick ${pick + 1}.`);
  if (pick >= picks.length) return finish();
  render();
  scheduleCpu();
}
