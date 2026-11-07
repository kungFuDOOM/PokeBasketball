import { describe, expect, it, vi } from 'vitest';
import { POKEMON, type Mon } from '../data/pokemon';
import { callFor } from '../game/announcer';
import type { Sfx } from '../game/game';
import { Game } from '../game/game';
import type { GameEvent } from '../game/types';
import type { RunEvent } from '../threept/run';
import { IDEAL_RELEASE, METER_TIME } from '../threept/shot';
import { RESUME_KEY, takeResume } from '../wallet/staleBuild';

// The screen module pulls in sprites / input helpers that read `window` lazily; there is no DOM in these tests.
vi.stubGlobal('window', {});
const { contestFrame, newContestRun } = await import('./threept');

const sharp: Mon = { ...POKEMON[0], r: { ...POKEMON[0].r, sht: 100 } };
/** A Pokémon whose special is Blaze (catch fire), the case most likely to light up. */
const blazer = POKEMON.find((m) => m.special === 'blaze')!;

/** Plays a whole contest through the screen's own frame function at 60 fps, perfect release every ball. */
function playLikeTheScreen(shooter: Mon) {
  const run = newContestRun(shooter, 2);
  (run.game as unknown as { rng: () => number }).rng = () => 0; // every shot drops
  const runEvents: RunEvent[] = [];
  const gameEvents: GameEvent[] = [];
  const sounds: Sfx[] = [];
  let fireFrames = 0;
  let prevHeld = false;
  const dt = 1 / 60;
  for (let i = 0; i < 120 * 60 && run.stage !== 'over'; i++) {
    // The screen derives `pressed` as the edge of `held`, like threept.ts renderPlay's frame.
    const held = run.stage === 'aim' || (run.stage === 'hold' && run.meter + dt / METER_TIME < IDEAL_RELEASE);
    const pressed = held && !prevHeld;
    prevHeld = held;
    contestFrame(run, dt, { pressed, held }, { run: (e) => runEvents.push(e), game: (e) => gameEvents.push(...e), sfx: (s) => sounds.push(s) });
    // What the renderer keys its flames on: the player's fire flag (body flames) and the ball holder / shooter's (flame ball).
    const b = run.game.ball;
    if (run.player.fire || b.owner?.fire || b.shot?.shooter.fire) fireFrames++;
  }
  return { run, runEvents, gameEvents, sounds, fireFrames };
}

describe('3-Point Contest screen: no on-fire at all', () => {
  it('builds its game with noFire through the screen factory', () => {
    const run = newContestRun(sharp, 2);
    expect(run.game).toBeInstanceOf(Game);
    expect(run.game.cfg.noFire).toBe(true);
  });

  for (const [label, mon] of [['a 100-Sht shooter', sharp], [`a Blaze shooter (${blazer.name})`, blazer]] as const) {
    it(`${label} makes all 25 through the screen's frame loop and never heats up or catches fire`, () => {
      const { run, gameEvents, sounds, fireFrames } = playLikeTheScreen(mon);
      expect(run.stage).toBe('over');
      expect(run.s.results.filter((b) => b.result === 'make').length).toBeGreaterThanOrEqual(3);
      expect(run.player.streak).toBeGreaterThanOrEqual(3); // the streak a normal game would have set alight
      expect(fireFrames).toBe(0);
      const kinds = gameEvents.map((e) => e.kind);
      expect(kinds).not.toContain('fire');
      expect(kinds).not.toContain('heating'); // "X is heating up!" (hud.ts) and the heating call
      expect(sounds).not.toContain('fire');
      // Nothing the screen hands on would make the announcer call heating / on fire / cooled.
      const calls = gameEvents.map(callFor);
      for (const c of ['heating', 'fire', 'cooled'] as const) expect(calls).not.toContain(c);
    });
  }

  it('the normal game still heats up and catches fire on a streak', () => {
    const team = (human: boolean) => ({ name: 'A', abbr: 'A', color: '#f00', color2: '#fff', roster: [sharp, sharp, sharp, sharp, sharp], human });
    const g = new Game({ home: team(true), away: team(false), quarterLen: 120, difficulty: 'pro', stamina: false, seed: 1 });
    const p = g.players.find((q) => q.team === 0)!;
    const score = (g as unknown as { scoreBasket(p: unknown, pts: number, how: string): void }).scoreBasket.bind(g);
    score(p, 3, 'jump');
    score(p, 3, 'jump');
    expect(g.events.some((e) => e.kind === 'heating')).toBe(true);
    score(p, 3, 'jump');
    expect(p.fire).toBe(true);
    expect(g.events.some((e) => e.kind === 'fire' && e.on)).toBe(true);
  });
});

describe('stale-build reload from the contest menus', () => {
  it('reopens the 3-Point Contest once, then forgets', () => {
    const m = new Map<string, string>();
    vi.stubGlobal('sessionStorage', { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) });
    m.set(RESUME_KEY, 'threept');
    expect(takeResume()).toBe('threept');
    expect(takeResume()).toBe(null);
    m.set(RESUME_KEY, 'something-else');
    expect(takeResume()).toBe(null);
    vi.unstubAllGlobals();
  });
});
