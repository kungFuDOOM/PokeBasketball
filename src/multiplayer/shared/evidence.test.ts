// The evidence path end to end: two lockstep clients sign every input batch they send (EvidenceLog), keep what
// they receive, and the judge reaches the score both clients saw from what they upload.
import { describe, expect, it } from 'vitest';
import { Game } from '../../game/game';
import { emptyIntent, seededRng, ENGINE_VERSION, type Intent } from '../../game/types';
import { EvidenceLog, cover, pack, unpack } from './evidence';
import { Lockstep, type NetMsg } from './lockstep';
import { gameConfigFor, judge, matchKey, type Evidence, type MatchSetup, type SignedInputs } from './winnerCheck';

const setup: MatchSetup = {
  matchId: 'evidence-it', engineVersion: ENGINE_VERSION, seed: 2026, quarterLen: 10,
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

/** A full match over a jittery, lossy link, every 'in' batch signed on the way out, as MatchLink does it. */
async function signedMatch(seed: number, drop: number) {
  const keys = [await matchKey(), await matchKey()];
  const logs = [new EvidenceLog(keys[0].privateKey, setup.matchId, 0), new EvidenceLog(keys[1].privateKey, setup.matchId, 1)];
  const rng = seededRng(seed);
  let now = 0;
  const queue: { at: number; to: 0 | 1; m: NetMsg }[] = [];
  const pending: Promise<void>[] = [];
  const games = [new Game(gameConfigFor(setup)), new Game(gameConfigFor(setup))];
  const link = (from: 0 | 1) => ({
    send(m: NetMsg) {
      const go = (x: NetMsg) => {
        if (x.k === 'in' && rng() < drop) return;
        queue.push({ at: now + 30 + rng() * 110, to: (1 - from) as 0 | 1, m: JSON.parse(JSON.stringify(x)) });
      };
      if (m.k === 'in') pending.push(logs[from].sign(m).then(go));
      else go(m);
    },
  });
  const ls = [0, 1].map((s) => new Lockstep(games[s], link(s as 0 | 1), { side: s as 0 | 1, now: () => now }));
  const players = [player(seed + 1), player(seed + 2)];
  const held: Intent[] = [players[0](), players[1]()];
  for (let f = 0; (games[0].phase !== 'final' || games[1].phase !== 'final') && f < 100_000; f++) {
    now += 1000 / 60 + (rng() - 0.5) * 6;
    if (pending.length) await Promise.all(pending.splice(0)); // signatures finish between frames, as in the browser
    queue.sort((a, b) => a.at - b.at);
    while (queue.length && queue[0].at <= now) {
      const q = queue.shift()!;
      logs[q.to].received(q.m);
      ls[q.to].receive(q.m);
    }
    for (const s of [0, 1]) {
      if (ls[s].advance(held[s], 1 / 60) > 0) held[s] = players[s]();
      games[s].events.length = 0;
      games[s].sfx.length = 0;
    }
  }
  for (const l of ls) l.maybeSend(true);
  await Promise.all(pending.splice(0));
  const pub: [string, string] = [keys[0].publicKey, keys[1].publicKey];
  return { games, ls, logs, ev: [logs[0].evidence(setup, pub), logs[1].evidence(setup, pub)] };
}

const merge = (a: Evidence, b: Evidence): Evidence => ({ ...a, inputs: [...a.inputs, ...b.inputs] });

describe('signed evidence from real lockstep play', () => {
  it('the judge reaches the score both clients saw, from both uploads or from either one alone', async () => {
    const m = await signedMatch(5, 0.15);
    expect(m.games[0].phase).toBe('final');
    const score = [m.games[0].score[0], m.games[0].score[1]];
    expect([m.games[1].score[0], m.games[1].score[1]]).toEqual(score);
    for (const ev of [merge(m.ev[0], m.ev[1]), m.ev[0], m.ev[1]]) {
      const v = await judge(ev);
      expect(v.status, v.notes.join('; ')).toBe('final');
      expect(v.score).toEqual(score);
      expect(v.winner).toBe(score[0] > score[1] ? 0 : 1);
    }
  }, 180_000);

  it('the upload is small: trimmed of overlapping resends, gzipped, and it unpacks to the same evidence', async () => {
    const m = await signedMatch(9, 0.1);
    const raw = m.logs[0].mine.length + m.logs[0].theirs.length;
    expect(m.ev[0].inputs.length).toBeLessThan(raw);
    const packed = await pack(m.ev[0]);
    expect(packed.length).toBeLessThan(JSON.stringify(m.ev[0]).length / 2);
    expect(JSON.stringify(await unpack(packed))).toBe(JSON.stringify(m.ev[0]));
    const v = await judge(await unpack(packed));
    expect(v.status).toBe('final');
  }, 180_000);

  it('a player who re-signs a different input for a tick they already sent is caught, even after trimming', async () => {
    const m = await signedMatch(11, 0.1);
    // Player 1 tries to rewrite history: a new signed batch for ticks it already sent, saying something else.
    const theirs = m.logs[0].theirs[Math.floor(m.logs[0].theirs.length / 2)];
    const forged: SignedInputs = { ...theirs, frames: theirs.frames.map(([, , b]) => [1, -1, b] as [number, number, number]) };
    // Signed with player 1's own key (a cheater has that), after the game.
    const rewrite = await m.logs[1].sign({ k: 'in', s: forged.from - 1, r: forged.frames.map(([mx, my, b]) => [1, mx, my, b]), a: 0 });
    const ev = merge(m.ev[0], { ...m.ev[1], inputs: [...m.ev[1].inputs, { side: 1, from: forged.from, frames: forged.frames, sig: rewrite.g! }] });
    const v = await judge(ev);
    expect(v.status).toBe('forfeit');
    expect(v.cheater).toBe(1);
  }, 180_000);
});

describe('evidence bookkeeping', () => {
  const b = (from: number, frames: number[], sig = 'x'): SignedInputs => ({ side: 0, from, frames: frames.map((v) => [v, 0, 0]), sig });

  it('cover keeps the fewest batches that still cover every frame', () => {
    const all = [b(1, [0, 0, 0]), b(2, [0, 0, 0, 0]), b(3, [0, 0]), b(6, [0, 0, 0]), b(20, [0])];
    const kept = cover(all);
    const frames = new Set(kept.flatMap((x) => x.frames.map((_, k) => x.from + k)));
    for (const x of all) for (let k = 0; k < x.frames.length; k++) expect(frames.has(x.from + k)).toBe(true);
    expect(kept.length).toBeLessThan(all.length);
  });

  it('cover never drops a batch that contradicts another (that is the proof of cheating)', () => {
    const honest = b(1, [0, 0, 0, 0]);
    const lie = b(2, [0, 1], 'other');
    expect(cover([honest, lie])).toContain(lie);
  });

  it('received() ignores anything that is not a well-formed signed batch', () => {
    const log = new EvidenceLog({} as CryptoKey, 'm', 0);
    const good = { k: 'in', s: 10, r: [[3, 0.5, -0.5, 2]], a: 0, g: 'a'.repeat(128) };
    for (const bad of [null, 7, { ...good, k: 'h' }, { ...good, g: 'zz' }, { ...good, g: undefined }, { ...good, s: -1 },
      { ...good, r: [[1e9, 0, 0, 0]] }, { ...good, r: 'x' }, { ...good, r: [[1, NaN, 0, 0]] }]) log.received(bad);
    expect(log.theirs).toHaveLength(0);
    log.received(good);
    expect(log.theirs).toEqual([{ side: 1, from: 11, frames: [[0.5, -0.5, 2], [0.5, -0.5, 2], [0.5, -0.5, 2]], sig: 'a'.repeat(128) }]);
  });
});
