import { describe, expect, it } from 'vitest';
import { Game } from '../../game/game';
import { stateHash } from '../../game/sync';
import type { NetMsg } from './lockstep';
import { ENGINE_VERSION } from '../../game/types';
import { RANKED_PRESETS, rosterDigest } from '../ranked/presets';
import { MatchLink, NET_VERSION, buildConfig, connect, setupFor, wantsEvidence } from './netplay';
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

describe('which matches sign and upload evidence', () => {
  it('rated matches do; Social (never rated or paid) does not', () => {
    expect(wantsEvidence({ queue: 'social' })).toBe(false);
    expect(wantsEvidence({ queue: 'ranked' })).toBe(true);
  });
});
