// The live pokejam.xyz odds: shots, steals, blocks and rebounds are rolls (as in Quick Play and Franchise), and
// every roll comes from the match's seeded RNG. Seeded CPU-vs-CPU games land in the same ranges the live game's
// own engine gives over the same matchups, and the same matchup goes different ways on different seeds.
import { describe, expect, it } from 'vitest';
import { COURTS } from '../data/courts';
import { POKEMON } from '../data/pokemon';
import { Game, bestLineup } from './game';
import { TICK } from './sync';
import { seededRng, type GameConfig, type TeamDef } from './types';

const randomTeam = (name: string, rng: () => number): TeamDef => {
  const { starters, bench } = bestLineup([...POKEMON].sort(() => rng() - 0.5).slice(0, 10));
  return { name, abbr: name.slice(0, 3).toUpperCase(), color: '#3b6fd8', color2: '#16224a', human: false, roster: starters, bench };
};

const config = (home: TeamDef, away: TeamDef, seed: number): GameConfig => ({
  home, away, quarterLen: 60, difficulty: 'pro', court: COURTS['Indigo Elite'], stamina: true, seed,
});

function play(cfg: GameConfig) {
  const g = new Game(cfg);
  for (let k = 0; g.phase !== 'final' && k < 400_000; k++) { g.update(TICK); g.events.length = 0; g.sfx.length = 0; }
  return g;
}

describe('live odds on the seeded RNG', () => {
  it('seeded CPU games shoot, steal, block and rebound like the live game', () => {
    const t = { fgm: 0, fga: 0, tpm: 0, tpa: 0, blk: 0, stl: 0, reb: 0, games: 0 };
    for (let s = 1; s <= 60; s++) {
      const rng = seededRng(s * 77);
      const g = play(config(randomTeam('Home', rng), randomTeam('Away', rng), s));
      expect(g.phase).toBe('final');
      for (const p of [...g.players, ...g.bench]) for (const k of ['fgm', 'fga', 'tpm', 'tpa', 'blk', 'stl', 'reb'] as const) t[k] += p.stats[k];
      t.games++;
    }
    // The live engine over 150 such games: FG 49%, 3P 31%, per game 8.8 blocks, 17 steals, 33 rebounds (90 s quarters).
    expect(t.fgm / t.fga).toBeGreaterThan(0.43);
    expect(t.fgm / t.fga).toBeLessThan(0.55);
    expect(t.tpm / t.tpa).toBeGreaterThan(0.24);
    expect(t.tpm / t.tpa).toBeLessThan(0.42);
    const per = (n: number) => (n / t.games) * (90 / 60);
    expect(per(t.blk)).toBeGreaterThan(5);
    expect(per(t.blk)).toBeLessThan(13);
    expect(per(t.stl)).toBeGreaterThan(11);
    expect(per(t.stl)).toBeLessThan(23);
    expect(per(t.reb)).toBeGreaterThan(24);
    expect(per(t.reb)).toBeLessThan(43);
  }, 120_000);

  it('the same matchup is not decided by ratings alone: different seeds, different games', () => {
    const rng = seededRng(2024);
    const home = randomTeam('Home', rng);
    const away = randomTeam('Away', rng);
    const scores = new Set<string>();
    const margins: number[] = [];
    for (let s = 1; s <= 12; s++) {
      const g = play(config(home, away, s));
      scores.add(`${g.score[0]}-${g.score[1]}`);
      margins.push(g.score[0] - g.score[1]);
    }
    expect(scores.size).toBeGreaterThan(6);
    expect(Math.max(...margins) - Math.min(...margins)).toBeGreaterThan(6);
  }, 120_000);

  it('a seed replays to the identical box score', () => {
    const rng = seededRng(5);
    const cfg = config(randomTeam('Home', rng), randomTeam('Away', rng), 31337);
    const box = (g: Game) => JSON.stringify([g.score, [...g.players, ...g.bench].map((p) => p.stats)]);
    expect(box(play(cfg))).toBe(box(play(cfg)));
  }, 60_000);
});
