import { afterEach, describe, expect, it, vi } from 'vitest';
import { logAdClick } from './clicks';

const ID = '123e4567-e89b-42d3-a456-426614174000';
const EP = 'https://x.supabase.co/functions/v1/pokejam-ads-live';

afterEach(() => vi.unstubAllGlobals());

describe('logAdClick', () => {
  it('posts one keepalive click for a paid ad', () => {
    const f = vi.fn().mockResolvedValue(new Response('{}'));
    vi.stubGlobal('fetch', f);
    expect(logAdClick(ID, 'https://ripit.co', EP)).toBe(true);
    expect(f).toHaveBeenCalledTimes(1);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe(EP);
    expect(init).toMatchObject({ method: 'POST', keepalive: true, credentials: 'omit', headers: { 'content-type': 'text/plain' } });
    expect(JSON.parse(init.body)).toEqual({ action: 'click', id: ID, url: 'https://ripit.co' });
  });
  it('ignores links with no paid-ad id ($PJAM house link, YOUR AD HERE), bad ids, non-https and no endpoint', () => {
    const f = vi.fn();
    vi.stubGlobal('fetch', f);
    expect(logAdClick(undefined, 'https://ripit.co', EP)).toBe(false);
    expect(logAdClick('', 'https://ripit.co', EP)).toBe(false);
    expect(logAdClick('not-a-uuid', 'https://ripit.co', EP)).toBe(false);
    expect(logAdClick(ID, 'http://ripit.co', EP)).toBe(false);
    expect(logAdClick(ID, null, EP)).toBe(false);
    expect(logAdClick(ID, 'https://ripit.co', '')).toBe(false);
    expect(f).not.toHaveBeenCalled();
  });
  it('never throws, whether fetch throws or rejects', async () => {
    vi.stubGlobal('fetch', vi.fn(() => { throw new Error('boom'); }));
    expect(() => logAdClick(ID, 'https://ripit.co', EP)).not.toThrow();
    expect(logAdClick(ID, 'https://ripit.co', EP)).toBe(false);
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(() => logAdClick(ID, 'https://ripit.co', EP)).not.toThrow();
    await Promise.resolve();
  });
  it('a malformed href does not throw', () => {
    vi.stubGlobal('fetch', vi.fn());
    expect(() => logAdClick(ID, 'not a url', EP)).not.toThrow();
  });
});
