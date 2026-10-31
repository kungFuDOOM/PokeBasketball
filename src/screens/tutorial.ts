// Tutorial / Training: an offline practice game against a passive CPU (GameConfig.practice), nothing saved.
// No replay, results, stats or telemetry: the final buzzer or Quit just goes back to the menu.
// Finishing every step shows a "Nice work!" screen; finishing, Exit tutorial or Quit marks the tutorial done (local only).
import { POKEMON } from '../data/pokemon';
import { LEAGUE, USER_STYLE, contrastAway } from '../franchise/league';
import type { Audio } from '../game/audio';
import type { GameConfig, TeamDef } from '../game/types';
import { cpuRoster } from '../season/team';
import { markTutorialDone } from '../tutorial/store';
import { createWatcher } from '../tutorial/watcher';
import { STEPS, currentStep, hintFor, initialState, reduce, type InputKind, type TutorialState } from '../tutorial/steps';
import { abbr, lettersName } from '../util';
import type { Settings } from './menu';
import { playGame, type PlayHandle } from './play';

export interface TutorialActions {
  menu(): void;
  /** Completion screen's "Play Quick Play"; falls back to the menu when not given. */
  quick?(): void;
}

/** Short quarters so the practice game never drags. */
export const TUTORIAL_QUARTER = 90;
/** Fixed seed: every tutorial plays out the same way for the same inputs. */
export const TUTORIAL_SEED = 20261031;

/** The offline practice config: the user's team against Brock's gym on Rookie, with the CPU held back. */
export function tutorialConfig(settings: Settings): GameConfig {
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
    quarterLen: TUTORIAL_QUARTER,
    difficulty: 'rookie',
    seed: TUTORIAL_SEED,
    stamina: false,
    autoSwitch: true,
    practice: true,
  };
}

/** Same touch detection as playGame (it adds `.has-touch` on exactly this condition). */
export const tutorialInput = (): InputKind =>
  window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0 ? 'touch' : 'keys';

/**
 * The prompt strip: docked above the stage in its own flex row (`.game.tut-on`), so it shrinks the court instead of
 * covering it. Only its two buttons take pointer events; its right end stops short of the pause/music/X corner.
 */
function stripHtml(): string {
  return `
    <div class="tut-strip" role="status" aria-live="polite">
      <div class="tut-text"><b class="tut-step"></b><span class="tut-hint"></span></div>
      <div class="tut-acts">
        <button class="tut-btn" data-tut="skip">Skip step</button>
        <button class="tut-btn ghost" data-tut="exit">Exit tutorial</button>
      </div>
      <i class="tut-prog" aria-hidden="true"></i>
    </div>`;
}

/** Shown over the court once every step is done: the game is stopped behind it. */
function doneHtml(): string {
  return `
    <div class="tut-done" role="dialog" aria-modal="true" aria-labelledby="tut-done-h">
      <div class="panel">
        <h2 id="tut-done-h">Nice work!</h2>
        <p>You've got the moves: run, pass, shoot, dunk, specials, defense and steals. Time for a real game.</p>
        <div class="tut-done-acts">
          <button class="btn primary big" data-tut="quick">Play Quick Play</button>
          <button class="btn ghost" data-tut="menu">Back to menu</button>
        </div>
      </div>
    </div>`;
}

export function tutorialScreen(root: HTMLElement, settings: Settings, audio: Audio, act: TutorialActions): PlayHandle {
  root.className = 'screen-game';
  window.scrollTo(0, 0);
  audio.unlock();
  const kind = tutorialInput();
  const watch = createWatcher();
  let state: TutorialState = initialState();
  let strip: HTMLElement | null = null;
  let shown = '';
  let left = false;
  /** Every way out of the tutorial: stop the game once, then go where asked. */
  const leave = (to: () => void) => {
    if (left) return;
    left = true;
    markTutorialDone();
    handle.stop();
    to();
  };
  const finish = () => {
    if (left) return;
    left = true;
    markTutorialDone();
    handle.stop();
    const gameEl = root.querySelector<HTMLElement>('.game');
    if (!gameEl) return act.menu();
    gameEl.insertAdjacentHTML('beforeend', doneHtml());
    const ov = gameEl.querySelector<HTMLElement>('.tut-done')!;
    ov.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-tut]')?.dataset.tut;
      if (a === 'quick') (act.quick ?? act.menu)();
      if (a === 'menu') act.menu();
    });
    ov.querySelector<HTMLButtonElement>('[data-tut="quick"]')!.focus();
  };

  const render = () => {
    if (!strip) return;
    const step = currentStep(state);
    const key = `${state.index}:${Math.floor(state.progress * 10)}`;
    if (key === shown) return;
    shown = key;
    const label = strip.querySelector<HTMLElement>('.tut-step')!;
    const hint = strip.querySelector<HTMLElement>('.tut-hint')!;
    const skip = strip.querySelector<HTMLButtonElement>('[data-tut="skip"]')!;
    if (step) {
      label.textContent = `${state.index + 1}/${STEPS.length} ${step.title}`;
      hint.textContent = hintFor(step.id, kind);
      strip.style.setProperty('--p', `${Math.min(1, state.progress / step.goal) * 100}%`);
    } else {
      label.textContent = 'Done!';
      hint.textContent = 'All steps complete.';
      strip.style.setProperty('--p', '100%');
    }
    skip.hidden = !step;
  };
  const dispatch = (sig: Parameters<typeof reduce>[1]) => {
    state = reduce(state, sig);
  };

  // playGame has already stopped itself before calling onFinal/onQuit. The buzzer before the last step doesn't count as done.
  const handle: PlayHandle = playGame(root, tutorialConfig(settings), audio,
    () => { if (!left) { left = true; act.menu(); } },
    () => { if (!left) { left = true; markTutorialDone(); act.menu(); } },
    {
      startingFive: false,
      record: false,
      onFrame: (g, events, intent, dt) => {
        if (state.done) return;
        for (const sig of watch(g, events, intent, dt)) dispatch(sig);
        render();
        // After this frame finishes (it re-arms its own requestAnimationFrame), stop the game and show the result.
        if (state.done) setTimeout(finish, 0);
      },
    });

  const gameEl = root.querySelector<HTMLElement>('.game')!;
  gameEl.classList.add('tut-on');
  gameEl.insertAdjacentHTML('afterbegin', stripHtml());
  strip = gameEl.querySelector<HTMLElement>('.tut-strip')!;
  strip.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-tut]');
    btn?.blur(); // never keep focus, so Space/Enter keep driving the game, not this button
    const a = btn?.dataset.tut;
    if (a === 'skip') {
      dispatch({ type: 'skipStep' });
      render();
      if (state.done) finish(); // skipping the last step still lands on the completion screen
    }
    if (a === 'exit') leave(act.menu); // skipping the whole tutorial counts as done, so the menu hint goes away
  });
  render();
  return handle;
}
