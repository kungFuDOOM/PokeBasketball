import { describe, expect, it } from 'vitest';
import { Game } from '../../game/game';
import { stateHash } from '../../game/sync';
import type { NetMsg } from './lockstep';
import { MatchLink, buildConfig, setupFor, wantsEvidence } from './netplay';
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

describe('which matches sign and upload evidence', () => {
  it('rated matches do; Social (never rated or paid) does not', () => {
    expect(wantsEvidence({ queue: 'social' })).toBe(false);
    expect(wantsEvidence({ queue: 'ranked' })).toBe(true);
  });
});
