// @ts-ignore Node's fs has no type declarations in this project.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { COURTS } from '../data/courts';
import { monByDex } from '../data/pokemon';
import { Game } from '../game/game';
import { ReplayRecorder } from '../game/replay';
import { packInput, stateHash, stepGame, type WireInput } from '../game/sync';
import { emptyIntent, seededRng, type GameConfig, type TeamDef } from '../game/types';
import { potgShareText } from '../ui/share';

const read = (p: string): string => readFileSync(new URL(p, import.meta.url), 'utf8');

describe('every mode that ends in a results screen offers the play of the game and its share', () => {
  const results = read('./results.ts');
  it('the shared results screen shows the watch button and a share button for the play', () => {
    expect(results).toContain('data-replay');
    expect(results).toContain('data-share-potg');
    expect(results).toMatch(/bindShare\(potgBox, potgShareText\(play\)/);
  });

  it('each mode reaches that screen with a recorded game', () => {
    const play = read('./play.ts');
    // Played games (practice/CPU, Quick Play, franchise, gyms, tournaments, watched, Social, Ranked, Pack Battles):
    // only the tutorial's drills opt out of recording, and online games record through the lockstep tap.
    expect(play).toMatch(/opts\.record === false \? null : new ReplayRecorder/);
    expect(play).toContain('online.record?.(');
    expect(read('../multiplayer/shared/onlineGame.ts')).toContain('ls.tap = tap');
    expect(read('./tutorial.ts')).toContain('record: false');
    // Simulated games record headlessly.
    expect(read('./quick.ts')).toMatch(/simulate\(cfg, \(g\) => \(rec = new ReplayRecorder/);
    expect(read('../main.ts')).toMatch(/simulate\(cfg, \(g\) => \(rec = new ReplayRecorder/);
  });

  it('every results caller goes through resultsScreen', () => {
    for (const f of ['../main.ts', './quick.ts', '../multiplayer/shared/matchFlow.ts', '../multiplayer/shared/onlineGame.ts']) {
      expect(read(f), f).toContain('resultsScreen(');
    }
  });

  it('online games never hold the result for a replay', () => {
    expect(read('./play.ts')).toContain('if (found && !online)');
  });
});

describe('the play share text', () => {
  it('names only the player and the play: no scores, wallets or money', () => {
    const t = potgShareText({ name: 'GENGAR', title: 'GAME WINNER · FROM DOWNTOWN' });
    expect(t).toContain('GENGAR');
    expect(t).toContain('GAME WINNER · FROM DOWNTOWN');
    expect(t).not.toMatch(/\$|usdc|sol\b|wallet|pack|prize|wager|\d/i);
  });
});

const team = (name: string, dexes: number[]): TeamDef => ({
  name, abbr: name.slice(0, 3).toUpperCase(), color: '#3b6fd8', color2: '#16224a', human: true, roster: dexes.map(monByDex),
});

describe('recording an online game (both players\' inputs)', () => {
  it('rebuilds the play exactly from the logged pair of inputs', () => {
    const cfg: GameConfig = { home: team('Pallet Town', [25, 381, 6, 445, 382]), away: team('Indigo Elite', [94, 130, 149, 248, 150]), quarterLen: 30, difficulty: 'pro', court: COURTS['Indigo Elite'], seed: 5 };
    const g = new Game(cfg);
    g.viewTeam = 1;
    const rec = new ReplayRecorder(cfg, g.seed, 1);
    const rng = seededRng(9);
    const mk = (): WireInput => { const i = emptyIntent(); i.mx = rng() * 2 - 1; i.my = rng() * 2 - 1; i.shoot = rng() < 0.03; i.pass = rng() < 0.01; return packInput(i); };
    const live = new Map<number, number>();
    for (let t = 0; g.phase !== 'final' && t < 100_000; t++) {
      const inputs: [WireInput, WireInput] = [mk(), mk()];
      rec.beforeBoth(g, inputs);
      const n = g.events.length;
      stepGame(g, inputs);
      rec.after(g, g.events.slice(n));
      live.set(rec.tick, stateHash(g));
      g.events.length = 0;
    }
    const h = rec.best(g);
    expect(h).not.toBeNull();
    const clip = rec.clip(h!)!;
    expect(clip).not.toBeNull();
    while (!clip.done) { clip.step(); expect(stateHash(clip.game)).toBe(live.get(clip.tick)); }
    expect(clip.ok).toBe(true);
  });
});
