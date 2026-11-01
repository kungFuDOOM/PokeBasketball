// Tutorial / Training: offline drills in a practice game against a passive CPU (GameConfig.practice), no replay/stats/telemetry.
// The drill runner (src/tutorial/runner.ts) drives it; each drill ends on a results card (score, stars, best stars).
// Best stars are saved locally; finishing, Exit or Quit marks the tutorial done (local only).
import { POKEMON, spriteUrl } from '../data/pokemon';
import { LEAGUE, USER_STYLE, contrastAway } from '../franchise/league';
import type { Audio } from '../game/audio';
import { movementSpot, reachedSpot } from '../game/practice';
import type { Game } from '../game/game';
import type { GameConfig, Marker, TeamDef } from '../game/types';
import { cpuRoster } from '../season/team';
import { coachMon, fitLine } from '../tutorial/coach';
import { getBestStars, markTutorialDone, recordDrillStars } from '../tutorial/store';
import { DRILL_IDS, coachLine, drill, goalFor, type DrillId, type InputKind, type Stars } from '../tutorial/drills';
import {
  currentDrill, startRun, startRunAll, step, timeLeft,
  type DrillOutcome, type MarkerRequest, type RunnerAction, type RunnerState, type RunnerStep,
} from '../tutorial/runner';
import { createWatcher } from '../tutorial/watcher';
import { abbr, esc, lettersName } from '../util';
import type { Settings } from './menu';
import { playGame, type PlayHandle } from './play';
import { starText } from './training';

export interface TutorialActions {
  menu(): void;
  /** Completion screen's "Play Quick Play"; falls back to the menu when not given. */
  quick?(): void;
  /** "Training menu" on the results/completion cards; falls back to the menu when not given. */
  training?(): void;
}

/** Short quarters so the practice game never drags. */
export const TUTORIAL_QUARTER = 90;
/** Fixed seed: every tutorial plays out the same way for the same inputs. */
export const TUTORIAL_SEED = 20261031;

/** Quarter length for drill games: the game clock stands still in a drill, this is only a backstop. */
export const DRILL_QUARTER = 600;

/**
 * The offline practice config: the user's team against Brock's gym on Rookie, with the CPU held back.
 * With `drill`, the game stages that training drill (src/game/practice.ts) instead of a free practice game.
 */
export function tutorialConfig(settings: Settings, drill?: DrillId): GameConfig {
  const pool = [...POKEMON].sort((a, b) => b.ovr - a.ovr);
  const mine = cpuRoster(pool, 5);
  const gym = LEAGUE[0];
  const theirs = cpuRoster(pool, 5, gym.types);
  const name = lettersName(settings.teamName) || 'Pallet Town';
  const home: TeamDef = { name, abbr: abbr(name), ...USER_STYLE, roster: mine, human: true };
  const away = contrastAway(home, {
    name: gym.name, abbr: gym.abbr, color: gym.color, color2: gym.color2,
    roster: theirs, human: false, boost: gym.boost, coach: gym.leader,
  });
  return {
    home,
    away,
    quarterLen: drill ? DRILL_QUARTER : TUTORIAL_QUARTER,
    difficulty: 'rookie',
    seed: TUTORIAL_SEED,
    stamina: false,
    autoSwitch: true,
    practice: true,
    ...(drill ? { drill } : {}),
  };
}

/** Resolves the drill runner's marker requests to floor markers in this game (cones, the pass lane, shot zones). */
export function drillMarkers(g: Game, reqs: readonly MarkerRequest[]): Marker[] {
  const u = g.teams[0].human ? 0 : 1;
  const out: Marker[] = [];
  for (const r of reqs) {
    if (r.kind === 'spot') {
      const s = movementSpot(r.index, u);
      if (s) out.push({ kind: 'spot', x: s.x, y: s.y });
    } else if (r.kind === 'zone') {
      out.push({ kind: 'zone', zone: r.zone, team: u });
    } else {
      // Pass lane: from the user's ball handler to the most open teammate.
      const me = g.ball.owner?.team === u ? g.ball.owner : null;
      if (!me) continue;
      const mates = g.teamPlayers(u).filter((p) => p !== me);
      const to = mates.reduce<typeof me | null>((a, b) => (!a || g.openness(b) > g.openness(a) ? b : a), null);
      if (to) out.push({ kind: 'lane', from: me.id, to: to.id });
    }
  }
  return out;
}

/** Same touch detection as playGame (it adds `.has-touch` on exactly this condition). */
export const tutorialInput = (): InputKind =>
  window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0 ? 'touch' : 'keys';

/** How long (seconds) a coach line (rep praise, tip) stays up before the drill goal comes back. */
export const PRAISE_S = 1.4;

/** What the tutorial screen opens on: one training drill, or "Run all" (the six in order). */
export type TutorialStart = DrillId | 'all';

export { starText };

/** The drill after `id` in the training order, or null after the last. */
export const nextDrillId = (id: DrillId): DrillId | null => DRILL_IDS[DRILL_IDS.indexOf(id) + 1] ?? null;

/**
 * The prompt strip: docked above the stage in its own flex row (`.game.tut-on`), so it shrinks the court instead of
 * covering it. Only its two buttons take pointer events; its right end stops short of the pause/music/X corner.
 * The coach (the user's top player, existing sprite art) sits at its left edge and "says" the short lines.
 */
function stripHtml(coach: { dex: number; name: string } | null): string {
  const face = coach
    ? `<img class="tut-coach" src="${spriteUrl(coach.dex)}" alt="" aria-hidden="true" draggable="false" title="Coach ${esc(coach.name)}">`
    : '';
  return `
    <div class="tut-strip" role="status" aria-live="polite">
      <div class="tut-text">${face}<div class="tut-lines"><b class="tut-step"></b><span class="tut-hint"></span></div></div>
      <div class="tut-acts">
        <button class="tut-btn" data-tut="skip">Skip drill</button>
        <button class="tut-btn ghost" data-tut="exit">Exit</button>
      </div>
      <i class="tut-prog" aria-hidden="true"></i>
    </div>`;
}

export interface ResultView {
  outcome: DrillOutcome;
  /** Best stars for this drill before this attempt was recorded. */
  prevBest: Stars;
  /** Best stars now (never lower than prevBest). */
  best: Stars;
  /** The coach's reaction line. */
  line: string;
  /** Label for the "Next" button, or null when there is no next drill (a single run of the last drill). */
  next: string | null;
}

/**
 * The results card after a drill: score, 1–3 star grade, best stars and Retry / Next drill / Training menu.
 * It sits below the prompt strip (never over it), so Skip and Exit keep working while it's up.
 */
export function resultHtml(v: ResultView): string {
  const { outcome: o } = v;
  const newBest = v.best > v.prevBest;
  return `
    <div class="tut-result" role="dialog" aria-labelledby="tut-res-h">
      <div class="panel">
        <h2 id="tut-res-h">${esc(drill(o.id).title)}</h2>
        <p class="tut-score">Score <b>${o.score}</b></p>
        <p class="tut-stars" role="img" aria-label="${o.stars} of 3 stars">${starText(o.stars)}</p>
        <p class="tut-best">Best <span aria-label="${v.best} of 3 stars">${starText(v.best)}</span>${newBest ? ' <b class="tut-new">New best!</b>' : ''}</p>
        <p class="tut-res-line">${esc(fitLine(v.line))}</p>
        <div class="tut-done-acts">
          ${v.next ? `<button class="btn primary" data-res="next">${esc(v.next)}</button>` : ''}
          <button class="btn${v.next ? '' : ' primary'}" data-res="retry">Retry</button>
          <button class="btn ghost" data-res="training">Training menu</button>
        </div>
      </div>
    </div>`;
}

/** Shown once a run is over: the game is stopped behind it. Lists each drill's stars from this run. */
function doneHtml(outcomes: readonly DrillOutcome[]): string {
  const rows = outcomes
    .map((o) => `<li><span>${esc(drill(o.id).title)}</span> <span aria-label="${o.stars} of 3 stars">${o.skipped ? 'skipped' : starText(o.stars)}</span></li>`)
    .join('');
  return `
    <div class="tut-done" role="dialog" aria-modal="true" aria-labelledby="tut-done-h">
      <div class="panel">
        <h2 id="tut-done-h">Nice work!</h2>
        ${rows ? `<ul class="tut-sum">${rows}</ul>` : ''}
        <p>Time for a real game.</p>
        <div class="tut-done-acts">
          <button class="btn primary big" data-tut="quick">Play Quick Play</button>
          <button class="btn" data-tut="training">Training menu</button>
          <button class="btn ghost" data-tut="menu">Back to menu</button>
        </div>
      </div>
    </div>`;
}

/** Enter/Space on a card button clicks it and never reaches the game's key handler (which swallows Space). */
function cardKeys(el: HTMLElement) {
  el.addEventListener('keydown', (e) => {
    const btn = (e.target as HTMLElement).closest('button');
    if (!btn || (e.code !== 'Enter' && e.code !== 'Space' && e.code !== 'NumpadEnter')) return;
    e.preventDefault();
    e.stopPropagation();
    btn.click();
  });
}

export function tutorialScreen(
  root: HTMLElement, settings: Settings, audio: Audio, act: TutorialActions, start: TutorialStart = 'all',
): PlayHandle {
  root.className = 'screen-game';
  window.scrollTo(0, 0);
  audio.unlock();
  const kind = tutorialInput();
  const watch = createWatcher();
  const first: DrillId = start === 'all' ? DRILL_IDS[0] : start;
  let rs!: RunnerState;
  let strip: HTMLElement | null = null;
  let gameEl: HTMLElement | null = null;
  let card: HTMLElement | null = null;
  let game: Game | null = null;
  let shown = '';
  let left = false;
  /** Marker requests from the runner; resolved against the live game every frame (the pass lane moves). */
  let markerReqs: MarkerRequest[] = [];
  /** The latest coach line and how long it has left on screen during play. */
  let coachText = '';
  let coachT = 0;
  /** Countdown digit (0 = GO) and how long GO! stays up. */
  let count = 0;
  let goT = 0;
  /** Set when a drill (re)starts: the game restages it on the next frame. */
  let restage = false;

  const toTraining = () => (act.training ?? act.menu)();
  /** Every way out of the tutorial: stop the game once, then go where asked. */
  const leave = (to: () => void) => {
    if (left) return;
    left = true;
    markTutorialDone();
    handle.stop();
    to();
  };
  const closeCard = () => {
    card?.remove();
    card = null;
  };
  const finish = (outcomes: readonly DrillOutcome[]) => {
    if (left) return;
    left = true;
    markTutorialDone();
    closeCard();
    handle.stop();
    if (!gameEl) return act.menu();
    gameEl.insertAdjacentHTML('beforeend', doneHtml(outcomes));
    const ov = gameEl.querySelector<HTMLElement>('.tut-done')!;
    cardKeys(ov);
    ov.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-tut]')?.dataset.tut;
      if (a === 'quick') (act.quick ?? act.menu)();
      if (a === 'training') toTraining();
      if (a === 'menu') act.menu();
    });
    ov.querySelector<HTMLButtonElement>('[data-tut="quick"]')!.focus();
  };
  const showResult = (o: DrillOutcome) => {
    if (!gameEl) return;
    closeCard();
    const prevBest = getBestStars(o.id);
    const best = recordDrillStars(o.id, o.stars);
    const after = nextDrillId(o.id);
    const next = rs.runAll ? (rs.index + 1 < rs.queue.length ? 'Next drill' : 'Finish') : after ? 'Next drill' : null;
    gameEl.insertAdjacentHTML('beforeend', resultHtml({ outcome: o, prevBest, best, line: coachText, next }));
    card = gameEl.querySelector<HTMLElement>('.tut-result')!;
    cardKeys(card);
    card.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-res]');
      btn?.blur();
      const a = btn?.dataset.res;
      if (a === 'retry') send({ type: 'retry' });
      if (a === 'training') leave(toTraining);
      if (a === 'next') {
        // A single-drill run has nowhere to advance: start the next drill as a new single run.
        if (rs.runAll) send({ type: 'next' });
        else if (after) apply(startRun(after));
      }
    });
    card.querySelector<HTMLButtonElement>('.btn.primary')?.focus();
  };

  const apply = (r: RunnerStep) => {
    rs = r.state;
    for (const e of r.emits) {
      switch (e.kind) {
        case 'drill':
          closeCard();
          restage = true;
          coachT = 0;
          break;
        case 'coach':
          coachText = coachLine(e.line);
          coachT = PRAISE_S;
          break;
        case 'markers':
          markerReqs = e.markers;
          break;
        case 'countdown':
          count = e.n;
          if (e.n === 0) goT = 0.8;
          break;
        case 'result':
          if (!e.outcome.skipped) showResult(e.outcome);
          break;
        case 'finished':
          if (game) game.markers = [];
          if (!e.exited) setTimeout(() => finish(e.outcomes), 0);
          break;
      }
    }
    render();
  };
  const send = (a: RunnerAction) => apply(step(rs, a));

  const render = () => {
    if (!strip) return;
    const id = currentDrill(rs);
    const label = strip.querySelector<HTMLElement>('.tut-step')!;
    const hint = strip.querySelector<HTMLElement>('.tut-hint')!;
    const skip = strip.querySelector<HTMLButtonElement>('[data-tut="skip"]')!;
    skip.hidden = !id;
    if (!id) {
      label.textContent = 'Done!';
      hint.textContent = fitLine('All drills complete.');
      strip.style.setProperty('--p', '100%');
      return;
    }
    const def = drill(id);
    const pos = rs.runAll ? `${rs.index + 1}/${rs.queue.length} ` : '';
    let tag = '';
    let text = goalFor(id, kind);
    let p = 0;
    switch (rs.phase) {
      case 'intro':
        break;
      case 'countdown':
        text = `Get set… ${count || 'GO!'}`;
        break;
      case 'active': {
        const secs = Math.ceil(timeLeft(rs));
        tag = ` ${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
        if (def.repTarget) tag += ` · ${rs.stats.reps}/${def.repTarget}`;
        if (goT > 0) text = 'GO!';
        else if (coachT > 0 && coachText) text = coachText;
        p = def.repTarget ? rs.stats.reps / def.repTarget : rs.stats.elapsed / def.timeLimit;
        break;
      }
      case 'done':
        text = coachText || 'Drill complete.';
        p = 1;
        break;
    }
    const key = `${rs.index}:${rs.phase}:${tag}:${text}:${Math.floor(p * 20)}`;
    if (key === shown) return;
    shown = key;
    label.textContent = `${pos}${def.title}${tag}`;
    hint.textContent = fitLine(text);
    strip.style.setProperty('--p', `${Math.min(1, Math.max(0, p)) * 100}%`);
  };

  const cfg = tutorialConfig(settings, first);
  const coach = coachMon(cfg.home.roster);
  const u = cfg.home.human ? 0 : 1;

  // playGame has already stopped itself before calling onFinal/onQuit.
  const handle: PlayHandle = playGame(root, cfg, audio,
    () => { if (!left) { left = true; act.menu(); } },
    () => { if (!left) { left = true; markTutorialDone(); act.menu(); } },
    {
      startingFive: false,
      record: false,
      onFrame: (g, events, intent, dt) => {
        game = g;
        if (rs.finished) return;
        const id = currentDrill(rs);
        if (restage && id) {
          g.setDrill(id);
          restage = false;
        }
        if (dt > 0) {
          coachT = Math.max(0, coachT - dt);
          goT = Math.max(0, goT - dt);
          send({ type: 'tick', dt });
        }
        for (const sig of watch(g, events, intent, dt)) send({ type: 'signal', signal: sig });
        // Movement: standing on the current cone counts as a rep.
        if (currentDrill(rs) === 'movement' && rs.phase === 'active' && g.user && reachedSpot(g.user, rs.stats.reps, u)) {
          send({ type: 'signal', signal: { type: 'spot' } });
        }
        g.markers = rs.finished ? [] : drillMarkers(g, markerReqs);
        render();
      },
    });

  gameEl = root.querySelector<HTMLElement>('.game')!;
  gameEl.classList.add('tut-on');
  gameEl.insertAdjacentHTML('afterbegin', stripHtml(coach));
  strip = gameEl.querySelector<HTMLElement>('.tut-strip')!;
  // Offline with a missing sprite: drop the portrait rather than show a broken image.
  strip.querySelector<HTMLImageElement>('.tut-coach')?.addEventListener('error', (e) => (e.target as HTMLElement).remove(), { once: true });
  strip.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-tut]');
    btn?.blur(); // never keep focus, so Space/Enter keep driving the game, not this button
    const a = btn?.dataset.tut;
    // Skip works in every phase (intro, countdown, mid-drill, on the results card); the last one lands on "Nice work!".
    if (a === 'skip') send({ type: 'skip' });
    // Exit works everywhere too, including mid-drill and during Run all. It counts as done, so the menu hint goes away.
    if (a === 'exit') leave(act.menu);
  });
  // The tutorial starts with the first drill already staged by its config: no restage needed.
  apply(start === 'all' ? startRunAll() : startRun(start));
  restage = false;
  return handle;
}
