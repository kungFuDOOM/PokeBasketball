import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BusyError } from './capacity';
import { ensureHuman, type HumanDeps } from './human';
import { ICE_MAX, ICE_WINDOW_MS, JOIN_ATTEMPTS, MatchOverError, NetError, connect, iceFor, resetIce } from './netplay';
import { SupabaseMatchService, type OnlineMatch, type RpcClient } from './onlineMatchService';

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); resetIce(); });

type Res = { data: unknown; error: { message: string; code?: string } | null; status?: number };
function db(handler: (fn: string, n: number) => Res) {
  const counts: Record<string, number> = {};
  const client: RpcClient = { rpc: (fn) => Promise.resolve(handler(fn, (counts[fn] = (counts[fn] ?? 0) + 1))) };
  return { client, counts };
}
const busy: Res = { data: null, error: { message: 'Service Unavailable' }, status: 503 };

describe('online requests are throttled', () => {
  it('a busy poll is retried with backoff, then succeeds; a real error is not retried', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const d = db((fn, n) => (fn === 'pokejam_find_match' ? (n < 3 ? busy : { data: 'm1', error: null }) : fn === 'pokejam_match_info'
      ? { data: { id: 'm1', queue: 'social', host: 'me', guest: 'g', host_name: 'A', guest_name: 'B', seed: 5, quarter_len: 120 }, error: null } : { data: null, error: null }));
    const svc = new SupabaseMatchService(d.client, 'me');
    const p = svc.quickMatch('social');
    await vi.advanceTimersByTimeAsync(1000);
    expect(d.counts.pokejam_find_match).toBe(2);
    await vi.advanceTimersByTimeAsync(2000);
    expect((await p).id).toBe('m1');
    expect(d.counts.pokejam_find_match).toBe(3);

    const bad = db(() => ({ data: null, error: { message: 'invalid input', code: '22023' }, status: 400 }));
    await expect(new SupabaseMatchService(bad.client, 'me').draftState('m')).rejects.toThrow('invalid input');
    expect(bad.counts.pokejam_draft_state).toBe(1);
  });

  it('gives up after the retries with an error that reads as "busy"', async () => {
    const d = db(() => busy);
    const p = new SupabaseMatchService(d.client, 'me').draftState('m').catch((e) => e);
    await vi.advanceTimersByTimeAsync(20_000);
    const err = await p;
    expect(d.counts.pokejam_draft_state).toBe(3);
    expect(err.status).toBe(503);
  });

  it('double-taps send one request: rename, make a room, report, block, join', async () => {
    const d = db((fn) => ({ data: fn === 'pokejam_create_room' ? 'ABC123' : fn === 'pokejam_ensure_profile' ? { trainer_name: 'Ash' } : fn === 'pokejam_join_room' ? null : true, error: null }));
    const svc = new SupabaseMatchService(d.client, 'me');
    await Promise.all([svc.setName('Ash'), svc.setName('Ash')]);
    await svc.setName('Ash'); // already set: no request at all
    await Promise.all([svc.createRoom(120), svc.createRoom(120)]);
    await Promise.all([svc.report('m', 'cheating'), svc.report('m', 'name')]);
    await Promise.all([svc.block('m'), svc.block('m')]);
    await Promise.all([svc.joinRoom('abc123').catch(() => {}), svc.joinRoom('ABC123').catch(() => {})]);
    expect(d.counts).toEqual({ pokejam_ensure_profile: 1, pokejam_create_room: 1, pokejam_report_player: 1, pokejam_block_player: 1, pokejam_join_room: 1 });
    await svc.setName('Misty');
    expect(d.counts.pokejam_ensure_profile).toBe(2);
  });

  it('room-code tries are limited per minute', async () => {
    const d = db(() => ({ data: null, error: null }));
    const svc = new SupabaseMatchService(d.client, 'me');
    for (let i = 0; i < 6; i++) await expect(svc.joinRoom(`AAAA${i}A`)).rejects.toThrow('room not found');
    await expect(svc.joinRoom('BBBBBB')).rejects.toThrow(/Too many tries/);
    expect(d.counts.pokejam_join_room).toBe(6);
    await expect(svc.joinRoom('abc')).rejects.toThrow(/6 letters/); // malformed codes cost nothing
    vi.advanceTimersByTime(61_000);
    await expect(svc.joinRoom('BBBBBB')).rejects.toThrow('room not found');
  });

  it('pokejam-human checks at once are one; after a failure the retry waits', async () => {
    let now = 1000;
    const log: string[] = [];
    let ok = false;
    const d: HumanDeps = {
      enabled: true, now: () => now, gate: { failedAt: -Infinity, flights: new Map() },
      pause: async (ms) => { log.push(`wait${ms}`); now += ms; },
      rpc: async () => ({ data: { required: true, until: null }, error: null }),
      token: async () => { log.push('token'); return 't'; },
      invoke: async () => (ok ? { ok: true } : { ok: false, reason: '403' }),
    };
    await Promise.all([ensureHuman(d).catch(() => {}), ensureHuman(d).catch(() => {})]);
    expect(log).toEqual(['token']);
    ok = true;
    now = 1500;
    await ensureHuman(d);
    expect(log).toEqual(['token', 'wait2500', 'token']);
  });
});

describe('pokejam-ice degrades quietly', () => {
  const sbWith = (invoke: () => Promise<unknown>) => ({ functions: { invoke: vi.fn(invoke) } }) as unknown as SupabaseClient & { functions: { invoke: ReturnType<typeof vi.fn> } };
  it('an error answer is null, makes no noise, and is not retried for this or later matches for a minute', async () => {
    const sb = sbWith(async () => ({ data: null, error: { message: 'TURN not configured' } }));
    expect(await iceFor(sb, 'm1', () => 0)).toBeNull();
    expect(await iceFor(sb, 'm1', () => 1)).toBeNull();
    expect(await iceFor(sb, 'm2', () => 59_000)).toBeNull();
    expect(sb.functions.invoke).toHaveBeenCalledTimes(1); // a refusal is not retried
    expect(await iceFor(sb, 'm3', () => 61_000)).toBeNull(); // pause over: one new attempt
    expect(sb.functions.invoke).toHaveBeenCalledTimes(2);
  });
  it('a thrown call is null; a hang (cold start) is tried once more, then null; success returns relay servers', async () => {
    expect(await iceFor(sbWith(async () => { throw new Error('net'); }), 'a', () => 0)).toBeNull();
    resetIce();
    const hanging = sbWith(() => new Promise(() => {}));
    const hang = iceFor(hanging, 'b', () => 0);
    await vi.advanceTimersByTimeAsync(7000);
    expect(hanging.functions.invoke).toHaveBeenCalledTimes(2); // the retry
    await vi.advanceTimersByTimeAsync(7000);
    expect(await hang).toBeNull();
    expect(hanging.functions.invoke).toHaveBeenCalledTimes(2);
    resetIce();
    // A cold start: the first call hangs, the retry answers.
    let n = 0;
    const cold = sbWith(() => (++n === 1 ? new Promise(() => {}) : Promise.resolve({ data: { iceServers: [{ urls: 'turn:y' }] }, error: null })));
    const warm = iceFor(cold, 'c0', () => 0);
    await vi.advanceTimersByTimeAsync(7000);
    expect(await warm).toEqual({ iceServers: [{ urls: 'turn:y' }], policy: 'relay' });
    resetIce();
    const ok = await iceFor(sbWith(async () => ({ data: { iceServers: [{ urls: 'turn:x' }] }, error: null })), 'c', () => 0);
    expect(ok).toEqual({ iceServers: [{ urls: 'turn:x' }], policy: 'relay' });
  });
  it("never asks more often than the server's limit (6 per 10 minutes), retries included", async () => {
    const sb = sbWith(async () => ({ data: { iceServers: [{ urls: 'turn:x' }] }, error: null }));
    for (let i = 0; i < ICE_MAX; i++) expect(await iceFor(sb, `m${i}`, () => i * 1000)).not.toBeNull();
    expect(await iceFor(sb, 'one-too-many', () => 9 * 60_000)).toBeNull(); // straight to Realtime, no request
    expect(sb.functions.invoke).toHaveBeenCalledTimes(ICE_MAX);
    expect(await iceFor(sb, 'later', () => ICE_WINDOW_MS + 1000)).not.toBeNull(); // the oldest has aged out
    expect(sb.functions.invoke).toHaveBeenCalledTimes(ICE_MAX + 1);
  });
});

describe('joining the match channel', () => {
  function fakeSb(statuses: string[]) {
    let joins = 0;
    const sends: unknown[] = [];
    const subs: number[] = [];
    const sb = {
      realtime: { setAuth: async () => {} },
      removeChannel: vi.fn(async () => 'ok'),
      channel: () => {
        const ch = {
          on: () => ch,
          send: async (m: unknown) => { sends.push(m); return 'ok'; },
          subscribe: (cb: (s: string, e?: Error) => void) => { subs.push(Date.now()); setTimeout(() => cb(statuses[Math.min(joins++, statuses.length - 1)]), 0); return ch; },
        };
        return ch as unknown as RealtimeChannel;
      },
    } as unknown as SupabaseClient;
    return { sb, sends, subs };
  }
  const match: OnlineMatch = { id: 'm', queue: 'social', side: 0, me: { id: 'a', name: 'A' }, opponent: { id: 'b', name: 'B', mmr: 1000, simulated: false }, game: { seed: 1, quarterLen: 120 }, keys: [null, null] };

  it('retries with growing, capped, jittered pauses, sends nothing unjoined, then reports "busy"', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const f = fakeSb(['CHANNEL_ERROR']);
    const t0 = Date.now();
    const p = connect(f.sb, match, undefined).catch((e) => e);
    await vi.advanceTimersByTimeAsync(30_000);
    const err = await p;
    expect(err).toBeInstanceOf(BusyError);
    expect(f.subs.length).toBe(JOIN_ATTEMPTS);
    // 1 s, 2 s, 4 s pauses (a millisecond of fake-timer slack per join)
    expect(f.subs.map((s) => Math.round((s - t0) / 10) * 10)).toEqual([0, 1000, 3000, 7000]);
    expect(f.sends).toEqual([]);
  });

  describe('a channel refused because the match is over is "opponent left", never "busy" (#6)', () => {
    const refusing = () => {
      const subs: number[] = [];
      const sb = {
        realtime: { setAuth: async () => {} },
        removeChannel: vi.fn(async () => 'ok'),
        channel: () => {
          const ch = {
            on: () => ch, send: async () => 'ok',
            subscribe: (cb: (s: string, e?: Error) => void) => {
              subs.push(Date.now());
              setTimeout(() => cb('CHANNEL_ERROR', new Error('Unauthorized: You do not have permissions to read from this Channel topic: pokejam:match:m')), 0);
              return ch;
            },
          };
          return ch as unknown as RealtimeChannel;
        },
      } as unknown as SupabaseClient;
      return { sb, subs };
    };
    const svcWith = (status: string | null) => {
      const d = db((fn) => (fn === 'pokejam_match_status' ? { data: status ? { status } : null, error: null } : { data: null, error: null }));
      return { svc: new SupabaseMatchService(d.client, 'a'), counts: d.counts };
    };

    it('the other player left: MatchOverError on the first refusal, no retries', async () => {
      const f = refusing();
      const { svc } = svcWith('void');
      const p = connect(f.sb, match, undefined, undefined, svc).catch((e) => e);
      await vi.advanceTimersByTimeAsync(100);
      expect(await p).toBeInstanceOf(MatchOverError);
      expect(f.subs.length).toBe(1);
    });

    it('refused while the match is still on: retried, then a connection error, not "busy"', async () => {
      const f = refusing();
      const { svc, counts } = svcWith('active');
      const p = connect(f.sb, match, undefined, undefined, svc).catch((e) => e);
      await vi.advanceTimersByTimeAsync(30_000);
      const err = await p;
      expect(err).toBeInstanceOf(NetError);
      expect(err).not.toBeInstanceOf(BusyError);
      expect(f.subs.length).toBe(JOIN_ATTEMPTS);
      expect(counts.pokejam_match_status).toBe(JOIN_ATTEMPTS);
    });
  });

  it('a join that never answers ends as busy, not "could not reach the other player"', async () => {
    const sb = { ...fakeSb(['x']).sb, channel: () => { const ch = { on: () => ch, send: async () => 'ok', subscribe: () => ch }; return ch as unknown as RealtimeChannel; } } as unknown as SupabaseClient;
    const p = connect(sb, match, undefined).catch((e) => e);
    await vi.advanceTimersByTimeAsync(41_000);
    expect(await p).toBeInstanceOf(BusyError);
  });
});
