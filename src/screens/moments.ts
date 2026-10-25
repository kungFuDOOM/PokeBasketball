// Full-screen franchise moments: the championship cutscene and the new-season preview. Both are overlays
// that dismiss with a tap, click or key, then hand control back to the hub.
import { spriteUrl } from '../data/pokemon';
import { monOf, perGame, teamOvrOf, type Franchise } from '../franchise/league';
import {
  finalGame, firstGames, ovrRanking, rosterHighlights, seasonLabel, spotlightOf, topContenders, userFinish,
} from '../franchise/moments';
import { TROPHY_IMG } from '../ui/trophy';
import { esc, tier } from '../util';
import { reducedMotion, SCENE_MS, SCENE_MS_CALM, startCelebration } from './celebration';
import { ordinal } from './draft.logic';
import type { CelebrationSound } from '../music/celebration';

/** Taps this soon after the screen opens are the tap that opened it, not a skip. */
const GUARD_MS = 450;

/** `intercept` runs on a tap that would close the screen; return true to swallow it. */
function mount(html: string, cls: string, done: () => void, onClose?: () => void, intercept?: () => boolean): HTMLElement {
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
    if (intercept && intercept()) return;
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

/** Code confetti, streamers and camera-flash sparkles on a canvas; returns a stop function. Off for people who ask for less motion. */
function confetti(host: HTMLElement, colors: string[], onFlash: () => void = () => {}): () => void {
  const canvas = host.querySelector<HTMLCanvasElement>('canvas.confetti');
  const ctx = canvas && canvas.getContext('2d');
  if (!canvas || !ctx || reducedMotion()) return () => {};
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = Math.round(canvas.clientWidth * dpr);
  canvas.height = Math.round(canvas.clientHeight * dpr);
  const w = canvas.width;
  const h = canvas.height;
  const bits = Array.from({ length: 130 }, (_, i) => ({
    x: Math.random() * w,
    y: -Math.random() * h * 0.8,
    vx: (Math.random() - 0.5) * 1.6 * dpr,
    vy: (1.2 + Math.random() * 2.2) * dpr,
    s: (4 + Math.random() * 6) * dpr,
    a: Math.random() * 6.28,
    va: (Math.random() - 0.5) * 0.3,
    c: colors[i % colors.length],
  }));
  // Streamers: long ribbons that sway as they fall.
  const ribbons = Array.from({ length: 14 }, (_, i) => ({
    x: Math.random() * w, y: -Math.random() * h, vy: (1.1 + Math.random() * 1.2) * dpr,
    len: (60 + Math.random() * 60) * dpr, amp: (6 + Math.random() * 8) * dpr, ph: Math.random() * 6.28, c: colors[i % colors.length],
  }));
  // Camera flashes from the stands: short white pops along the top of the screen.
  const flashes: { x: number; y: number; life: number; r: number }[] = [];
  const onCourt = !!host.querySelector('.cel-canvas');
  let last = performance.now();
  let raf = 0;
  const tick = (now: number) => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    ctx.clearRect(0, 0, w, h);
    for (const b of bits) {
      b.x += b.vx;
      b.y += b.vy;
      b.a += b.va;
      if (b.y > h + 20) { b.y = -10; b.x = Math.random() * w; }
      ctx.save();
      ctx.translate(b.x, b.y);
      ctx.rotate(b.a);
      ctx.fillStyle = b.c;
      ctx.fillRect(-b.s / 2, -b.s / 4, b.s, b.s / 2);
      ctx.restore();
    }
    ctx.lineWidth = 3 * dpr;
    for (const r of ribbons) {
      r.y += r.vy;
      r.ph += 0.05;
      if (r.y - r.len > h) { r.y = -10; r.x = Math.random() * w; }
      ctx.strokeStyle = r.c;
      ctx.beginPath();
      for (let k = 0; k <= 10; k++) {
        const px = r.x + Math.sin(r.ph + k * 0.7) * r.amp;
        const py = r.y - (k / 10) * r.len;
        if (k) ctx.lineTo(px, py);
        else ctx.moveTo(px, py);
      }
      ctx.stroke();
    }
    if (onCourt && Math.random() < dt * 9) {
      flashes.push({ x: Math.random() * w, y: (0.04 + Math.random() * 0.2) * h, life: 0.3, r: (7 + Math.random() * 9) * dpr });
      onFlash();
    }
    ctx.strokeStyle = '#fff';
    ctx.fillStyle = '#fff';
    ctx.lineWidth = 1.5 * dpr;
    for (let i = flashes.length - 1; i >= 0; i--) {
      const fl = flashes[i];
      fl.life -= dt;
      if (fl.life <= 0) { flashes.splice(i, 1); continue; }
      const k = fl.life / 0.3;
      const r = fl.r * (0.5 + (1 - k));
      ctx.globalAlpha = k;
      ctx.beginPath();
      ctx.moveTo(fl.x - r, fl.y); ctx.lineTo(fl.x + r, fl.y);
      ctx.moveTo(fl.x, fl.y - r); ctx.lineTo(fl.x, fl.y + r);
      ctx.moveTo(fl.x - r * 0.5, fl.y - r * 0.5); ctx.lineTo(fl.x + r * 0.5, fl.y + r * 0.5);
      ctx.moveTo(fl.x + r * 0.5, fl.y - r * 0.5); ctx.lineTo(fl.x - r * 0.5, fl.y + r * 0.5);
      ctx.stroke();
      ctx.fillRect(fl.x - dpr, fl.y - dpr, 2 * dpr, 2 * dpr);
    }
    ctx.globalAlpha = 1;
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => cancelAnimationFrame(raf);
}

/** `sound` is the celebration's audio (fanfare, crowd, announcer); omitted, the cutscene is silent. */
export function championshipScreen(f: Franchise, done: () => void, sound?: CelebrationSound) {
  const champ = f.teams[f.champion!];
  const mine = champ.human;
  const spot = spotlightOf(f, champ);
  const fin = finalGame(f);
  const pg = spot ? perGame(f.players[spot.uid].stats) : null;
  const sc = fin && fin.score ? fin : null;
  const side = (id: number, pts: number) => `<span class="${id === f.champion ? 'win' : ''}">${esc(f.teams[id].abbr)} <b>${pts}</b></span>`;
  const html = `
    <div class="cel" aria-hidden="true"><div class="cel-zoom"><canvas class="cel-canvas"></canvas></div><div class="cel-shade"></div></div>
    <canvas class="confetti" aria-hidden="true"></canvas>
    <p class="cel-skip">Tap to skip</p>
    <div class="mo-body" style="--tc:${champ.color};--tc2:${champ.color2}">
      <div class="mo-art"><img class="trophy-img" src="${esc(TROPHY_IMG)}" alt="Championship trophy"></div>
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
  // The court scene plays first. One tap during it jumps to the title card; the next tap (after a short beat) continues.
  let cardAt = 0;
  let timer = 0;
  const showCard = () => {
    if (cardAt) return;
    cardAt = Date.now();
    window.clearTimeout(timer);
    el.classList.add('show-card');
    sound?.card();
  };
  const intercept = () => {
    if (!cardAt) { showCard(); return true; }
    return Date.now() - cardAt < 350;
  };
  const el = mount(html, 'champion', done, () => { window.clearTimeout(timer); stopConfetti(); stopScene(); sound?.stop(); }, intercept);
  sound?.start();
  const stopScene = startCelebration(el, f, champ, { onBump: () => sound?.bump() });
  const stopConfetti = confetti(el, [champ.color, '#ffcb05', '#f2f0e6', champ.color2 === '#16224a' ? '#3b6fd8' : champ.color2, '#e3350d'], () => sound?.flash());
  timer = window.setTimeout(showCard, reducedMotion() ? SCENE_MS_CALM : SCENE_MS);
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
        <h1>Season ${esc(seasonLabel(f.season))}</h1>
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
