import type { Audio } from '../game/audio';
import { Game } from '../game/game';
import { Hud } from '../game/hud';
import { Input } from '../game/input';
import { Renderer } from '../game/render';
import { preload } from '../game/sprites';
import type { GameConfig } from '../game/types';
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
            <button class="btn ghost" data-a="quit">Quit to menu</button>
          </div>
          ${controlsHtml()}
        </div>
      </div>
      <div class="loading">Warming up…</div>
    </div>`;
  const gameEl = root.querySelector<HTMLElement>('.game')!;
  const canvas = root.querySelector<HTMLCanvasElement>('canvas')!;
  const pauseMenu = root.querySelector<HTMLElement>('.pause-menu')!;
  const muteBtn = pauseMenu.querySelector<HTMLButtonElement>('[data-a="mute"]')!;
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

  let running = true;
  let ready = false;
  let raf = 0;
  let last = performance.now();
  let acc = 0;
  let finalT = -1;
  let pend = { shoot: false, pass: false, swap: false, steal: false, special: false };

  const setMuteLabel = () => (muteBtn.textContent = audio.muted ? 'Sound: off' : 'Sound: on');
  setMuteLabel();
  const setPaused = (p: boolean) => {
    g.paused = p;
    pauseMenu.hidden = !p;
    input.enabled = !p;
  };
  root.querySelector('.pause-btn')!.addEventListener('click', () => setPaused(!g.paused));
  pauseMenu.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('[data-a]')?.dataset.a;
    if (a === 'resume') setPaused(false);
    if (a === 'mute') { audio.setMuted(!audio.muted); setMuteLabel(); }
    if (a === 'quit') { stop(); onQuit(); }
  });
  const onKey = (e: KeyboardEvent) => {
    if (g.paused && (e.code === 'Escape' || e.code === 'KeyP')) setPaused(false);
  };
  window.addEventListener('keydown', onKey);
  const onVis = () => { if (document.hidden && g.phase !== 'final') setPaused(true); };
  document.addEventListener('visibilitychange', onVis);

  void preload([...cfg.home.roster, ...cfg.away.roster]).then(() => {
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
      for (const s of g.sfx.splice(0)) audio.play(s);
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
    window.removeEventListener('keydown', onKey);
    document.removeEventListener('visibilitychange', onVis);
  }
  return { stop };
}
