import { Announcer, CLIPS } from '../game/announcer';
import type { Audio } from '../game/audio';
import { Game } from '../game/game';
import { Hud } from '../game/hud';
import { ReplayRecorder } from '../game/replay';
import { Input } from '../game/input';
import { Renderer } from '../game/render';
import { preload } from '../game/sprites';
import { emptyIntent, type GameConfig, type GameEvent, type Intent, type Player, type TeamId } from '../game/types';
import { spriteUrl } from '../data/pokemon';
import { esc } from '../util';
import { Voice, sharedVoice } from '../game/voice';
import { controlsHtml } from './menu';
import { playOfTheGame, rememberReplay, type PlayOfTheGame } from './potg';
import { nextSpeed, stepHeadless } from './watch';
import { startingFive, type StartingFive } from './startingFive';

const STEP = 1 / 60;
/** Dev aid: ?speed=4 runs the simulation four times faster. */
const SPEED = Math.max(1, Math.min(8, Number(new URLSearchParams(location.search).get('speed')) || 1));
/** Dev aid: ?intro=0 skips the starting-five intro (dev builds only). */
const INTRO = !(import.meta.env.DEV && new URLSearchParams(location.search).get('intro') === '0');

export interface PlayHandle {
  stop(): void;
}

/**
 * Online games: the driver owns the simulation clock (lockstep, see src/multiplayer/shared/lockstep.ts).
 * The screen hands it the local input every frame; it steps the game when both players' inputs are in.
 * Online games never pause, since the other player's game keeps going.
 */
export interface OnlineDriver {
  /** The team this player controls (the guest plays the away team). */
  viewTeam: TeamId;
  start(g: Game): void;
  /** Returns how many times the input was sampled (edge-triggered buttons are consumed then). */
  advance(intent: Intent, dt: number): number;
  /** A banner such as "Waiting for opponent…", or null. */
  status(): string | null;
  /** Round-trip time to the other player in ms, or null while unknown (shown as a small meter). */
  ping?(): number | null;
  /** Called every frame before tip-off (loading, then the starting-five intro), to keep the link to the other player alive. */
  idle?(): void;
}

export function playGame(
  root: HTMLElement,
  cfg: GameConfig,
  audio: Audio,
  onFinal: (g: Game) => void,
  onQuit: () => void,
  /**
   * startingFive: play the starting-five intro on the court before tip-off (see startingFiveEnabled).
   * record: false skips the replay recorder (no Play of the Game), e.g. for the tutorial.
   * onFrame: read-only per-frame hook after the sim steps (the tutorial's prompt strip); dt is 0 while paused.
   */
  opts: {
    onAutoSubs?: (on: boolean) => void;
    online?: OnlineDriver;
    spectator?: boolean;
    startingFive?: boolean;
    record?: boolean;
    onFrame?: (g: Game, events: readonly GameEvent[], intent: Intent, dt: number) => void;
  } = {},
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
          ${opts.spectator ? '' : controlsHtml()}
        </div>
      </div>
      <div class="loading">Warming up…</div>
      <div class="net-status" hidden></div>
      <div class="net-ping" hidden></div>
      ${opts.spectator ? '<div class="spec-bar"><button class="spec-btn" data-a="speed" aria-label="Playback speed">1x</button><button class="spec-btn" data-a="skip" aria-label="Skip to result">Skip<span class="spec-long"> to result</span></button></div>' : ''}
    </div>`;
  const gameEl = root.querySelector<HTMLElement>('.game')!;
  const canvas = root.querySelector<HTMLCanvasElement>('canvas')!;
  const pauseMenu = root.querySelector<HTMLElement>('.pause-menu')!;
  const muteBtn = pauseMenu.querySelector<HTMLButtonElement>('[data-a="mute"]')!;
  const annBtn = pauseMenu.querySelector<HTMLButtonElement>('[data-a="announcer"]')!;
  const loading = root.querySelector<HTMLElement>('.loading')!;

  const g = new Game(cfg);
  const online = opts.online;
  const netStatus = root.querySelector<HTMLElement>('.net-status')!;
  const netPing = root.querySelector<HTMLElement>('.net-ping')!;
  let pingShown = '';
  if (online) {
    g.viewTeam = online.viewTeam;
    online.start(g);
  }
  const renderer = new Renderer(canvas);
  const hud = new Hud(gameEl, g);
  // Play of the Game: offline games are recorded so the best moment can be replayed after the final buzzer.
  const spectator = !!opts.spectator && !online;
  gameEl.classList.toggle('spectator', spectator);
  const rec = online || spectator || opts.record === false ? null : new ReplayRecorder(cfg, g.seed);
  let potg: PlayOfTheGame | null = null;
  let intro: StartingFive | null = null;
  const input = new Input();
  const touch = window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
  if (touch && !spectator) {
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
  let speed = SPEED;
  let skipping = false;
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
      rec?.autoSubs(g.cfg.userAutoSubs);
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
        const [out, inn] = onFloor ? [p, picked] : [picked, p];
        if (g.requestSub(out, inn)) rec?.sub(out, inn);
        picked = null;
      }
    }
    renderSubs();
  });

  const speedBtn = root.querySelector<HTMLButtonElement>('[data-a="speed"]');
  speedBtn?.addEventListener('click', () => {
    speed = nextSpeed(speed);
    speedBtn.textContent = `${speed}x`;
  });
  root.querySelector('.spec-bar [data-a="skip"]')?.addEventListener('click', () => {
    if (g.phase === 'final') return;
    skipping = true;
    setPaused(false);
    loading.textContent = 'Finishing the game…';
    gameEl.appendChild(loading);
  });

  const menuOpen = () => !pauseMenu.hidden;
  const setPaused = (p: boolean) => {
    g.paused = p && !online; // an online game keeps running behind the menu
    pauseMenu.hidden = !p;
    input.enabled = !p;
    if (p) {
      picked = null;
      renderSubs();
    }
  };
  root.querySelector('.pause-btn')!.addEventListener('click', () => setPaused(!menuOpen()));
  pauseMenu.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('[data-a]')?.dataset.a;
    if (a === 'resume') setPaused(false);
    if (a === 'mute') { audio.setMuted(!audio.muted); if (audio.muted) voice.stop(); setMuteLabel(); }
    if (a === 'announcer') { voice.setOn(!voice.on); setMuteLabel(); }
    if (a === 'quit') { stop(); onQuit(); }
  });
  const onKey = (e: KeyboardEvent) => {
    if (menuOpen() && (e.code === 'Escape' || e.code === 'KeyP')) setPaused(false);
  };
  window.addEventListener('keydown', onKey);
  const onVis = () => { if (document.hidden && g.phase !== 'final' && !online) setPaused(true); };
  document.addEventListener('visibilitychange', onVis);

  void preload([...cfg.home.roster, ...cfg.away.roster, ...(cfg.home.bench ?? []), ...(cfg.away.bench ?? [])]).then(() => {
    ready = true;
    loading.remove();
    audio.startCrowd();
    if (!INTRO || !running || !opts.startingFive) return;
    // Your starting five, before tip-off. Offline you can skip it; online both players watch it and tip off together.
    const mine: TeamId | null = online ? online.viewTeam : cfg.home.human !== cfg.away.human ? (cfg.home.human ? 0 : 1) : null;
    intro = startingFive(gameEl, g, { audio, voice, mine, skippable: !online });
    hud.el.hidden = true;
  });

  const frame = (now: number) => {
    if (!running) return;
    // rAF timestamps can be a hair earlier than the performance.now() taken at start; never go negative.
    const dt = Math.max(0, Math.min(0.1, (now - last) / 1000));
    last = now;
    if (potg) {
      // The replay: any button skips it; then the results.
      const { intent, pause } = input.read();
      if (pause || intent.shoot || intent.pass) potg.skip();
      if (!potg.frame(dt)) {
        stop();
        onFinal(g);
        return;
      }
      raf = requestAnimationFrame(frame);
      return;
    }
    if (intro) {
      const { intent, pause } = input.read();
      if (pause || intent.shoot || intent.pass) intro.skip();
      online?.idle?.();
      // Offline, the pause menu holds the intro too.
      if (!(menuOpen() && !online) && !intro.frame(dt)) {
        intro = null;
        hud.el.hidden = false;
      }
      renderer.draw(g, dt);
      raf = requestAnimationFrame(frame);
      return;
    }
    if (!ready) online?.idle?.();
    if (ready) {
      const read = input.read();
      const pause = read.pause;
      // Spectators have no player: nothing they press reaches the game.
      const intent = spectator ? emptyIntent() : read.intent;
      if (pause && g.phase !== 'final' && !skipping) setPaused(!menuOpen());
      // Edge-triggered buttons are held until one sim step consumes them.
      pend.shoot ||= intent.shoot;
      pend.pass ||= intent.pass;
      pend.swap ||= intent.swap;
      pend.steal ||= intent.steal;
      pend.special ||= intent.special;
      if (online) {
        if (online.advance({ ...intent, ...pend }, dt) > 0) pend = { shoot: false, pass: false, swap: false, steal: false, special: false };
        const st = online.status();
        netStatus.hidden = !st;
        if (st) netStatus.textContent = st;
        const ms = online.ping?.() ?? null;
        const shown = ms === null ? '' : `${Math.round(ms)} ms`;
        if (shown !== pingShown) {
          pingShown = shown;
          netPing.hidden = !shown;
          netPing.textContent = shown;
          netPing.dataset.q = ms === null ? '' : pingQuality(ms);
        }
      } else if (skipping) {
        // Skip to result: same tick function, no rendering, a slice of each frame at a time.
        const t0 = performance.now();
        while (g.phase !== 'final' && performance.now() - t0 < 12) stepHeadless(g, 120);
        if (g.phase === 'final') {
          stop();
          onFinal(g);
          return;
        }
      } else {
        acc += dt * speed;
        while (acc >= STEP) {
          const want = { ...intent, ...pend };
          g.userInput = rec ? rec.before(g, want) : want;
          const n = g.events.length;
          g.update(STEP);
          rec?.after(g, g.events.slice(n));
          pend = { shoot: false, pass: false, swap: false, steal: false, special: false };
          acc -= STEP;
        }
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
      opts.onFrame?.(g, events, intent, g.paused ? 0 : dt);
      const u = g.user;
      input.setContext(!!u && g.ball.owner === u, !!u && u.special >= 1);
      if (g.phase === 'final') {
        if (finalT < 0) finalT = 3;
        finalT -= dt;
        if (finalT <= 0) {
          const best = rec?.best(g);
          const clip = best && rec!.clip(best);
          if (best && clip) {
            rememberReplay(g, { rec: rec!, best, teamName: g.teams[best.team].name, audio, voice });
            hud.el.hidden = true;
            root.querySelector<HTMLElement>('.pause-btn')!.hidden = true;
            potg = playOfTheGame(gameEl, canvas, clip, best, g.teams[best.team].name, audio, voice);
            raf = requestAnimationFrame(frame);
            return;
          }
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
    intro = null;
    gameEl.querySelector('.s5')?.remove();
    cancelAnimationFrame(raf);
    input.destroy();
    audio.stopCrowd();
    voice.stop();
    window.removeEventListener('keydown', onKey);
    document.removeEventListener('visibilitychange', onVis);
  }
  return { stop };
}

/** Colour band of the ping meter: good under 180 ms, fair to 300, poor above. */
export const pingQuality = (ms: number): 'good' | 'fair' | 'poor' => (ms < 180 ? 'good' : ms <= 300 ? 'fair' : 'poor');
