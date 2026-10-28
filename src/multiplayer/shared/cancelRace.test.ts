// Cancel / "Play CPU instead" while a matchmaking request is in flight (bug #1): a cancelled search never hands back
// a match, and a match that arrives anyway is left on the server.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RoomGoneError, SupabaseMatchService, type RpcClient } from './onlineMatchService';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

type Res = { data: unknown; error: { message: string; code?: string } | null; status?: number };

/** A fake server: RPCs in `held` wait until answered by hand; the rest answer from `answers` at once. */
function heldDb(held: string[], answers: Record<string, unknown> = {}) {
  const calls: { fn: string; args?: Record<string, unknown> }[] = [];
  const waiting: Record<string, ((r: Res) => void)[]> = {};
  const db: RpcClient = {
    rpc(fn, args) {
      calls.push({ fn, args });
      if (held.includes(fn)) return new Promise<Res>((r) => (waiting[fn] ??= []).push(r));
      const a = answers[fn];
      return Promise.resolve(a && typeof a === 'object' && 'error' in a ? (a as Res) : { data: a ?? null, error: null });
    },
  };
  const answer = async (fn: string, data: unknown) => {
    await vi.waitFor(() => expect(waiting[fn]?.length).toBeTruthy());
    waiting[fn].shift()!({ data, error: null });
  };
  return { db, calls, answer, fns: () => calls.map((c) => c.fn) };
}
const info = { id: 'm1', queue: 'social', host: 'h', guest: 'me', host_name: 'Ash', guest_name: 'Misty', seed: 7, quarter_len: 120, status: 'active' };

describe('quick match: Cancel always wins', () => {
  it('a match id that comes back after Cancel is left on the server, never returned', async () => {
    const f = heldDb(['pokejam_find_match'], { pokejam_match_info: info });
    const svc = new SupabaseMatchService(f.db, 'me');
    const abort = new AbortController();
    const p = svc.quickMatch('social', abort.signal).catch((e) => e);
    await vi.waitFor(() => expect(f.fns()).toContain('pokejam_find_match'));
    abort.abort(); // the player taps Cancel / Play CPU instead with the poll in flight
    await f.answer('pokejam_find_match', 'm1'); // ...and the server had just paired them
    const err = await p;
    expect(err.name).toBe('AbortError');
    expect(f.fns()).not.toContain('pokejam_match_info');
    expect(f.calls).toContainEqual({ fn: 'pokejam_leave_match', args: { p_match: 'm1' } });
    expect(f.fns()).toContain('pokejam_leave_queue');
  });

  it('a Cancel while the match is being read is just as final', async () => {
    const f = heldDb(['pokejam_match_info'], { pokejam_find_match: 'm1' });
    const svc = new SupabaseMatchService(f.db, 'me');
    const abort = new AbortController();
    const p = svc.quickMatch('social', abort.signal).catch((e) => e);
    await vi.waitFor(() => expect(f.fns()).toContain('pokejam_match_info'));
    abort.abort();
    await f.answer('pokejam_match_info', info);
    expect((await p).name).toBe('AbortError');
    expect(f.calls).toContainEqual({ fn: 'pokejam_leave_match', args: { p_match: 'm1' } });
  });

  it('a Cancel during the human check means no search is sent at all', async () => {
    let pass!: () => void;
    const f = heldDb([]);
    const svc = new SupabaseMatchService(f.db, 'me', ['social'], () => new Promise<void>((r) => (pass = r)));
    const abort = new AbortController();
    const p = svc.quickMatch('social', abort.signal).catch((e) => e);
    await vi.waitFor(() => expect(pass).toBeTypeOf('function'));
    abort.abort();
    pass();
    expect((await p).name).toBe('AbortError');
    expect(f.fns()).not.toContain('pokejam_find_match');
  });

  it('without a Cancel, the match comes back with its status', async () => {
    const f = heldDb([], { pokejam_find_match: 'm1', pokejam_match_info: info });
    const m = await new SupabaseMatchService(f.db, 'me').quickMatch('social', new AbortController().signal);
    expect(m.id).toBe('m1');
    expect(m.status).toBe('active');
    expect(f.fns()).not.toContain('pokejam_leave_match');
  });
});

describe('rooms: Cancel and Back always win', () => {
  it('host: a friend who joins as the host cancels gets the match left, not a draft', async () => {
    const f = heldDb(['pokejam_room_state'], { pokejam_match_info: info });
    const svc = new SupabaseMatchService(f.db, 'me');
    const abort = new AbortController();
    const p = svc.waitForFriend('ABC123', abort.signal).catch((e) => e);
    await vi.waitFor(() => expect(f.fns()).toContain('pokejam_room_state'));
    abort.abort();
    await f.answer('pokejam_room_state', { match: 'm1', status: 'active' });
    expect((await p).name).toBe('AbortError');
    expect(f.calls).toContainEqual({ fn: 'pokejam_leave_match', args: { p_match: 'm1' } });
  });

  it('guest: Back while the join is in flight leaves the match it lands in', async () => {
    const f = heldDb(['pokejam_join_room'], { pokejam_match_info: info });
    const svc = new SupabaseMatchService(f.db, 'me');
    const away = new AbortController();
    const p = svc.joinRoom('abc123', away.signal).catch((e) => e);
    await vi.waitFor(() => expect(f.fns()).toContain('pokejam_join_room'));
    away.abort();
    await f.answer('pokejam_join_room', 'm1');
    expect((await p).name).toBe('AbortError');
    expect(f.calls).toContainEqual({ fn: 'pokejam_leave_match', args: { p_match: 'm1' } });
  });

  it('host: polls until the friend joins; a room that is over or expired ends the wait with a clear reason', async () => {
    let n = 0;
    const states = [{ match: null, status: 'waiting' }, { match: 'm1', status: 'active' }];
    const ok = heldDb([], { pokejam_match_info: info });
    ok.db.rpc = ((orig) => (fn: string, args?: Record<string, unknown>) =>
      fn === 'pokejam_room_state' ? Promise.resolve({ data: states[n++], error: null }) : orig(fn, args))(ok.db.rpc.bind(ok.db));
    const p = new SupabaseMatchService(ok.db, 'me').waitForFriend('ABC123');
    await vi.advanceTimersByTimeAsync(3000);
    expect((await p).id).toBe('m1');

    for (const [status, why] of [['void', /friend left/], ['expired', /30 minutes/]] as const) {
      const f = heldDb([], { pokejam_room_state: { match: null, status } });
      const err = await new SupabaseMatchService(f.db, 'me').waitForFriend('ABC123').catch((e) => e);
      expect(err).toBeInstanceOf(RoomGoneError);
      expect(err.message).toMatch(why);
    }
  });

  it('host: on a server without pokejam_room_state, falls back to the old poll', async () => {
    const f = heldDb([], {
      pokejam_room_state: { data: null, error: { message: 'Could not find the function', code: 'PGRST202' }, status: 404 },
      pokejam_room_match: 'm1', pokejam_match_info: info,
    });
    expect((await new SupabaseMatchService(f.db, 'me').waitForFriend('ABC123')).id).toBe('m1');
    expect(f.fns()).toEqual(['pokejam_room_state', 'pokejam_room_match', 'pokejam_match_info']);
  });
});

describe('leaving when the page goes away (#8)', () => {
  it('sends leave_queue (searching), leave_match (in a match, nothing else) and close_room as keepalive beacons', () => {
    const sent: [string, unknown][] = [];
    const svc = new SupabaseMatchService(heldDb([]).db, 'me', ['social'], async () => {}, (fn, args) => void sent.push([fn, args]));
    svc.leaveOnExit(null);
    svc.leaveOnExit('m1');
    svc.closeRoomOnExit('ABC123');
    expect(sent).toEqual([['pokejam_leave_queue', undefined], ['pokejam_leave_match', { p_match: 'm1' }], ['pokejam_close_room', { p_code: 'ABC123' }]]);
  });

  // A closing page gets a request's CORS preflight out but not the request itself (load test v2: 15 of 15 tab-closed
  // matches stayed active). So each exit request is sent once beforehand as a no-op, while the page is alive.
  const NIL = '00000000-0000-0000-0000-000000000000';
  const beacons = () => {
    const sent: [string, unknown][] = [];
    return { sent, send: (fn: string, args?: Record<string, unknown>) => void sent.push([fn, args]) };
  };

  it('warms up leave_queue before the first search poll, and waits for it so it never lands after a pairing', async () => {
    let answered!: () => void;
    const sent: string[] = [];
    const f = heldDb([], { pokejam_find_match: 'm1', pokejam_match_info: info });
    const svc = new SupabaseMatchService(f.db, 'me', ['social'], async () => {},
      (fn) => { sent.push(fn); return fn === 'pokejam_leave_queue' ? new Promise<void>((r) => (answered = r)) : undefined; });
    const p = svc.quickMatch('social', new AbortController().signal);
    await vi.waitFor(() => expect(sent).toContain('pokejam_leave_queue'));
    await vi.advanceTimersByTimeAsync(100);
    expect(f.fns()).not.toContain('pokejam_find_match'); // still waiting for the warm-up
    answered();
    expect((await p).id).toBe('m1');
    expect(f.fns()).toEqual(['pokejam_find_match', 'pokejam_match_info']); // the warm-up is a beacon, not a normal call
  });

  it('warms up leave_match with an id no match has once a match starts (quick, room host, room guest); at most every 20 minutes', async () => {
    const b = beacons();
    const f = heldDb([], { pokejam_find_match: 'm1', pokejam_match_info: info, pokejam_room_state: { match: 'm1', status: 'active' }, pokejam_join_room: 'm1' });
    const svc = new SupabaseMatchService(f.db, 'me', ['social'], async () => {}, b.send);
    await svc.quickMatch('social');
    expect(b.sent).toEqual([['pokejam_leave_queue', undefined], ['pokejam_leave_match', { p_match: NIL }]]);
    await svc.waitForFriend('ABC123');
    await svc.joinRoom('XYZ789');
    expect(b.sent).toHaveLength(2);
    vi.advanceTimersByTime(21 * 60_000);
    await svc.joinRoom('XYZ780');
    expect(b.sent[b.sent.length - 1]).toEqual(['pokejam_leave_match', { p_match: NIL }]);
  });

  it('warms up close_room with a code no room has once the room is made', async () => {
    const b = beacons();
    const svc = new SupabaseMatchService(heldDb([], { pokejam_create_room: 'ABC123' }).db, 'me', ['social'], async () => {}, b.send);
    expect(await svc.createRoom(120)).toBe('ABC123');
    expect(b.sent).toEqual([['pokejam_close_room', { p_code: '' }]]);
  });

  it('a cancelled search sends no leave_match warm-up (it never became a match)', async () => {
    const b = beacons();
    const f = heldDb(['pokejam_find_match'], { pokejam_match_info: info });
    const abort = new AbortController();
    const p = new SupabaseMatchService(f.db, 'me', ['social'], async () => {}, b.send).quickMatch('social', abort.signal).catch((e) => e);
    await vi.waitFor(() => expect(f.fns()).toContain('pokejam_find_match'));
    abort.abort();
    await f.answer('pokejam_find_match', 'm1');
    expect((await p).name).toBe('AbortError');
    expect(b.sent.map(([fn]) => fn)).toEqual(['pokejam_leave_queue']);
  });

  it('reads a match status (null when it is not mine)', async () => {
    expect(await new SupabaseMatchService(heldDb([], { pokejam_match_status: { status: 'void' } }).db, 'me').matchStatus('m1')).toBe('void');
    expect(await new SupabaseMatchService(heldDb([]).db, 'me').matchStatus('m1')).toBeNull();
  });
});

describe('in-game heartbeat (migration 20261106)', () => {
  it('alive() calls pokejam_match_alive with the match id', async () => {
    const f = heldDb([], { pokejam_match_alive: 'active' });
    await new SupabaseMatchService(f.db, 'me').alive('m1');
    expect(f.calls).toEqual([{ fn: 'pokejam_match_alive', args: { p_match: 'm1' } }]);
  });

  it('a server without it: asked once, then never again; other errors are swallowed and retried next beat', async () => {
    const f = heldDb([], { pokejam_match_alive: { data: null, error: { message: 'not found', code: 'PGRST202' }, status: 404 } });
    const svc = new SupabaseMatchService(f.db, 'me');
    await svc.alive('m1');
    await svc.alive('m1');
    expect(f.fns()).toEqual(['pokejam_match_alive']);

    const g = heldDb([], { pokejam_match_alive: { data: null, error: { message: 'boom', code: '500' }, status: 500 } });
    const svc2 = new SupabaseMatchService(g.db, 'me');
    await expect(svc2.alive('m1')).resolves.toBeUndefined();
    await svc2.alive('m1');
    expect(g.fns()).toEqual(['pokejam_match_alive', 'pokejam_match_alive']);
  });
});
