// "Play of the Game": after the final buzzer, the best moment replays on the court before the results screen.
// A title card names the player and the play while the announcer introduces it. Then the clip runs like a TV replay:
// the camera pushes in and follows the play through the build-up (the steal, the break, the pass), the action eases
// into deep slow motion, freezes for a beat on the moment itself with a punch-in, and eases back out. The popups and
// announcer call it again. Any button skips it. The results screen can play it again (watchAgain), from the same
// recording.
import { Announcer, CLIPS } from '../game/announcer';
import type { Audio } from '../game/audio';
import { Voice } from '../game/voice';
import type { Game } from '../game/game';
import { Hud } from '../game/hud';
import { Renderer, VH, VW } from '../game/render';
import type { Highlight, ReplayClip, ReplayRecorder } from '../game/replay';
import { TICK } from '../game/sync';
import { esc } from '../util';

/** Seconds the title card holds before the clip rolls (longer if the announcer's intro is), and the hold and fade at the end. */
const CARD = 1.7;
const HOLD = 0.9;
const FADE = 0.45;

// Slow motion, in ticks relative to the moment: full speed until EASE_IN_FROM, easing down to SLOW by SLOW_FROM,
// held through SLOW_UNTIL, then easing back up to full speed by EASE_OUT_BY. A freeze of FREEZE seconds on the moment.
const EASE_IN_FROM = -100;
const SLOW_FROM = -66;
const SLOW_UNTIL = 20;
const EASE_OUT_BY = 48;
const SLOW = 0.22;
const FREEZE = 0.35;

// The camera: how far it pushes in while following the build-up, at the moment, and as the play winds down.
// On a phone the scoreboard, name tag and letterbox cover more of a small court, so it keeps more of the play in
// frame (COMPACT); a big screen goes tighter.
const ZOOM = {
  wide: { follow: 1.35, moment: 2.15, after: 1.6 },
  compact: { follow: 1.22, moment: 1.8, after: 1.4 },
};
type ZoomSet = typeof ZOOM.wide;
/** Stages narrower than this (CSS px) use the compact camera. */
const COMPACT_BELOW = 760;
/** An extra kick of zoom right on the moment, decaying over this many seconds. */
const PUNCH = 0.22;
const PUNCH_DECAY = 0.4;

export interface PlayOfTheGame {
  /** Advance by wall-clock `dt`; returns false once it's over. */
  frame(dt: number): boolean;
  skip(): void;
}

let lastIntro = '';

/** The announcer's intro: "Here's the play of the game!" or "PLAY OF THE GAME!", or "Let's see that one again…" on a rewatch. */
function introLine(again: boolean): string {
  if (again) return 'potg_3';
  const pick = ['potg_1', 'potg_2'].filter((c) => c !== lastIntro);
  lastIntro = pick[Math.floor(Math.random() * pick.length)];
  return lastIntro;
}

const smooth = (a: number, b: number, x: number) => { const k = Math.max(0, Math.min(1, (x - a) / (b - a))); return k * k * (3 - 2 * k); };

/** Playback speed at a tick: eases into deep slow motion around the moment and back out. */
export function speedAt(rel: number): number {
  if (rel < SLOW_FROM) return 1 - (1 - SLOW) * smooth(EASE_IN_FROM, SLOW_FROM, rel);
  if (rel <= SLOW_UNTIL) return SLOW;
  return SLOW + (1 - SLOW) * smooth(SLOW_UNTIL, EASE_OUT_BY, rel);
}

/** How far the camera is pushed in at a tick (before any punch). */
export function zoomAt(rel: number, z: ZoomSet = ZOOM.wide): number {
  if (rel < 0) return z.follow + (z.moment - z.follow) * smooth(SLOW_FROM - 20, -6, rel);
  return z.moment + (z.after - z.moment) * smooth(SLOW_UNTIL, EASE_OUT_BY + 30, rel);
}

/** The camera for this screen: compact on phones (small stage), wide on bigger screens. */
export function zoomFor(stageWidth: number): ZoomSet {
  return stageWidth > 0 && stageWidth < COMPACT_BELOW ? ZOOM.compact : ZOOM.wide;
}

export function playOfTheGame(gameEl: HTMLElement, canvas: HTMLCanvasElement, clip: ReplayClip, h: Highlight, teamName: string,
  audio: Audio, voice: Voice, opts: { again?: boolean } = {}): PlayOfTheGame {
  const g = clip.game;
  const renderer = new Renderer(canvas);
  renderer.snap(g);
  renderer.showUser = false;
  // The stage (not the zoomed canvas) tells phone from desktop.
  const zoom = () => zoomFor((canvas.parentElement ?? canvas).getBoundingClientRect().width);
  const hud = new Hud(gameEl, g, { intro: false });
  hud.el.classList.add('potg-hud');
  const announcer = new Announcer();
  voice.load(CLIPS);
  const el = document.createElement('div');
  el.className = 'potg';
  el.innerHTML = `
    <div class="potg-bar top"></div><div class="potg-bar bottom"></div>
    <div class="potg-tag"><i></i>REPLAY</div>
    <div class="potg-card">
      <small>PLAY OF THE GAME</small>
      <strong>${esc(h.name)}</strong>
      <span>${esc(h.title)} · ${esc(teamName.toUpperCase())}</span>
    </div>
    <button class="potg-skip" type="button">Skip ▸</button>
    <div class="potg-flash"></div>
    <div class="potg-fade"></div>`;
  // The overlay sits on the court itself (the 16:9 stage), so on a phone with side bars it frames the play, not the screen.
  (canvas.parentElement ?? gameEl).appendChild(el);
  gameEl.classList.add('potg-on');
  const fade = el.querySelector<HTMLElement>('.potg-fade')!;
  const flash = el.querySelector<HTMLElement>('.potg-flash')!;
  const intro = introLine(!!opts.again);
  const card = Math.max(CARD, voice.length(intro) + 0.2);
  voice.say(intro);
  let t = 0;
  let acc = 0;
  let endT = -1;
  let over = false;
  let frozen = 0;
  let froze = false;
  let punch = 0;
  // Camera: zoom and the canvas point (480×270 space) it's centred on, eased toward their targets every frame.
  const cam = { zoom: 1, x: VW / 2, y: VH / 2 };
  const finish = () => {
    if (over) return;
    over = true;
    el.remove();
    hud.el.remove();
    canvas.style.transform = '';
    gameEl.classList.remove('potg-on');
  };
  el.querySelector('.potg-skip')!.addEventListener('click', (e) => { e.stopPropagation(); finish(); });
  requestAnimationFrame(() => el.classList.add('in'));

  /** What the camera looks at: the player making the play, pulled toward the ball, a little above the floor. */
  const focus = () => {
    const p = [...g.players, ...g.bench].find((q) => q.id === h.playerId);
    const b = g.ball;
    const ball = renderer.screenOf(b.x, b.y, b.z);
    if (!p) return ball;
    const me = renderer.screenOf(p.x, p.y, p.z + 3);
    // On the player while they have it; once it's in the air (a shot, a pass), follow the ball to the rim.
    const k = b.owner === p ? 0.3 : clip.tick < clip.moment ? 0.7 : 0.8;
    return { x: me.x + (ball.x - me.x) * k, y: me.y + (ball.y - me.y) * k };
  };

  const placeCamera = (dt: number) => {
    const rel = clip.tick - clip.moment;
    const rolling = t >= card;
    const z = zoom();
    const want = (rolling ? zoomAt(rel, z) : 1 + (z.follow - 1) * smooth(0, card, t) * 0.35) + punch;
    const f = focus();
    const ease = 1 - Math.exp(-dt * (rel > -20 && rel < 10 ? 7 : 3.5));
    cam.zoom += (want - cam.zoom) * ease;
    cam.x += (f.x - cam.x) * ease;
    cam.y += (f.y - cam.y) * ease;
    // Never show past the canvas edges.
    const hw = VW / (2 * cam.zoom);
    const hh = VH / (2 * cam.zoom);
    const x = Math.max(hw, Math.min(VW - hw, cam.x));
    const y = Math.max(hh, Math.min(VH - hh, cam.y));
    canvas.style.transform = `scale(${cam.zoom.toFixed(4)}) translate(${((0.5 - x / VW) * 100).toFixed(3)}%, ${((0.5 - y / VH) * 100).toFixed(3)}%)`;
  };

  return {
    skip: finish,
    frame(dt: number) {
      if (over) return false;
      t += dt;
      let simDt = 0;
      punch = Math.max(0, punch - (PUNCH / PUNCH_DECAY) * dt);
      if (t >= card && !clip.done) {
        el.classList.add('rolling');
        const rel = clip.tick - clip.moment;
        const speed = speedAt(rel);
        el.classList.toggle('slow', speed < 0.6);
        if (frozen > 0) {
          frozen -= dt;
        } else {
          acc += dt * speed;
          while (acc >= TICK && !clip.done) {
            clip.step();
            acc -= TICK;
            simDt += TICK;
            // The moment: hold the frame for a beat, flash, and punch in.
            if (!froze && clip.tick >= clip.moment) {
              froze = true;
              frozen = FREEZE;
              punch = PUNCH;
              acc = 0;
              flash.classList.remove('go');
              void flash.offsetWidth;
              flash.classList.add('go');
              break;
            }
          }
        }
        const events = g.events.splice(0);
        hud.handle(events);
        renderer.handle(events, g);
        const sfx = g.sfx.splice(0);
        for (const s of sfx) audio.play(s);
        // A call that lands with a horn waits for it, as in the game.
        const hold = Voice.hornDelay(sfx);
        const line = announcer.next(events, g.time, (c) => hold + voice.length(c));
        if (line) voice.say(line.clip, hold);
      }
      if (clip.done && endT < 0) endT = t;
      if (endT >= 0) {
        const k = (t - endT - HOLD) / FADE;
        fade.style.opacity = String(Math.max(0, Math.min(1, k)));
        if (k >= 1) { finish(); return false; }
      }
      // Slow motion slows the renderer's own animation (running legs, effects) to match.
      renderer.draw(g, simDt || (t < card || frozen > 0 ? 0 : dt * 0.2));
      hud.update(simDt);
      placeCamera(dt);
      return true;
    },
  };
}

// ---- Watch again (results screen) ----

interface Saved { rec: ReplayRecorder; best: Highlight; teamName: string; audio: Audio; voice: Voice }
const saved = new WeakMap<Game, Saved>();

/** The play screen keeps the recording with the finished game, so the results screen can replay it. */
export function rememberReplay(g: Game, s: Saved) {
  saved.set(g, s);
}

/** The play of a finished game, if there's one to watch: who and what. */
export function replayOf(g: Game): Highlight | null {
  return saved.get(g)?.best ?? null;
}

/** Play it again, full screen over the results; any button or Skip closes it. */
export function watchAgain(g: Game) {
  const s = saved.get(g);
  const clip = s && s.rec.clip(s.best);
  if (!s || !clip) return;
  const modal = document.createElement('div');
  modal.className = 'game potg-modal';
  modal.innerHTML = '<div class="stage"><canvas class="court" aria-label="Replay"></canvas></div>';
  document.body.appendChild(modal);
  const p = playOfTheGame(modal, modal.querySelector('canvas')!, clip, s.best, s.teamName, s.audio, s.voice, { again: true });
  const onKey = (e: KeyboardEvent) => {
    if (['Escape', 'Space', 'Enter', 'KeyJ', 'KeyK', 'KeyP'].includes(e.code)) { e.preventDefault(); p.skip(); }
  };
  window.addEventListener('keydown', onKey);
  let last = performance.now();
  const tick = (now: number) => {
    const dt = Math.max(0, Math.min(0.1, (now - last) / 1000));
    last = now;
    if (p.frame(dt)) { requestAnimationFrame(tick); return; }
    window.removeEventListener('keydown', onKey);
    modal.remove();
  };
  requestAnimationFrame(tick);
}
