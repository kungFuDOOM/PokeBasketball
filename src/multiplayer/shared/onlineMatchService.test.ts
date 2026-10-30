import { describe, expect, it } from 'vitest';
import { ENGINE_VERSION } from '../../game/types';
import { SupabaseMatchService, type OnlineOpponent, type RpcClient } from './onlineMatchService';

/** A fake server: records RPC calls and answers from a table. */
function fakeDb(answers: Record<string, unknown> = {}) {
  const calls: { fn: string; args?: Record<string, unknown> }[] = [];
  const db: RpcClient = {
    rpc(fn, args) {
      calls.push({ fn, args });
      return Promise.resolve({ data: answers[fn] ?? null, error: null });
    },
  };
  return { db, calls };
}

const opp = (mySide: 0 | 1): OnlineOpponent => ({ id: 'them', name: 'Rival', mmr: 1000, simulated: false, matchId: 'm1', mySide });
const result = (won: boolean) => ({ won, score: (won ? [50, 40] : [40, 50]) as [number, number], engineVersion: ENGINE_VERSION });

describe('SupabaseMatchService (Ranked presets, flag off)', () => {
  it('never calls the preset RPCs when Ranked is off', async () => {
    const { db, calls } = fakeDb();
    const svc = new SupabaseMatchService(db, 'me');
    await expect(svc.rankedPresets()).rejects.toThrow(/Ranked/);
    await expect(svc.rankedPick('m1', 'A')).rejects.toThrow(/Ranked/);
    await expect(svc.rankedPickState('m1')).rejects.toThrow(/Ranked/);
    expect(calls).toEqual([]);
  });
});

describe('SupabaseMatchService (Social)', () => {
  it('social results never carry a rank, even if the server sent one', async () => {
    const { db, calls } = fakeDb({ pokejam_report_result: { status: 'done', rank: { mmrDelta: 30 } } });
    const out = await new SupabaseMatchService(db, 'me').reportResult('social', opp(0), result(true));
    expect(out).toEqual({ queue: 'social' });
    expect(calls.map((c) => c.fn)).toEqual(['pokejam_report_result']);
  });

  it('refuses ranked: a Social service can never submit a rated result', async () => {
    const { db, calls } = fakeDb();
    const svc = new SupabaseMatchService(db, 'me', ['social']);
    await expect(svc.reportResult('ranked', opp(0), result(true))).rejects.toThrow(/ranked/);
    await expect(svc.quickMatch('ranked')).rejects.toThrow(/ranked/);
    expect(calls).toEqual([]);
  });

  it('reports who won from the host side for both players', async () => {
    const { db, calls } = fakeDb();
    const svc = new SupabaseMatchService(db, 'me');
    await svc.reportResult('social', opp(0), result(true)); // I'm the host and won
    await svc.reportResult('social', opp(1), result(true)); // I'm the guest and won
    expect(calls.map((c) => c.args)).toEqual([{ p_match: 'm1', p_host_won: true }, { p_match: 'm1', p_host_won: false }]);
  });

  it('works out sides, names and the server-picked game from the match', async () => {
    const info = { id: 'm1', queue: 'social', host: 'h', guest: 'me', host_name: 'Ash', guest_name: 'Misty', seed: 4000000000, quarter_len: 60 };
    const m = await new SupabaseMatchService(fakeDb({ pokejam_match_info: info }).db, 'me').matchInfo('m1');
    expect(m.side).toBe(1);
    expect(m.opponent.name).toBe('Ash');
    expect(m.me.name).toBe('Misty');
    expect(m.game).toEqual({ seed: 4000000000, quarterLen: 60, rosters: null });
  });

  it('shows a blocked opponent name (a modified client) as the default "Trainer"', async () => {
    const info = { id: 'm1', queue: 'social', host: 'h', guest: 'me', host_name: 'f u c k', guest_name: 'Misty', seed: 1, quarter_len: 60 };
    const m = await new SupabaseMatchService(fakeDb({ pokejam_match_info: info }).db, 'me').matchInfo('m1');
    expect(m.opponent.name).toBe('Trainer');
    expect(m.me.name).toBe('Misty');
    const host = await new SupabaseMatchService(fakeDb({ pokejam_match_info: { ...info, host: 'me', guest: 'g', host_name: 'Ash', guest_name: 'Kissass' } }).db, 'me').matchInfo('m1');
    expect(host.opponent.name).toBe('Trainer');
    expect(host.me.name).toBe('Ash');
  });

  it('never sends a blocked name of its own', async () => {
    const { db, calls } = fakeDb({ pokejam_ensure_profile: { trainer_name: 'Trainer' } });
    await new SupabaseMatchService(db, 'me').setName('sh1t');
    expect(calls[0].args).toEqual({ p_name: 'Trainer' });
  });

  it('refuses a match with no server seed (an old server), rather than letting a player pick the game', async () => {
    const info = { id: 'm1', queue: 'social', host: 'h', guest: 'me', host_name: 'Ash', guest_name: 'Misty', seed: null, quarter_len: 120 };
    await expect(new SupabaseMatchService(fakeDb({ pokejam_match_info: info }).db, 'me').matchInfo('m1')).rejects.toThrow(/older server/);
  });

  it('a room code with no open room is "room not found"', async () => {
    await expect(new SupabaseMatchService(fakeDb({ pokejam_join_room: null }).db, 'me').joinRoom('ABC123')).rejects.toThrow(/room not found/);
  });

  it('rooms ask for 1- or 2-minute quarters only; reports and blocks name the match', async () => {
    const { db, calls } = fakeDb({ pokejam_report_player: true });
    const svc = new SupabaseMatchService(db, 'me');
    await svc.createRoom(300);
    await svc.createRoom(60);
    expect(await svc.report('m1', 'name')).toBe(true);
    await svc.block('m1');
    expect(calls.map((c) => [c.fn, c.args])).toEqual([
      ['pokejam_create_room', { p_quarter_len: 120 }], ['pokejam_create_room', { p_quarter_len: 60 }],
      ['pokejam_report_player', { p_match: 'm1', p_reason: 'name', p_note: null }], ['pokejam_block_player', { p_match: 'm1' }],
    ]);
  });

  it('checks room codes before asking the server', async () => {
    const { db, calls } = fakeDb();
    await expect(new SupabaseMatchService(db, 'me').joinRoom('AB')).rejects.toThrow(/6/);
    expect(calls).toEqual([]);
  });
});
