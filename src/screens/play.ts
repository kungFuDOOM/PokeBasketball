import { Announcer, CLIPS } from '../game/announcer';
import type { Audio } from '../game/audio';
import { Game } from '../game/game';
import { Hud } from '../game/hud';
import { Input } from '../game/input';
import { Renderer } from '../game/render';
import { preload } from '../game/sprites';
import type { GameConfig, Player } from '../game/types';
import { spriteUrl } from '../data/pokemon';
import { esc } from '../util';
import { Voice, sharedVoice } from '../game/voice';
import { controlsHtml } from './menu';

const STEP = 1 / 60;
/** Dev aid: ?speed=4 runs the simulation four times faster. */
const SPEED = Math.max(1, Math.min(8, Number(new URLSearchParams(location.search).get('speed')) || 1));

export interface PlayHandle {
  stop(): void;
}

export function playGame(
  root: HTMLElement,
  cfg: GameConfig,
  audio: Audio,
  onFinal: (g: Game) => void,
  onQuit: () => void,
  opts: { onAutoSubs?: (on: boolean) => void } = {},
): PlayHandle {
  root.innerHTML = `
    <div class="game">
      <div class="stage"><canvas class="court" aria-label="Basketball court"></canvas></div>
      <button class="icon-btn pause-btn" aria-label="Pause">II</button>
      <div class="pause-menu" hidden>
        <div class="panel">
          <h2>PAUSED</h2>
          <div class="pause-actions">
            <button class="btn primary" data-a="resume">Resume</button>
            <button class="btn" data-a="mute"></button>
            <button class="btn" data-a="announcer"></button>
            <button class="btn ghost" data-a="quit">Quit to menu</button>
          </div>
          <div class="subs-panel" hidden></div>
          ${controlsHtml()}
        </div>
      </div>
      <div class="loading">Warming up…</div>
    </div>`;
  const gameEl = root.querySelector<HTMLElement>('.game')!;
  const canvas = root.querySelector<HTMLCanvasElement>('canvas')!;
  const pauseMenu = root.querySelector<HTMLElement>('.pause-menu')!;
  const muteBtn = pauseMenu.querySelector<HTMLButtonElement>('[data-a="mute"]')!;
  const annBtn = pauseMenu.querySelector<HTMLButtonElement>('[data-a="announcer"]')!;
  const loading = root.querySelector<HTMLElement>('.loading')!;

  const g = new Game(cfg);
  const renderer = new Renderer(canvas);
  const hud = new Hud(gameEl, g);
  const input = new Input();
  const touch = window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
  if (touch) {
    input.attachTouch(gameEl);
    gameEl.classList.add('has-touch');
  }

  // Arena announcer: display only (never touches the sim). His clips load in the background now that audio is unlocked.
  const announcer = new Announcer();
  const voice = sharedVoice(audio);
  voice.load(CLIPS);

  let running = true;
  let ready = false;
  let raf = 0;
  let last = performance.now();
  let acc = 0;
  let finalT = -1;
  let pend = { shoot: false, pass: false, swap: false, steal: false, special: false };

  const setMuteLabel = () => {
    muteBtn.textContent = audio.muted ? 'Sound: off' : 'Sound: on';
    annBtn.textContent = voice.on ? 'Announcer: on' : 'Announcer: off';
  };
  setMuteLabel();
  // ---- substitutions (franchise games with a bench) ----
  const subsPanel = pauseMenu.querySelector<HTMLElement>('.subs-panel')!;
  const hasBench = !!cfg.stamina && cfg.home.human && (cfg.home.bench?.length ?? 0) > 0;
  let picked: Player | null = null;
  const renderSubs = () => {
    if (!hasBench) return;
    subsPanel.hidden = false;
    const pendingFor = (p: Player) => g.pendingSubs.find((s) => s.out === p || s.in === p);
    const row = (p: Player) => {
      const pend = pendingFor(p);
      const note = p.hurt ? `<em>hurt · out ${p.hurt} wk, comes out at the next dead ball</em>` : pend ? `<em>${pend.out === p ? 'out' : 'in'} at next dead ball</em>` : '';
      return `<li><button class="sub-row ${picked === p ? 'sel' : ''} ${pend ? 'pend' : ''}" data-pid="${p.id}">
        <img src="${spriteUrl(p.mon.dex)}" alt="">
        <span class="nm">${esc(p.mon.name)}<small>${p.mon.pos} · ${p.mon.ovr} · STA ${p.stamina}</small>${note}</span>
        <i class="en ${p.energy < 0.5 ? 'low' : ''}" style="--v:${Math.round(p.energy * 100)}%" title="Energy ${Math.round(p.energy * 100)}%"></i>
      </button></li>`;
    };
    const auto = g.cfg.userAutoSubs !== false;
    subsPanel.innerHTML = `
      <div class="subs-head">
        <h3>Substitutions</h3>
        <button class="btn small" data-a="autosubs">${auto ? 'Auto subs: on' : 'Auto subs: off'}</button>
      </div>
      <p class="note">${picked ? `Now pick who ${g.players.includes(picked) ? 'comes in for' : 'goes out for'} ${esc(picked.mon.name)}.` : 'Tap a player on the floor, then a bench player. Subs check in at the next dead ball.'}${auto ? ' The coach also rotates for you; turn auto subs off to run it yourself.' : ''}</p>
      <div class="subs-cols">
        <div><h4>On the floor</h4><ul>${g.teamPlayers(0).sort((a, b) => a.slot - b.slot).map(row).join('')}</ul></div>
        <div><h4>Bench</h4><ul>${g.bench.filter((p) => p.team === 0).sort((a, b) => a.rotation - b.rotation).map(row).join('')}</ul></div>
      </div>`;
  };
  subsPanel.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('[data-a="autosubs"]')) {
      g.cfg.userAutoSubs = g.cfg.userAutoSubs === false;
      opts.onAutoSubs?.(g.cfg.userAutoSubs);
      renderSubs();
      return;
    }
    const id = Number(t.closest<HTMLElement>('[data-pid]')?.dataset.pid);
    const p = [...g.players, ...g.bench].find((x) => x.id === id);
    if (!p) return;
    if (g.pendingSubs.some((s) => s.out === p || s.in === p)) {
      g.cancelSub(p);
      picked = null;
    } else if (!picked || picked === p) {
      picked = picked === p ? null : p;
    } else {
      const onFloor = g.players.includes(p);
      if (onFloor === g.players.includes(picked)) picked = p;
      else {
        g.requestSub(onFloor ? p : picked, onFloor ? picked : p);
        picked = null;
      }
    }
    renderSubs();
  });

  const setPaused = (p: boolean) => {
    g.paused = p;
    pauseMenu.hidden = !p;
    input.enabled = !p;
    if (p) {
      picked = null;
      renderSubs();
    }
  };
  root.querySelector('.pause-btn')!.addEventListener('click', () => setPaused(!g.paused));
  pauseMenu.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('[data-a]')?.dataset.a;
    if (a === 'resume') setPaused(false);
    if (a === 'mute') { audio.setMuted(!audio.muted); if (audio.muted) voice.stop(); setMuteLabel(); }
    if (a === 'announcer') { voice.setOn(!voice.on); setMuteLabel(); }
    if (a === 'quit') { stop(); onQuit(); }
  });
  const onKey = (e: KeyboardEvent) => {
    if (g.paused && (e.code === 'Escape' || e.code === 'KeyP')) setPaused(false);
  };
  window.addEventListener('keydown', onKey);
  const onVis = () => { if (document.hidden && g.phase !== 'final') setPaused(true); };
  document.addEventListener('visibilitychange', onVis);

  void preload([...cfg.home.roster, ...cfg.away.roster, ...(cfg.home.bench ?? []), ...(cfg.away.bench ?? [])]).then(() => {
    ready = true;
    loading.remove();
    audio.startCrowd();
  });

  const frame = (now: number) => {
    if (!running) return;
    // rAF timestamps can be a hair earlier than the performance.now() taken at start; never go negative.
    const dt = Math.max(0, Math.min(0.1, (now - last) / 1000));
    last = now;
    if (ready) {
      const { intent, pause } = input.read();
      if (pause && g.phase !== 'final') setPaused(!g.paused);
      // Edge-triggered buttons are held until one sim step consumes them.
      pend.shoot ||= intent.shoot;
      pend.pass ||= intent.pass;
      pend.swap ||= intent.swap;
      pend.steal ||= intent.steal;
      pend.special ||= intent.special;
      acc += dt * SPEED;
      while (acc >= STEP) {
        g.userInput = { ...intent, ...pend };
        g.update(STEP);
        pend = { shoot: false, pass: false, swap: false, steal: false, special: false };
        acc -= STEP;
      }
      const events = g.events.splice(0);
      hud.handle(events);
      renderer.handle(events, g);
      const sfx = g.sfx.splice(0);
      for (const s of sfx) audio.play(s);
      // A call that lands with a horn (end of a quarter, shot clock) waits for the horn to finish.
      const hold = Voice.hornDelay(sfx);
      const line = announcer.next(events, g.time, (c) => hold + voice.length(c));
      if (line) {
        voice.load(CLIPS); // in case the first tap came after the game started
        voice.say(line.clip, hold);
      }
      const u = g.user;
      input.setContext(!!u && g.ball.owner === u, !!u && u.special >= 1);
      if (g.phase === 'final') {
        if (finalT < 0) finalT = 3;
        finalT -= dt;
        if (finalT <= 0) {
          stop();
          onFinal(g);
          return;
        }
      }
    }
    renderer.draw(g, g.paused ? 0 : dt);
    hud.update(g.paused ? 0 : dt);
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);

  function stop() {
    running = false;
    cancelAnimationFrame(raf);
    input.destroy();
    audio.stopCrowd();
    voice.stop();
    window.removeEventListener('keydown', onKey);
    document.removeEventListener('visibilitychange', onVis);
  }
  return { stop };
}
