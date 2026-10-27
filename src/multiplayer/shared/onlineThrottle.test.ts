import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BusyError } from './capacity';
import { ensureHuman, type HumanDeps } from './human';
import { JOIN_ATTEMPTS, connect, iceFor, resetIce } from './netplay';
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
  it('an error answer is null, makes no noise, and is not retried for this or later matches for a while', async () => {
    const sb = sbWith(async () => ({ data: null, error: { message: 'TURN not configured' } }));
    expect(await iceFor(sb, 'm1', () => 0)).toBeNull();
    expect(await iceFor(sb, 'm1', () => 1)).toBeNull();
    expect(await iceFor(sb, 'm2', () => 60_000)).toBeNull();
    expect(sb.functions.invoke).toHaveBeenCalledTimes(1);
    expect(await iceFor(sb, 'm3', () => 11 * 60_000)).toBeNull(); // pause over: one new attempt
    expect(sb.functions.invoke).toHaveBeenCalledTimes(2);
  });
  it('a thrown call or a hang is also just null; success returns relay servers', async () => {
    expect(await iceFor(sbWith(async () => { throw new Error('net'); }), 'a', () => 0)).toBeNull();
    resetIce();
    const hang = iceFor(sbWith(() => new Promise(() => {})), 'b', () => 0);
    await vi.advanceTimersByTimeAsync(7000);
    expect(await hang).toBeNull();
    resetIce();
    const ok = await iceFor(sbWith(async () => ({ data: { iceServers: [{ urls: 'turn:x' }] }, error: null })), 'c', () => 0);
    expect(ok).toEqual({ iceServers: [{ urls: 'turn:x' }], policy: 'relay' });
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

  it('a join that never answers ends as busy, not "could not reach the other player"', async () => {
    const sb = { ...fakeSb(['x']).sb, channel: () => { const ch = { on: () => ch, send: async () => 'ok', subscribe: () => ch }; return ch as unknown as RealtimeChannel; } } as unknown as SupabaseClient;
    const p = connect(sb, match, undefined).catch((e) => e);
    await vi.advanceTimersByTimeAsync(41_000);
    expect(await p).toBeInstanceOf(BusyError);
  });
});
