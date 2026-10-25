// Full-screen franchise moments: the championship cutscene and the new-season preview. Both are overlays
// that dismiss with a tap, click or key, then hand control back to the hub.
import { monByDex, spriteUrl } from '../data/pokemon';
import { monOf, perGame, teamOvrOf, type FTeam, type Franchise } from '../franchise/league';
import {
  finalGame, firstGames, ovrRanking, rosterHighlights, seasonLabel, spotlightOf, topContenders, userFinish,
} from '../franchise/moments';
import { TROPHY_IMG } from '../ui/trophy';
import { esc, tier } from '../util';
import { ordinal } from './draft.logic';

/** Taps this soon after the screen opens are the tap that opened it, not a skip. */
const GUARD_MS = 450;

function mount(html: string, cls: string, done: () => void, onClose?: () => void): HTMLElement {
  const el = document.createElement('div');
  el.className = `moment ${cls}`;
  el.setAttribute('role', 'dialog');
  el.setAttribute('aria-modal', 'true');
  el.innerHTML = html;
  document.body.appendChild(el);
  const opened = Date.now();
  let closed = false;
  const close = () => {
    if (closed || Date.now() - opened < GUARD_MS) return;
    closed = true;
    window.removeEventListener('keydown', onKey, true);
    if (onClose) onClose();
    el.remove();
    done();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      close();
    }
  };
  el.addEventListener('click', close);
  window.addEventListener('keydown', onKey, true);
  return el;
}

/** Code confetti on a canvas; returns a stop function. Skipped for people who ask for less motion. */
function confetti(host: HTMLElement, colors: string[]): () => void {
  const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const canvas = host.querySelector<HTMLCanvasElement>('canvas.confetti');
  const ctx = canvas && canvas.getContext('2d');
  if (!canvas || !ctx || reduce) return () => {};
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const size = () => {
    canvas.width = Math.round(canvas.clientWidth * dpr);
    canvas.height = Math.round(canvas.clientHeight * dpr);
  };
  size();
  const w = () => canvas.width;
  const h = () => canvas.height;
  const bits = Array.from({ length: 110 }, (_, i) => ({
    x: Math.random() * w(),
    y: -Math.random() * h(),
    vx: (Math.random() - 0.5) * 1.6 * dpr,
    vy: (1.2 + Math.random() * 2.2) * dpr,
    s: (4 + Math.random() * 6) * dpr,
    a: Math.random() * 6.28,
    va: (Math.random() - 0.5) * 0.3,
    c: colors[i % colors.length],
  }));
  let raf = 0;
  const tick = () => {
    ctx.clearRect(0, 0, w(), h());
    for (const b of bits) {
      b.x += b.vx;
      b.y += b.vy;
      b.a += b.va;
      if (b.y > h() + 20) { b.y = -10; b.x = Math.random() * w(); }
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.a);
      ctx.fillStyle = b.c;
      ctx.fillRect(-b.s / 2, -b.s / 4, b.s, b.s / 2);
      ctx.restore();
    }
    raf = requestAnimationFrame(tick);
  };
  tick();
  return () => cancelAnimationFrame(raf);
}

/** The trophy picture: a real image once TROPHY_IMG is set, else the champion's star Pokémon. */
function trophyHtml(f: Franchise, champ: FTeam, star: string | null): string {
  if (TROPHY_IMG) return `<img class="trophy-img" src="${esc(TROPHY_IMG)}" alt="Championship trophy">`;
  const dex = star ? f.players[star].dex : null;
  return dex === null ? '' : `<img class="trophy-img star" src="${spriteUrl(dex)}" alt="${esc(champ.name)} star ${esc(monByDex(dex).name)}">`;
}

export function championshipScreen(f: Franchise, done: () => void) {
  const champ = f.teams[f.champion!];
  const mine = champ.human;
  const spot = spotlightOf(f, champ);
  const fin = finalGame(f);
  const star = spot ? spot.uid : null;
  const pg = spot ? perGame(f.players[spot.uid].stats) : null;
  const sc = fin && fin.score ? fin : null;
  const side = (id: number, pts: number) => `<span class="${id === f.champion ? 'win' : ''}">${esc(f.teams[id].abbr)} <b>${pts}</b></span>`;
  const html = `
    <canvas class="confetti" aria-hidden="true"></canvas>
    <div class="mo-body" style="--tc:${champ.color};--tc2:${champ.color2}">
      <div class="mo-art">${trophyHtml(f, champ, star)}</div>
      <div class="mo-text">
        <p class="eyebrow">${esc(seasonLabel(f.season))} Champions</p>
        <h1>${mine ? "You're the champions!" : esc(champ.name)}</h1>
        <p class="mo-team"><b class="abbr">${esc(champ.abbr)}</b>${mine ? esc(champ.name) : 'win the title'}</p>
        ${sc ? `<p class="mo-final">The Final · ${side(sc.home, sc.score![0])} <i>–</i> ${side(sc.away, sc.score![1])}</p>` : ''}
        ${spot && pg ? `<p class="mo-mvp"><span class="lbl">${esc(spot.label)}</span> <strong>${esc(monOf(f, spot.uid).name)}</strong> · ${pg.ppg.toFixed(1)} PPG · ${pg.rpg.toFixed(1)} RPG · ${pg.apg.toFixed(1)} APG</p>` : ''}
        ${mine ? '' : `<p class="mo-you">${esc(userFinish(f))}</p>`}
        <p class="mo-hint">Tap to continue</p>
      </div>
    </div>`;
  const el = mount(html, 'champion', done, () => stop());
  const stop = confetti(el, [champ.color, '#ffcb05', '#f2f0e6', champ.color2 === '#16224a' ? '#3b6fd8' : champ.color2, '#e3350d']);
}

export function newSeasonScreen(f: Franchise, done: () => void) {
  const me = f.teams[0];
  const ranking = ovrRanking(f);
  const mine = ranking.find((r) => r.team.human)!;
  const hl = rosterHighlights(f);
  const rivals = topContenders(f, 3);
  const games = firstGames(f, 3);
  const mon = (uid: string, rookie: boolean) => {
    const m = monOf(f, uid);
    return `<li class="${rookie ? 'rookie' : ''}"><img src="${spriteUrl(m.dex)}" alt=""><span>${esc(m.name)}</span><b class="t-${tier(m.ovr)}">${m.ovr}</b>${rookie ? '<em>Rookie</em>' : ''}</li>`;
  };
  const html = `
    <div class="mo-body ns" style="--tc:${me.color};--tc2:${me.color2}">
      <div class="mo-head">
        <p class="eyebrow">${esc(me.name)} · ${esc(me.abbr)}</p>
        <h1>${esc(seasonLabel(f.season))}</h1>
        <p class="mo-sub">${teamOvrOf(f, me)} OVR · ${ordinal(mine.rank)} of ${ranking.length} in the league</p>
      </div>
      <div class="ns-cols">
        <section><h3>Roster highlights</h3><ul class="ns-mons">${hl.map((x) => mon(x.uid, x.rookie)).join('')}</ul></section>
        <section><h3>Teams to beat</h3><ul class="ns-list">${rivals.map((r) => `<li style="--tc:${r.team.color}"><i></i><span>${esc(r.team.name)}</span><b>${r.ovr}</b><small>${ordinal(r.rank)}</small></li>`).join('')}</ul></section>
        ${games.length ? `<section><h3>Up first</h3><ul class="ns-list">${games.map((g) => `<li style="--tc:${g.opp.color}"><i></i><span>${g.home ? 'vs' : '@'} ${esc(g.opp.name)}</span><small>Wk ${g.week}</small></li>`).join('')}</ul></section>` : ''}
      </div>
      <p class="mo-hint">Tap to start the season</p>
    </div>`;
  mount(html, 'newseason', done);
}
