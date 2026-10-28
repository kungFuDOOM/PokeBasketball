import { describe, expect, it } from 'vitest';
import { POKEMON, POSITIONS } from '../../data/pokemon';
import { Game } from '../../game/game';
import { stateHash } from '../../game/sync';
import { canPick, draftSide, draftedRosters, teamOf, type DraftView } from './draft';
import { buildConfig, setupFor } from './netplay';
import type { OnlineMatch } from './onlineMatchService';
import { gameConfigFor } from './winnerCheck';
import migration from '../../../supabase/migrations/20261101_pokejam_social_draft.sql?raw';
import monsSync from '../../../supabase/migrations/20261102_pokejam_mons_sync.sql?raw';

const view = (over: Partial<DraftView> = {}): DraftView => ({
  pool: [{ dex: 25, pos: 'PG' }, { dex: 26, pos: 'PG' }, { dex: 6, pos: 'SF' }, { dex: 9, pos: 'PF' }],
  first: 0, picks: [], done: false, me: 0, turn: 0, on_turn: 0, seconds_left: 12, opponent_seen_ago: 1, ...over,
});

describe('the Social draft, client side (#28)', () => {
  it('snake order: A B B A A B B A A B from whoever goes first', () => {
    expect(Array.from({ length: 10 }, (_, i) => draftSide(0, i))).toEqual([0, 1, 1, 0, 0, 1, 1, 0, 0, 1]);
    expect(Array.from({ length: 10 }, (_, i) => draftSide(1, i))).toEqual([1, 0, 0, 1, 1, 0, 0, 1, 1, 0]);
  });

  it('a card is pickable only on my turn, if nobody has it and I still need its position', () => {
    expect(canPick(view(), 25)).toBe(true);
    expect(canPick(view({ on_turn: 1 }), 25)).toBe(false);
    expect(canPick(view({ done: true }), 25)).toBe(false);
    expect(canPick(view(), 999)).toBe(false);
    const after = view({ picks: [{ side: 0, dex: 25, pos: 'PG', auto: false }] });
    expect(canPick(after, 25)).toBe(false); // taken
    expect(canPick(after, 26)).toBe(false); // I already have a PG
    expect(canPick(after, 6)).toBe(true);
    expect(teamOf(after, 0)).toEqual({ PG: 25 });
  });

  it('the drafted rosters come out in position order, only once both are complete', () => {
    const picks = POSITIONS.flatMap((pos, i) => [
      { side: 0 as const, dex: 100 + i, pos, auto: false }, { side: 1 as const, dex: 200 + i, pos, auto: i % 2 === 0 },
    ]).reverse();
    expect(draftedRosters({ picks })).toEqual([[100, 101, 102, 103, 104], [200, 201, 202, 203, 204]]);
    expect(draftedRosters({ picks: picks.slice(1) })).toBeNull();
  });

  it('host, guest and the winner check play the drafted teams, identically', () => {
    const rosters: [number[], number[]] = [[25, 135, 6, 9, 143], [65, 214, 94, 445, 248]];
    const match = (side: 0 | 1): OnlineMatch => ({
      id: 'd1', queue: 'social', side,
      me: { id: side ? 'g' : 'h', name: side ? 'Misty' : 'Ash' }, opponent: { id: side ? 'h' : 'g', name: side ? 'Ash' : 'Misty', mmr: 1000, simulated: false },
      game: { seed: 4242, quarterLen: 120, rosters }, keys: [null, null],
    });
    const setup = setupFor(match(0));
    expect([setup.home.roster, setup.away.roster]).toEqual(rosters);
    expect(setupFor(match(1))).toEqual(setup);
    const games = [new Game(buildConfig(match(0))), new Game(buildConfig(match(1))), new Game(gameConfigFor(setup))];
    for (let t = 0; t < 600; t++) for (const g of games) g.update(1 / 60);
    expect(new Set(games.map(stateHash)).size).toBe(1);
    expect(games[0].players.filter((p) => p.team === 0).map((p) => p.mon.dex).sort()).toEqual([...rosters[0]].sort());
  });

  it("the server's Pokémon list (migrations 20261101, then 20261102) matches the game's, dex and position", () => {
    // Later migrations upsert over earlier ones.
    const byDex = new Map<number, string>();
    for (const m of (migration + monsSync).matchAll(/\((\d+),'(PG|SG|SF|PF|C)'\)/g)) byDex.set(Number(m[1]), m[2]);
    const rows = [...byDex].sort((a, b) => a[0] - b[0]);
    const game = [...POKEMON].sort((a, b) => a.dex - b.dex).map((m) => [m.dex, m.pos]);
    expect(rows).toEqual(game);
  });
});
