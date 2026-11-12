// The deployed site's Content Security Policy (vite.config.ts) with the live ads endpoint: no inline scripts, and no new
// origins unless VITE_ADS_API points away from the Supabase project. The client never talks to a Solana RPC directly.
// @ts-ignore Node's fs has no type declarations in this project.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adsApiOrigin, CC_IMAGES, csp } from '../vite.config';
import { adsUrl } from './ads/api';

const SUPA = 'https://ksvfgxodbwfntqnahukn.supabase.co';
const directive = (policy: string, name: string) => policy.split('; ').find((d) => d.startsWith(`${name} `)) ?? '';

describe('site CSP with live ads', () => {
  it('never allows inline or eval scripts', () => {
    for (const p of [csp(SUPA, true, true), csp(SUPA, false, false, 'https://ads.example.com/functions/v1/pokejam-ads-live')]) {
      expect(directive(p, 'script-src')).not.toMatch(/'unsafe-inline'|'unsafe-eval'|'unsafe-hashes'|'nonce-|'sha\d+-/);
      expect(p).toContain("default-src 'none'");
    }
  });

  it('adds no origin for the default endpoint (the Supabase project) and no Solana RPC', () => {
    const p = csp(SUPA, false, true);
    expect(p).toBe(csp(SUPA, false, true, `${SUPA}/functions/v1/pokejam-ads-live`));
    expect(p).not.toMatch(/solana|helius|rpc/i);
    expect(directive(p, 'connect-src')).toBe(
      `connect-src 'self' https://cloudflareinsights.com ${SUPA} wss://ksvfgxodbwfntqnahukn.supabase.co`
      + ' https://www.googletagmanager.com https://*.google-analytics.com https://*.analytics.google.com',
    );
  });

  it('adds just the origin of a VITE_ADS_API hosted elsewhere', () => {
    expect(adsApiOrigin('https://ads.example.com/functions/v1/pokejam-ads-live?x=1', SUPA)).toBe('https://ads.example.com');
    expect(directive(csp(SUPA, false, false, 'https://ads.example.com/f'), 'connect-src')).toMatch(/ https:\/\/ads\.example\.com$/);
    expect(adsApiOrigin(undefined, SUPA)).toBeUndefined();
    expect(adsApiOrigin(`${SUPA}/functions/v1/pokejam-ads-live`, SUPA)).toBeUndefined();
  });

  it('fails the build on a non-https or malformed VITE_ADS_API', () => {
    expect(() => adsApiOrigin('http://localhost:54321/functions/v1/pokejam-ads-live', SUPA)).toThrow(/https/);
    expect(() => adsApiOrigin('not a url', SUPA)).toThrow(/valid URL/);
  });

  it('allows every origin the ad flow fetches, however the endpoint is set up', () => {
    const allowed = (policy: string, url: string) => directive(policy, 'connect-src').split(' ').slice(1).includes(new URL(url).origin);
    const onProject = adsUrl({ VITE_SUPABASE_URL: SUPA });
    expect(allowed(csp(SUPA, false, true), onProject)).toBe(true);
    expect(allowed(csp(SUPA, false, false), onProject)).toBe(true); // admin.html's policy, without analytics
    const elsewhere = 'https://ads.example.com/functions/v1/pokejam-ads-live';
    expect(allowed(csp(SUPA, false, true, elsewhere), adsUrl({ VITE_ADS_API: elsewhere, VITE_SUPABASE_URL: SUPA }))).toBe(true);
    expect(allowed(csp(SUPA, false, true), elsewhere)).toBe(false); // the check itself can fail
  });

  it('allows the wallet icons the page draws (the Wallet Standard makes them data: URIs)', () => {
    expect(directive(csp(SUPA, false, true), 'img-src').split(' ')).toContain('data:');
  });

  it("allows Collector Crypt's card images only in a Pack Battles build (VITE_MODE_PACK_BATTLES)", () => {
    const cc = CC_IMAGES.split(' ');
    const off = directive(csp(SUPA, false, true), 'img-src').split(' ');
    const on = directive(csp(SUPA, false, true, undefined, true), 'img-src').split(' ');
    expect(cc.filter((h) => off.includes(h))).toEqual([]);
    expect(cc.every((h) => on.includes(h))).toBe(true);
    expect(on.filter((h) => !off.includes(h))).toEqual(cc);
    expect(directive(csp(SUPA, false, true, undefined, true), 'connect-src')).toBe(directive(csp(SUPA, false, true), 'connect-src'));
  });

  describe('the ad client never calls Solana from the browser', () => {
    // The ad page's own code, as text, plus the shared file it imports to rebuild a USDC transfer.
    const sources = import.meta.glob(['./ads/*.ts', '!./ads/*.test.ts', '../supabase/functions/_shared/ads/usdc-chain.ts'], { query: '?raw', import: 'default', eager: true }) as Record<string, string>;
    const code = (f: string) => sources[f].replace(/^\s*(\/\/|\*|\/\*).*$/gm, '');

    it('finds the files it means to check', () => {
      for (const f of ['api', 'screen', 'settle', 'usdcPay', 'wallet']) expect(Object.keys(sources)).toContain(`./ads/${f}.ts`);
    });

    it('names no RPC method, RPC host or RPC client', () => {
      const rpc = /getLatestBlockhash|getAccountInfo|getBalance|getTransaction|getSignature|getTokenAccount|sendRawTransaction|\bsendTransaction\b|simulateTransaction|isBlockhashValid|confirmTransaction|jsonrpc|PUBLIC_RPC|new Connection|@solana\/web3|pack\/rpc|\.solana\.com|helius|quicknode|alchemy/i;
      expect(Object.keys(sources).filter((f) => rpc.test(code(f)))).toEqual([]);
    });

    it('fetches only the ad endpoint', () => {
      const fetches = Object.keys(sources).flatMap((f) => [...code(f).matchAll(/\bfetch\(\s*([^,)]+)/g)].map((m) => m[1].trim()));
      expect(new Set(fetches)).toEqual(new Set(['URL_', '`${URL_}?action=board`', '`${URL_}?action=pjam-price`']));
      expect(Object.keys(sources).filter((f) => /XMLHttpRequest|WebSocket|EventSource|sendBeacon/.test(code(f)))).toEqual([]);
    });

    it('leaves the site only by links: every other host is a page you open, not one it calls', () => {
      const hosts = new Set(Object.keys(sources).flatMap((f) => [...code(f).matchAll(/https?:\/\/([a-z0-9.-]+)/gi)].map((m) => m[1])));
      expect([...hosts].sort()).toEqual(['phantom.app', 'solflare.com', 'solscan.io', 't.me', 'x.com']);
    });
  });

  it('index.html and admin.html carry no inline scripts', () => {
    for (const f of ['index.html', 'admin.html']) {
      const html = readFileSync(f, 'utf8');
      for (const tag of html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) ?? []) {
        if (/^<script\s+type="application\/ld\+json">/i.test(tag)) continue; // data block, not executable
        expect(tag, `${f}: ${tag}`).toMatch(/^<script\b[^>]*\bsrc=/i);
        expect(tag.replace(/^<script\b[^>]*>/i, '').replace(/<\/script>$/i, '').trim()).toBe('');
      }
      expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    }
  });
});
