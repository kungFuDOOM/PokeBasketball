// Dev only (main.ts imports this under import.meta.env.DEV): ?results=win|close|big|tie jumps straight to the
// final results screen with a made-up finished game, for screenshots.
import { POKEMON } from '../data/pokemon';
import { userCourt } from '../data/courts';
import { USER_STYLE } from '../franchise/league';
import { Game } from '../game/game';
import { resultsScreen } from './results';

const SCORES = { win: [46, 45], close: [45, 46], big: [31, 58], tie: [50, 50] } as const;

export function devResults(root: HTMLElement, kind: keyof typeof SCORES) {
  const mons = POKEMON.slice(0, 10);
  const game = new Game({
    home: { name: 'Pallet Town', abbr: 'PAL', ...USER_STYLE, human: true, roster: mons.slice(0, 5) },
    away: { name: 'Viridian City', abbr: 'VIR', color: '#2f9e5b', color2: '#0d2e1b', human: false, roster: mons.slice(5) },
    quarterLen: 60, difficulty: 'pro', court: userCourt('Pallet Town'),
  });
  game.score = [...SCORES[kind]];
  game.players.forEach((p, i) => { p.stats.pts = 2 + (i % 5) * 3; p.stats.reb = i % 4; p.stats.fgm = 3; p.stats.fga = 7; p.stats.sec = 240; });
  root.className = 'screen-results';
  resultsScreen(root, game, {
    tag: 'Quick Play · Viridian City Gym',
    shareOpponent: 'Viridian City Gym',
    buttons: [{ id: 'rematch', label: 'Rematch', kind: 'primary' }, { id: 'menu', label: 'Main menu', kind: 'ghost' }],
    onAction: () => location.assign(location.pathname),
  });
}

export const devResultsKind = (): keyof typeof SCORES | null => {
  const k = new URLSearchParams(location.search).get('results');
  return k && k in SCORES ? (k as keyof typeof SCORES) : null;
};
