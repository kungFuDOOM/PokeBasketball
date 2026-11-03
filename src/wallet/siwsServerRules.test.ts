// Encodes what Supabase Auth (supabase/auth internal/utilities/siws + internal/api/web3.go) enforces on a Sign in with Solana
// message, and checks buildSiwsMessage against it. "Chain ID: mainnet" was a live 400 ("siws: Chain ID is not valid").
import { describe, expect, it } from 'vitest';
import { FLOW_TTL_MS, SIWS_CHAIN_ID, buildSiwsMessage } from './phantomLink';

const WALLET = '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV';
const NOW = Date.parse('2026-11-02T12:00:00.000Z');
const MAX_VALIDITY_MS = 10 * 60_000; // MaximumValidityDuration default
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;
const CHAIN_RE = /^solana:(main|dev|test|local)net$/;

/** The server's checks, in the server's terms. Returns the first violated rule, or null. */
function serverVerdict(message: string, o: { now: number; redirectAllow: string[] }): string | null {
  if (new TextEncoder().encode(message).length > 20 * 1024) return 'too long';
  const lines = message.split('\n');
  const header = /^(\S+) wants you to sign in with your Solana account:$/.exec(lines[0]);
  if (!header) return 'header';
  const field = (n: string) => lines.find((l) => l.startsWith(`${n}: `))?.slice(n.length + 2);
  const uri = field('URI');
  if (!uri) return 'no URI';
  let u: URL;
  try { u = new URL(uri); } catch { return 'bad URI'; }
  if (u.protocol !== 'https:' && u.hostname !== 'localhost') return 'URI scheme';
  if (!o.redirectAllow.includes(u.origin)) return 'URI not allowed';
  if (header[1] !== u.host) return 'domain != URI host';
  const issued = field('Issued At');
  if (!issued || !RFC3339.test(issued)) return 'Issued At format';
  if (Math.abs(o.now - Date.parse(issued)) > MAX_VALIDITY_MS) return 'Issued At window';
  const exp = field('Expiration Time');
  if (exp !== undefined) {
    if (!RFC3339.test(exp)) return 'Expiration format';
    if (Date.parse(exp) <= o.now) return 'expired';
  }
  const nb = field('Not Before');
  if (nb !== undefined && Date.parse(nb) > o.now) return 'not yet valid';
  const chain = field('Chain ID');
  if (chain !== undefined && !CHAIN_RE.test(chain)) return 'Chain ID';
  return null;
}

const build = (over: Partial<Parameters<typeof buildSiwsMessage>[0]> = {}) =>
  buildSiwsMessage({ host: 'pokejam.xyz', uri: 'https://pokejam.xyz/', address: WALLET, nonce: 'AbCdEfGh12345678', issuedAt: NOW, expiresAt: NOW + FLOW_TTL_MS, ...over });
const allow = { now: NOW, redirectAllow: ['https://pokejam.xyz'] };

describe("buildSiwsMessage against Supabase Auth's rules", () => {
  it('passes every server rule', () => {
    expect(serverVerdict(build(), allow)).toBeNull();
    // Right at the edges of the clock: the phone's clock a little off either way still passes.
    expect(serverVerdict(build(), { ...allow, now: NOW + 5 * 60_000 })).toBeNull();
    expect(serverVerdict(build(), { ...allow, now: NOW - 5 * 60_000 })).toBeNull();
  });
  it('writes a Chain ID the server regexp accepts (solana:mainnet), never bare "mainnet"', () => {
    expect(SIWS_CHAIN_ID).toMatch(CHAIN_RE);
    expect(build()).toContain('\nChain ID: solana:mainnet\n');
    expect(build()).not.toMatch(/Chain ID: mainnet/);
  });
  it('the validator itself rejects what the live server rejected, so the test can fail', () => {
    expect(serverVerdict(build().replace('solana:mainnet', 'mainnet'), allow)).toBe('Chain ID');
    expect(serverVerdict(build().replace('Chain ID: solana:mainnet\n', ''), allow)).toBeNull(); // omitted is fine
    for (const bad of ['solana:', 'solana:main', 'eip155:1', 'solana:mainnet-beta', 'Solana:mainnet']) {
      expect(serverVerdict(build().replace('solana:mainnet', bad), allow), bad).toBe('Chain ID');
    }
    for (const ok of ['solana:mainnet', 'solana:devnet', 'solana:testnet', 'solana:localnet']) expect(ok).toMatch(CHAIN_RE);
  });
  it('domain equals the URI host (port included), URI is https and on the allow list', () => {
    expect(serverVerdict(build({ host: 'other.xyz' }), allow)).toBe('domain != URI host');
    expect(serverVerdict(build({ uri: 'http://pokejam.xyz/' }), allow)).toBe('URI scheme');
    expect(serverVerdict(build({ uri: 'https://evil.xyz/', host: 'evil.xyz' }), allow)).toBe('URI not allowed');
    const lh = { now: NOW, redirectAllow: ['http://localhost:5173'] };
    expect(serverVerdict(build({ uri: 'http://localhost:5173/', host: 'localhost:5173' }), lh)).toBeNull();
    expect(serverVerdict(build({ uri: 'https://pokejam.xyz:8443/x', host: 'pokejam.xyz:8443' }), { now: NOW, redirectAllow: ['https://pokejam.xyz:8443'] })).toBeNull();
  });
  it('Issued At and Expiration Time are RFC 3339 and inside the window', () => {
    const m = build();
    expect(m).toMatch(/\nIssued At: 2026-11-02T12:00:00\.000Z\n/);
    expect(m).toMatch(/\nExpiration Time: 2026-11-02T12:10:00\.000Z\n/);
    expect(serverVerdict(m, { ...allow, now: NOW + MAX_VALIDITY_MS + 1 })).toBe('Issued At window');
    expect(serverVerdict(m, { ...allow, now: NOW - MAX_VALIDITY_MS - 1 })).toBe('Issued At window');
    expect(serverVerdict(build({ expiresAt: NOW - 1 }), allow)).toBe('expired');
    // Our own flow lifetime is exactly the server's limit, so Issued At is only ever stale when the sign-in itself has expired.
    expect(FLOW_TTL_MS).toBeLessThanOrEqual(MAX_VALIDITY_MS);
  });
  it('stays well under the 20KB limit and has no stray newlines in the statement', () => {
    expect(new TextEncoder().encode(build()).length).toBeLessThan(1024);
    expect(build().split('\n')).toHaveLength(11);
  });
});

describe('the desktop / extension path (src/wallet/phantom.ts)', () => {
  it("lets supabase-js build the message with no Chain ID line, which the server accepts", async () => {
    const { AuthClient } = await import('@supabase/supabase-js');
    const { SIGN_IN_STATEMENT } = await import('./phantom');
    let signed = '';
    const wallet = { publicKey: { toBase58: () => WALLET }, signMessage: async (b: Uint8Array) => { signed = new TextDecoder().decode(b); return new Uint8Array(64); } };
    const auth = new AuthClient({ url: 'https://x.invalid/auth/v1', persistSession: false, autoRefreshToken: false, fetch: async () => new Response('{}', { status: 400 }) });
    // Exactly the arguments signInWithPhantom passes (the URL is the page's, as in the browser).
    await auth.signInWithWeb3({ chain: 'solana', statement: SIGN_IN_STATEMENT, wallet, options: { url: 'https://pokejam.xyz/' } } as never).catch(() => null);
    expect(signed).toContain('wants you to sign in with your Solana account');
    expect(signed).not.toContain('Chain ID');
  });
});
