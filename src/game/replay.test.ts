import { describe, expect, it } from 'vitest';
import { COURTS } from '../data/courts';
import { monByDex } from '../data/pokemon';
import { Game } from './game';
import { ReplayRecorder } from './replay';
import { stateHash } from './sync';
import { emptyIntent, seededRng, type GameConfig, type Intent, type TeamDef } from './types';

const team = (name: string, human: boolean, dexes: number[], bench: number[] = []): TeamDef => ({
  name, abbr: name.slice(0, 3).toUpperCase(), color: '#3b6fd8', color2: '#16224a', human, roster: dexes.map(monByDex), bench: bench.map(monByDex),
});
const config = (seed: number): GameConfig => ({
  home: team('Pallet Town', true, [25, 381, 6, 445, 382], [26, 9, 3, 143, 131]),
  away: team('Indigo Elite', false, [94, 130, 149, 248, 150], [65, 68, 59, 34, 31]),
  quarterLen: 30, difficulty: 'pro', court: COURTS['Indigo Elite'], stamina: true, seed,
});

/** A player who changes what they're doing now and then, with full-precision sticks (like a real gamepad). */
function player(seed: number) {
  const rng = seededRng(seed);
  let held = emptyIntent();
  return (): Intent => {
    if (rng() < 0.08) { held = emptyIntent(); held.mx = rng() * 2 - 1; held.my = rng() * 2 - 1; held.turbo = rng() < 0.3; }
    const shoot = rng() < 0.03;
    return { ...held, shoot, shootHeld: shoot || held.shootHeld, pass: rng() < 0.01, steal: rng() < 0.01, special: rng() < 0.004 };
  };
}

/** The play screen's loop, offline: record every tick, ask for a sub and flip auto subs partway through. */
function playRecorded(seed: number) {
  const cfg = config(seed);
  const g = new Game(cfg);
  const rec = new ReplayRecorder(cfg, g.seed);
  const input = player(seed + 1);
  const live = new Map<number, number>();
  for (let t = 0; g.phase !== 'final' && t < 100_000; t++) {
    if (t === 2000) { g.cfg.userAutoSubs = false; rec.autoSubs(false); }
    if (t === 2600) {
      const out = g.players.find((p) => p.team === 0)!;
      const inn = g.bench.find((p) => p.team === 0)!;
      if (g.requestSub(out, inn)) rec.sub(out, inn);
    }
    if (t === 4000) { g.cfg.userAutoSubs = true; rec.autoSubs(true); }
    g.userInput = rec.before(g, input());
    const n = g.events.length;
    g.update(1 / 60);
    rec.after(g, g.events.slice(n));
    live.set(rec.tick, stateHash(g));
    g.events.length = 0;
    g.sfx.length = 0;
  }
  return { g, rec, live };
}

describe('play of the game', () => {
  it('picks a play, and rebuilds it tick for tick the way it went live', () => {
    for (const seed of [3, 11, 29]) {
      const { g, rec, live } = playRecorded(seed);
      expect(g.phase).toBe('final');
      const h = rec.best(g)!;
      expect(h, `seed ${seed}`).toBeTruthy();
      const clip = rec.clip(h)!;
      expect(clip, `seed ${seed}: clip`).toBeTruthy();
      let sawMoment = false;
      while (!clip.done) {
        clip.step();
        expect(stateHash(clip.game), `seed ${seed} tick ${clip.tick}`).toBe(live.get(clip.tick));
        if (clip.tick === h.tick) sawMoment = true;
        clip.game.events.length = 0;
        clip.game.sfx.length = 0;
      }
      expect(clip.ok).toBe(true);
      expect(sawMoment).toBe(true);
      expect(clip.tick).toBe(clip.end);
    }
  });

  it('the moment shows up in the replay: the same event, by the same player, on the same tick', () => {
    const { g, rec } = playRecorded(5);
    const h = rec.best(g)!;
    const clip = rec.clip(h)!;
    const kinds = { dunk: 'score', oop: 'score', three: 'score', buzzer: 'buzzerbeater', block: 'block', steal: 'steal', fire: 'fire', special: 'special' } as const;
    let found = false;
    while (!clip.done) {
      clip.step();
      if (clip.tick === h.tick) found = clip.game.events.some((e) => e.kind === kinds[h.kind] && 'player' in e && e.player.id === h.playerId);
      clip.game.events.length = 0;
    }
    expect(found).toBe(true);
  });

  it('"game winner" only ever means the winners\' last lead change, late in the game', () => {
    for (const seed of [3, 5, 11, 17, 29, 41]) {
      const { g, rec } = playRecorded(seed);
      const h = rec.best(g)!;
      if (!h.title.startsWith('GAME WINNER')) continue;
      expect(h.team).toBe(g.score[0] > g.score[1] ? 0 : 1);
      expect(h.tick).toBe((rec as unknown as { lastLeadChange: number }).lastLeadChange);
    }
  });

  it('a blowout has no game winner: a late dunk by a team that led all game is just a dunk', () => {
    const cfg = config(1);
    const g = new Game(cfg);
    const rec = new ReplayRecorder(cfg, g.seed);
    const p = g.players.find((x) => x.team === 1)!;
    const at = (quarter: number, score: [number, number]) => { g.score = score; g.quarter = quarter; g.clock = 10; return g; };
    // Team 1 scores first and never trails: the only lead change is that first basket, early in the game.
    rec.after(at(1, [0, 2]), [{ kind: 'score', player: p, points: 2, how: 'layup' }]);
    for (let i = 0; i < 400; i++) rec.after(at(2, [0, 10]), []);
    rec.after(at(4, [0, 20]), [{ kind: 'score', player: p, points: 2, how: 'dunk' }]);
    const h = rec.best(at(4, [0, 20]))!;
    expect(h.kind).toBe('dunk');
    expect(h.title).toBe('SLAM DUNK');
  });

  it('refuses to show a replay that does not match what was played', () => {
    const { g, rec } = playRecorded(3);
    const h = rec.best(g)!;
    // Tamper with one recorded input inside the clip: the rebuild must notice and give up, not show a wrong play.
    const log = (rec as unknown as { log: { input: { mx: number } }[] }).log;
    for (let t = h.tick - 200; t < h.tick; t++) if (log[t]) log[t].input.mx = log[t].input.mx > 0 ? -1 : 1;
    const clip = rec.clip(h);
    if (clip) {
      while (!clip.done) clip.step();
      expect(clip.ok).toBe(false);
    }
  });
});
