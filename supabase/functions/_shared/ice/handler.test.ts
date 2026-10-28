import { describe, expect, it } from 'vitest';
import { iceConfig, iceHandler, type IceDeps } from './handler.ts';

const MATCH = '0b7f6c1e-1d2a-4c55-9a51-7a1b2c3d4e5f';
const cfg = iceConfig((k) => ({ TURN_KEY_ID: 'key1', TURN_KEY_API_TOKEN: 'secret', ICE_ALLOWED_ORIGINS: 'https://pokejam.xyz' } as Record<string, string>)[k])!;
const req = (body: unknown, headers: Record<string, string> = { origin: 'https://pokejam.xyz', authorization: 'Bearer jwt' }, method = 'POST') =>
  new Request('https://f.test/pokejam-ice', { method, headers, body: method === 'POST' ? JSON.stringify(body) : undefined });

function deps(ok = true) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const d: IceDeps = {
    iceOk: async (jwt, m) => ok && jwt === 'jwt' && m === MATCH,
    fetch: (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return Response.json({ iceServers: [{
        urls: ['stun:stun.cloudflare.com:3478', 'turn:turn.cloudflare.com:3478?transport=udp', 'turn:turn.cloudflare.com:53?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'],
        username: 'u', credential: 'c',
      }] }, { status: 201 });
    }) as unknown as typeof fetch,
  };
  return { d, calls };
}

describe('pokejam-ice', () => {
  it('gives a player in an active match relay-only TURN servers, minted with the server-side key', async () => {
    const { d, calls } = deps();
    const r = await iceHandler(req({ match: MATCH }), cfg, d);
    expect(r.status).toBe(200);
    expect(r.headers.get('access-control-allow-origin')).toBe('https://pokejam.xyz');
    expect(await r.json()).toEqual({ iceServers: [{ urls: ['turn:turn.cloudflare.com:3478?transport=udp', 'turns:turn.cloudflare.com:443?transport=tcp'], username: 'u', credential: 'c' }] });
    expect(calls[0].url).toBe('https://rtc.live.cloudflare.com/v1/turn/keys/key1/credentials/generate-ice-servers');
    expect((calls[0].init?.headers as Record<string, string>).authorization).toBe('Bearer secret');
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ ttl: 3600 });
  });

  it('refuses anyone else: no session, not in the match, a bad match id, another site, a GET', async () => {
    const { d, calls } = deps();
    expect((await iceHandler(req({ match: MATCH }, { origin: 'https://pokejam.xyz' }), cfg, d)).status).toBe(401);
    expect((await iceHandler(req({ match: MATCH }), cfg, deps(false).d)).status).toBe(403);
    expect((await iceHandler(req({ match: "x' or 1=1" }), cfg, d)).status).toBe(400);
    expect((await iceHandler(req({ match: MATCH }, { origin: 'https://evil.example', authorization: 'Bearer jwt' }), cfg, d)).status).toBe(403);
    expect((await iceHandler(req(null, { origin: 'https://pokejam.xyz' }, 'GET'), cfg, d)).status).toBe(405);
    expect(calls).toHaveLength(0); // the TURN key was never used
  });

  it('answers the browser preflight, and with no TURN key set up hands out nothing (the game stays on Realtime)', async () => {
    const pre = await iceHandler(req(null, { origin: 'https://pokejam.xyz' }, 'OPTIONS'), cfg, deps().d);
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-methods')).toContain('POST');
    const off = await iceHandler(req({ match: MATCH }), null, deps().d);
    expect(await off.json()).toEqual({ iceServers: [] });
  });
});
