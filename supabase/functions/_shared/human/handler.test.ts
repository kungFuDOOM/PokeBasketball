import { describe, expect, it } from 'vitest';
import { SITEVERIFY, humanConfig, humanHandler, type HumanDeps } from './handler.ts';

const cfg = humanConfig((k) => ({ TURNSTILE_SECRET_KEY: 'sekret', HUMAN_ALLOWED_ORIGINS: 'https://pokejam.xyz' } as Record<string, string>)[k])!;
const req = (body: unknown, headers: Record<string, string> = { origin: 'https://pokejam.xyz', authorization: 'Bearer jwt', 'cf-connecting-ip': '203.0.113.9' }, method = 'POST') =>
  new Request('https://f.test/pokejam-human', { method, headers, body: method === 'POST' ? JSON.stringify(body) : undefined });

function deps(verdict = true) {
  const sent: FormData[] = [];
  const granted: [string, number][] = [];
  const d: HumanDeps = {
    userOf: async (jwt) => (jwt === 'jwt' ? 'user-1' : null),
    grant: async (u, m) => { granted.push([u, m]); return '2026-10-23T12:20:00Z'; },
    fetch: (async (url: string, init?: RequestInit) => {
      expect(url).toBe(SITEVERIFY);
      sent.push(init!.body as FormData);
      return Response.json({ success: verdict, 'error-codes': verdict ? [] : ['invalid-input-response'] });
    }) as unknown as typeof fetch,
  };
  return { d, sent, granted };
}

describe('pokejam-human', () => {
  it('checks the token with Cloudflare (secret, token and the player\'s IP), then grants that player a pass', async () => {
    const { d, sent, granted } = deps();
    const r = await humanHandler(req({ token: 'tok' }), cfg, d);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, until: '2026-10-23T12:20:00Z' });
    expect([sent[0].get('secret'), sent[0].get('response'), sent[0].get('remoteip')]).toEqual(['sekret', 'tok', '203.0.113.9']);
    expect(granted).toEqual([['user-1', 20]]);
  });

  it('a failed check, no session, no token, another site or a GET gets no pass', async () => {
    const bad = deps(false);
    expect((await humanHandler(req({ token: 'tok' }), cfg, bad.d)).status).toBe(403);
    expect(bad.granted).toEqual([]);
    const { d, sent, granted } = deps();
    expect((await humanHandler(req({ token: 'tok' }, { origin: 'https://pokejam.xyz' }), cfg, d)).status).toBe(401);
    expect((await humanHandler(req({ token: 'tok' }, { origin: 'https://pokejam.xyz', authorization: 'Bearer someone-else' }), cfg, d)).status).toBe(401);
    expect((await humanHandler(req({}), cfg, d)).status).toBe(400);
    expect((await humanHandler(req({ token: 'tok' }, { origin: 'https://evil.example', authorization: 'Bearer jwt' }), cfg, d)).status).toBe(403);
    expect((await humanHandler(req(null, { origin: 'https://pokejam.xyz' }, 'GET'), cfg, d)).status).toBe(405);
    expect(sent).toHaveLength(0);
    expect(granted).toEqual([]);
  });

  it('without the secret set it skips (local and preview builds), and answers the browser preflight', async () => {
    expect(await (await humanHandler(req({ token: 'tok' }), null, deps().d)).json()).toEqual({ ok: true, skipped: true });
    expect((await humanHandler(req(null, { origin: 'https://pokejam.xyz' }, 'OPTIONS'), cfg, deps().d)).status).toBe(204);
    expect(humanConfig(() => undefined)).toBeNull();
    expect(humanConfig((k) => ({ TURNSTILE_SECRET_KEY: 's', HUMAN_PASS_MINUTES: '500' } as Record<string, string>)[k])!.passMinutes).toBe(60);
  });
});
