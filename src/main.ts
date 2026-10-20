import './style.css';
import type { Mon } from './data/pokemon';
import { Audio } from './game/audio';
import type { TeamDef } from './game/types';
import { draftScreen, matchupHtml } from './screens/draft';
import { bindSettings, menuScreen, type Settings } from './screens/menu';
import { playGame } from './screens/play';
import { resultsScreen } from './screens/results';

const app = document.querySelector<HTMLElement>('#app')!;
const audio = new Audio();
const CPU = { name: 'Team Rocket', abbr: 'RKT', color: '#d8343b', color2: '#3a1218' };
const HOME = { color: '#3b6fd8', color2: '#16224a' };

const settings: Settings = { difficulty: 'pro', quarterLen: 120, teamName: 'Pallet Town' };
try {
  Object.assign(settings, JSON.parse(localStorage.getItem('pokejam.settings') ?? '{}'));
} catch { /* storage unavailable */ }
const save = () => {
  try {
    localStorage.setItem('pokejam.settings', JSON.stringify(settings));
  } catch { /* storage unavailable */ }
};

// Browsers only allow audio after a gesture.
window.addEventListener('pointerdown', () => audio.unlock(), { once: false, passive: true });
window.addEventListener('keydown', () => audio.unlock(), { passive: true });

const abbr = (name: string) => (name.replace(/[^a-z0-9]/gi, '').slice(0, 3) || 'YOU').toUpperCase();

function teams(user: Mon[], cpu: Mon[]): [TeamDef, TeamDef] {
  const name = settings.teamName.trim() || 'Pallet Town';
  return [
    { name, abbr: abbr(name), ...HOME, roster: user, human: true },
    { name: CPU.name, abbr: CPU.abbr, color: CPU.color, color2: CPU.color2, roster: cpu, human: false },
  ];
}

function menu() {
  app.className = 'screen-menu';
  menuScreen(app, settings, save, () => {
    audio.unlock();
    draft();
  });
}

function draft() {
  app.className = 'screen-draft';
  draftScreen(app, settings, audio, CPU.name, matchup, menu);
}

/** After the draft: review both lineups, pick difficulty and quarter length, tip off. */
function matchup(user: Mon[], cpu: Mon[]) {
  app.className = 'screen-matchup';
  const [h, a] = teams(user, cpu);
  app.innerHTML = matchupHtml(h, a, settings);
  bindSettings(app, settings, save);
  app.querySelector('[data-a="tip"]')!.addEventListener('click', () => play(user, cpu));
  app.querySelector('[data-a="back"]')!.addEventListener('click', draft);
}

function play(user: Mon[], cpu: Mon[]) {
  app.className = 'screen-game';
  audio.unlock();
  const [home, away] = teams(user, cpu);
  playGame(app, { home, away, quarterLen: settings.quarterLen, difficulty: settings.difficulty }, audio, (g) => {
    app.className = 'screen-results';
    resultsScreen(app, g, (a) => {
      if (a === 'rematch') play(user, cpu);
      else if (a === 'redraft') draft();
      else menu();
    });
  }, menu);
}

menu();
