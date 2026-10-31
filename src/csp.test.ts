// The deployed site's Content Security Policy (vite.config.ts) with the live ads endpoint: no inline scripts, and no new
// origins unless VITE_ADS_API points away from the Supabase project. The client never talks to a Solana RPC directly.
// @ts-ignore Node's fs has no type declarations in this project.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adsApiOrigin, csp } from '../vite.config';

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

  it('index.html and admin.html carry no inline scripts', () => {
    for (const f of ['index.html', 'admin.html']) {
      const html = readFileSync(f, 'utf8');
      for (const tag of html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi) ?? []) {
        expect(tag, `${f}: ${tag}`).toMatch(/^<script\b[^>]*\bsrc=/i);
        expect(tag.replace(/^<script\b[^>]*>/i, '').replace(/<\/script>$/i, '').trim()).toBe('');
      }
      expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    }
  });
});
