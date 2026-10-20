import { POKEMON, POSITIONS, RATING_LABELS, SPECIALS, TYPE_COLORS, spriteUrl, type Mon, type PokeType, type Pos, type Ratings } from '../data/pokemon';
import type { Audio } from '../game/audio';
import { bestLineup, chemistry, teamOvr } from '../game/game';
import { esc, tier } from '../util';

/** CPU general manager: best available, nudged toward open positions and the team's favorite types. */
export function cpuPick(pool: Mon[], roster: Mon[], types: PokeType[] = []): Mon {
  const count = (pos: string) => roster.filter((m) => m.pos === pos).length;
  let best = pool[0];
  let bs = -Infinity;
  for (const m of pool) {
    const onType = m.types.some((t) => types.includes(t));
    const need = [5, 2, 0][Math.min(2, count(m.pos))];
    const s = m.ovr + need + (onType ? 8 : 0) + Math.random() * 5;
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
  leader?: string;
  types?: PokeType[];
  boost?: number;
  gym?: number;
  badge?: string;
  elite?: boolean;
}

/** Overall of the five who would start. */
const startersOvr = (picks: Mon[]) => teamOvr(bestLineup(picks).starters);

function rosterHtml(t: DraftTeam, picks: Mon[], size: number): string {
  const { starters } = bestLineup(picks);
  const slots = Array.from({ length: size }, (_, i) => {
    const m = picks[i];
    const role = size > 5 && m ? `<small>${starters.includes(m) ? 'Starter' : 'Bench'}</small>` : '';
    return m
      ? `<li><img src="${spriteUrl(m.dex)}" alt=""><span class="nm">${esc(m.name)}${role}</span><span class="pos">${m.pos}</span><b class="t-${tier(m.ovr)}">${m.ovr}</b></li>`
      : `<li class="empty"><span>Pick ${i + 1}${size > 5 && i >= 5 ? ' (bench)' : ''}</span></li>`;
  }).join('');
  const chem = picks.length >= 5 && chemistry(starters) ? '<span class="chem">+2 Balanced lineup</span>' : '';
  return `<div class="roster you"><h4>${esc(t.name)} <span class="tovr">${picks.length ? startersOvr(picks) : '--'}</span>${chem}</h4>${posTrackHtml(picks, size)}<p class="pos-note">${needText(picks, size)}</p><ul>${slots}</ul></div>`;
}

function boardHtml(teams: DraftTeam[], rosters: Mon[][], size: number): string {
  const rows = teams.map((t, i) => t.human ? '' : `
    <li style="--tc:${t.color}" title="${esc(t.name)}${t.leader ? ` (${esc(t.leader)})` : ''}">
      <span class="abbr">${esc(t.abbr)}</span>
      ${Array.from({ length: size }, (_, k) => rosters[i][k]
        ? `<img src="${spriteUrl(rosters[i][k].dex)}" alt="${esc(rosters[i][k].name)}" title="${esc(rosters[i][k].name)} (${rosters[i][k].ovr})">`
        : '<i></i>').join('')}
    </li>`).join('');
  return `<div class="board ${size > 5 ? 'many' : ''}" style="--slots:${size}"><h4>League board</h4><ul>${rows}</ul></div>`;
}

/** Everything needed to resume a draft: who is in it, the round-one order, and every pick so far (dex numbers). */
export interface DraftState {
  teams: DraftTeam[];
  order: number[];
  taken: number[];
  /** Picks per team: 5 in Quick Play, 10 in franchise (older saved drafts have none and used 5). */
  rounds?: number;
}

/** Seconds you get on the clock for each pick. When it runs out, the best fit is picked for you. */
const PICK_SECONDS = 60;

/** How many of each position a full roster wants: one starter each, plus a backup each with a 10-man roster. */
export const targetPer = (size: number) => (size > 5 ? 2 : 1);
export const countAt = (roster: Mon[], p: Pos) => roster.filter((m) => m.pos === p).length;

/** Positions a roster doesn't have yet, in PG..C order. */
const needs = (roster: Mon[]) => POSITIONS.filter((p) => !countAt(roster, p));
/** Positions with a starter but no backup yet (10-man rosters only). */
const thin = (roster: Mon[], size: number) => POSITIONS.filter((p) => countAt(roster, p) > 0 && countAt(roster, p) < targetPer(size));

/** One cell per position: how many you have against the target, and who they are. */
export function posTrackHtml(roster: Mon[], size: number, compact = false): string {
  const goal = targetPer(size);
  return `<ul class="pos-track ${compact ? 'compact' : ''}">${POSITIONS.map((p) => {
    const at = roster.filter((m) => m.pos === p);
    const cls = at.length === 0 ? 'need' : at.length < goal ? 'thin' : 'ok';
    const label = at.length === 0 ? 'Need' : at.length < goal ? 'Backup' : '✓';
    return `<li class="${cls}" title="${p}: ${at.map((m) => m.name).join(', ') || 'none yet'}">
      <b>${p}</b><span>${at.length}/${goal}</span>${compact ? '' : `<small>${label}</small>
      <span class="who">${at.map((m) => `<img src="${spriteUrl(m.dex)}" alt="${esc(m.name)}">`).join('')}</span>`}
    </li>`;
  }).join('')}</ul>`;
}

/** Plain-language summary of what the roster still needs, and a warning when picks are running out. */
function needText(roster: Mon[], size: number): string {
  const left = size - roster.length;
  if (!left) return 'Roster full.';
  const need = needs(roster);
  const backup = thin(roster, size);
  if (need.length) {
    const must = need.length >= left ? ' <b class="warn">Draft them now: you are running out of picks.</b>' : '';
    return `Still need a starter at <b>${need.join(', ')}</b>.${must}`;
  }
  if (backup.length) return `Starting five covered. Backups wanted at <b>${backup.join(', ')}</b>.`;
  return size > 5 ? 'Every position has a starter and a backup. Take the best Pokémon left.' : 'All five positions covered.';
}

function teamBarHtml(roster: Mon[], size: number): string {
  return `
    <span class="tbar-lbl">My team <b>${roster.length}/${size}</b></span>
    ${size > 5 ? '' : `<span class="tbar-slots">${Array.from({ length: size }, (_, i) => roster[i]
      ? `<img src="${spriteUrl(roster[i].dex)}" alt="${esc(roster[i].name)}">`
      : '<i></i>').join('')}</span>`}
    ${posTrackHtml(roster, size, true)}
    <span class="tbar-need"><span class="clock" hidden></span>${roster.length ? `${startersOvr(roster)} OVR` : ''}</span>`;
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
  const size = state.rounds ?? 5;
  for (let r = 0; r < size; r++) picks.push(...(r % 2 ? [...order].reverse() : order));
  const me = teams.findIndex((t) => t.human);
  let pick = 0;
  let filter: Pos | 'ALL' = 'ALL';
  let typeFilter = '';
  let selected: Mon | null = null;
  const log: string[] = [`Draft order: ${order.map((i) => (teams[i].human ? 'You' : teams[i].abbr)).join(', ')}`];
  let cpuTimer = 0;
  let done = false;
  /** Milliseconds left on your pick clock (counts only while the tab is visible). */
  let clockLeft = PICK_SECONDS * 1000;
  let clockPick = -1;
  let lastTick = performance.now();
  let lastBeep = 0;
  let teamOpen = false;

  root.innerHTML = `
    <div class="draft">
      <header class="draft-head">
        <button class="btn ghost small" data-a="back">Menu</button>
        <div class="status"><span class="round"></span><span class="otc"></span><span class="clock big" hidden></span></div>
        <div class="head-actions">
          <button class="btn small" data-a="auto">Auto-pick</button>
          <button class="btn small" data-a="sim">Sim rest</button>
        </div>
      </header>
      <div class="draft-body">
        <section class="pool">
          <div class="filters" role="tablist">
            ${(['ALL', ...POSITIONS] as const).map((p) => `<button data-f="${p}" class="${p === 'ALL' ? 'on' : ''}">${p}${p === 'ALL' ? '' : '<small></small>'}</button>`).join('')}
            <select id="type-filter" aria-label="Filter by type">
              <option value="">All types</option>
              ${(Object.keys(TYPE_COLORS) as PokeType[]).map((t) => `<option value="${t}">${t}</option>`).join('')}
            </select>
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
  $<HTMLSelectElement>('#type-filter').addEventListener('change', (e) => {
    typeFilter = (e.target as HTMLSelectElement).value;
    render();
  });

  const userTurn = () => !done && picks[pick] === me;

  const render = () => {
    const round = Math.floor(pick / teams.length) + 1;
    $('.round').textContent = done ? 'DRAFT COMPLETE' : `ROUND ${round} · PICK ${pick + 1} OF ${picks.length}`;
    const otc = $('.otc');
    const until = picks.indexOf(me, pick) - pick;
    otc.textContent = done ? '' : userTurn() ? "You're on the clock" : `${teams[picks[pick]].name} is picking… (you're up in ${until})`;
    otc.classList.toggle('you', userTurn());
    const shown = pool.filter((m) => (filter === 'ALL' || m.pos === filter) && (!typeFilter || m.types.includes(typeFilter as PokeType)));
    grid.innerHTML = shown.map((m) => monCard(m, selected === m ? 'sel' : '')).join('');
    $('.rosters').innerHTML = rosterHtml(teams[me], rosters[me], size) + boardHtml(teams, rosters, size);
    $('.log').innerHTML = log.slice(-6).reverse().map((l) => `<li>${esc(l)}</li>`).join('');
    $('.tbar').innerHTML = teamBarHtml(rosters[me], size);
    root.querySelectorAll<HTMLElement>('.filters [data-f]').forEach((b) => {
      const p = b.dataset.f as Pos | 'ALL';
      if (p === 'ALL') return;
      const n = countAt(rosters[me], p);
      b.querySelector('small')!.textContent = String(n);
      b.classList.toggle('need', n === 0);
      b.classList.toggle('thin', n > 0 && n < targetPer(size));
    });
    updateClock();
    const sheet = $('.team-sheet');
    sheet.hidden = !teamOpen;
    if (teamOpen) {
      $('.team-sheet-body').innerHTML = rosterHtml(teams[me], rosters[me], size)
        + `<p class="note">Cover all five positions in your starting five for the +2 lineup bonus.${size > 5 ? ' Picks 6-10 are your bench: a backup at every position keeps the rotation from playing out of position when starters tire.' : ''}</p>`
        + boardHtml(teams, rosters, size);
    }
    if (selected) {
      detail.hidden = false;
      detail.innerHTML = `<button class="close" aria-label="Close">×</button>` + detailHtml(selected, userTurn());
    } else detail.hidden = true;
    root.querySelectorAll<HTMLButtonElement>('[data-a="auto"], [data-a="sim"]').forEach((b) => (b.disabled = done));
  };

  const clockEls = () => root.querySelectorAll<HTMLElement>('.clock');
  function updateClock() {
    const on = userTurn();
    if (on && clockPick !== pick) { clockPick = pick; clockLeft = PICK_SECONDS * 1000; lastBeep = 0; }
    const secs = Math.max(0, Math.ceil(clockLeft / 1000));
    clockEls().forEach((el) => {
      el.hidden = !on;
      el.textContent = `0:${String(secs).padStart(2, '0')}`;
      el.classList.toggle('low', secs <= 10);
    });
  }

  const clock = window.setInterval(() => {
    const now = performance.now();
    const dt = now - lastTick;
    lastTick = now;
    if (!root.isConnected || done) { window.clearInterval(clock); return; }
    if (!userTurn() || document.hidden) return;
    clockLeft -= Math.min(dt, 1000);
    const secs = Math.ceil(clockLeft / 1000);
    if (secs <= 5 && secs > 0 && secs !== lastBeep) { lastBeep = secs; audio.blip(secs <= 3); }
    if (clockLeft <= 0) {
      take(cpuPick(pool, rosters[me]), "Time's up! Auto-picked");
      return;
    }
    updateClock();
  }, 200);

  const record = (m: Mon, note?: string) => {
    const t = picks[pick];
    state.taken.push(m.dex);
    pool.splice(pool.indexOf(m), 1);
    rosters[t].push(m);
    log.push(`${note ?? `${teams[t].human ? 'You' : teams[t].name} selected`} ${m.name} (${m.pos}, ${m.ovr})`);
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

  const take = (m: Mon, note?: string) => {
    const human = picks[pick] === me;
    record(m, note);
    audio.blip(human);
    if (pick >= picks.length) return finish();
    onProgress(state);
    render();
    scheduleCpu();
  };

  const scheduleCpu = () => {
    window.clearTimeout(cpuTimer);
    if (!done && picks[pick] !== me) {
      cpuTimer = window.setTimeout(() => take(cpuPick(pool, rosters[picks[pick]], teams[picks[pick]].types)), 280);
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
    if (a === 'back') { window.clearTimeout(cpuTimer); window.clearInterval(clock); done = true; onBack(); }
    if (a === 'auto' && userTurn()) take(cpuPick(pool, rosters[me]));
    if (a === 'sim' && !done) {
      window.clearTimeout(cpuTimer);
      while (pick < picks.length) record(cpuPick(pool, rosters[picks[pick]], teams[picks[pick]].types));
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
