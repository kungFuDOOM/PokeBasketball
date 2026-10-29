import { describe, expect, it } from 'vitest';
import { DEVICE_KEY, makeOfflineStats, randomUuid, type OfflineDeps } from './offlineStats';

const memStorage = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};

const setup = (over: Partial<OfflineDeps> = {}) => {
  const sent: Record<string, string | number | null>[] = [];
  const store = memStorage();
  let n = 0;
  const s = makeOfflineStats({
    send: async (b) => { sent.push(b); },
    storage: () => store,
    online: () => true,
    uuid: () => `00000000-0000-4000-8000-00000000000${++n}`,
    ...over,
  });
  return { s, sent, store };
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('offline stats', () => {
  it('sends the RPC arguments and nothing else', () => {
    const { s, sent } = setup();
    s.start('quick').finish('played');
    s.season('franchise', 2, 3);
    expect(sent).toEqual([
      { p_device: '00000000-0000-4000-8000-000000000001', p_event: 'start', p_mode: 'quick', p_resolution: null, p_season: null, p_playoff_round: null },
      { p_device: '00000000-0000-4000-8000-000000000001', p_event: 'finish', p_mode: 'quick', p_resolution: 'played', p_season: null, p_playoff_round: null },
      { p_device: '00000000-0000-4000-8000-000000000001', p_event: 'season', p_mode: 'franchise', p_resolution: null, p_season: 2, p_playoff_round: 3 },
    ]);
  });

  it('keeps one device id in localStorage and reuses it', () => {
    const { s, sent, store } = setup();
    s.start('franchise');
    s.start('quick');
    expect(store.m.get(DEVICE_KEY)).toBe('00000000-0000-4000-8000-000000000001');
    expect(new Set(sent.map((b) => b.p_device)).size).toBe(1);
    // a junk value is replaced
    store.m.set(DEVICE_KEY, 'not-a-uuid');
    s.start('quick');
    expect(sent[2].p_device).toBe('00000000-0000-4000-8000-000000000002');
  });

  it('one start and at most one finish per game', () => {
    const { s, sent } = setup();
    const g = s.start('franchise');
    g.finish('simmed');
    g.finish('played');
    g.finish();
    expect(sent.map((b) => [b.p_event, b.p_resolution])).toEqual([['start', null], ['finish', 'simmed']]);
    s.start('franchise').finish();
    expect(sent[sent.length - 1]).toMatchObject({ p_event: 'finish', p_resolution: 'played' });
  });

  it('sends nothing offline or without storage', () => {
    const off = setup({ online: () => false });
    off.s.start('quick').finish();
    expect(off.sent).toHaveLength(0);
    const none = setup({ storage: () => null });
    none.s.start('quick').finish();
    expect(none.sent).toHaveLength(0);
  });

  it('never throws: rejected fetch, throwing send, throwing storage', async () => {
    const rejected = setup({ send: () => Promise.reject(new Error('network')) });
    expect(() => rejected.s.start('quick').finish()).not.toThrow();
    const sync = setup({ send: () => { throw new Error('sync'); } });
    expect(() => sync.s.season('season_draft', null, 0)).not.toThrow();
    const badStore = setup({ storage: () => ({ getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } }) });
    expect(() => badStore.s.start('quick').finish()).not.toThrow();
    expect(badStore.sent).toHaveLength(0);
    const quota = setup({ storage: () => ({ getItem: () => null, setItem: () => { throw new Error('quota'); } }) });
    expect(() => quota.s.start('quick')).not.toThrow();
    expect(quota.sent).toHaveLength(0);
    await new Promise((r) => setTimeout(r, 0)); // no unhandled rejection
  });

  it('random ids are v4 UUIDs, with or without crypto.getRandomValues', () => {
    expect(randomUuid()).toMatch(UUID);
    const orig = crypto.getRandomValues;
    try {
      Object.defineProperty(crypto, 'getRandomValues', { value: () => { throw new Error('none'); }, configurable: true });
      const a = randomUuid();
      expect(a).toMatch(UUID);
      expect(randomUuid()).not.toBe(a);
    } finally {
      Object.defineProperty(crypto, 'getRandomValues', { value: orig, configurable: true });
    }
  });
});
