// Title-screen "attract mode": a muted CPU-vs-CPU game on the real engine, behind the menu.
// Cheap on purpose: ~30fps, the renderer's small canvas, paused while the tab is hidden, and torn
// down (rAF, listeners) the moment the menu leaves the page.
import { COURTS, courtFor } from '../data/courts';
import { POKEMON, type Mon } from '../data/pokemon';
import { LEAGUE, contrastAway } from '../franchise/league';
import { Game } from '../game/game';
import { Renderer } from '../game/render';
import { preload } from '../game/sprites';
import { cpuRoster } from '../season/team';
import { shuffle } from '../util';

export interface AttractState {
  venue: string;
  home: string;
  away: string;
  score: [number, number];
  /** "1ST 0:42" style. */
  clock: string;
}

export interface Attract {
  stop(): void;
}

const STEP = 1 / 60;
const FRAME_MS = 1000 / 30;
/** A game that hasn't ended this long after it began is replaced (a quarter of 45s is ~3 minutes). */
const MAX_GAME_MS = 4 * 60 * 1000;

const fmtClock = (g: Game) => {
  const t = Math.max(0, g.clock);
  const q = g.quarter > 4 ? 'OT' : ['1ST', '2ND', '3RD', '4TH'][g.quarter - 1];
  return g.phase === 'final' ? 'FINAL' : `${q} ${t < 10 ? t.toFixed(1) : `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`}`;
};

export function prefersStatic(): boolean {
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches || !!conn?.saveData;
}

function randomGame(): Game {
  const [a, b] = shuffle([...LEAGUE]).slice(0, 2);
  const pool: Mon[] = shuffle([...POKEMON]);
  const home = { name: a.name, abbr: a.abbr, color: a.color, color2: a.color2, roster: cpuRoster(pool, 5, a.types), human: false };
  const away = contrastAway(home, { name: b.name, abbr: b.abbr, color: b.color, color2: b.color2, roster: cpuRoster(pool, 5, b.types), human: false });
  return new Game({ home, away, quarterLen: 45, difficulty: 'allstar', court: COURTS[a.name] ?? courtFor(a) });
}

export function startAttract(canvas: HTMLCanvasElement, onState: (s: AttractState) => void): Attract {
  const renderer = new Renderer(canvas);
  let game: Game | null = null;
  let raf = 0;
  let stopped = false;
  let last = performance.now();
  let lastDraw = 0;
  let acc = 0;
  let startedAt = 0;
  let endedAt = 0;
  let lastKey = '';
  let loading = false;

  const next = () => {
    if (loading) return;
    loading = true;
    const g = randomGame();
    void preload([...g.cfg.home.roster, ...g.cfg.away.roster]).then(() => {
      loading = false;
      if (stopped) return;
      game = g;
      renderer.snap(g);
      startedAt = performance.now();
      endedAt = 0;
      acc = 0;
    });
  };

  const emit = () => {
    if (!game) return;
    const key = `${game.score[0]}-${game.score[1]} ${fmtClock(game)}`;
    if (key === lastKey) return;
    lastKey = key;
    onState({ venue: game.cfg.court?.venue ?? '', home: game.teams[0].abbr, away: game.teams[1].abbr, score: [game.score[0], game.score[1]], clock: fmtClock(game) });
  };

  const frame = (now: number) => {
    // The menu was replaced by another screen: shut everything down.
    if (stopped || !canvas.isConnected) return stop();
    raf = requestAnimationFrame(frame);
    if (now - lastDraw < FRAME_MS - 2) return;
    lastDraw = now;
    const dt = Math.max(0, Math.min(0.1, (now - last) / 1000));
    last = now;
    if (!game) return;
    acc += dt;
    while (acc >= STEP) {
      game.update(STEP);
      acc -= STEP;
    }
    renderer.handle(game.events.splice(0), game);
    game.sfx.length = 0;
    renderer.draw(game, dt);
    emit();
    if (game.phase === 'final') endedAt ||= now;
    if ((endedAt && now - endedAt > 5000) || now - startedAt > MAX_GAME_MS) {
      game = null;
      next();
    }
  };

  const onVis = () => {
    if (stopped) return;
    if (!canvas.isConnected) return stop();
    cancelAnimationFrame(raf);
    if (!document.hidden) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  };
  document.addEventListener('visibilitychange', onVis);

  function stop() {
    stopped = true;
    cancelAnimationFrame(raf);
    document.removeEventListener('visibilitychange', onVis);
    game = null;
  }

  next();
  raf = requestAnimationFrame(frame);
  return { stop };
}
