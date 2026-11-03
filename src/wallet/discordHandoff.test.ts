// @ts-ignore Node's fs has no type declarations in this project.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  beginDiscordHandoff, finishDiscordInSafari, discordHandoffUrl, discordSignInPlan, parseDiscordReturn, reportDiscordFailure,
  restoreDiscordInApp, wipeDiscordOauthStorage, type DiscordCodeAuth, type DiscordAppAuth,
} from './discordHandoff';
import { discordSheetHtml } from './discordView';
import { handoffCode, openRefreshToken } from './phantomHandoff';
import { relayTake, type RelayClient, type Store } from './phantomLink';

const loc = { origin: 'https://pokejam.xyz', pathname: '/' };
const NOW = Date.parse('2026-11-03T02:00:00.000Z');

function memStore(): Store & { m: Map<string, string>; key(i: number): string | null; length: number } {
  const m = new Map<string, string>();
  return {
    m,
    get length() { return m.size; },
    key: (i) => [...m.keys()][i] ?? null,
    getItem: (k) => m.get(k) ?? null,
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

function relay() {
  const rows = new Map<string, unknown>();
  const calls: string[] = [];
  const client: RelayClient = {
    rpc: async (fn, args) => {
      calls.push(fn);
      const id = String(args.p_id);
      if (fn === 'pokejam_phantom_relay_put') {
        if (rows.has(id)) return { data: false, error: null };
        rows.set(id, args.p_payload);
        return { data: true, error: null };
      }
      const v = rows.get(id) ?? null;
      rows.delete(id);
      return { data: v, error: null };
    },
  };
  return { client, rows, calls };
}

describe('where Discord sign-in runs', () => {
  it('a standalone app hands off to Safari; any other tab redirects itself', () => {
    expect(discordSignInPlan(true)).toBe('handoff');
    expect(discordSignInPlan(false)).toBe('redirect');
  });
  it('the handoff URL carries the id and public key, never the secret', () => {
    const s = memStore();
    const { url, handoff } = beginDiscordHandoff(s, { loc, returnTo: 'ranked', now: NOW });
    expect(url).toContain(`pj_discord=${handoff.id}`);
    expect(url).toContain('pj_gk=');
    expect(url).toContain('pj_to=ranked');
    expect(url).not.toContain(handoff.secret);
    expect(discordHandoffUrl(loc, handoff)).toBe(url);
    expect(handoffCode(handoff.id)).toHaveLength(4);
    const sheet = discordSheetHtml({ kind: 'wait', code: handoffCode(handoff.id), url });
    expect(sheet).toContain('Continue in Safari');
    expect(sheet).toContain(handoffCode(handoff.id));
    expect(sheet).not.toMatch(/@/);
  });
});

describe('Safari finishes, the app collects', () => {
  it('exchanges the code, seals the refresh token, and the app restores the same return target', async () => {
    const app = memStore();
    const { url, handoff } = beginDiscordHandoff(app, { loc, returnTo: 'profile', now: NOW });
    const landed = parseDiscordReturn(new URL(url).search + '&code=oauth-code');
    expect(landed).toMatchObject({ id: handoff.id, returnTo: 'profile', code: 'oauth-code' });
    const calls: string[] = [];
    const auth: DiscordCodeAuth & { signOut?: () => void } = {
      exchangeCodeForSession: async (code) => { calls.push(code); return { data: { session: { refresh_token: 'rt-1' } }, error: null }; },
      signOut: () => { calls.push('signOut'); },
    };
    const box = relay();
    await finishDiscordInSafari(auth, box.client, { code: landed!.code!, id: landed!.id, pub: landed!.pub });
    expect(calls).toEqual(['oauth-code']);
    const opened = openRefreshToken(box.rows.get(handoff.id) as { k: string; n: string; d: string }, { secret: handoff.secret });
    expect(opened).toBe('rt-1');
    const appAuth: DiscordAppAuth = { refreshSession: async ({ refresh_token }) => { calls.push(refresh_token); return { data: { session: { refresh_token } }, error: null }; } };
    const restored = await restoreDiscordInApp(app, box.client, appAuth, NOW);
    expect(restored).toEqual({ kind: 'done', returnTo: 'profile' });
    expect(calls).toContain('rt-1');
    expect(app.m.has('pokejam.discord.handoff')).toBe(false);
  });
  it('a wrong key cannot read the token, and a reported failure stops the wait', async () => {
    const app = memStore();
    const { handoff } = beginDiscordHandoff(app, { loc, returnTo: 'ranked', now: NOW });
    const box = relay();
    await finishDiscordInSafari(
      { exchangeCodeForSession: async () => ({ data: { session: { refresh_token: 'rt-1' } }, error: null }) },
      box.client, { code: 'c', id: handoff.id, pub: parseDiscordReturn(discordHandoffUrl(loc, handoff))!.pub },
    );
    const other = memStore();
    const decoy = beginDiscordHandoff(other, { loc, returnTo: 'ranked', now: NOW }).handoff;
    await expect(restoreDiscordInApp(memStore(), box.client, { refreshSession: async () => ({ data: null, error: null }) }, NOW)).resolves.toEqual({ kind: 'none' });
    // The row was not taken (nobody was waiting on that store). Take it with the wrong secret.
    const row = await relayTake(box.client, handoff.id);
    expect(() => openRefreshToken(row!, { secret: decoy.secret })).toThrow();
    const again = memStore();
    beginDiscordHandoff(again, { loc, returnTo: 'ranked', now: NOW });
    // Fresh handoff id is not the one we just consumed. Report against the original id with a new handoff whose id we set by writing storage.
    again.setItem('pokejam.discord.handoff', JSON.stringify({ ...handoff, expiresAt: NOW + 60_000 }));
    const box2 = relay();
    await reportDiscordFailure(box2.client, handoff.id);
    await expect(restoreDiscordInApp(again, box2.client, { refreshSession: async () => ({ data: { session: {} }, error: null }) }, NOW)).rejects.toThrow(/didn't finish/);
  });
  it('wipes the throwaway oauth storage and does not sign out', () => {
    const s = memStore();
    s.setItem('pokejam.discord.oauth', 'session');
    s.setItem('pokejam.discord.oauth-code-verifier', 'verifier');
    s.setItem('pokejam.auth', 'guest');
    wipeDiscordOauthStorage(s);
    expect(s.m.has('pokejam.discord.oauth')).toBe(false);
    expect(s.m.has('pokejam.discord.oauth-code-verifier')).toBe(false);
    expect(s.m.get('pokejam.auth')).toBe('guest');
    const strip = (p: string) => readFileSync(new URL(p, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    expect(strip('./discordSheet.ts')).not.toMatch(/\bsignOut\b/);
    expect(strip('./discordHandoff.ts')).not.toMatch(/\bsignOut\b/);
  });
});
