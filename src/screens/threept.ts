// 3-Point Contest side mode: pick shooter -> pick money rack -> play 60s -> results. Offline, solo, personal best only.
// Pure rules live in src/threept/*; this file is the DOM flow, threept.view.ts draws the court.
import { POKEMON, spriteUrl, type Mon } from '../data/pokemon';
import { crownImg } from '../kabuto/dom';
import { isKingKabuto, withKingKabuto } from '../kabuto/king';
import type { Audio } from '../game/audio';
import type { Sfx } from '../game/game';
import { Input } from '../game/input';
import { preload } from '../game/sprites';
import { featuredShooter, rackPreview, rackSpots, summarize } from '../threept/contest';
import { pickerRows } from '../threept/picker';
import { IDEAL_RELEASE, contestGreenWindow } from '../threept/shot';
import { ContestRun, type RunEvent } from '../threept/run';
import { loadBest, saveIfBest } from '../threept/save';
import { BALLS_PER_RACK, MAX_SCORE, RACKS, TOTAL_BALLS, type RackId } from '../threept/types';
import { esc, tier } from '../util';
import type { Settings } from './menu';
import { CourtView } from './threept.view';

export interface ThreePtActions {
  menu(): void;
}

export type ThreePtStep = 'pick' | 'rack' | 'play' | 'results';

/** Remembered across visits in this session: "Change shooter" scrolls back to them, Play again reuses both. */
let lastDex: number | null = null;
let lastRack: RackId = 2;

const SPOTS = rackSpots();
/** The picker pool: King Kabuto replaces Kabuto while his window is open, so dex lookups must go through here. */
const pickerPool = () => withKingKabuto(POKEMON);
const monByDex = (dex: number): Mon => pickerPool().find((m) => m.dex === dex) ?? POKEMON[0];
/** Name markup: the gold tag for King Kabuto, escaped text for everyone else. */
const nameHtml = (m: Mon) => (isKingKabuto(m) ? `<span class="king-tag">${esc(m.name)}</span>` : esc(m.name));
/** Crown King Kabuto's sprites under `scope` (they start plain and swap once the crowned image is ready). */
const crownAll = (scope: ParentNode) => scope.querySelectorAll<HTMLImageElement>('img[data-king]').forEach(crownImg);
const DT_MAX = 0.05;
/** Seconds between the last ball / buzzer and the results screen. */
const RESULTS_DELAY = 0.9;

export function threePtContest(root: HTMLElement, settings: Settings, audio: Audio, act: ThreePtActions): void {
  void settings; // the contest meter is fixed and friendly: the menu difficulty does not apply
  let step: ThreePtStep = 'pick';
  let shooter: Mon | null = lastDex !== null ? monByDex(lastDex) : null;
  let moneyRack: RackId = lastRack;
  let stepCleanup: (() => void) | null = null;
  let alive = true;
  let raf = 0;
  let frame: ((dt: number) => void) | null = null;
  let last = performance.now();

  const sfx = (s: Sfx) => { try { audio.play(s); } catch { /* audio never breaks the mode */ } };
  const blip = (high = false) => { try { audio.blip(high); } catch { /* silent */ } };

  // One rAF loop for the whole mode: the play step's frame, or gamepad navigation on the menus.
  const loop = (now: number) => {
    if (!alive) return;
    const dt = Math.min(DT_MAX, Math.max(0, (now - last) / 1000));
    last = now;
    frame?.(dt);
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  const go = (next: ThreePtStep) => {
    stepCleanup?.();
    stepCleanup = null;
    frame = null;
    step = next;
    window.scrollTo(0, 0);
    if (next === 'pick') renderPick();
    else if (next === 'rack') renderRack();
    else if (next === 'play') renderPlay();
    crownAll(root);
  };

  const leave = () => {
    if (!alive) return;
    alive = false;
    stepCleanup?.();
    stepCleanup = null;
    frame = null;
    cancelAnimationFrame(raf);
    window.removeEventListener('keydown', onKey);
    act.menu();
  };

  // Esc on the menu-like steps; the play step handles its own keys through Input.
  const onKey = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (step === 'pick') {
      const q = root.querySelector<HTMLInputElement>('.tp-q');
      if (q && q.value && document.activeElement === q) return; // the browser clears the search first
      e.preventDefault();
      leave();
    } else if (step === 'rack') { e.preventDefault(); go('pick'); }
    else if (step === 'results') { e.preventDefault(); leave(); }
  };
  window.addEventListener('keydown', onKey);

  /** Gamepad on menus: D-pad / stick moves focus, A presses, B backs out. Polled from the shared loop. */
  const padNav = (scope: () => HTMLElement | null, back: () => void) => {
    const prev = new Set<string>();
    let repeatAt = 0;
    let t = 0;
    return (dt: number) => {
      t += dt;
      const now = new Set<string>();
      for (const gp of navigator.getGamepads?.() ?? []) {
        if (!gp) continue;
        const b = (i: number) => !!gp.buttons[i]?.pressed;
        const ax = gp.axes[0] ?? 0, ay = gp.axes[1] ?? 0;
        if (b(12) || ay < -0.6) now.add('up');
        if (b(13) || ay > 0.6) now.add('down');
        if (b(14) || ax < -0.6) now.add('left');
        if (b(15) || ax > 0.6) now.add('right');
        if (b(0)) now.add('a');
        if (b(1)) now.add('b');
      }
      const edge = (k: string) => now.has(k) && !prev.has(k);
      const dir = (['up', 'down', 'left', 'right'] as const).find((k) => now.has(k));
      let move = 0;
      if (dir && edge(dir)) { move = dir === 'up' || dir === 'left' ? -1 : 1; repeatAt = t + 0.4; }
      else if (dir && t >= repeatAt) { move = dir === 'up' || dir === 'left' ? -1 : 1; repeatAt = t + 0.1; }
      const el = scope();
      if (el && move) {
        const items = [...el.querySelectorAll<HTMLElement>('button:not([disabled]), input')].filter((x) => x.offsetParent !== null);
        const i = items.indexOf(document.activeElement as HTMLElement);
        const n = items[i < 0 ? 0 : Math.max(0, Math.min(items.length - 1, i + move))];
        n?.focus();
      }
      if (el && edge('a')) {
        const f = document.activeElement as HTMLElement | null;
        if (f && el.contains(f) && f.tagName === 'BUTTON') f.click();
      }
      if (edge('b')) back();
      prev.clear();
      for (const k of now) prev.add(k);
    };
  };

  const bestChip = () => {
    const b = loadBest();
    return b ? `<span class="tp-best-chip" title="Personal best">Best <b>${b.score}</b> · ${esc(b.name)}</span>` : '';
  };

  // ---------- step 1: shooter picker ----------
  function renderPick() {
    root.innerHTML = `
      <div class="threept tp-pick">
        <header class="tp-head">
          <button class="btn ghost small" data-a="menu">Menu</button>
          <h1>3-Point Contest</h1>
          ${bestChip()}
        </header>
        <p class="tp-sub">Pick any Pokémon to shoot. Higher <b>Sht</b> means a bigger green window and better odds.</p>
        <div class="tp-search">
          <input type="search" class="tp-q" placeholder="Search a name or #dex" aria-label="Search shooters" autocomplete="off">
          <span class="tp-count" aria-live="polite"></span>
        </div>
        <div class="tp-list" role="listbox" aria-label="Shooters"></div>
      </div>`;
    const list = root.querySelector<HTMLElement>('.tp-list')!;
    const q = root.querySelector<HTMLInputElement>('.tp-q')!;
    const count = root.querySelector<HTMLElement>('.tp-count')!;
    const featured = featuredShooter();
    const pool = pickerPool();
    const draw = () => {
      const rows = pickerRows(q.value, featured, pool);
      count.textContent = `${rows.length} of ${pool.length}`;
      list.innerHTML = rows.length ? rows.map((m) => {
        const sel = m.dex === shooter?.dex;
        const badge = featured && featured.dex === m.dex ? `<span class="tp-badge">${esc(featured.badge)}</span>` : '';
        return `<button class="tp-row${sel ? ' on' : ''}" role="option" aria-selected="${sel}" data-dex="${m.dex}">
          <img src="${spriteUrl(m.dex)}" alt="" loading="lazy" width="48" height="48"${isKingKabuto(m) ? ' data-king' : ''}>
          <span class="tp-name">${nameHtml(m)}${badge}<small>#${m.dex} · ${m.pos} · ${esc(m.archetype)}</small></span>
          <span class="tp-stat tp-sht t-${tier(m.r.sht)}"><small>Sht</small><b>${m.r.sht}</b></span>
          <span class="tp-stat t-${tier(m.ovr)}"><small>OVR</small><b>${m.ovr}</b></span>
          <span class="tp-go" aria-hidden="true">Pick</span>
        </button>`;
      }).join('') : '<p class="tp-empty">No Pokémon match. Try another name or number.</p>';
      crownAll(list);
    };
    draw();
    q.addEventListener('input', draw);
    root.querySelector('[data-a="menu"]')!.addEventListener('click', leave);
    list.addEventListener('click', (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>('.tp-row');
      if (!row) return;
      shooter = monByDex(Number(row.dataset.dex));
      lastDex = shooter.dex;
      blip(true);
      go('rack');
    });
    // Coming back via "Change shooter": scroll to and focus the last pick; otherwise start in the search box.
    const cur = shooter ? list.querySelector<HTMLElement>(`.tp-row[data-dex="${shooter.dex}"]`) : null;
    if (cur) { cur.scrollIntoView({ block: 'center' }); cur.focus({ preventScroll: true }); }
    else if (!matchMedia('(pointer: coarse)').matches) q.focus();
    frame = padNav(() => root.querySelector('.tp-pick'), leave);
  }

  // ---------- step 2: money rack ----------
  function renderRack() {
    if (!shooter) return go('pick');
    const m = shooter;
    root.innerHTML = `
      <div class="threept tp-rackstep">
        <header class="tp-head">
          <button class="btn ghost small" data-a="back">Change shooter</button>
          <h1>Money rack</h1>
          <span class="tp-max">Max <b>${MAX_SCORE}</b></span>
        </header>
        <div class="tp-shooter">
          <img src="${spriteUrl(m.dex)}" alt="" width="56" height="56"${isKingKabuto(m) ? ' data-king' : ''}>
          <span><b>${nameHtml(m)}</b><small>Sht ${m.r.sht} · OVR ${m.ovr}</small></span>
        </div>
        <p class="tp-sub">Every ball on your money rack is worth 2. Elsewhere only the last ball of each rack is.</p>
        <div class="tp-arc" role="group" aria-label="Money rack">
          <div class="tp-hoop" aria-hidden="true"></div>
          ${SPOTS.map((s) => `<button class="tp-rackbtn r${s.rack}" data-r="${s.rack}" aria-pressed="false">
            <span class="tp-rl">${s.label}</span>
            <span class="tp-balls">${Array.from({ length: BALLS_PER_RACK }, (_, i) => `<i data-i="${i}"></i>`).join('')}</span>
            <b class="tp-pts"></b>
          </button>`).join('')}
        </div>
        <div class="tp-actions"><button class="btn primary big" data-a="start">Start</button></div>
        <p class="tp-hint">Hold <kbd>J</kbd>/<kbd>Space</kbd> (gamepad <kbd>X</kbd>, or the Shoot button) and release on green. The 60 second clock starts on your first shot.</p>
      </div>`;
    const btns = [...root.querySelectorAll<HTMLButtonElement>('.tp-rackbtn')];
    const sync = () => {
      const pts = rackPreview(moneyRack);
      btns.forEach((b, r) => {
        const on = r === moneyRack;
        b.setAttribute('aria-pressed', String(on));
        b.classList.toggle('on', on);
        b.querySelector('.tp-pts')!.textContent = String(pts[r]);
        b.setAttribute('aria-label', `${SPOTS[r].label}: ${pts[r]} points${on ? ', money rack' : ''}`);
        b.querySelectorAll<HTMLElement>('.tp-balls i').forEach((i, k) => i.classList.toggle('money', on || k === BALLS_PER_RACK - 1));
      });
    };
    const select = (r: number) => {
      moneyRack = Math.max(0, Math.min(RACKS - 1, r)) as RackId;
      lastRack = moneyRack;
      sync();
    };
    const startContest = () => { blip(true); go('play'); };
    sync();
    btns.forEach((b, r) => {
      b.addEventListener('click', () => { select(r); blip(); });
      b.addEventListener('focus', () => select(r));
      b.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); btns[Math.max(0, r - 1)].focus(); }
        else if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); btns[Math.min(RACKS - 1, r + 1)].focus(); }
        else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(r); startContest(); }
      });
    });
    root.querySelector('[data-a="back"]')!.addEventListener('click', () => go('pick'));
    root.querySelector('[data-a="start"]')!.addEventListener('click', startContest);
    btns[moneyRack].focus({ preventScroll: true });
    frame = padNav(() => root.querySelector('.tp-rackstep'), () => go('pick'));
  }

  // ---------- step 3: play ----------
  function renderPlay() {
    if (!shooter) return go('pick');
    const m = shooter;
    const run = new ContestRun(m, moneyRack);
    root.innerHTML = `
      <div class="tp-game">
        <div class="tp-hud" role="status">
          <div class="tp-clock" aria-label="Time left"></div>
          <div class="tp-score" aria-label="Score"><b>0</b><small>/ ${MAX_SCORE}</small></div>
          <div class="tp-rackinfo"><b class="tp-rackname"></b><small class="tp-ballno"></small></div>
        </div>
        <div class="tp-stage">
          <canvas class="tp-court" aria-label="3-point contest court"></canvas>
          <p class="tp-tip">Hold <b>SHOOT</b>, release on green. Clock starts on your first shot.</p>
        </div>
        <div class="tp-meter" aria-hidden="true"><i class="tp-mgreen"></i><i class="tp-mfill"></i><i class="tp-mmark"></i></div>
        <p class="tp-rackline"><b class="tp-rackname"></b><small class="tp-ballno"></small></p>
        <div class="tp-dots" aria-hidden="true">${Array.from({ length: RACKS }, (_, r) => `<span class="tp-dgroup${r === moneyRack ? ' money-rack' : ''}">${
          Array.from({ length: BALLS_PER_RACK }, (_, i) => `<i data-b="${r * BALLS_PER_RACK + i}" class="${r === moneyRack || i === BALLS_PER_RACK - 1 ? 'money' : ''}"></i>`).join('')}</span>`).join('')}</div>
        <button class="icon-btn pause-btn tp-pausebtn" aria-label="Pause">II</button>
        <div class="pause-menu tp-pause" hidden>
          <div class="panel">
            <h2 class="tp-ptitle">PAUSED</h2>
            <div class="pause-actions tp-main">
              <button class="btn primary" data-a="resume">Resume</button>
              <button class="btn" data-a="mute"></button>
              <button class="btn ghost" data-a="quit">Quit to menu</button>
            </div>
            <div class="pause-actions tp-confirm" hidden>
              <p>Quit this contest? This run won't count.</p>
              <button class="btn primary" data-a="keep">Keep shooting</button>
              <button class="btn ghost" data-a="really-quit">Quit</button>
            </div>
            <p class="tp-keys">Hold <kbd>J</kbd>/<kbd>Space</kbd> or <kbd>X</kbd> to shoot · <kbd>P</kbd>/<kbd>Esc</kbd>/Start pause/resume · <kbd>Q</kbd> quit</p>
          </div>
        </div>
      </div>`;
    const gameEl = root.querySelector<HTMLElement>('.tp-game')!;
    const stage = root.querySelector<HTMLElement>('.tp-stage')!;
    const canvas = root.querySelector<HTMLCanvasElement>('canvas')!;
    const clockEl = root.querySelector<HTMLElement>('.tp-clock')!;
    const scoreEl = root.querySelector<HTMLElement>('.tp-score b')!;
    const rackNames = [...root.querySelectorAll<HTMLElement>('.tp-rackname')];
    const ballNos = [...root.querySelectorAll<HTMLElement>('.tp-ballno')];
    const tip = root.querySelector<HTMLElement>('.tp-tip')!;
    const dots = [...root.querySelectorAll<HTMLElement>('.tp-dots i')];
    const meterEl = root.querySelector<HTMLElement>('.tp-meter')!;
    const gw = contestGreenWindow(m.r);
    meterEl.style.setProperty('--lo', `${(IDEAL_RELEASE - gw) * 100}%`);
    meterEl.style.setProperty('--hi', `${(IDEAL_RELEASE + gw) * 100}%`);
    const pauseMenu = root.querySelector<HTMLElement>('.tp-pause')!;
    const mainActions = pauseMenu.querySelector<HTMLElement>('.tp-main')!;
    const confirmEl = pauseMenu.querySelector<HTMLElement>('.tp-confirm')!;
    const ptitle = pauseMenu.querySelector<HTMLElement>('.tp-ptitle')!;
    const muteBtn = pauseMenu.querySelector<HTMLButtonElement>('[data-a="mute"]')!;
    const pauseBtn = root.querySelector<HTMLButtonElement>('.tp-pausebtn')!;

    const view = new CourtView(canvas, m.dex);
    void preload([m]);
    const input = new Input();
    const touch = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
    if (touch) {
      input.attachTouch(gameEl);
      gameEl.classList.add('has-touch');
    }
    try { audio.startCrowd(); } catch { /* silent */ }

    // Mouse / finger hold on the court also shoots (one pointer at a time; release anywhere ends it).
    let pointerId: number | null = null;
    const onDown = (e: PointerEvent) => {
      if (pointerId !== null || !pauseMenu.hidden) return;
      pointerId = e.pointerId;
      stage.setPointerCapture?.(e.pointerId);
      e.preventDefault();
    };
    const onUp = (e: PointerEvent) => { if (e.pointerId === pointerId) pointerId = null; };
    stage.addEventListener('pointerdown', onDown);
    stage.addEventListener('pointerup', onUp);
    stage.addEventListener('pointercancel', onUp);
    window.addEventListener('pointerup', onUp);

    // A tap on the touch Shoot button can start and end between two frames: latch it so it still fires a shot.
    let tapLatch = false;
    const shootBtn = gameEl.querySelector<HTMLElement>('.tb.shoot');
    const onTap = () => { tapLatch = true; };
    shootBtn?.addEventListener('pointerdown', onTap);

    let paused = false;
    let overT = -1;
    let prevHeld = false;
    let prevStart = false;

    const setMuteLabel = () => { muteBtn.textContent = audio.muted ? 'Sound: off' : 'Sound: on'; };
    setMuteLabel();
    const showConfirm = (on: boolean) => {
      confirmEl.hidden = !on;
      mainActions.hidden = on;
      ptitle.textContent = on ? 'QUIT?' : 'PAUSED';
      (on ? confirmEl.querySelector<HTMLElement>('[data-a="keep"]') : mainActions.querySelector<HTMLElement>('[data-a="resume"]'))?.focus();
    };
    const setPaused = (p: boolean, confirm = false) => {
      if (overT >= 0) return; // the contest is over: nothing left to pause
      paused = p;
      if (p) run.pause(); else run.resume();
      pointerId = null;
      pauseMenu.hidden = !p;
      if (p) showConfirm(confirm);
      else { confirmEl.hidden = true; mainActions.hidden = false; (document.activeElement as HTMLElement | null)?.blur?.(); }
    };
    pauseBtn.addEventListener('click', () => setPaused(!paused));
    pauseMenu.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest<HTMLElement>('[data-a]')?.dataset.a;
      if (a === 'resume' || a === 'keep') { if (a === 'keep') showConfirm(false); setPaused(false); }
      if (a === 'mute') { audio.setMuted(!audio.muted); setMuteLabel(); }
      if (a === 'quit') showConfirm(true);
      if (a === 'really-quit') leave();
    });
    // Keyboard pause / quit are handled on keydown (a quick tap can fall between frames); auto-repeat is ignored.
    const onPlayKey = (e: KeyboardEvent) => {
      if (e.repeat || overT >= 0) return;
      if (e.code === 'KeyQ') { e.preventDefault(); if (!paused) setPaused(true, true); else showConfirm(true); }
      else if (e.code === 'KeyP' || e.code === 'Escape') {
        e.preventDefault();
        if (paused && !confirmEl.hidden) showConfirm(false);
        else setPaused(!paused);
      }
    };
    window.addEventListener('keydown', onPlayKey);
    const onVis = () => { if (document.hidden && !paused) setPaused(true); };
    const onBlur = () => { if (!paused) setPaused(true); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('blur', onBlur);

    const menuNav = padNav(() => pauseMenu, () => (confirmEl.hidden ? setPaused(false) : showConfirm(false)));

    const hud = () => {
      const s = run.s;
      const t = s.timeLeft;
      clockEl.textContent = t >= 10 ? String(Math.ceil(t - 1e-9)) : t.toFixed(1);
      clockEl.classList.toggle('low', t < 10);
      scoreEl.textContent = String(s.results.reduce((n, b) => n + b.points, 0));
      const v = run.stage === 'hold' ? run.meter : run.stage === 'flight' && run.shot ? run.shot.meter : 0;
      meterEl.style.setProperty('--v', `${Math.min(1, v) * 100}%`);
      meterEl.classList.toggle('active', v > 0);
      meterEl.classList.toggle('green', v >= IDEAL_RELEASE - gw && v <= IDEAL_RELEASE + gw);
      const done = s.ballIndex >= TOTAL_BALLS;
      const shown = done ? TOTAL_BALLS - 1 : s.ballIndex;
      const rackText = `${SPOTS[run.rack].label}${run.rack === s.moneyRack ? ' · Money' : ''}`;
      const ballText = `Ball ${(shown % BALLS_PER_RACK) + 1}/${BALLS_PER_RACK} · Rack ${run.rack + 1}/${RACKS}`;
      for (const el of rackNames) if (el.textContent !== rackText) el.textContent = rackText;
      for (const el of ballNos) if (el.textContent !== ballText) el.textContent = ballText;
      dots.forEach((d, i) => {
        const b = s.results[i];
        d.classList.toggle('made', b?.result === 'make');
        d.classList.toggle('miss', b?.result === 'miss');
        d.classList.toggle('cur', !b && i === s.ballIndex && run.stage !== 'over');
      });
    };

    const handle = (ev: RunEvent) => {
      switch (ev.kind) {
        case 'start': tip.hidden = true; break;
        case 'release': view.release(run, ev.grade, ev.result); sfx('shot'); break;
        case 'result':
          view.landed(ev.ball.points, ev.ball.money, ev.ball.result);
          sfx(ev.ball.result === 'make' ? 'swish' : 'rim');
          break;
        case 'rack': sfx('bounce'); break;
        case 'buzzer': sfx('buzzer'); break;
        case 'over':
          if (overT < 0) {
            overT = 0;
            if (run.s.timeLeft > 0) sfx('buzzer'); // all 25 taken early: horn to close it out
            pauseBtn.hidden = true;
          }
          break;
      }
    };

    // Gamepad Start toggles pause (keyboard P / Esc go through onPlayKey, so Input's own pause flag is unused).
    const startPressed = () => {
      let down = false;
      for (const gp of navigator.getGamepads?.() ?? []) if (gp?.buttons[9]?.pressed) down = true;
      const edge = down && !prevStart;
      prevStart = down;
      return edge;
    };

    frame = (dt) => {
      const { intent } = input.read();
      const start = startPressed();
      if (paused) {
        tapLatch = false;
        if (start) setPaused(false);
        else menuNav(dt);
        view.draw(run, 0);
        return;
      }
      if (start && overT < 0) { setPaused(true); view.draw(run, 0); return; }
      const held = intent.shootHeld || pointerId !== null || tapLatch;
      tapLatch = false;
      const pressed = held && !prevHeld;
      prevHeld = held;
      for (const ev of run.step(dt, { pressed, held })) handle(ev);
      view.draw(run, dt);
      hud();
      if (overT >= 0) {
        overT += dt;
        if (overT >= RESULTS_DELAY) { renderResults(run); crownAll(root); }
      }
    };
    hud();
    view.draw(run, 0);

    stepCleanup = () => {
      view.destroy();
      shootBtn?.removeEventListener('pointerdown', onTap);
      input.destroy(); // also removes the touch overlay
      try { audio.stopCrowd(); } catch { /* silent */ }
      window.removeEventListener('keydown', onPlayKey);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('blur', onBlur);
      document.removeEventListener('visibilitychange', onVis);
    };
  }

  // ---------- step 4: results ----------
  function renderResults(run: ContestRun) {
    stepCleanup?.();
    stepCleanup = null;
    frame = null;
    step = 'results';
    const m = run.s.shooter;
    const sum = summarize(run.s);
    const before = loadBest();
    // Saved before anything renders, so a reload on this screen keeps it.
    const isNew = saveIfBest(sum.score, m.dex, m.name);
    const best = loadBest();
    const rackRows = SPOTS.map((sp) => {
      const balls = run.s.results.filter((b) => b.rack === sp.rack);
      const pts = balls.reduce((n, b) => n + b.points, 0);
      const cells = Array.from({ length: BALLS_PER_RACK }, (_, i) => {
        const b = balls[i];
        const money = sp.rack === run.s.moneyRack || i === BALLS_PER_RACK - 1;
        return `<i class="${money ? 'money' : ''} ${b ? (b.result === 'make' ? 'made' : 'miss') : ''}"></i>`;
      }).join('');
      return `<li class="${sp.rack === run.s.moneyRack ? 'money-rack' : ''}"><span>${sp.label}${sp.rack === run.s.moneyRack ? ' <em>Money</em>' : ''}</span><span class="tp-dots">${cells}</span><b>${pts}</b></li>`;
    }).join('');
    window.scrollTo(0, 0);
    root.innerHTML = `
      <div class="threept tp-results">
        <h1>3-Point Contest</h1>
        <div class="tp-big" aria-label="Score ${sum.score} of ${MAX_SCORE}"><b>${sum.score}</b><span>/ ${MAX_SCORE}</span></div>
        ${isNew ? '<p class="tp-new">New high score!</p>' : ''}
        <ul class="tp-stats">
          <li><small>Makes</small><b>${sum.makes}/${TOTAL_BALLS}</b></li>
          <li><small>Money balls</small><b>${sum.moneyMakes}</b></li>
          ${sum.finishedEarly ? `<li><small>Time left</small><b>${sum.timeLeft.toFixed(1)}s</b></li>` : `<li><small>Shot</small><b>${sum.attempts}/${TOTAL_BALLS}</b></li>`}
        </ul>
        <div class="tp-resrow">
          <div class="tp-shooter">
            <img src="${spriteUrl(m.dex)}" alt="" width="56" height="56"${isKingKabuto(m) ? ' data-king' : ''}>
            <span><b>${nameHtml(m)}</b><small>Sht ${m.r.sht} · OVR ${m.ovr}</small></span>
          </div>
          <p class="tp-best">${best ? `Personal best <b>${best.score}</b> · ${esc(best.name)}${isNew && before ? ` <small>(was ${before.score})</small>` : ''}` : 'No personal best yet: score a point to set one.'}</p>
        </div>
        <ol class="tp-racks">${rackRows}</ol>
        <div class="tp-actions">
          <button class="btn primary big" data-a="again">Play again</button>
          <button class="btn" data-a="shooter">New shooter</button>
          <button class="btn ghost" data-a="menu">Menu</button>
        </div>
      </div>`;
    root.querySelector('[data-a="again"]')!.addEventListener('click', () => go('play'));
    root.querySelector('[data-a="shooter"]')!.addEventListener('click', () => go('pick'));
    root.querySelector('[data-a="menu"]')!.addEventListener('click', leave);
    root.querySelector<HTMLElement>('[data-a="again"]')!.focus({ preventScroll: true });
    frame = padNav(() => root.querySelector('.tp-results'), leave);
  }

  go(step);
}
