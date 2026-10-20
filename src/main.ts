import './style.css';
import { monByDex, spriteUrl, type Mon } from './data/pokemon';
import {
  CPU_TEAMS, USER_STYLE, advance, createFranchise, gameConfig, loadDraft, loadFranchise, nextSeason, recordGame, saveDraft, saveFranchise,
  simulate, weekGames, weekLabel, type FGame, type Franchise, type Progress,
} from './franchise/league';
import { Audio } from './game/audio';
import type { Game } from './game/game';
import { draftScreen, type DraftState } from './screens/draft';
import { hubScreen } from './screens/hub';
import { menuScreen, type Settings } from './screens/menu';
import { playGame } from './screens/play';
import { resultsScreen } from './screens/results';
import { esc } from './util';

const app = document.querySelector<HTMLElement>('#app')!;
const audio = new Audio();

const settings: Settings = { difficulty: 'pro', quarterLen: 120, teamName: 'Pallet Town' };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem('pokejam.settings') ?? '{}'));
} catch { /* storage unavailable */ }
const save = () => {
  try {
    localStorage.setItem('pokejam.settings', JSON.stringify(settings));
  } catch { /* storage unavailable */ }
};

let franchise: Franchise | null = loadFranchise();

// Browsers only allow audio after a gesture.
window.addEventListener('pointerdown', () => audio.unlock(), { passive: true });
window.addEventListener('keydown', () => audio.unlock(), { passive: true });

const abbr = (name: string) => (name.replace(/[^a-z0-9]/gi, '').slice(0, 3) || 'YOU').toUpperCase();
const shuffle = <T,>(a: T[]) => {
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

function overlay(text: string): () => void {
  const el = document.createElement('div');
  el.className = 'sim-overlay';
  el.innerHTML = `<div class="ball-spin" aria-hidden="true"></div><p>${esc(text)}</p>`;
  document.body.appendChild(el);
  return () => el.remove();
}

function draftSummary(d: DraftState): string {
  const me = d.teams.findIndex((t) => t.human);
  const n = d.taken.length;
  const mine = Array.from({ length: n }, (_, i) => i).filter((i) => {
    const round = Math.floor(i / d.order.length);
    const order = round % 2 ? [...d.order].reverse() : d.order;
    return order[i % d.order.length] === me;
  }).length;
  return `${d.teams[me].name} · Pick ${n + 1} of ${d.order.length * 5} · ${mine}/5 drafted`;
}

function menu() {
  app.className = 'screen-menu';
  const f = franchise;
  const d = loadDraft();
  menuScreen(app, settings, save, {
    saved: f ? `${f.teams[0].name} · Season ${f.season} · ${f.phase === 'done' ? 'Offseason' : weekLabel(f)} · ${f.teams[0].w}-${f.teams[0].l}` : null,
    draft: d ? draftSummary(d) : null,
    onContinue: hub,
    onResumeDraft: () => {
      const saved = loadDraft();
      if (saved) draft(saved);
    },
    onNew: () => {
      audio.unlock();
      saveDraft(null);
      const name = settings.teamName.trim() || 'Pallet Town';
      const teams = [
        { name, abbr: abbr(name), ...USER_STYLE, human: true },
        ...CPU_TEAMS.map((t) => ({ ...t, human: false })),
      ];
      draft({ teams, order: shuffle(teams.map((_, i) => i)), taken: [] });
    },
  });
}

function draft(state: DraftState) {
  app.className = 'screen-draft';
  window.scrollTo(0, 0);
  draftScreen(app, state, audio, (rosters, leftovers) => {
    franchise = createFranchise(state.teams, rosters, leftovers);
    saveFranchise(franchise);
    saveDraft(null);
    hub();
  }, menu, saveDraft);
}

function hub() {
  const f = franchise;
  if (!f) return menu();
  app.className = 'screen-hub';
  window.scrollTo(0, 0);
  hubScreen(app, f, settings, {
    play: (g) => playUserGame(f, g),
    simMine: (g) => void simUserGame(f, g),
    simWeek: () => void finishWeek(f).then(hub),
    nextSeason: () => {
      nextSeason(f);
      saveFranchise(f);
      hub();
    },
    menu,
    saved: () => {
      save();
      saveFranchise(f);
    },
  });
}

/** Sims every game still open this week, then moves the league forward. */
async function finishWeek(f: Franchise) {
  const open = weekGames(f).filter((g) => !g.score);
  const done = overlay(open.length ? 'Simulating around the league…' : 'Advancing…');
  for (const g of open) {
    const { cfg, sides, uidOf } = gameConfig(f, g, false, settings.quarterLen, settings.difficulty);
    recordGame(f, g, await simulate(cfg), sides, uidOf);
  }
  advance(f);
  saveFranchise(f);
  done();
}

function playUserGame(f: Franchise, g: FGame) {
  app.className = 'screen-game';
  audio.unlock();
  const { cfg, sides, uidOf } = gameConfig(f, g, true, settings.quarterLen, settings.difficulty);
  playGame(app, cfg, audio, (game) => afterUserGame(f, g, game, sides, uidOf, false), hub);
}

async function simUserGame(f: Franchise, g: FGame) {
  const { cfg, sides, uidOf } = gameConfig(f, g, false, settings.quarterLen, settings.difficulty);
  const done = overlay('Simulating your game…');
  const game = await simulate(cfg);
  done();
  afterUserGame(f, g, game, sides, uidOf, true);
}

function progressHtml(f: Franchise, progress: Progress[]): string {
  const mine = progress.filter((p) => p.team === 0);
  if (!mine.length) return '';
  const evos = mine.filter((p) => p.evolvedTo).map((p) => {
    const to = monByDex(p.evolvedTo!).name.toUpperCase();
    const from = p.name.toUpperCase();
    return `
      <div class="evo">
        <div class="evo-anim"><img class="from" src="${spriteUrl(p.evolvedFrom!)}" alt="${esc(p.name)}"><img class="to" src="${spriteUrl(p.evolvedTo!)}" alt="${esc(to)}"></div>
        <p class="evo-1">What? ${esc(from)} is evolving!</p>
        <p class="evo-2">Congratulations! Your ${esc(from)} evolved into ${esc(to)}!</p>
      </div>`;
  }).join('');
  const levels = mine.map((p) => {
    const dex = p.evolvedTo ?? f.players[p.uid].dex;
    return `<li><img src="${spriteUrl(dex)}" alt=""><span><b>${esc(p.name)}</b> grew to Lv ${p.level}</span><small>${esc(p.gains.join(', ') || 'Ratings maxed')}</small></li>`;
  }).join('');
  return `<section class="progress"><h3>Level ups</h3>${evos}<ul class="levels">${levels}</ul></section>`;
}

function afterUserGame(f: Franchise, g: FGame, game: Game, sides: [number, number], uidOf: Map<Mon, string>, simmed: boolean) {
  const progress = recordGame(f, g, game, sides, uidOf);
  saveFranchise(f);
  app.className = 'screen-results';
  window.scrollTo(0, 0);
  const won = game.score[0] > game.score[1];
  const label = g.round === 'final' ? 'The Final' : g.round === 'semi' ? 'Semifinal' : weekLabel(f);
  resultsScreen(app, game, {
    tag: simmed ? `${label} · Simulated` : label,
    headline: won ? (g.round === 'final' ? 'Champions!' : 'You win!') : `${f.teams[sides[1]].name} win`,
    extraHtml: progressHtml(f, progress),
    buttons: [{ id: 'continue', label: 'Continue', kind: 'primary' }],
    onAction: () => void finishWeek(f).then(hub),
  });
}

menu();
