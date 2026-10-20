import { POKEMON, POSITIONS, RATING_LABELS, SPECIALS, TYPE_COLORS, spriteUrl, type Mon, type Pos, type Ratings } from '../data/pokemon';
import type { Audio } from '../game/audio';
import { chemistry, teamOvr } from '../game/game';
import type { TeamDef } from '../game/types';
import { esc, tier } from '../util';
import { settingsHtml, type Settings } from './menu';

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

function typeChips(m: Mon): string {
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

function rosterHtml(title: string, picks: Mon[], cls: string): string {
  const slots = Array.from({ length: 5 }, (_, i) => {
    const m = picks[i];
    return m
      ? `<li><img src="${spriteUrl(m.dex)}" alt=""><span class="nm">${esc(m.name)}</span><span class="pos">${m.pos}</span><b class="t-${tier(m.ovr)}">${m.ovr}</b></li>`
      : `<li class="empty"><span>Pick ${i + 1}</span></li>`;
  }).join('');
  const chem = picks.length === 5 && chemistry(picks) ? '<span class="chem">+2 Balanced lineup</span>' : '';
  return `<div class="roster ${cls}"><h4>${esc(title)} <span class="tovr">${picks.length ? teamOvr(picks) : '--'}</span>${chem}</h4><ul>${slots}</ul></div>`;
}

export function matchupHtml(home: TeamDef, away: TeamDef, settings: Settings): string {
  const col = (t: TeamDef) => `
    <div class="mu-team" style="--tc:${t.color}">
      <h3>${esc(t.name)}<span class="tovr">${teamOvr(t.roster)}</span></h3>
      ${chemistry(t.roster) ? '<p class="chem">+2 Balanced lineup: all five positions covered</p>' : '<p class="chem off">No lineup bonus: a position is doubled up</p>'}
      <ul>${[...t.roster].sort((a, b) => POSITIONS.indexOf(a.pos) - POSITIONS.indexOf(b.pos)).map((m) =>
        `<li><span class="pos">${m.pos}</span><img src="${spriteUrl(m.dex)}" alt=""><span class="nm">${esc(m.name)}<small>${m.archetype}</small></span><b class="t-${tier(m.ovr)}">${m.ovr}</b></li>`).join('')}</ul>
    </div>`;
  return `
    <div class="matchup">
      <h2>Tonight's matchup</h2>
      <div class="mu-cols">${col(home)}<div class="vs">VS</div>${col(away)}</div>
      ${settingsHtml(settings)}
      <div class="actions center">
        <button class="btn primary big" data-a="tip">Tip off</button>
        <button class="btn ghost" data-a="back">Redraft</button>
      </div>
    </div>`;
}

export function draftScreen(
  root: HTMLElement,
  settings: Settings,
  audio: Audio,
  cpuName: string,
  onDone: (user: Mon[], cpu: Mon[]) => void,
  onBack: () => void,
) {
  // Own container so listeners die with the screen.
  const host = root;
  root = document.createElement('div');
  host.replaceChildren(root);
  const pool = [...POKEMON].sort((a, b) => b.ovr - a.ovr);
  const user: Mon[] = [];
  const cpu: Mon[] = [];
  const userFirst = Math.random() < 0.5;
  // Snake draft: 1-2, 2-1, 1-2, 2-1, 1-2
  const order: ('u' | 'c')[] = [];
  for (let r = 0; r < 5; r++) {
    const pair: ('u' | 'c')[] = userFirst ? ['u', 'c'] : ['c', 'u'];
    order.push(...(r % 2 ? pair.reverse() : pair));
  }
  let pick = 0;
  let filter: Pos | 'ALL' = 'ALL';
  let selected: Mon | null = null;
  const log: string[] = [userFirst ? 'You won the coin toss and pick first.' : `${cpuName} won the coin toss and picks first.`];
  let cpuTimer = 0;
  let done = false;

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
    </div>`;
  const $ = <T extends HTMLElement>(s: string) => root.querySelector<T>(s)!;
  const grid = $('.grid');
  const detail = $('.detail');

  const userTurn = () => !done && order[pick] === 'u';

  const render = () => {
    const round = Math.floor(pick / 2) + 1;
    $('.round').textContent = done ? 'DRAFT COMPLETE' : `ROUND ${round} · PICK ${pick + 1} OF 10`;
    const otc = $('.otc');
    otc.textContent = done ? '' : userTurn() ? "You're on the clock" : `${cpuName} is picking…`;
    otc.classList.toggle('you', userTurn());
    const shown = pool.filter((m) => filter === 'ALL' || m.pos === filter);
    grid.innerHTML = shown.map((m) => monCard(m, selected === m ? 'sel' : '')).join('');
    $('.rosters').innerHTML = rosterHtml(settings.teamName || 'You', user, 'you') + rosterHtml(cpuName, cpu, 'cpu');
    $('.log').innerHTML = log.slice(-6).reverse().map((l) => `<li>${esc(l)}</li>`).join('');
    if (selected) {
      detail.hidden = false;
      detail.innerHTML = `<button class="close" aria-label="Close">×</button>` + detailHtml(selected, userTurn());
    } else detail.hidden = true;
    root.querySelectorAll<HTMLButtonElement>('[data-a="auto"], [data-a="sim"]').forEach((b) => (b.disabled = done));
  };

  const take = (m: Mon, who: 'u' | 'c') => {
    pool.splice(pool.indexOf(m), 1);
    (who === 'u' ? user : cpu).push(m);
    log.push(`${who === 'u' ? settings.teamName || 'You' : cpuName} selected ${m.name} (${m.pos}, ${m.ovr})`);
    pick++;
    if (selected === m) selected = null;
    audio.blip(who === 'u');
    if (pick >= order.length) {
      done = true;
      render();
      window.setTimeout(() => onDone(user, cpu), 900);
      return;
    }
    render();
    scheduleCpu();
  };

  const scheduleCpu = () => {
    window.clearTimeout(cpuTimer);
    if (!done && order[pick] === 'c') {
      cpuTimer = window.setTimeout(() => take(cpuPick(pool, cpu), 'c'), 750);
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
    if (t.closest('.close')) { selected = null; render(); return; }
    if (t.closest('.pick') && selected && userTurn()) { take(selected, 'u'); return; }
    const a = t.closest<HTMLElement>('[data-a]')?.dataset.a;
    if (a === 'back') { window.clearTimeout(cpuTimer); done = true; onBack(); }
    if (a === 'auto' && userTurn()) take(cpuPick(pool, user), 'u');
    if (a === 'sim' && !done) {
      window.clearTimeout(cpuTimer);
      while (pick < order.length) {
        const who = order[pick];
        const m = cpuPick(pool, who === 'u' ? user : cpu);
        pool.splice(pool.indexOf(m), 1);
        (who === 'u' ? user : cpu).push(m);
        log.push(`${who === 'u' ? settings.teamName || 'You' : cpuName} selected ${m.name} (${m.pos}, ${m.ovr})`);
        pick++;
      }
      done = true;
      selected = null;
      render();
      window.setTimeout(() => onDone(user, cpu), 600);
    }
  });

  render();
  scheduleCpu();
}
