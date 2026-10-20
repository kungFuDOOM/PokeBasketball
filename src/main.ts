import './style.css';
import type { Mon } from './data/pokemon';
import { Audio } from './game/audio';
import type { TeamDef } from './game/types';
import { autoDraft, draftScreen, matchupHtml } from './screens/draft';
import { menuScreen, type Settings } from './screens/menu';
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

function teams(user: Mon[], cpu: Mon[], humanHome: boolean): [TeamDef, TeamDef] {
  const name = settings.teamName.trim() || 'Pallet Town';
  return [
    { name: humanHome ? name : 'Pallet Town', abbr: humanHome ? abbr(name) : 'PAL', ...HOME, roster: user, human: humanHome },
    { name: CPU.name, abbr: CPU.abbr, color: CPU.color, color2: CPU.color2, roster: cpu, human: false },
  ];
}

function menu() {
  app.className = 'screen-menu';
  menuScreen(app, settings, save, (mode) => {
    audio.unlock();
    if (mode === 'draft') draft();
    else {
      const [a, b] = autoDraft();
      matchup(a, b, mode === 'quick');
    }
  });
}

function draft() {
  app.className = 'screen-draft';
  draftScreen(app, settings, audio, CPU.name, (u, c) => matchup(u, c, true), menu);
}

function matchup(user: Mon[], cpu: Mon[], human: boolean) {
  app.className = 'screen-matchup';
  const [h, a] = teams(user, cpu, human);
  app.innerHTML = matchupHtml(h, a, settings);
  app.querySelector('[data-a="tip"]')!.addEventListener('click', () => play(user, cpu, human));
  app.querySelector('[data-a="back"]')!.addEventListener('click', menu);
}

function play(user: Mon[], cpu: Mon[], human: boolean) {
  app.className = 'screen-game';
  audio.unlock();
  const [home, away] = teams(user, cpu, human);
  playGame(app, { home, away, quarterLen: settings.quarterLen, difficulty: settings.difficulty }, audio, (g) => {
    app.className = 'screen-results';
    resultsScreen(app, g, (a) => {
      if (a === 'rematch') play(user, cpu, human);
      else if (a === 'redraft') draft();
      else menu();
    });
  }, menu);
}

menu();
