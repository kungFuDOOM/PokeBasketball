import { afterEach, describe, expect, it, vi } from 'vitest';
import { COURTS } from '../data/courts';
import { POKEMON, monByDex, type Mon } from '../data/pokemon';
import { LEAGUE } from '../franchise/league';
import { simulateSeason, type SimInput } from '../season/sim';
import { Game, IDEAL_RELEASE, teamOvr } from './game';
import aiSrc from './ai.ts?raw';
import gameSrc from './game.ts?raw';
import simSrc from '../season/sim.ts?raw';
import { HOOP_Y, hoopX, seededRng, type GameConfig, type Player, type TeamDef, type TeamId } from './types';

const TICK = 1 / 60;
type Rng = () => number;
const constant = (v: number): Rng => () => v;
const STREAMS: [string, () => Rng][] = [
  ['always 0', () => constant(0)],
  ['always 0.999999', () => constant(0.999999)],
  ['always 0.5', () => constant(0.5)],
  ['seed 1', () => seededRng(1)],
  ['seed 777', () => seededRng(777)],
];

const team = (name: string, human: boolean, dexes: number[]): TeamDef => ({
  name, abbr: name.slice(0, 3).toUpperCase(), color: '#3b6fd8', color2: '#16224a', human, roster: dexes.map(monByDex),
});
const HOME = [25, 381, 6, 445, 382];
const AWAY = [94, 130, 149, 248, 150];
const config = (humans: [boolean, boolean], extra: Partial<GameConfig> = {}, rosters: [number[], number[]] = [HOME, AWAY]): GameConfig => ({
  home: team('Pallet Town', humans[0], rosters[0]),
  away: team('Indigo Elite', humans[1], rosters[1]),
  quarterLen: 30,
  difficulty: 'pro',
  court: COURTS['Indigo Elite'],
  stamina: true,
  ...extra,
});

afterEach(() => vi.restoreAllMocks());

interface Plays {
  giveBall(p: Player, silent?: boolean): void;
  releaseShot(p: Player): void;
  maybeInjure(p: Player, base: number): void;
  endQuarter(): void;
  startQuarter(): void;
}
const plays = (g: Game) => g as unknown as Plays;

/** A live game with everyone parked away, one shooter with the ball at `d` feet and `ang` from the hoop, and a defender `gap` feet from them. */
function stage(rng: Rng, d: number, ang: number, gap: number | null, meterErr: number) {
  const g = new Game(config([true, false], { rng }));
  g.tipoff = null;
  g.phase = 'live';
  for (const p of g.players) Object.assign(p, { x: 10 + p.slot * 3, y: p.team === 0 ? 3 : 47, z: 0, vx: 0, vy: 0, vz: 0, state: 'free' });
  const [shooter] = g.teamPlayers(0);
  Object.assign(shooter, { x: hoopX(0) - Math.cos(ang) * d, y: HOOP_Y + Math.sin(ang) * d, energy: 1 });
  if (gap !== null) {
    const [def] = g.teamPlayers(1);
    Object.assign(def, { x: shooter.x + Math.cos(ang) * gap, y: shooter.y + Math.sin(ang) * gap });
  }
  plays(g).giveBall(shooter, true);
  const w = g.greenWindow(shooter);
  shooter.meter = IDEAL_RELEASE + meterErr * w;
  return { g, shooter, w };
}

describe('shots: skill first, a little luck', () => {
  it('a perfect release on an open or lightly contested look always goes in, whatever the rolls', () => {
    let checked = 0;
    for (const [, mk] of STREAMS) {
      for (let d = 3; d <= 30; d += 3) {
        for (const gap of [null, 9, 6, 4.5]) {
          for (const ang of [-0.8, 0, 0.8]) {
            const { g, shooter } = stage(mk(), d, ang, gap, 0.5);
            const open = (g.contest(shooter) - 0.35) / 0.65;
            if (open < 0.4) continue;
            plays(g).releaseShot(shooter);
            expect(g.ball.shot?.make, `d=${d} gap=${gap} ang=${ang}`).toBe(true);
            checked++;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
  });

  it('make chance: better timing beats worse, heavier contest beats lighter, and way-off or smothered shots almost never drop', () => {
    const { g, shooter } = stage(constant(0.5), 17, 0, null, 0);
    const odds = (r: number, contest: number, d = 17) => g.shotOdds(shooter, r, d, false, contest);
    for (const c of [1, 0.7, 0.4]) {
      const seq = [0.5, 1.5, 3, 4, 5, 6.5].map((r) => odds(r, c));
      for (let i = 1; i < seq.length; i++) expect(seq[i]).toBeLessThanOrEqual(seq[i - 1]);
      expect(seq[1]).toBeGreaterThan(seq[3]);
      expect(seq[3]).toBeGreaterThan(seq[5]);
    }
    for (const r of [0.5, 1.5, 3]) {
      expect(odds(r, 1)).toBeGreaterThan(odds(r, 0.7));
      expect(odds(r, 0.7)).toBeGreaterThan(odds(r, 0.4));
    }
    expect(odds(1.5, 1)).toBeGreaterThan(0.65);
    expect(odds(1.5, 1)).toBeLessThan(0.95);
    for (const r of [5.2, 6.5, 9]) expect(odds(r, 1)).toBeLessThan(0.1);
    for (const r of [4, 5.2, 6.5]) expect(odds(r, 0.35)).toBeLessThan(0.1);
    expect(odds(1.5, 0.35)).toBeLessThan(0.3);
    expect(odds(1, 1, 27)).toBeLessThan(odds(1, 1, 10));
  });

  it('rolled make rates follow the odds: timing sweep from the seeded stream', () => {
    const rate = (meterErr: number, gap: number | null) => {
      const rng = seededRng(99);
      let made = 0;
      const n = 300;
      for (let i = 0; i < n; i++) {
        const { g, shooter } = stage(rng, 15, 0, gap, meterErr);
        plays(g).releaseShot(shooter);
        if (g.ball.shot?.make) made++;
      }
      return made / n;
    };
    const perfect = rate(0.3, null);
    const good = rate(1.8, null);
    const late = rate(3.6, null);
    const veryLate = rate(7, null);
    expect(perfect).toBe(1);
    expect(good).toBeGreaterThan(0.55);
    expect(good).toBeLessThan(0.95);
    expect(late).toBeLessThan(good);
    expect(late).toBeGreaterThan(veryLate);
    expect(veryLate).toBeLessThan(0.1);
    expect(rate(1.8, 2)).toBeLessThan(good);
  });
});

describe('one injectable rng', () => {
  const play = (cfg: Partial<GameConfig>) => {
    const g = new Game({ ...config([false, false], { quarterLen: 40, injuries: true, ...cfg }) });
    for (let i = 0; i < 100_000 && g.phase !== 'final'; i++) { g.update(TICK); g.events.length = 0; g.sfx.length = 0; }
    const box = [...g.players, ...g.bench].map((p) => ({ id: p.id, ...p.stats, hurt: p.hurt }));
    return { phase: g.phase, score: g.score, quarter: g.quarter, box };
  };

  it('the same seed replays the identical full game; other seeds can differ', () => {
    const a = play({ seed: 11 });
    expect(a.phase).toBe('final');
    expect(a.score[0] + a.score[1]).toBeGreaterThan(0);
    expect(play({ seed: 11 })).toEqual(a);
    const others = [12, 13, 14].map((seed) => JSON.stringify(play({ seed })));
    expect(others.some((o) => o !== JSON.stringify(a))).toBe(true);
  });

  it('every roll comes from the injected rng, never Math.random', () => {
    const spy = vi.spyOn(Math, 'random');
    let calls = 0;
    const rng = seededRng(5);
    const a = play({ rng: () => { calls++; return rng(); } });
    expect(calls).toBeGreaterThan(100);
    expect(spy).not.toHaveBeenCalled();
    expect(a.phase).toBe('final');
  });

  it('gameplay sources never call Math.random directly', () => {
    for (const [name, src] of [['game.ts', gameSrc], ['ai.ts', aiSrc], ['season/sim.ts', simSrc]]) {
      expect(src.includes('Math.random'), name).toBe(false);
    }
  });
});

describe('jump balls and overtime', () => {
  function tip(g: Game, plan: [number, number]): TeamId {
    g.tipoff!.plan = plan;
    for (let i = 0; i < 900 && g.tipoff && !g.tipoff.to; i++) g.update(TICK);
    const e = g.events.find((x) => x.kind === 'jumpball');
    if (e?.kind !== 'jumpball') throw new Error('no jump ball');
    return e.winner.team;
  }
  const fresh = (rng: Rng, rosters?: [number[], number[]]) => new Game(config([false, false], { rng }, rosters));

  it('the better-timed jump wins, with any stream', () => {
    for (const [, rng] of STREAMS) {
      expect(tip(fresh(rng()), [1, 1.3])).toBe(0);
      expect(tip(fresh(rng()), [1.3, 1])).toBe(1);
    }
  });

  it('only an exact tie is a coin flip, from the rng', () => {
    const mirror: [number[], number[]] = [HOME, HOME];
    expect(tip(fresh(constant(0), mirror), [1, 1])).toBe(0);
    expect(tip(fresh(constant(0.999999), mirror), [1, 1])).toBe(1);
  });

  it('overtime opens with a jump ball', () => {
    for (const [, rng] of STREAMS) {
      const g = fresh(rng());
      g.tipoff = null;
      g.phase = 'live';
      g.quarter = 4;
      g.score = [50, 50];
      plays(g).endQuarter();
      for (let i = 0; i < 900 && !g.tipoff; i++) g.update(TICK);
      expect(g.quarter).toBe(5);
      expect(g.tipoff).not.toBeNull();
      expect(g.events).toContainEqual({ kind: 'quarter', label: 'OVERTIME', sub: 'JUMP BALL' });
    }
  });
});

describe('injuries', () => {
  const hit = (rng: Rng, energy: number) => {
    const g = new Game(config([false, false], { rng, injuries: true }));
    const [p] = g.teamPlayers(0);
    p.energy = energy;
    plays(g).maybeInjure(p, 0.012);
    return p.hurt;
  };
  it('a fatigue threshold decides it; only a small chance sits on top for a half-tired player', () => {
    const unlucky = constant(0.999999);
    expect(hit(unlucky, 1)).toBe(0);
    expect(hit(unlucky, 0.5)).toBe(0);
    expect(hit(unlucky, 0.3)).toBe(0);
    expect(hit(unlucky, 0.15)).toBe(1);
    expect(hit(unlucky, 0.01)).toBe(3);
    expect(hit(constant(0), 0.3)).toBe(1);
    expect(hit(constant(0), 1)).toBe(0);
    expect(hit(constant(0), 0.5)).toBe(0);
  });
});

describe('bounces', () => {
  it('a miss comes off the rim by geometry plus a little jitter: same stream same bounce, other streams differ slightly', () => {
    const bounce = (seed: number) => {
      const { g, shooter } = stage(seededRng(seed), 14, 0.3, null, 3);
      plays(g).releaseShot(shooter);
      for (let i = 0; i < 200 && g.ball.mode === 'shot'; i++) g.update(TICK);
      const b = g.ball;
      return b.mode === 'loose' ? Math.atan2(b.vy, b.vx) : null;
    };
    const apart = (a: number, b: number) => Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
    for (const seed of [4, 5, 6]) expect(bounce(seed)).toBe(bounce(seed));
    const angles = Array.from({ length: 40 }, (_, i) => bounce(i + 1)).filter((a): a is number => a !== null);
    expect(angles.length).toBeGreaterThan(5);
    expect(new Set(angles).size).toBeGreaterThan(1);
    for (const a of angles) expect(apart(a, angles[0])).toBeLessThan(1.6);
  });
});

describe('franchise season sim', () => {
  const byOvr = [...POKEMON].sort((a, b) => b.ovr - a.ovr);
  /** A league where team `i` takes players from the ovr-sorted pool starting at `starts[i]` (stride 1, 10 deep). */
  function league(seed: number, starts: number[]): SimInput {
    const n = 1 + LEAGUE.length;
    const teams = Array.from({ length: n }, (_, i) => {
      const roster: Mon[] = byOvr.slice(starts[i], starts[i] + 10);
      return {
        name: i ? LEAGUE[i - 1].name : 'Pallet Town', abbr: i ? LEAGUE[i - 1].abbr : 'PAL',
        color: '#3b6fd8', color2: '#16224a', boost: 0, roster,
      };
    });
    return { seed, teams };
  }
  /** Share of the user's games lost by the stronger side (by team ovr), over many seeds. */
  function upsetRate(starts: number[]) {
    let upsets = 0;
    let games = 0;
    const ovr = league(0, starts).teams.map((t) => teamOvr(t.roster));
    for (let seed = 1; seed <= 60; seed++) {
      for (const w of simulateSeason(league(seed, starts)).weeks) {
        const mine = ovr[0];
        const theirs = ovr[w.opp];
        if (mine === theirs) continue;
        games++;
        if (mine > theirs ? !w.win : w.win) upsets++;
      }
    }
    return { rate: upsets / games, games };
  }

  it('the same seed gives the identical season; other seeds can differ', () => {
    const starts = [0, 20, 40, 60, 80, 100, 120, 140, 160, 180, 200];
    const a = simulateSeason(league(7, starts));
    expect(simulateSeason(league(7, starts))).toEqual(a);
    const others = [8, 9, 10].map((s) => JSON.stringify({ ...simulateSeason(league(s, starts)), seed: 0 }));
    expect(others.some((o) => o !== JSON.stringify({ ...a, seed: 0 }))).toBe(true);
  });

  it('close matchups get upsets now and then; lopsided ones almost never', () => {
    const n = 1 + LEAGUE.length;
    const lopsided = upsetRate(Array.from({ length: n }, (_, i) => i * 14));
    const close = upsetRate(Array.from({ length: n }, (_, i) => i));
    expect(lopsided.games).toBeGreaterThan(300);
    expect(lopsided.rate).toBeLessThan(0.05);
    expect(close.rate).toBeGreaterThan(0.1);
    expect(close.rate).toBeLessThan(0.3);
  });
});
