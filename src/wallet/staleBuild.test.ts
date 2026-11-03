import { describe, expect, it, vi } from 'vitest';
import type { Store } from './phantomLink';
import { RELOAD_KEY, isStale, reloadIfStale, runningBuild } from './staleBuild';

function memStore(): Store & { m: Map<string, string> } {
  const m = new Map<string, string>();
  return { m, getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), removeItem: (k) => void m.delete(k) };
}
const run = (live: string | Error, running = 'abc1234', store: Store = memStore()) => {
  const reload = vi.fn();
  const p = reloadIfStale({ running, store, reload, fetchLive: () => (live instanceof Error ? Promise.reject(live) : Promise.resolve(live)) });
  return { p, reload, store };
};

describe('is the running build stale', () => {
  it('only when a valid, different id is live', () => {
    expect(isStale('abc1234', 'def5678')).toBe(true);
    expect(isStale('abc1234', ' def5678\n')).toBe(true);
    expect(isStale('abc1234', 'abc1234')).toBe(false);
    expect(isStale('abc1234', '')).toBe(false);
    expect(isStale('abc1234', null)).toBe(false);
    expect(isStale('abc1234', '<!doctype html><html>')).toBe(false); // a host that answers every path with its error page
    expect(isStale('abc1234', 'x'.repeat(80))).toBe(false);
  });
  it('a dev build is never stale, and tests run as dev', () => {
    expect(isStale('dev', 'def5678')).toBe(false);
    expect(runningBuild()).toBe('dev');
  });
});

describe('reloading before a sign-in starts', () => {
  it('reloads once when the live build differs', async () => {
    const { p, reload, store } = run('def5678');
    expect(await p).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(store.getItem(RELOAD_KEY)).toBe('def5678');
  });
  it('does not reload when the build matches', async () => {
    const { p, reload } = run('abc1234');
    expect(await p).toBe(false);
    expect(reload).not.toHaveBeenCalled();
  });
  it('does not loop when a cache keeps serving the old bundle after a reload', async () => {
    const store = memStore();
    expect(await run('def5678', 'abc1234', store).p).toBe(true);
    const again = run('def5678', 'abc1234', store);
    expect(await again.p).toBe(false);
    expect(again.reload).not.toHaveBeenCalled();
    // A newer deploy after that is still picked up.
    expect(await run('fff9999', 'abc1234', store).p).toBe(true);
  });
  it('is silent on network errors and unusable answers', async () => {
    for (const live of [new Error('Failed to fetch'), new TypeError('Load failed'), '']) {
      const { p, reload } = run(live);
      expect(await p).toBe(false);
      expect(reload).not.toHaveBeenCalled();
    }
  });
  it('is silent when storage or reload throw', async () => {
    const broken: Store = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); }, removeItem: () => {} };
    expect(await run('def5678', 'abc1234', broken).p).toBe(false);
    expect(await reloadIfStale({ running: 'abc1234', store: memStore(), reload: () => { throw new Error('x'); }, fetchLive: async () => 'def5678' })).toBe(false);
  });
});
