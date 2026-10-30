import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GUEST_FALLBACK_MS, PreBarrier, PreGate, parsePre, type PreKind } from './pre';

describe('parsePre', () => {
  it('accepts the four kinds, with or without a time', () => {
    for (const k of ['ready', 'skip', 'unskip', 'go'] as const) expect(parsePre({ k })).toEqual({ k });
    expect(parsePre({ k: 'go', at: 1234 })).toEqual({ k: 'go', at: 1234 });
  });

  it('rejects junk', () => {
    for (const junk of [null, undefined, 1, 'go', [], {}, { k: 'hi' }, { k: 7 }, { k: 'go', at: 'soon' }, { k: 'go', at: NaN }])
      expect(parsePre(junk)).toBeNull();
  });
});

describe('PreBarrier', () => {
  it('the host sends go once, only when both are ready', () => {
    const b = new PreBarrier(0);
    expect(b.host).toBe(true);
    expect(b.takeGo()).toBe(false);
    b.ready();
    expect(b.takeGo()).toBe(false);
    expect(b.canStart()).toBe(false);
    b.receive({ k: 'ready' });
    expect(b.takeGo()).toBe(true);
    expect(b.takeGo()).toBe(false);
    expect(b.canStart()).toBe(true);
  });

  it('the host can force go after the cap without the guest', () => {
    const b = new PreBarrier(0);
    b.ready();
    expect(b.takeGo(true)).toBe(true);
    expect(b.canStart()).toBe(true);
  });

  it('the guest never sends go and starts only on go', () => {
    const b = new PreBarrier(1);
    b.ready();
    b.receive({ k: 'ready' });
    expect(b.takeGo(true)).toBe(false);
    expect(b.canStart()).toBe(false);
    b.receive({ k: 'go' });
    expect(b.canStart()).toBe(true);
  });

  it('a go sent to the host is ignored', () => {
    const b = new PreBarrier(0);
    b.receive({ k: 'go' });
    expect(b.goReceived).toBe(false);
    expect(b.canStart()).toBe(false);
  });
});

describe('PreGate: simulated host and guest', () => {
  const CAP = 10_000;
  const LATENCY = 50;
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Two gates joined by a link with one-way latency; `drop` loses that side's messages. */
  function pair(drop: { host?: boolean; guest?: boolean } = {}) {
    const startedAt: [number | null, number | null] = [null, null];
    const sent: [PreKind[], PreKind[]] = [[], []];
    const gates: PreGate[] = [];
    for (const side of [0, 1] as const) {
      gates[side] = new PreGate(side, CAP, (k) => {
        sent[side].push(k);
        if (side === 0 ? drop.host : drop.guest) return;
        setTimeout(() => gates[1 - side].peer({ k }), LATENCY);
      }, () => {
        expect(startedAt[side]).toBeNull();
        startedAt[side] = Date.now();
      });
    }
    return { host: gates[0], guest: gates[1], startedAt, sent, t0: Date.now() };
  }

  it('both intros end: host sends go, guest starts one latency later', () => {
    const s = pair();
    vi.advanceTimersByTime(6000);
    s.host.localEnd();
    s.guest.localEnd();
    vi.advanceTimersByTime(LATENCY - 1);
    expect(s.startedAt).toEqual([null, null]);
    vi.advanceTimersByTime(1);
    expect(s.startedAt[0]).toBe(s.t0 + 6000 + LATENCY);
    expect(s.startedAt[1]).toBeNull();
    vi.advanceTimersByTime(LATENCY);
    expect(s.startedAt[1]).toBe(s.t0 + 6000 + 2 * LATENCY);
    expect(s.sent).toEqual([['ready', 'go'], ['ready']]);
  });

  it('the guest never starts before go, even when ready first and the host is slow', () => {
    const s = pair();
    s.guest.localEnd();
    vi.advanceTimersByTime(8000);
    expect(s.startedAt[1]).toBeNull();
    s.host.localEnd();
    expect(s.startedAt[0]).toBe(s.t0 + 8000);
    vi.advanceTimersByTime(LATENCY - 1);
    expect(s.startedAt[1]).toBeNull();
    vi.advanceTimersByTime(1);
    expect(s.startedAt[1]).toBe(s.t0 + 8000 + LATENCY);
  });

  it('the cap bounds both: the host forces go when the guest never says ready', () => {
    const s = pair({ guest: true });
    s.host.localEnd();
    s.guest.localEnd();
    vi.advanceTimersByTime(CAP - 1);
    expect(s.startedAt).toEqual([null, null]);
    vi.advanceTimersByTime(1);
    expect(s.startedAt[0]).toBe(s.t0 + CAP);
    vi.advanceTimersByTime(LATENCY);
    expect(s.startedAt[1]).toBe(s.t0 + CAP + LATENCY);
  });

  it('the cap bounds both even if neither intro reports its end', () => {
    const s = pair();
    vi.advanceTimersByTime(CAP + LATENCY);
    expect(s.startedAt).toEqual([s.t0 + CAP, s.t0 + CAP + LATENCY]);
    expect(s.sent[0]).toEqual(['ready', 'go']);
  });

  it('a guest that never hears go starts only at the cap + fallback', () => {
    const s = pair({ host: true });
    s.host.localEnd();
    s.guest.localEnd();
    vi.advanceTimersByTime(CAP + GUEST_FALLBACK_MS - 1);
    expect(s.startedAt[1]).toBeNull();
    vi.advanceTimersByTime(1);
    expect(s.startedAt[1]).toBe(s.t0 + CAP + GUEST_FALLBACK_MS);
  });

  it('destroy (abort, opponent left) clears the timers: nothing starts', () => {
    const s = pair();
    s.host.destroy();
    s.guest.destroy();
    s.host.localEnd();
    s.guest.peer({ k: 'go' });
    vi.advanceTimersByTime(CAP * 2);
    expect(s.startedAt).toEqual([null, null]);
  });
});
