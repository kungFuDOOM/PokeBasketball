import { afterEach, describe, expect, it, vi } from 'vitest';
import { COURTS } from '../data/courts';
import { monByDex } from '../data/pokemon';
import { simulateSeason, type SimInput } from '../season/sim';
import { Game, IDEAL_RELEASE } from './game';
import simSrc from '../season/sim.ts?raw';
import {
  BALL_R, HOOP_Y, emptyIntent, hoopX,
  type GameConfig, type GameEvent, type Player, type TeamDef, type TeamId,
} from './types';

const TICK = 1 / 60;
type Rng = () => number;
/** Test-only stream (mulberry32) used to stand in for Math.random and to lay out scenarios. */
function seededRng(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const team = (name: string, human: boolean, dexes: number[]): TeamDef => ({
  name, abbr: name.slice(0, 3).toUpperCase(), color: '#3b6fd8', color2: '#16224a', human, roster: dexes.map(monByDex),
});

const HOME = [25, 381, 6, 445, 382];
const AWAY = [94, 130, 149, 248, 150];

const config = (seed: number, humans: [boolean, boolean], rosters: [number[], number[]] = [HOME, AWAY]): GameConfig => ({
  home: team('Pallet Town', humans[0], rosters[0]),
  away: team('Indigo Elite', humans[1], rosters[1]),
  quarterLen: 30,
  difficulty: 'pro',
  court: COURTS['Indigo Elite'],
  stamina: true,
  seed,
});

afterEach(() => vi.restoreAllMocks());

/** The engine's private play resolvers, called directly so a test can stage exactly one play. */
interface Plays {
  giveBall(p: Player, silent?: boolean): void;
  releaseShot(p: Player): void;
  releaseLayup(p: Player): void;
  startDunk(p: Player, oop: boolean): void;
  updateDunk(p: Player, dt: number): void;
  updateShot(dt: number): void;
  doPass(p: Player): void;
  updatePass(dt: number): void;
  trySteal(p: Player): void;
  loosePickup(): void;
  endQuarter(): void;
  startQuarter(): void;
}
const plays = (g: Game) => g as unknown as Plays;

/** Swaps the game's random stream. If a result changes with the stream, luck decided it. */
const withRng = (_g: Game, rng: Rng) => { vi.spyOn(Math, 'random').mockImplementation(rng); };
const constant = (v: number): Rng => () => v;
const STREAMS: [string, () => Rng][] = [
  ['always 0', () => constant(0)],
  ['always 0.999999', () => constant(0.999999)],
  ['seed 1', () => seededRng(1)],
  ['seed 777', () => seededRng(777)],
];

interface Spot { x: number; y: number }
interface Scenario {
  shooter: Spot;
  meter: number;
  defender: Spot;
  defZ: number;
  mate: Spot;
  /** Dribble height, 0 = the ball on the floor, 1 = in the hand. */
  low: number;
}

/** A spot `d` feet from team 0's hoop at angle `a` (0 = straight out toward half court). */
const fromHoop = (d: number, a: number): Spot => ({ x: hoopX(0) - Math.cos(a) * d, y: HOOP_Y + Math.sin(a) * d });
const near = (s: Spot, d: number, a: number): Spot => ({ x: s.x + Math.cos(a) * d, y: s.y + Math.sin(a) * d });

/** Scenarios across the floor: every distance, release timing, and defender spot and height. */
function scenarios(n: number): Scenario[] {
  const r = seededRng(2024);
  return Array.from({ length: n }, () => {
    const shooter = fromHoop(1 + r() * 32, (r() - 0.5) * 2.6);
    return {
      shooter,
      meter: 0.3 + r() * 0.95,
      defender: near(shooter, 0.5 + r() * 7, r() * Math.PI * 2),
      defZ: r() < 0.4 ? 0 : 0.8 + r() * 3.5,
      mate: fromHoop(4 + r() * 22, (r() - 0.5) * 2.6),
      low: r(),
    };
  });
}

/** A live game with everyone parked out of the way, then the three players in the play placed (the defender is the best shot blocker). */
function stage(rng: Rng, sc: Scenario) {
  const g = new Game(config(42, [true, false]));
  withRng(g, rng);
  g.tipoff = null;
  g.phase = 'live';
  g.events.length = 0;
  for (const p of g.players) {
    Object.assign(p, { x: 10 + p.slot * 3, y: p.team === 0 ? 3 : 47, z: 0, vx: 0, vy: 0, vz: 0, state: 'free' });
  }
  const [shooter, mate] = g.teamPlayers(0);
  const defender = g.teamPlayers(1).reduce((a, b) => (b.r.blk > a.r.blk ? b : a));
  Object.assign(shooter, sc.shooter);
  Object.assign(mate, sc.mate);
  Object.assign(defender, sc.defender, { z: sc.defZ });
  return { g, p: plays(g), shooter, mate, defender };
}

const happened = (g: Game, kind: GameEvent['kind']) => g.events.some((e) => e.kind === kind);

/** Everything that decides a game, for one scenario played with one random stream. Bounce angles aren't in it. */
function outcomes(rng: () => Rng, sc: Scenario) {
  const out: Record<string, unknown> = {};

  // A jump shot, a layup and a dunk from the spot, flown out with the defender hanging where they are.
  {
    const { g, p, shooter } = stage(rng(), sc);
    p.giveBall(shooter, true);
    shooter.state = 'shoot';
    shooter.meter = sc.meter;
    shooter.z = 1;
    p.releaseShot(shooter);
    const shot = g.ball.shot!;
    const release = g.events.find((e) => e.kind === 'release');
    for (let i = 0; i < 300 && g.ball.mode === 'shot'; i++) p.updateShot(TICK);
    out.jump = { make: shot.make, airball: shot.airball, grade: release?.kind === 'release' && release.grade, blocked: happened(g, 'block'), score: g.score[0] };
  }
  {
    const { g, p, shooter } = stage(rng(), sc);
    p.giveBall(shooter, true);
    shooter.state = 'layup';
    shooter.z = 1;
    p.releaseLayup(shooter);
    const make = g.ball.shot!.make;
    for (let i = 0; i < 300 && g.ball.mode === 'shot'; i++) p.updateShot(TICK);
    out.layup = { make, blocked: happened(g, 'block'), score: g.score[0] };
  }
  {
    // The defender waits somewhere along the dunker's path to the rim.
    const { g, p, shooter, defender } = stage(rng(), sc);
    const k = 0.3 + sc.low * 0.6;
    defender.x = shooter.x + (hoopX(0) - shooter.x) * k + (sc.defender.x - shooter.x) * 0.3;
    defender.y = shooter.y + (HOOP_Y - shooter.y) * k + (sc.defender.y - shooter.y) * 0.3;
    p.giveBall(shooter, true);
    p.startDunk(shooter, false);
    const make = shooter.dunk!.make;
    for (let i = 0; i < 300 && shooter.dunk; i++) p.updateDunk(shooter, TICK);
    out.dunk = { make, blocked: happened(g, 'block'), score: g.score[0] };
  }
  // A swipe at the dribble, then a shove.
  {
    const { g, p, shooter, defender } = stage(rng(), sc);
    p.giveBall(shooter, true);
    g.ball.x = shooter.x + shooter.facing * 0.9 * shooter.size;
    g.ball.y = shooter.y + 0.5;
    g.ball.z = shooter.z + BALL_R + sc.low * 2.2 * shooter.size;
    defender.z = 0;
    defender.intent = emptyIntent();
    p.trySteal(defender);
    out.steal = g.ball.owner?.id;
  }
  {
    const { g, p, shooter, defender } = stage(rng(), sc);
    p.giveBall(shooter, true);
    defender.z = 0;
    defender.intent = { ...emptyIntent(), turbo: true };
    p.trySteal(defender);
    const shove = g.events.find((e) => e.kind === 'shove');
    out.shove = shove?.kind === 'shove' ? shove.ok : null;
  }
  // A pass to a teammate with the defender somewhere around the lane.
  {
    const { g, p, shooter, mate, defender } = stage(rng(), sc);
    p.giveBall(shooter, true);
    Object.assign(defender, { x: (shooter.x + mate.x) / 2 + (sc.low - 0.5) * 4, y: (shooter.y + mate.y) / 2, z: 0 });
    shooter.intent = { ...emptyIntent(), passTo: mate };
    p.doPass(shooter);
    for (let i = 0; i < 300 && g.ball.mode === 'pass'; i++) p.updatePass(TICK);
    out.pass = g.ball.owner?.id;
  }
  // A loose ball with all three in range.
  {
    const { g, p, shooter, mate, defender } = stage(rng(), sc);
    const b = g.ball;
    Object.assign(b, { mode: 'loose', owner: null, x: shooter.x, y: shooter.y, z: 1, fromShot: 0 });
    Object.assign(defender, near(shooter, sc.low * 1.6, sc.meter * 6));
    Object.assign(mate, near(shooter, (1 - sc.low) * 1.6, sc.meter * 3));
    p.loosePickup();
    out.rebound = b.owner?.id;
  }
  return out;
}

describe('pure skill (engine v2): luck never decides a play', () => {
  const all = scenarios(150);

  it('the same play gives the same result whatever the random stream', () => {
    for (const sc of all) {
      const expected = outcomes(STREAMS[0][1], sc);
      for (const [, rng] of STREAMS.slice(1)) expect(outcomes(rng, sc)).toEqual(expected);
    }
  });

  it('the scenarios cover both results of every kind of play', () => {
    const results = all.map((sc) => outcomes(STREAMS[2][1], sc));
    const seen = (f: (o: Record<string, unknown>) => unknown) => new Set(results.map((o) => JSON.stringify(f(o))));
    for (const kind of ['jump', 'layup', 'dunk'] as const) {
      expect(seen((o) => (o[kind] as { make: boolean }).make).size, `${kind} make and miss`).toBe(2);
      expect(seen((o) => (o[kind] as { blocked: boolean }).blocked).size, `${kind} blocked and not`).toBe(2);
    }
    for (const kind of ['steal', 'shove', 'pass', 'rebound']) expect(seen((o) => o[kind]).size, kind).toBeGreaterThan(1);
  });

  it('a jumper goes in on timing, position and defense', () => {
    const open: Scenario = { shooter: fromHoop(16, 0.3), meter: IDEAL_RELEASE, defender: { x: 20, y: 45 }, defZ: 0, mate: fromHoop(20, -1), low: 1 };
    const jump = (sc: Scenario) => outcomes(STREAMS[2][1], sc).jump;
    const { g, shooter } = stage(seededRng(1), open);
    const w = g.greenWindow(shooter);

    // Open: a perfect release and a Good one both drop; a very late one doesn't, and way off is an airball.
    expect(jump(open)).toMatchObject({ make: true, grade: 'perfect' });
    expect(jump({ ...open, meter: IDEAL_RELEASE + w * 1.8 })).toMatchObject({ make: true, grade: 'good' });
    expect(jump({ ...open, meter: IDEAL_RELEASE + w * 5 })).toMatchObject({ make: false, grade: 'very-late' });
    expect(jump({ ...open, meter: IDEAL_RELEASE + 0.45 })).toMatchObject({ make: false, airball: true });

    // The same Good release with a defender in the shooter's face misses; a dead-center one still drops.
    const smothered = { ...open, defender: near(open.shooter, 1.2, 0) };
    expect(jump({ ...smothered, meter: IDEAL_RELEASE + w * 1.8 })).toMatchObject({ make: false });
    expect(jump(smothered)).toMatchObject({ make: true });

    // Range: a Good release that drops from 16 feet comes up empty from 30.
    expect(jump({ ...open, shooter: fromHoop(30, 0.3), meter: IDEAL_RELEASE + w * 1.8 })).toMatchObject({ make: false });
  });

  it('an open layup always drops and a defender in the way stops it', () => {
    const open: Scenario = { shooter: fromHoop(5, 0.4), meter: IDEAL_RELEASE, defender: { x: 20, y: 45 }, defZ: 0, mate: fromHoop(20, -1), low: 1 };
    const layup = (sc: Scenario, rng: () => Rng) => outcomes(rng, sc).layup as { make: boolean };
    for (const [, rng] of STREAMS) {
      expect(layup(open, rng).make).toBe(true);
      expect(layup({ ...open, defender: near(open.shooter, 1, 0), defZ: 2 }, rng).make).toBe(false);
    }
  });
});


describe('pure skill: jump balls and overtime', () => {
  /** Runs a jump ball where the CPU jumpers go at set meter values; returns the team that won the tip. */
  function tip(g: Game, plan: [number, number]): TeamId {
    g.tipoff!.plan = plan;
    for (let i = 0; i < 900 && g.tipoff && !g.tipoff.to; i++) g.update(TICK);
    const e = g.events.find((x) => x.kind === 'jumpball');
    if (e?.kind !== 'jumpball') throw new Error('no jump ball');
    return e.winner.team;
  }
  const fresh = (rng: Rng, rosters?: [number[], number[]]) => {
    const g = new Game(config(3, [false, false], rosters));
    withRng(g, rng);
    return g;
  };

  it('the better-timed jump wins, the same way with any random stream', () => {
    const reference = tip(fresh(constant(0)), [0.95, 1.05]);
    for (const [, rng] of STREAMS) {
      expect(tip(fresh(rng()), [1, 1.3])).toBe(0);
      expect(tip(fresh(rng()), [1.3, 1])).toBe(1);
      expect(tip(fresh(rng()), [0.95, 1.05])).toBe(reference);
    }
  });

  it('a dead heat alternates: home takes the 1st jump ball, away the 2nd', () => {
    const mirror: [number[], number[]] = [HOME, HOME];
    for (const [, rng] of STREAMS) {
      expect(tip(fresh(rng(), mirror), [1, 1])).toBe(0);
      const g = fresh(rng(), mirror);
      g.quarter = 3;
      plays(g).startQuarter();
      g.events.length = 0;
      expect(tip(g, [1, 1])).toBe(1);
    }
  });

  it('the CPU tip timing is fixed, not rolled', () => {
    const plans = STREAMS.map(([, rng]) => fresh(rng()).tipoff!.plan);
    for (const p of plans) expect(p).toEqual(plans[0]);
  });

  it('overtime opens with a jump ball, not a coin flip', () => {
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

describe('pure skill: whole games and injuries', () => {
  const play = (rng: Rng, injuries = false) => {
    vi.spyOn(Math, 'random').mockImplementation(rng);
    const g = new Game({ ...config(11, [false, false]), quarterLen: 40, injuries });
    for (let i = 0; i < 100_000 && g.phase !== 'final'; i++) { g.update(TICK); g.events.length = 0; g.sfx.length = 0; }
    const box = [...g.players, ...g.bench].map((p) => ({ id: p.id, ...p.stats, hurt: p.hurt }));
    return { phase: g.phase, score: g.score, quarter: g.quarter, box };
  };

  it('a full CPU game plays out the same whatever Math.random returns', () => {
    const ref = play(constant(0));
    expect(ref.phase).toBe('final');
    expect(ref.score[0] + ref.score[1]).toBeGreaterThan(0);
    for (const [, rng] of STREAMS.slice(1)) expect(play(rng())).toEqual(ref);
  });

  it('injuries come from fatigue and contact, not a roll', () => {
    const ref = play(constant(0), true);
    for (const [, rng] of STREAMS.slice(1)) expect(play(rng(), true)).toEqual(ref);

    const g = new Game({ ...config(5, [false, false]), injuries: true, stamina: true });
    const [p] = g.teamPlayers(0);
    const hit = (energy: number) => {
      p.hurt = 0;
      p.energy = energy;
      (g as unknown as { maybeInjure(p: Player, b: number): void }).maybeInjure(p, 0.012);
      return p.hurt;
    };
    expect(hit(1)).toBe(0);
    expect(hit(0.5)).toBe(0);
    expect(hit(0.15)).toBe(1);
    expect(hit(0.01)).toBe(3);
    const mild = hit(0.15);
    expect(hit(0.15)).toBe(mild);
  });
});

describe('pure skill: franchise season sim', () => {
  it('results depend on ratings only, never on the seed', () => {
    const mons = [25, 381, 6, 445, 382, 94, 130, 149, 248, 150].map(monByDex);
    const mk = (seed: number): SimInput => ({
      seed,
      teams: ['A', 'B', 'C', 'D'].map((n, i) => ({
        name: n, abbr: n, color: '#fff', color2: '#000', roster: [...mons.slice(i), ...mons.slice(0, i)],
      })),
    });
    const ref = simulateSeason(mk(1));
    for (const seed of [0, 2, 99, 123456]) expect({ ...simulateSeason(mk(seed)), seed: 0 }).toEqual({ ...ref, seed: 0 });
  });
});

describe('pure skill: loose balls come from geometry', () => {
  type Staged = ReturnType<typeof stage>;
  const base: Scenario = { shooter: fromHoop(16, 0.3), meter: IDEAL_RELEASE, defender: { x: 20, y: 45 }, defZ: 0, mate: fromHoop(20, -1), low: 1 };
  const snap = (g: Game) => ({ b: { x: g.ball.x, y: g.ball.y, z: g.ball.z, vx: g.ball.vx, vy: g.ball.vy, vz: g.ball.vz, mode: g.ball.mode }, s: g.score });

  /** Stages one play, runs it to its first miss or block, then steps 30 more ticks. */
  const cases: [string, (st: Staged) => void][] = [
    ['jumper early', ({ g, p, shooter }) => { p.giveBall(shooter, true); shooter.state = 'shoot'; shooter.meter = IDEAL_RELEASE - 0.1; shooter.z = 1; p.releaseShot(shooter); for (let i = 0; i < 300 && g.ball.mode === 'shot'; i++) p.updateShot(TICK); }],
    ['jumper late', ({ g, p, shooter }) => { p.giveBall(shooter, true); shooter.state = 'shoot'; shooter.meter = IDEAL_RELEASE + g.greenWindow(shooter) * 5; shooter.z = 1; p.releaseShot(shooter); for (let i = 0; i < 300 && g.ball.mode === 'shot'; i++) p.updateShot(TICK); }],
    ['layup', ({ g, p, shooter, defender }) => { Object.assign(shooter, fromHoop(4, 0.4)); Object.assign(defender, near(shooter, 1, 0), { z: 2 }); p.giveBall(shooter, true); shooter.state = 'layup'; shooter.z = 1; p.releaseLayup(shooter); for (let i = 0; i < 300 && g.ball.mode === 'shot'; i++) p.updateShot(TICK); }],
    ['block', ({ g, p, shooter, defender }) => { Object.assign(defender, near(shooter, 1, 0), { z: 3, vx: 3, vy: 1 }); p.giveBall(shooter, true); shooter.state = 'shoot'; shooter.meter = IDEAL_RELEASE; shooter.z = 1; p.releaseShot(shooter); for (let i = 0; i < 300 && g.ball.mode === 'shot'; i++) p.updateShot(TICK); }],
    ['dunk', ({ p, shooter }) => { Object.assign(shooter, fromHoop(7, 0.2)); p.giveBall(shooter, true); p.startDunk(shooter, false); shooter.dunk!.make = false; for (let i = 0; i < 200 && shooter.state === 'dunk'; i++) p.updateDunk(shooter, TICK); }],
  ];

  for (const [name, run] of cases) {
    it(`${name}: the loose ball is identical under any Math.random`, () => {
      const results = STREAMS.map(([, rng]) => {
        const st = stage(rng(), base);
        run(st);
        for (let i = 0; i < 30; i++) st.g.update(TICK);
        return snap(st.g);
      });
      for (const r of results.slice(1)) expect(r).toEqual(results[0]);
    });
  }

  it('different releases bounce differently', () => {
    const outs = [-0.12, 0.12].map((o) => {
      const st = stage(constant(0), base);
      const { g, p, shooter } = st;
      p.giveBall(shooter, true); shooter.state = 'shoot'; shooter.meter = IDEAL_RELEASE + o; shooter.z = 1; p.releaseShot(shooter);
      for (let i = 0; i < 300 && g.ball.mode === 'shot'; i++) p.updateShot(TICK);
      return g.ball.vx + ',' + g.ball.vy;
    });
    expect(outs[0]).not.toBe(outs[1]);
  });
});

describe('pure skill: CPU games follow the matchup', () => {
  const run = (a: number[], b: number[]) => {
    const g = new Game({ ...config(0, [false, false], [a, b]), quarterLen: 40 });
    const seq: string[] = [];
    for (let i = 0; i < 100_000 && g.phase !== 'final'; i++) {
      g.update(TICK);
      for (const e of g.events) seq.push(e.kind);
      g.events.length = 0; g.sfx.length = 0;
    }
    return { score: g.score.join('-'), seq: seq.join(',') };
  };
  it('different teams play different games', () => {
    const pool = [HOME, AWAY, [3, 9, 65, 68, 143], [144, 145, 146, 131, 59]];
    const games = [run(pool[0], pool[1]), run(pool[2], pool[3]), run(pool[0], pool[2]), run(pool[1], pool[3])];
    expect(new Set(games.map((x) => x.score)).size).toBeGreaterThan(1);
    expect(new Set(games.map((x) => x.seq)).size).toBe(games.length);
  });
});

describe('gameplay has no random stream', () => {
  const dir = import.meta.glob('./*.ts', { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
  const files = Object.entries(dir).filter(([n]) => !/\.test\.ts$/.test(n) && !/\/(render|audio)\.ts$/.test(n));
  const all: [string, string][] = [...files, ['season/sim.ts', simSrc]];
  it('scans every gameplay source', () => {
    expect(files.map(([n]) => n)).toEqual(expect.arrayContaining(['./game.ts', './ai.ts', './types.ts']));
  });
  for (const [name, text] of all) {
    it(name, () => {
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
      expect(code.length).toBeGreaterThan(300);
      expect(code).not.toMatch(/Math\.random|\brng\b|\brandn?\(|\bseeded\(/);
    });
  }
});
