import { describe, expect, it } from 'vitest';
import { Game } from '../../game/game';
import { packInput, stepGame, type WireInput } from '../../game/sync';
import { ENGINE_VERSION, emptyIntent, seededRng } from '../../game/types';
import {
  gameConfigFor, inputForTick, judge, matchKey, replay, signApplied, signInputs, signTicks, PRESS_BITS,
  type Evidence, type MatchSetup, type SignedApplied, type SignedInputs,
} from './winnerCheck';

/** Lockstep's warm-up: the first ticks carry no input from either side. */
const EMPTY_TICKS = 4;

/**
 * A live lockstep match the way shared/lockstep.ts plays it: tick t steps with both sides' inputs for
 * tick t. Each side sends its inputs in signed batches that repeat whatever the peer hasn't acked yet, so
 * batches overlap. `stopAt` cuts the session off mid-game.
 */
async function liveLockstep(s: MatchSetup, opts: { stopAt?: number } = {}) {
  const [host, guest] = [await matchKey(), await matchKey()];
  const g = new Game(gameConfigFor(s));
  const pad = [controller(31), controller(32)];
  const byTick: WireInput[][] = [[], []];
  const inputs: SignedInputs[] = [];
  const acked = [EMPTY_TICKS, EMPTY_TICKS];
  let t = 0;
  for (; g.phase !== 'final' && t < (opts.stopAt ?? 1e9); t++) {
    if (t < EMPTY_TICKS) stepGame(g, [null, null]);
    else {
      const ins: [WireInput, WireInput] = [pad[0](), pad[1]()];
      byTick[0][t] = ins[0];
      byTick[1][t] = ins[1];
      stepGame(g, ins);
    }
    g.events.length = 0;
    g.sfx.length = 0;
    // About every 4 ticks each side sends (and signs) everything from its last ack; the peer acks 2 ticks behind.
    if (t >= EMPTY_TICKS && t % 4 === 3) {
      for (const side of [0, 1] as const) {
        inputs.push(await signTicks(side ? guest.privateKey : host.privateKey, s.matchId, side, acked[side], byTick[side].slice(acked[side], t + 1)));
        acked[side] = Math.max(acked[side], t - 1);
      }
    }
  }
  for (const side of [0, 1] as const) {
    if (acked[side] < t) inputs.push(await signTicks(side ? guest.privateKey : host.privateKey, s.matchId, side, acked[side], byTick[side].slice(acked[side], t)));
  }
  const evidence: Evidence = { setup: s, keys: [host.publicKey, guest.publicKey], inputs, applied: [], lockstep: { emptyTicks: EMPTY_TICKS } };
  return { evidence, keys: { host, guest }, live: { score: [g.score[0], g.score[1]] as [number, number], ticks: t, final: g.phase === 'final' } };
}

const setup = (over: Partial<MatchSetup> = {}): MatchSetup => ({
  matchId: 'm-1', engineVersion: ENGINE_VERSION, seed: 424242, quarterLen: 20,
  home: { name: 'Pallet Town', abbr: 'PAL', color: '#3b6fd8', color2: '#16224a', roster: [25, 381, 6, 445, 382] },
  away: { name: 'Indigo Elite', abbr: 'IND', color: '#e3350d', color2: '#3d0a03', roster: [94, 130, 149, 248, 150] },
  ...over,
});

/** A scripted player: the same seed always gives the same stream of inputs. */
function controller(seed: number) {
  const rng = seededRng(seed);
  let held = emptyIntent();
  return (): WireInput => {
    if (rng() < 0.08) {
      held = emptyIntent();
      held.mx = rng() * 2 - 1;
      held.my = rng() * 2 - 1;
      held.turbo = rng() < 0.3;
    }
    const i = { ...held, shoot: rng() < 0.03, pass: rng() < 0.01, steal: rng() < 0.01 };
    i.shootHeld = i.shoot;
    return packInput(i);
  };
}

/**
 * A live host-authoritative match. Each side makes a frame every tick; the guest's frames reach the host
 * `lag` ticks late. The host applies the newest frame it has from each side and broadcasts the applied
 * log. Returns the live result plus everything each side would hold afterwards.
 */
async function liveMatch(s: MatchSetup, opts: { lag?: number; stopAt?: number } = {}) {
  const lag = opts.lag ?? 4;
  const [host, guest] = [await matchKey(), await matchKey()];
  const g = new Game(gameConfigFor(s));
  const sent: WireInput[][] = [[], []];
  const inputs: SignedInputs[] = [];
  const applied: SignedApplied[] = [];
  const pad = [controller(1), controller(2)];
  let pending: [number, number][] = [];
  let pendingFrom = 1;
  const prev: [number, number] = [0, 0];
  const flushInputs = async (side: 0 | 1, upTo: number, size: number) => {
    // Batches of `size` frames, signed by their own side.
    const from = Math.floor((upTo - 1) / size) * size + 1;
    if (upTo % size === 0) inputs.push(await signInputs(side ? guest.privateKey : host.privateKey, s.matchId, side, from, sent[side].slice(from - 1, upTo)));
  };
  let t = 0;
  for (; g.phase !== 'final' && t < (opts.stopAt ?? 1e9); t++) {
    for (const side of [0, 1] as const) {
      sent[side].push(pad[side]());
      await flushInputs(side, sent[side].length, side ? 6 : 8);
    }
    const use: [number, number] = [sent[0].length, Math.max(0, sent[1].length - lag)];
    stepGame(g, [inputForTick(sent[0], use[0], prev[0]), inputForTick(sent[1], use[1], prev[1])]);
    g.events.length = 0;
    g.sfx.length = 0;
    prev[0] = use[0];
    prev[1] = use[1];
    pending.push(use);
    if (pending.length === 30) {
      applied.push(await signApplied(host.privateKey, s.matchId, pendingFrom, pending));
      pendingFrom += pending.length;
      pending = [];
    }
  }
  // Flush the tails.
  if (pending.length) applied.push(await signApplied(host.privateKey, s.matchId, pendingFrom, pending));
  for (const side of [0, 1] as const) {
    const size = side ? 6 : 8;
    const done = Math.floor(sent[side].length / size) * size;
    if (done < sent[side].length) inputs.push(await signInputs(side ? guest.privateKey : host.privateKey, s.matchId, side, done + 1, sent[side].slice(done)));
  }
  const evidence: Evidence = { setup: s, keys: [host.publicKey, guest.publicKey], inputs, applied };
  return { evidence, keys: { host, guest }, sent, live: { score: [g.score[0], g.score[1]] as [number, number], ticks: t, final: g.phase === 'final' } };
}

describe('winner check', () => {
  it('replays an honest match to the same score and winner the host saw live', async () => {
    const m = await liveMatch(setup());
    expect(m.live.final).toBe(true);
    const v = await judge(m.evidence);
    expect(v.status).toBe('final');
    expect(v.score).toEqual(m.live.score);
    expect(v.ticks).toBe(m.live.ticks);
    expect(v.winner).toBe(m.live.score[0] > m.live.score[1] ? 0 : 1);
    expect(v.notes).toEqual([]);
  }, 60_000);

  it('either player alone can submit everything needed, and duplicates are harmless', async () => {
    const m = await liveMatch(setup({ seed: 7 }));
    const truth = await judge(m.evidence);
    const doubled = await judge({ ...m.evidence, inputs: [...m.evidence.inputs, ...m.evidence.inputs], applied: [...m.evidence.applied, ...m.evidence.applied] });
    expect(doubled).toEqual(truth);
    // Order of submission doesn't matter either.
    const shuffled = await judge({ ...m.evidence, inputs: [...m.evidence.inputs].reverse(), applied: [...m.evidence.applied].reverse() });
    expect(shuffled.score).toEqual(truth.score);
  }, 60_000);

  it("ignores a guest input the host forged, and judges on the guest's real one", async () => {
    const m = await liveMatch(setup({ seed: 11 }));
    const truth = await judge(m.evidence);
    const real = m.evidence.inputs.find((b) => b.side === 1 && b.from > 100)!;
    // The host can't sign as the guest: it can only reuse the guest's signature on altered frames.
    const forged: SignedInputs = { ...real, frames: real.frames.map(() => [1, 1, 2] as [number, number, number]) };
    const v = await judge({ ...m.evidence, inputs: [forged, ...m.evidence.inputs] });
    expect(v.status).toBe('final');
    expect(v.score).toEqual(truth.score);
    expect(v.notes.some((n) => /bad shape or signature/.test(n))).toBe(true);
  }, 60_000);

  it('a host that re-signs its own inputs after the game forfeits when the guest holds the originals', async () => {
    const m = await liveMatch(setup({ seed: 12 }));
    const orig = m.evidence.inputs.find((b) => b.side === 0 && b.from === 81)!;
    const rewritten = await signInputs(m.keys.host.privateKey, 'm-1', 0, 81, orig.frames.map(() => ({ mx: 0, my: 1, b: 2 })));
    const v = await judge({ ...m.evidence, inputs: [...m.evidence.inputs, rewritten] });
    expect(v.status).toBe('forfeit');
    expect(v.cheater).toBe(0);
    expect(v.winner).toBe(1);
  }, 60_000);

  it('a host that re-signs a different applied log forfeits', async () => {
    const m = await liveMatch(setup({ seed: 13 }));
    const chunk = m.evidence.applied[3];
    const other = await signApplied(m.keys.host.privateKey, 'm-1', chunk.from, chunk.entries.map(([h, g]) => [h, Math.max(0, g - 1)] as [number, number]));
    const v = await judge({ ...m.evidence, applied: [other, ...m.evidence.applied] });
    expect(v.status).toBe('forfeit');
    expect(v.cheater).toBe(0);
  }, 60_000);

  it('a guest that signs two versions of a frame forfeits', async () => {
    const m = await liveMatch(setup({ seed: 14 }));
    const twin = await signInputs(m.keys.guest.privateKey, 'm-1', 1, 7, [{ mx: -1, my: -1, b: 0 }]);
    const v = await judge({ ...m.evidence, inputs: [...m.evidence.inputs, twin] });
    expect(v.status).toBe('forfeit');
    expect(v.cheater).toBe(1);
    expect(v.winner).toBe(0);
  }, 60_000);

  it('signatures are bound to the match: a batch from another match is ignored', async () => {
    const m = await liveMatch(setup({ seed: 15 }));
    const elsewhere = await signInputs(m.keys.guest.privateKey, 'm-2', 1, 1, [{ mx: 1, my: 0, b: 2 }]);
    const v = await judge({ ...m.evidence, inputs: [elsewhere, ...m.evidence.inputs] });
    expect(v.status).toBe('final');
    expect(v.notes.length).toBe(1);
  }, 60_000);

  it('a log that stops early is incomplete, with the score where it stopped', async () => {
    const m = await liveMatch(setup({ seed: 16 }), { stopAt: 900 });
    const v = await judge(m.evidence);
    expect(v.status).toBe('incomplete');
    expect(v.ticks).toBe(900);
    expect(v.score).toEqual(m.live.score);
  }, 60_000);

  it('a missing frame, a log that goes backwards, or a different engine version cannot be judged', async () => {
    const m = await liveMatch(setup({ seed: 17 }), { stopAt: 300 });
    const noGuest = await judge({ ...m.evidence, inputs: m.evidence.inputs.filter((b) => b.side === 0) });
    expect(noGuest.status).toBe('invalid');
    const c = m.evidence.applied[2];
    const back = await signApplied(m.keys.host.privateKey, 'm-1', c.from, c.entries.map(([h, g], i) => (i === 5 ? [h, 0] : [h, g]) as [number, number]));
    expect((await judge({ ...m.evidence, applied: m.evidence.applied.map((x) => (x === c ? back : x)) })).status).toBe('invalid');
    expect((await judge({ ...m.evidence, setup: { ...m.evidence.setup, engineVersion: ENGINE_VERSION + 1 } })).status).toBe('invalid');
    expect((await judge({ ...m.evidence, keys: [m.evidence.keys[0], m.evidence.keys[0]] })).status).toBe('invalid');
    expect((await judge({ ...m.evidence, setup: { ...m.evidence.setup, away: { ...m.evidence.setup.away, roster: [25, 130, 149, 248, 150] } } })).status).toBe('invalid');
  }, 60_000);

  it('a frame that stays applied keeps its stick and holds, but its button presses count once', () => {
    const frames: WireInput[] = [{ mx: 0.5, my: -0.5, b: 1 | 2 | 4 | 8 }];
    expect(inputForTick(frames, 1, 0)).toEqual(frames[0]);
    expect(inputForTick(frames, 1, 1)).toEqual({ mx: 0.5, my: -0.5, b: (1 | 2 | 4 | 8) & ~PRESS_BITS });
    expect(inputForTick(frames, 0, 0)).toBeNull();
  });

  describe('lockstep (the sync Social ships with)', () => {
    it('replays an honest lockstep match, overlapping resends and all, to the live score', async () => {
      const m = await liveLockstep(setup({ seed: 21 }));
      expect(m.live.final).toBe(true);
      const v = await judge(m.evidence);
      expect(v.status).toBe('final');
      expect(v.score).toEqual(m.live.score);
      expect(v.ticks).toBe(m.live.ticks);
      expect(v.notes).toEqual([]);
    }, 60_000);

    it('a player who signs a different input for a tick they already sent forfeits', async () => {
      const m = await liveLockstep(setup({ seed: 22 }));
      const rewrite = await signTicks(m.keys.guest.privateKey, 'm-1', 1, 200, [{ mx: 1, my: 1, b: 2 }]);
      const v = await judge({ ...m.evidence, inputs: [...m.evidence.inputs, rewrite] });
      expect(v.status).toBe('forfeit');
      expect(v.cheater).toBe(1);
    }, 60_000);

    it("inputs that stop mid-game are incomplete at the last tick both players' inputs exist", async () => {
      const m = await liveLockstep(setup({ seed: 23 }), { stopAt: 1200 });
      const v = await judge(m.evidence);
      expect(v.status).toBe('incomplete');
      expect(v.ticks).toBe(1200);
      expect(v.score).toEqual(m.live.score);
      // Drop the guest's later batches: the judge stops where the guest's signed inputs run out.
      const cut = await judge({ ...m.evidence, inputs: m.evidence.inputs.filter((b) => b.side === 0 || b.from <= 600) });
      expect(cut.status).toBe('incomplete');
      expect(cut.ticks).toBeLessThan(1200);
    }, 60_000);
  });

  it('replay is the same engine the game runs: same setup and inputs, same result', () => {
    const s = setup({ seed: 99 });
    const pads = [controller(5), controller(6)];
    const ticks = Array.from({ length: 2000 }, () => [pads[0](), pads[1]()] as [WireInput, WireInput]);
    const a = replay(s, ticks);
    const b = replay(s, ticks);
    expect(a.hash).toBe(b.hash);
    expect(a.score).toEqual(b.score);
    expect(replay({ ...s, seed: 100 }, ticks).hash).not.toBe(a.hash);
  });
});
