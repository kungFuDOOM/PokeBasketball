import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const board = vi.fn();
const setLiveAds = vi.fn();
vi.mock('../config/features', () => ({ MODE_ADS: true }));
vi.mock('../data/ads', () => ({ setLiveAds: (a: unknown) => setLiveAds(a) }));
vi.mock('./api', () => ({ ADS_CONFIGURED: true, adsApi: { board: () => board() } }));

const MIN = 60_000;
const okBoard = () => ({ live: [{ text: 'HI', theme: 'gold', ends_at: '2099-01-01T00:00:00Z' }] });

let hidden = false;
let visListener: (() => void) | undefined;
let store: Map<string, string>;

async function load() {
  const m = await import('./board');
  m.resetLiveAdsForTest();
  return m;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
  hidden = false; visListener = undefined; store = new Map();
  board.mockReset(); setLiveAds.mockReset();
  board.mockResolvedValue(okBoard());
  vi.stubGlobal('document', {
    get hidden() { return hidden; },
    addEventListener: (_: string, f: () => void) => { visListener = f; },
  });
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
  });
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('live ads polling', () => {
  it('fetches on start, then every 10 minutes (not 2)', async () => {
    const { startLiveAds, EVERY } = await load();
    expect(EVERY).toBe(10 * MIN);
    startLiveAds(); startLiveAds(); // idempotent
    await vi.advanceTimersByTimeAsync(0);
    expect(board).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(9 * MIN);
    expect(board).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1 * MIN + 1000);
    expect(board).toHaveBeenCalledTimes(2);
  });

  it('never fetches while hidden, and refreshes on visible only when stale', async () => {
    const { startLiveAds } = await load();
    startLiveAds();
    await vi.advanceTimersByTimeAsync(0);
    expect(board).toHaveBeenCalledTimes(1);
    hidden = true;
    visListener!();
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(board).toHaveBeenCalledTimes(1);
    hidden = false;
    visListener!(); // 60 min old: stale
    await vi.advanceTimersByTimeAsync(0);
    expect(board).toHaveBeenCalledTimes(2);
    visListener!(); // just fetched: fresh
    await vi.advanceTimersByTimeAsync(0);
    expect(board).toHaveBeenCalledTimes(2);
  });

  it('uses a fresh cache instead of fetching on start, and a stale one is ignored', async () => {
    let m = await load();
    m.startLiveAds();
    await vi.advanceTimersByTimeAsync(0);
    expect(board).toHaveBeenCalledTimes(1);
    expect(store.has(m.CACHE_KEY)).toBe(true);

    vi.setSystemTime(Date.now() + 5 * MIN);
    setLiveAds.mockClear();
    m = await load(); // a reload / second tab
    m.startLiveAds();
    await vi.advanceTimersByTimeAsync(0);
    expect(board).toHaveBeenCalledTimes(1);
    expect(setLiveAds).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(5 * MIN + 2000); // cache now 10 min old
    expect(board).toHaveBeenCalledTimes(2);

    vi.setSystemTime(Date.now() + 30 * MIN);
    m = await load();
    m.startLiveAds();
    await vi.advanceTimersByTimeAsync(0);
    expect(board).toHaveBeenCalledTimes(3);
  });

  it('survives broken storage', async () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } });
    const { startLiveAds } = await load();
    startLiveAds();
    await vi.advanceTimersByTimeAsync(0);
    expect(board).toHaveBeenCalledTimes(1);
    expect(setLiveAds).toHaveBeenCalled();
  });

  it('backs off after errors: 20, then 30 minutes', async () => {
    board.mockRejectedValue(new Error('down'));
    const { startLiveAds } = await load();
    startLiveAds();
    await vi.advanceTimersByTimeAsync(0);
    expect(board).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(19 * MIN);
    expect(board).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1 * MIN + 1000);
    expect(board).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(29 * MIN);
    expect(board).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1 * MIN + 1000);
    expect(board).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(30 * MIN + 1000); // capped at 30
    expect(board).toHaveBeenCalledTimes(4);
  });

  it('applyBoard (the Advertise page) updates the cache', async () => {
    const { applyBoard, CACHE_KEY } = await load();
    applyBoard(okBoard() as never);
    expect(JSON.parse(store.get(CACHE_KEY)!).live[0].text).toBe('HI');
  });
});

describe('board GET', () => {
  it('sends no custom headers, so there is no CORS preflight', async () => {
    vi.resetModules();
    vi.doUnmock('./api');
    vi.stubEnv('VITE_SUPABASE_URL', 'https://x.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon');
    vi.stubEnv('VITE_ADS_API', '');
    const f = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ live: [] }) });
    vi.stubGlobal('fetch', f);
    const { adsApi } = await import('./api');
    await adsApi.board();
    const [url, init] = f.mock.calls[0];
    expect(url).toBe('https://x.supabase.co/functions/v1/pokejam-ads-live?action=board');
    expect(init?.headers).toBeUndefined();
    expect(init?.method ?? 'GET').toBe('GET');
    await adsApi.quote('x' as never, null);
    expect(f.mock.calls[1][1].headers).toMatchObject({ apikey: 'anon', 'content-type': 'application/json' });
    vi.unstubAllEnvs();
  });
});
