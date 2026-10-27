// Integration: kfd's real Lockstep (#8) plus the winner check (#9). Two clients play a full game over a jittery,
// lossy link; every 'in' message each side sends is signed with signTicks, exactly as docs/multiplayer.md asks.
// The judge, given only that signed evidence, must reach the same final score both clients saw.
import { describe, expect, it } from 'vitest';
import { Game } from '../../game/game';
import { ENGINE_VERSION, emptyIntent, seededRng, type Intent } from '../../game/types';
import type { WireInput } from '../../game/sync';
import { Lockstep, MIN_DELAY, type NetMsg } from './lockstep';
import { gameConfigFor, judge, matchKey, signTicks, type MatchSetup, type SignedInputs } from './winnerCheck';

const setup: MatchSetup = {
  matchId: 'lockstep-it', engineVersion: ENGINE_VERSION, seed: 4242, quarterLen: 12,
  home: { name: 'Pallet Town', abbr: 'PAL', color: '#3b6fd8', color2: '#16224a', roster: [25, 381, 6, 445, 382] },
  away: { name: 'Indigo Elite', abbr: 'IND', color: '#e3350d', color2: '#3d0a03', roster: [94, 130, 149, 248, 150] },
};

function player(seed: number) {
  const rng = seededRng(seed);
  let held = emptyIntent();
  return (): Intent => {
    if (rng() < 0.08) { held = emptyIntent(); held.mx = rng() * 2 - 1; held.my = rng() * 2 - 1; held.turbo = rng() < 0.3; }
    const shoot = rng() < 0.03;
    return { ...held, shoot, shootHeld: shoot, pass: rng() < 0.01, steal: rng() < 0.01 };
  };
}

/** Expand an 'in' message's runs into one input per tick, starting at tick m.s. */
const expand = (m: Extract<NetMsg, { k: 'in' }>): WireInput[] => m.r.flatMap(([n, mx, my, b]) => Array.from({ length: n }, () => ({ mx, my, b })));

async function signedMatch(seed: number, drop: number) {
  const keys = [await matchKey(), await matchKey()];
  const rng = seededRng(seed);
  let now = 0;
  const queue: { at: number; to: 0 | 1; m: NetMsg }[] = [];
  const signing: Promise<SignedInputs>[] = [];
  const games = [new Game(gameConfigFor(setup)), new Game(gameConfigFor(setup))];
  const link = (from: 0 | 1) => ({
    send(m: NetMsg) {
      // The sender signs what it sends (and keeps it) even if the network then drops it.
      if (m.k === 'in' && m.r.length) signing.push(signTicks(keys[from].privateKey, setup.matchId, from, m.s, expand(m)));
      if (m.k === 'in' && rng() < drop) return;
      queue.push({ at: now + 30 + rng() * 110, to: (1 - from) as 0 | 1, m: JSON.parse(JSON.stringify(m)) });
    },
  });
  const ls = [0, 1].map((s) => new Lockstep(games[s], link(s as 0 | 1), { side: s as 0 | 1, now: () => now }));
  const players = [player(seed + 1), player(seed + 2)];
  const held: Intent[] = [players[0](), players[1]()];
  for (let f = 0; (games[0].phase !== 'final' || games[1].phase !== 'final') && f < 200_000; f++) {
    now += 1000 / 60 + (rng() - 0.5) * 6;
    queue.sort((a, b) => a.at - b.at);
    while (queue.length && queue[0].at <= now) { const q = queue.shift()!; ls[q.to].receive(q.m); }
    for (const s of [0, 1]) {
      if (ls[s].advance(held[s], 1 / 60) > 0) held[s] = players[s]();
      games[s].events.length = 0;
      games[s].sfx.length = 0;
    }
  }
  // Flush any inputs scheduled past the last tick, as a client does when it says goodbye.
  for (const l of ls) l.maybeSend(true);
  const inputs = await Promise.all(signing);
  return { games, ls, keys, evidence: { setup, keys: [keys[0].publicKey, keys[1].publicKey] as [string, string], inputs, applied: [], lockstep: { emptyTicks: MIN_DELAY } } };
}

describe("winner check on kfd's lockstep", () => {
  it('judges a full lockstep game over a lossy link to the exact score both clients saw', async () => {
    const m = await signedMatch(7, 0.15);
    expect(m.games[0].phase).toBe('final');
    expect([m.games[1].score[0], m.games[1].score[1]]).toEqual([m.games[0].score[0], m.games[0].score[1]]);
    const v = await judge(m.evidence);
    expect(v.notes).toEqual([]);
    expect(v.status).toBe('final');
    expect(v.score).toEqual([m.games[0].score[0], m.games[0].score[1]]);
    expect(v.ticks).toBe(m.ls[0].tick);
  }, 120_000);

  it('a player who re-signs a different input for a tick they already sent forfeits', async () => {
    const m = await signedMatch(11, 0.1);
    const rewrite = await signTicks(m.keys[1].privateKey, setup.matchId, 1, 400, [{ mx: 1, my: -1, b: 2 }]);
    const v = await judge({ ...m.evidence, inputs: [...m.evidence.inputs, rewrite] });
    expect(v.status).toBe('forfeit');
    expect(v.cheater).toBe(1);
  }, 120_000);
});
