import { describe, expect, it } from 'vitest';
import { Game } from '../../game/game';
import { stateHash } from '../../game/sync';
import { Lockstep, type NetMsg } from './lockstep';
import { ENGINE_VERSION, emptyIntent } from '../../game/types';
import { RANKED_PRESETS, rosterDigest } from '../ranked/presets';
import { startingFiveEnabled } from '../../screens/intro.logic';
import { MatchLink, NET_VERSION, buildConfig, connect, setupFor, wantsEvidence, type Connected } from './netplay';
import { gameConfigFor } from './winnerCheck';
import type { OnlineMatch } from './onlineMatchService';
import { rostersFor } from './roster';

const match = (side: 0 | 1, seed = 123456789): OnlineMatch => ({
  id: 'm1', queue: 'social', side,
  me: { id: side === 0 ? 'h' : 'g', name: side === 0 ? 'Ash' : 'Misty' },
  opponent: { id: side === 0 ? 'g' : 'h', name: side === 0 ? 'Misty' : 'Ash', mmr: 1000, simulated: false },
  game: { seed, quarterLen: 120 },
  keys: [null, null],
});
const dexes = (c: ReturnType<typeof buildConfig>) => [c.home.roster.map((m) => m.dex), c.away.roster.map((m) => m.dex)];

describe('the online game comes from the server, the same on both sides', () => {
  it('host and guest build the identical game from the match row', () => {
    const [h, g] = [buildConfig(match(0)), buildConfig(match(1))];
    expect(dexes(g)).toEqual(dexes(h));
    expect([g.home.name, g.away.name]).toEqual(['Ash', 'Misty']);
    expect([h.seed, h.quarterLen]).toEqual([123456789, 120]);
  });

  it('the rosters follow the seed: same seed, same teams; another seed, other teams', () => {
    expect(rostersFor(42).map((r) => r.map((m) => m.dex))).toEqual(rostersFor(42).map((r) => r.map((m) => m.dex)));
    expect(rostersFor(42).map((r) => r.map((m) => m.dex))).not.toEqual(rostersFor(43).map((r) => r.map((m) => m.dex)));
    for (const r of rostersFor(7)) expect(r.map((m) => m.pos)).toEqual(['PG', 'SG', 'SF', 'PF', 'C']);
  });

  it('Ranked plays the server preset rosters and never falls back to seed teams', () => {
    const rosters: [number[], number[]] = [RANKED_PRESETS[2].dex, RANKED_PRESETS[5].dex];
    const ranked = (side: 0 | 1, r: [number[], number[]] | null | undefined): OnlineMatch => ({ ...match(side), queue: 'ranked', game: { seed: 9, quarterLen: 120, rosters: r } });
    const setup = setupFor(ranked(1, rosters));
    expect([setup.home.roster, setup.away.roster]).toEqual(rosters);
    expect(setupFor(ranked(0, rosters))).toEqual(setup);
    for (const r of [null, undefined]) expect(() => setupFor(ranked(0, r))).toThrow('ranked match has no preset rosters');
    // Social keeps its seed fallback.
    expect([setupFor(match(0)).home.roster, setupFor(match(0)).away.roster]).toEqual(rostersFor(123456789, 'social').map((t) => t.map((m) => m.dex)));
  });
});

describe('the judge rebuilds the game that was played', () => {
  it('host, guest and the judge (gameConfigFor(setupFor(match))) step through identical games', () => {
    const setup = setupFor(match(0));
    expect(setupFor(match(1))).toEqual(setup);
    const games = [new Game(buildConfig(match(0))), new Game(buildConfig(match(1))), new Game(gameConfigFor(setup))];
    for (let t = 0; t < 1800; t++) {
      for (const g of games) g.update(1 / 60);
      if (t % 300 === 0) expect(new Set(games.map(stateHash)).size, `tick ${t}`).toBe(1);
    }
    expect(games[0].cfg.difficulty).toBe(gameConfigFor(setup).difficulty);
  });
});

describe('hand-over between the direct link and Realtime', () => {
  function rig() {
    const realtime: string[] = [];
    const direct: string[] = [];
    const ch = { send: (x: { payload: { k: string } }) => { realtime.push(x.payload.k); return Promise.resolve('ok'); } };
    const link = new MatchLink(ch as never, {} as never);
    const inner = link as unknown as { rtc: unknown; openedAt: number };
    inner.rtc = { open: true, send: (m: { k: string }) => direct.push(m.k), close() {} };
    inner.openedAt = performance.now();
    return { link, realtime, direct, inner };
  }
  const input: NetMsg = { k: 'in', s: 0, r: [], a: 0 };

  it('uses the direct link while it is heard from', () => {
    const { link, realtime, direct } = rig();
    link.send(input);
    expect(direct).toEqual(['in']);
    expect(realtime).toEqual([]);
    expect(link.pace()).toBe(16);
  });

  it('a direct link that reads open but has gone silent (the peer dropped it) falls back to Realtime; pings still try it and a pong brings it back', () => {
    const { link, realtime, direct, inner } = rig();
    inner.openedAt = performance.now() - 5000; // opened long ago, nothing heard since
    link.send(input);
    expect(realtime).toEqual(['in']);
    expect(direct).toEqual([]);
    expect(link.pace()).toBe(100);
    link.pinger.ping();
    expect(direct).toEqual(['ping']);
    link.deliver({ k: 'pong', n: 1, t: 0 }, 'direct');
    link.send(input);
    expect(direct).toEqual(['ping', 'in']);
    expect(link.pace()).toBe(16);
  });

  it('a send that throws on the direct link goes over Realtime instead', () => {
    const { link, realtime, inner } = rig();
    (inner.rtc as { send: () => void }).send = () => { throw new Error('closing'); };
    link.send(input);
    expect(realtime).toEqual(['in']);
  });

  it('the peer saying its direct link is down closes ours', () => {
    const { link, inner } = rig();
    let closed = false;
    (inner.rtc as { close: () => void }).close = () => { closed = true; };
    link.signal({ k: 'down' });
    expect(closed).toBe(true);
  });
});

describe('the ranked handshake carries a roster digest', () => {
  type Hi = { k: string; side: number; d?: number; v: number; n: number };
  function rankedRig(m: OnlineMatch) {
    const sent: Hi[] = [];
    let onHs: (e: { payload: unknown }) => void = () => {};
    const ch = {
      on(_t: string, f: { event: string }, cb: (e: { payload: unknown }) => void) { if (f.event === 'hs') onHs = cb; return ch; },
      send: (x: { payload: Hi }) => { sent.push(x.payload); return Promise.resolve('ok'); },
      subscribe(cb: (s: string) => void) { cb('SUBSCRIBED'); return ch; },
    };
    const sb = { channel: () => ch, removeChannel: () => Promise.resolve('ok'), realtime: { setAuth: () => Promise.resolve() } };
    const p = connect(sb as never, m, undefined);
    p.catch(() => {});
    const flush = () => new Promise((r) => setTimeout(r, 0));
    return { sent, p, flush, peer: (extra: Partial<Hi>) => onHs({ payload: { k: 'hi', v: ENGINE_VERSION, n: NET_VERSION, side: m.side === 0 ? 1 : 0, ...extra } }) };
  }
  const ranked = (side: 0 | 1): OnlineMatch => ({ ...match(side), queue: 'ranked', game: { seed: 1, quarterLen: 120, rosters: [RANKED_PRESETS[0].dex, RANKED_PRESETS[3].dex] } });
  const want = rosterDigest([RANKED_PRESETS[0].dex, RANKED_PRESETS[3].dex]);

  it('the digest is deterministic and tells teams apart', () => {
    expect(rosterDigest([[1, 2, 3, 4, 5], [6, 7, 8, 9, 10]])).toBe(rosterDigest([[1, 2, 3, 4, 5], [6, 7, 8, 9, 10]]));
    expect(rosterDigest([[1, 2, 3, 4, 5], [6, 7, 8, 9, 10]])).not.toBe(rosterDigest([[6, 7, 8, 9, 10], [1, 2, 3, 4, 5]]));
  });

  it('ranked sends the digest of both rosters; social sends none', async () => {
    const r = rankedRig(ranked(0));
    await r.flush();
    expect(r.sent[0].d).toBe(want);
    const s = rankedRig(match(0));
    await s.flush();
    expect(s.sent[0].d).toBeUndefined();
  });

  it('a different digest from the peer aborts like a version mismatch', async () => {
    const r = rankedRig(ranked(1));
    await r.flush();
    r.peer({ d: want ^ 1 });
    await expect(r.p).rejects.toThrow(/different game versions/);
  });

  it('a matching digest, or none (an older client), connects', async () => {
    for (const d of [want, undefined]) {
      const r = rankedRig(ranked(1));
      await r.flush();
      r.peer(d === undefined ? {} : { d });
      const c = await r.p;
      expect(c.setup.away.roster).toEqual(RANKED_PRESETS[3].dex);
      c.link.close();
    }
  });
});

describe('the handshake says whether the peer shows the pre-game intro', () => {
  type Cb = (x: { payload: unknown }) => void;
  function introRig(side: 0 | 1) {
    const sent: { event: string; payload: Record<string, unknown> }[] = [];
    const handlers: Record<string, Cb> = {};
    const ch = {
      on: (_t: string, f: { event: string }, cb: Cb) => { handlers[f.event] = cb; return ch; },
      subscribe: (cb: (s: string) => void) => { cb('SUBSCRIBED'); return ch; },
      send: (x: { event: string; payload: Record<string, unknown> }) => { sent.push(x); return Promise.resolve('ok'); },
    };
    const sb = { channel: () => ch, removeChannel: () => Promise.resolve('ok'), realtime: { setAuth: () => Promise.resolve() } };
    const conn = connect(sb as never, match(side), undefined);
    const peerHi = (extra: Record<string, unknown>) =>
      handlers.hs({ payload: { k: 'hi', v: ENGINE_VERSION, n: NET_VERSION, side: side === 0 ? 1 : 0, ...extra } });
    return { conn, sent, handlers, peerHi };
  }

  it('our hi carries i:1, and a peer hi with i:1 yields intro:true', async () => {
    const { conn, sent, peerHi } = introRig(0);
    await Promise.resolve();
    await Promise.resolve();
    expect(sent.find((s) => s.event === 'hs')?.payload.i).toBe(1);
    peerHi({ i: 1 });
    const c = await conn;
    expect(c.intro).toBe(true);
    c.link.close();
  });

  it('an old peer (no i) yields intro:false', async () => {
    const { conn, peerHi } = introRig(1);
    await Promise.resolve();
    peerHi({});
    const c = await conn;
    expect(c.intro).toBe(false);
    c.link.close();
  });

  it("'pre' events reach onPre and junk is dropped; sendPre goes out on the channel", async () => {
    const { conn, sent, handlers, peerHi } = introRig(0);
    await Promise.resolve();
    peerHi({ i: 1 });
    const c = await conn;
    const got: unknown[] = [];
    c.link.onPre((p) => got.push(p));
    handlers.pre({ payload: { k: 'skip' } });
    handlers.pre({ payload: { k: 'nope' } });
    handlers.pre({ payload: null });
    expect(got).toEqual([{ k: 'skip' }]);
    c.link.sendPre('ready');
    expect(sent[sent.length - 1]).toMatchObject({ event: 'pre', payload: { k: 'ready' } });
    c.link.close();
  });
});

describe('the starting five online: only when both peers support it, and lockstep holds either way', () => {
  type Cb = (x: { payload: unknown }) => void;
  /** One side's connect() over a fake channel; `hello` is the peer's hi as it would arrive. */
  async function side(s: 0 | 1, hello: Record<string, unknown>) {
    const sent: { event: string; payload: Record<string, unknown> }[] = [];
    const handlers: Record<string, Cb> = {};
    const ch = {
      on: (_t: string, f: { event: string }, cb: Cb) => { handlers[f.event] = cb; return ch; },
      subscribe: (cb: (st: string) => void) => { cb('SUBSCRIBED'); return ch; },
      send: (x: { event: string; payload: Record<string, unknown> }) => { sent.push(x); return Promise.resolve('ok'); },
    };
    const sb = { channel: () => ch, removeChannel: () => Promise.resolve('ok'), realtime: { setAuth: () => Promise.resolve() } };
    const conn = connect(sb as never, match(s), undefined);
    await Promise.resolve();
    await Promise.resolve();
    handlers.hs({ payload: hello });
    const c = await conn;
    c.link.close();
    return { c, hi: sent.find((x) => x.event === 'hs')!.payload };
  }
  const newHi = (s: 0 | 1) => ({ k: 'hi', v: ENGINE_VERSION, n: NET_VERSION, side: s, i: 1, s: 1 });
  const oldHi = (s: 0 | 1) => ({ k: 'hi', v: ENGINE_VERSION, n: NET_VERSION, side: s, i: 1 });
  /** Roughly how long the starting five holds the sim (ms). */
  const INTRO_FIVE_MS = 6000;
  const shows = (c: Connected) => startingFiveEnabled('full', 'social', true, c.startingFive);

  /** Two lockstep peers on a fake clock; each only idles (maybeSend) while its intro plays, as play.ts does. */
  function run(introMs: [number, number]) {
    let now = 0;
    const q: { at: number; to: 0 | 1; m: NetMsg }[] = [];
    const games = [new Game(buildConfig(match(0))), new Game(buildConfig(match(1)))];
    const ls = ([0, 1] as const).map((s) => new Lockstep(games[s], {
      send: (m: NetMsg) => q.push({ at: now + 40, to: (1 - s) as 0 | 1, m: JSON.parse(JSON.stringify(m)) }),
    }, { side: s, now: () => now }));
    for (let f = 0; f < 60 * 20; f++) {
      now += 1000 / 60;
      q.sort((a, b) => a.at - b.at);
      while (q.length && q[0].at <= now) { const x = q.shift()!; ls[x.to].receive(x.m); }
      for (const s of [0, 1]) {
        if (now < introMs[s]) ls[s].maybeSend(false);
        else ls[s].advance(emptyIntent(), 1 / 60);
      }
    }
    return { games, ls };
  }
  const inStep = ({ ls }: ReturnType<typeof run>) => {
    const t = Math.min(ls[0].tick, ls[1].tick);
    expect(t).toBeGreaterThan(300);
    for (const l of ls) expect(l.problem).toBeNull();
    expect(ls[0].stats.desyncs + ls[1].stats.desyncs).toBe(0);
  };

  it('new + new: our hi carries s:1, both sides show it, and they stay in lockstep after it', async () => {
    const [a, b] = await Promise.all([side(0, newHi(1)), side(1, newHi(0))]);
    expect(a.hi.s).toBe(1);
    expect([shows(a.c), shows(b.c)]).toEqual([true, true]);
    // The intros end a little apart on each screen; the earlier side simply waits for the other's inputs.
    inStep(run([INTRO_FIVE_MS, INTRO_FIVE_MS + 400]));
  });

  it('new + old peer (no s): the new side does not show it, they connect and stay in lockstep', async () => {
    const a = await side(0, oldHi(1));
    expect(a.c.startingFive).toBe(false);
    expect(shows(a.c)).toBe(false);
    expect(a.c.intro).toBe(true); // the pre-game card is unaffected
    inStep(run([0, 0]));
  });

  it('NET_VERSION is still 3', () => {
    expect(NET_VERSION).toBe(3);
  });
});

describe('which matches sign and upload evidence', () => {
  it('rated matches do; Social (never rated or paid) does not', () => {
    expect(wantsEvidence({ queue: 'social' })).toBe(false);
    expect(wantsEvidence({ queue: 'ranked' })).toBe(true);
  });
});
