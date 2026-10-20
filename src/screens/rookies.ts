// Offseason rookie draft: one round from the unevolved free agents, worst record first, then everyone cuts
// down to ten. The prospects are judged on what they grow into, so each card shows its final form.
import { monByDex, spriteUrl } from '../data/pokemon';
import {
  finishRookieDraft, monOf, potentialOf, rookieLeft, rookieOnClock, rookiePick, tradeValue, type Franchise,
} from '../franchise/league';
import type { Audio } from '../game/audio';
import { esc, tier } from '../util';
import { countAt, posTrackHtml, targetPer, typeChips } from './draft';

export interface RookieActions {
  /** Draft finished and the new season has started. */
  done(): void;
  menu(): void;
  saved(): void;
}

const PICK_SECONDS = 60;

export function rookieScreen(root: HTMLElement, f: Franchise, audio: Audio, act: RookieActions) {
  const host = root;
  root = document.createElement('div');
  host.replaceChildren(root);
  const me = f.teams[0];
  let selected: string | null = null;
  let cutting: string | null = null;
  let cpuTimer = 0;
  let clockLeft = PICK_SECONDS * 1000;
  let clockFor = -1;
  let lastTick = performance.now();
  let lastBeep = 0;
  const log: string[] = [];

  const myTurn = () => rookieOnClock(f)?.human === true;
  const picksMade = () => f.rookies?.picks.length ?? 0;
  const myMons = () => me.roster.map((u) => monOf(f, u));

  const card = (u: string) => {
    const m = monOf(f, u);
    const pot = potentialOf(m.dex);
    const grows = pot.dex !== m.dex;
    const mons = myMons();
    const fits = countAt(mons, m.pos) < targetPer(10);
    return `
      <button class="mon-card rk t-${tier(pot.ovr)} ${selected === u ? 'sel' : ''}" data-uid="${u}" aria-label="${esc(m.name)}, ${m.pos}, grows to ${pot.ovr}">
        <span class="ovr">${m.ovr}</span>
        <span class="pos">${m.pos}</span>
        <img src="${spriteUrl(m.dex)}" alt="" loading="lazy">
        <span class="nm">${esc(m.name)}</span>
        <span class="types">${typeChips(m)}</span>
        ${grows ? `<span class="grow"><img src="${spriteUrl(pot.dex)}" alt="">${esc(monByDex(pot.dex).name)} <b class="t-${tier(pot.ovr)}">${pot.ovr}</b></span><small class="grow-lv">by Lv ${pot.level}</small>` : ''}
        ${fits ? '<small class="fits">Fills a need</small>' : ''}
      </button>`;
  };

  const detail = () => {
    if (!selected) return '';
    const m = monOf(f, selected);
    const pot = potentialOf(m.dex);
    const end = monByDex(pot.dex);
    return `
      <button class="close" aria-label="Close">×</button>
      <div class="rk-detail">
        <div class="rk-forms">
          <div><img src="${spriteUrl(m.dex)}" alt=""><b class="t-${tier(m.ovr)}">${m.ovr}</b><span>Now</span></div>
          ${pot.dex !== m.dex ? `<i>→</i><div><img src="${spriteUrl(pot.dex)}" alt=""><b class="t-${tier(pot.ovr)}">${pot.ovr}</b><span>${esc(end.name)} · Lv ${pot.level}</span></div>` : ''}
        </div>
        <h3>${esc(m.name)}</h3>
        <p class="arch">${m.pos} · ${m.archetype}${end.pos !== m.pos ? ` (plays ${end.pos} once evolved)` : ''}</p>
        <span class="types">${typeChips(m)}</span>
        <button class="btn primary big pick" ${myTurn() ? '' : 'disabled'}>${myTurn() ? `Draft ${esc(m.name)}` : 'Waiting for your pick'}</button>
      </div>`;
  };

  const orderHtml = () => {
    const r = f.rookies!;
    return `<ol class="rk-order">${r.order.map((id, i) => {
      const t = f.teams[id];
      const u = r.picks[i];
      return `<li class="${i === picksMade() ? 'now' : ''} ${t.human ? 'mine' : ''}" style="--tc:${t.color}" title="${esc(t.name)}">
        <span>${i + 1}</span><b>${t.human ? 'YOU' : esc(t.abbr)}</b>${u ? `<img src="${spriteUrl(f.players[u].dex)}" alt="${esc(monOf(f, u).name)}">` : '<i></i>'}
      </li>`;
    }).join('')}</ol>`;
  };

  /** After the draft: cut one player to get back to ten. */
  const cutHtml = () => {
    const sorted = [...me.roster].sort((a, b) => tradeValue(f, a) - tradeValue(f, b));
    const must = me.roster.length > 10;
    return `
      <section class="card rk-cut">
        <h3 class="sec">${must ? 'Cut one player' : 'Rookie draft complete'}</h3>
        <p class="note">${must ? 'Rosters max out at ten. Whoever you cut goes to free agency; your lowest-value players are listed first.' : 'Your roster has room, so nobody needs to go.'} Every other team cuts its least valuable player.</p>
        ${posTrackHtml(myMons(), 10)}
        ${must ? `<ul class="fa-list">${sorted.map((u) => {
          const m = monOf(f, u);
          const pot = potentialOf(m.dex);
          const p = f.players[u];
          return `<li class="${cutting === u ? 'picked' : ''}"><img src="${spriteUrl(m.dex)}" alt=""><span class="nm">${esc(m.name)}<small>${m.pos} · Lv ${p.level}${pot.dex !== m.dex ? ` · grows to ${pot.ovr}` : ''}${f.rookies!.picks.includes(u) ? ' · Rookie' : ''}</small></span><b class="t-${tier(m.ovr)}">${m.ovr}</b><button class="btn small ${cutting === u ? 'primary' : 'ghost'}" data-cut="${u}">${cutting === u ? 'Cut' : 'Select'}</button></li>`;
        }).join('')}</ul>` : ''}
        <div class="actions center">
          <button class="btn primary big" data-a="start" ${must && !cutting ? 'disabled' : ''}>${must ? (cutting ? `Cut ${esc(monOf(f, cutting).name)} and start Season ${f.season + 1}` : 'Pick someone to cut') : `Start Season ${f.season + 1}`}</button>
        </div>
      </section>`;
  };

  const render = () => {
    const onClock = rookieOnClock(f);
    const done = !onClock;
    root.innerHTML = `
      <div class="draft rookies">
        <header class="draft-head">
          <button class="btn ghost small" data-a="menu">Menu</button>
          <div class="status">
            <span class="round">ROOKIE DRAFT${done ? '' : ` · PICK ${picksMade() + 1}/${f.rookies!.order.length}`}</span>
            <span class="otc ${myTurn() ? 'you' : ''}">${done ? 'Draft complete' : myTurn() ? "You're on the clock" : `${esc(onClock!.name)} is picking…`}</span>
            <span class="clock big" hidden></span>
          </div>
          <div class="head-actions">${myTurn() ? '<button class="btn small" data-a="auto">Auto-pick</button>' : ''}</div>
        </header>
        ${orderHtml()}
        ${done ? cutHtml() : `
        <div class="draft-body">
          <section class="pool">
            <p class="note">${myTurn() ? 'Tap a prospect to scout them, then draft.' : 'Scout the prospects while the league picks.'} The big number is their OVR today; the small sprite is what they grow into.</p>
            <div class="grid">${rookieLeft(f).map(card).join('')}</div></section>
          <aside class="side">
            <div class="detail" ${selected ? '' : 'hidden'}>${detail()}</div>
            <div class="roster you"><h4>${esc(me.name)} depth</h4>${posTrackHtml(myMons(), 10)}</div>
            <ol class="log">${log.slice(-6).reverse().map((l) => `<li>${esc(l)}</li>`).join('')}</ol>
          </aside>
        </div>`}
      </div>`;
    updateClock();
  };

  function updateClock() {
    const on = myTurn();
    if (on && clockFor !== picksMade()) { clockFor = picksMade(); clockLeft = PICK_SECONDS * 1000; lastBeep = 0; }
    const secs = Math.max(0, Math.ceil(clockLeft / 1000));
    root.querySelectorAll<HTMLElement>('.clock').forEach((el) => {
      el.hidden = !on;
      el.textContent = `0:${String(secs).padStart(2, '0')}`;
      el.classList.toggle('low', secs <= 10);
    });
  }

  const take = (uid?: string, note = 'selected') => {
    const t = rookieOnClock(f);
    const u = rookiePick(f, uid);
    if (!t || !u) return;
    const m = monOf(f, u);
    log.push(`${t.human ? 'You' : t.name} ${note} ${m.name} (${m.pos}, grows to ${potentialOf(m.dex).ovr})`);
    audio.blip(t.human);
    if (selected === u) selected = null;
    act.saved();
    render();
    scheduleCpu();
  };

  const scheduleCpu = () => {
    window.clearTimeout(cpuTimer);
    const t = rookieOnClock(f);
    if (t && !t.human) cpuTimer = window.setTimeout(() => take(), 650);
  };

  const clock = window.setInterval(() => {
    const now = performance.now();
    const dt = now - lastTick;
    lastTick = now;
    if (!root.isConnected) { window.clearInterval(clock); window.clearTimeout(cpuTimer); return; }
    if (!myTurn() || document.hidden) return;
    clockLeft -= Math.min(dt, 1000);
    const secs = Math.ceil(clockLeft / 1000);
    if (secs <= 5 && secs > 0 && secs !== lastBeep) { lastBeep = secs; audio.blip(secs <= 3); }
    if (clockLeft <= 0) { take(undefined, "ran out of time and got"); return; }
    updateClock();
  }, 200);

  root.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    const c = t.closest<HTMLElement>('.mon-card[data-uid]');
    if (c) { selected = c.dataset.uid!; audio.blip(); render(); return; }
    if (t.closest('.pick') && selected && myTurn()) { take(selected); return; }
    if (t.closest('.close')) { selected = null; render(); return; }
    const cut = t.closest<HTMLElement>('[data-cut]')?.dataset.cut;
    if (cut) { cutting = cutting === cut ? null : cut; render(); return; }
    const a = t.closest<HTMLElement>('[data-a]')?.dataset.a;
    if (a === 'menu') { window.clearTimeout(cpuTimer); window.clearInterval(clock); act.menu(); }
    if (a === 'auto' && myTurn()) take(undefined, 'auto-picked');
    if (a === 'start' && (cutting || me.roster.length <= 10)) {
      window.clearInterval(clock);
      finishRookieDraft(f, cutting ?? '');
      act.saved();
      act.done();
    }
  });

  if (!f.rookies) return act.done();
  render();
  scheduleCpu();
}

