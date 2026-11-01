import { describe, expect, it, vi } from 'vitest';
import { POKEMON, POSITIONS, type Mon } from '../data/pokemon';
import { Game } from '../game/game';
import {
  MOVEMENT_SPOTS, PRACTICE_DRILLS, PRACTICE_STAGES, movementSpot, reachedSpot, type PracticeDrill,
} from '../game/practice';
import { COURT_L, COURT_W, emptyIntent, isThree, type GameConfig, type TeamDef } from '../game/types';

// GameConfig.practice (the tutorial): the CPU never steals or shoves and reacts slowly; unset, nothing changes.
const by = (p: string) => POKEMON.filter((m) => m.pos === p).sort((a, b) => b.ovr - a.ovr);
const five = (i: number): Mon[] => POSITIONS.map((p) => by(p)[i]);
const team = (name: string, roster: Mon[], human: boolean): TeamDef =>
  ({ name, abbr: name.slice(0, 3).toUpperCase(), color: '#e33', color2: '#222', roster, human });
const cfg = (practice?: boolean): GameConfig => ({
  home: team('You', five(0), true), away: team('Cpu', five(1), false),
  quarterLen: 30, difficulty: 'rookie', seed: 7, stamina: false, autoSwitch: true, ...(practice ? { practice } : {}),
});

/** Plays a whole seeded game with the user idle; returns CPU steals and the final score. */
function run(c: GameConfig) {
  const g = new Game(c);
  let cpuSteals = 0;
  for (let n = 0; g.phase !== 'final' && n < 400000; n++) {
    g.update(1 / 60);
    for (const e of g.events) if (e.kind === 'steal' && e.player.team === 1) cpuSteals++;
    g.events.length = 0;
    g.sfx.length = 0;
  }
  return { cpuSteals, score: [...g.score] };
}

describe('practice CPU', () => {
  it('has no aggression and slow reactions only on the CPU side', () => {
    const g = new Game(cfg(true));
    const cpu = g.teamPlayers(1)[0];
    const me = g.teamPlayers(0)[0];
    expect(g.aggro(cpu)).toBe(0);
    expect(g.reactTime(cpu)).toBeGreaterThanOrEqual(1.5);
    expect(g.aggro(me)).toBe(new Game(cfg()).aggro(me));
  });

  it('never steals from an idle user over a whole game', () => {
    expect(run(cfg(true)).cpuSteals).toBe(0);
  });

  it('practice starts live with the user holding the ball (no jump ball); normal games still tip off', () => {
    const g = new Game(cfg(true));
    g.update(1 / 60);
    expect(g.tipoff).toBeNull();
    expect(g.ball.mode).toBe('held');
    expect(g.ball.owner?.team).toBe(0);
    expect(g.ball.owner).toBe(g.user);
    // After the inbound pause the game goes live with the user still holding (play.ts: A reads PASS).
    for (let i = 0; i < 150 && g.phase === 'tip'; i++) g.update(1 / 60);
    expect(g.phase).toBe('live');
    expect(g.ball.owner).toBe(g.user);
    const n = new Game(cfg());
    n.update(1 / 60);
    expect(n.tipoff).not.toBeNull();
  });
});

// Training drill setups (GameConfig.drill, src/game/practice.ts): practice only, normal games unchanged.
const drillCfg = (drill: PracticeDrill, practice = true): GameConfig => ({ ...cfg(practice), drill });
/** Steps until the staging pause is over (phase goes live). */
function live(g: Game) {
  for (let i = 0; i < 120 && g.phase !== 'live'; i++) g.update(1 / 60);
  expect(g.phase).toBe('live');
}
const userBallDrills: PracticeDrill[] = ['movement', 'layups', 'jumpshots', 'passing'];

describe('practice drill setups', () => {
  it.each(userBallDrills)('%s: the user starts with the ball on their stage spot, no jump ball', (d) => {
    const g = new Game(drillCfg(d));
    expect(g.drill).toBe(d);
    expect(g.tipoff).toBeNull();
    live(g);
    expect(g.ball.owner).toBe(g.user);
    expect(g.user!.team).toBe(0);
    const [x, y] = PRACTICE_STAGES[d].user[0];
    expect(Math.hypot(g.user!.x - x, g.user!.y - y)).toBeLessThan(1.5);
  });

  it('layups and jump shots start in range with every defender behind the user', () => {
    for (const d of ['layups', 'jumpshots'] as const) {
      const g = new Game(drillCfg(d));
      const me = g.user!;
      expect(g.distToHoop(me)).toBeLessThan(d === 'layups' ? 20 : 23.75);
      for (const q of g.teamPlayers(1)) expect(q.x).toBeLessThan(me.x);
    }
    const j = new Game(drillCfg('jumpshots')).user!;
    expect(isThree(j.x, j.y, 0)).toBe(false);
  });

  it('passing: every teammate is open (no defender within 15 ft)', () => {
    const g = new Game(drillCfg('passing'));
    for (const p of g.teamPlayers(0)) if (p !== g.user) expect(g.openness(p)).toBeGreaterThan(15);
  });

  it('movement: six cones on the user frontcourt, reachable from the stage', () => {
    expect(MOVEMENT_SPOTS).toHaveLength(6);
    for (const [x, y] of MOVEMENT_SPOTS) {
      expect(x).toBeGreaterThan(COURT_L / 2);
      expect(x).toBeLessThan(COURT_L);
      expect(y).toBeGreaterThan(0);
      expect(y).toBeLessThan(COURT_W);
    }
    expect(reachedSpot({ x: 66, y: 10 }, 0, 0)).toBe(true);
    expect(reachedSpot({ x: 66, y: 16 }, 0, 0)).toBe(false);
    expect(movementSpot(0, 1)).toEqual({ x: COURT_L - 66, y: 10 });
    expect(movementSpot(6, 0)).toBeNull();
  });

  it('movement: the clocks stand still, so holding the ball never ends the drill', () => {
    const g = new Game(drillCfg('movement'));
    live(g);
    const clock = g.clock;
    for (let i = 0; i < 60 * 40; i++) g.update(1 / 60);
    expect(g.clock).toBe(clock);
    expect(g.shotClock).toBe(24);
    expect(g.ball.owner?.team).toBe(0);
  });

  it('defense: the CPU has the ball and runs plays; the user guards the handler; a CPU bucket restages it', () => {
    const g = new Game(drillCfg('defense'));
    live(g);
    expect(g.ball.owner?.team).toBe(1);
    expect(g.user!.team).toBe(0);
    expect(g.user!.slot).toBe(0);
    // The user stands between the handler and the hoop he attacks (the left one).
    expect(g.user!.x).toBeLessThan(g.ball.owner!.x);
    let scored = false;
    let restaged = false;
    for (let i = 0; i < 60 * 60 && !restaged; i++) {
      g.update(1 / 60);
      if (g.events.some((e) => e.kind === 'score' && e.player.team === 1)) scored = true;
      if (scored && g.phase === 'live' && g.ball.owner?.team === 1 && g.ball.owner.slot === 0) restaged = true;
      g.events.length = 0;
    }
    expect(scored).toBe(true);
    expect(restaged).toBe(true);
    expect(g.ball.owner!.x).toBeCloseTo(PRACTICE_STAGES.defense.cpu[0][0], 0);
  });

  it('steals: the CPU handler only dribbles, and a user steal restages the CPU with the ball', () => {
    const g = new Game(drillCfg('steals'));
    live(g);
    const h = g.ball.owner!;
    expect(h.team).toBe(1);
    expect(Math.hypot(g.user!.x - h.x, g.user!.y - h.y)).toBeLessThan(6);
    // Idle user: the CPU never shoots or passes away its dribble.
    for (let i = 0; i < 60 * 20; i++) {
      g.update(1 / 60);
      for (const e of g.events) expect(e.kind === 'release' || e.kind === 'score').toBe(false);
      g.events.length = 0;
      expect(g.ball.mode).toBe('held');
      expect(g.ball.owner).toBe(h);
    }
    // Chase and swipe until a steal lands, then the drill resets with the CPU holding again.
    let stole = false;
    for (let i = 0; i < 60 * 30 && !stole; i++) {
      const me = g.user!;
      const o = g.ball.owner;
      g.userInput = { ...emptyIntent(), mx: o ? Math.sign(o.x - me.x) : 0, my: o ? Math.sign(o.y - me.y) : 0, steal: i % 20 === 0 };
      g.update(1 / 60);
      if (g.events.some((e) => e.kind === 'steal' && e.player.team === 0)) stole = true;
      g.events.length = 0;
    }
    expect(stole).toBe(true);
    g.userInput = emptyIntent();
    live(g);
    for (let i = 0; i < 120 && g.ball.owner?.team !== 1; i++) g.update(1 / 60);
    expect(g.ball.owner?.team).toBe(1);
    expect(g.ball.owner?.slot).toBe(0);
  });

  it('a CPU rebound in a user-ball drill restages it with the user holding again', () => {
    const g = new Game(drillCfg('jumpshots'));
    live(g);
    g.update(1 / 60);
    // Force a turnover: hand the ball to the CPU.
    const cpu = g.teamPlayers(1)[0];
    (g as unknown as { giveBall(p: unknown): void }).giveBall(cpu);
    g.update(1 / 60);
    expect(g.phase).toBe('dead');
    live(g);
    expect(g.ball.owner).toBe(g.user);
    expect(g.user!.slot).toBe(0);
  });

  it('setDrill switches drills mid-game; ignored outside practice; normal games never stage', () => {
    const g = new Game(cfg(true));
    expect(g.drill).toBeNull();
    g.setDrill('steals');
    live(g);
    expect(g.ball.owner?.team).toBe(1);
    g.setDrill('passing');
    live(g);
    expect(g.ball.owner).toBe(g.user);
    const n = new Game(drillCfg('layups', false));
    expect(n.drill).toBeNull();
    n.setDrill('layups');
    expect(n.drill).toBeNull();
    n.update(1 / 60);
    expect(n.tipoff).not.toBeNull();
  });

  it('every drill keeps the passive CPU (no aggression, slow reactions)', () => {
    for (const d of PRACTICE_DRILLS) {
      const g = new Game(drillCfg(d));
      for (const q of g.teamPlayers(1)) {
        expect(g.aggro(q)).toBe(0);
        expect(g.reactTime(q)).toBeGreaterThanOrEqual(1.5);
      }
    }
  });

  it('tutorialConfig stages the drill; markers resolve to cones, zones and the pass lane', async () => {
    vi.stubGlobal('location', { search: '' }); // play.ts reads ?speed at import
    const { tutorialConfig, drillMarkers, DRILL_QUARTER } = await import('../screens/tutorial');
    const c = tutorialConfig({ teamName: 'Pallet' } as Parameters<typeof tutorialConfig>[0], 'passing');
    expect(c.practice).toBe(true);
    expect(c.drill).toBe('passing');
    expect(c.quarterLen).toBe(DRILL_QUARTER);
    expect(tutorialConfig({ teamName: 'Pallet' } as Parameters<typeof tutorialConfig>[0]).drill).toBeUndefined();
    const g = new Game(c);
    const ms = drillMarkers(g, [{ kind: 'spot', index: 2, of: 6 }, { kind: 'zone', zone: 'mid' }, { kind: 'passLane' }]);
    expect(ms[0]).toEqual({ kind: 'spot', x: MOVEMENT_SPOTS[2][0], y: MOVEMENT_SPOTS[2][1] });
    expect(ms[1]).toEqual({ kind: 'zone', zone: 'mid', team: 0 });
    expect(ms[2]).toMatchObject({ kind: 'lane', from: g.ball.owner!.id });
    vi.unstubAllGlobals();
  });
});
