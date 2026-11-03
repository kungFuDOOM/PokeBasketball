import { describe, expect, it } from 'vitest';
import { RETURN_KEY, accountOf, isGuest, returnUrl, signInWithGoogle, type AuthClient } from './account';

const ADDR = '7EcDhSYGxXyscszYEp35KHN8vvw3svAuLKTzXwCFLtV';
const loc = { origin: 'https://pokejam.xyz', pathname: '/', search: '' };

function fake(o: { oauth?: string } = {}) {
  const calls: { fn: string; arg: unknown }[] = [];
  const ok = { error: null };
  const sb: AuthClient = {
    auth: {
      signInWithOAuth: async (c) => { calls.push({ fn: 'oauth', arg: c }); return o.oauth ? { error: { message: o.oauth } } : ok; },
    },
  };
  return { sb, calls };
}
const store = () => { const m = new Map<string, string>(); return { m, s: { setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k) } }; };

describe('who is signed in', () => {
  it('guests (anonymous or no user) are guests; Google, wallet and other users are not', () => {
    expect(accountOf(null)).toEqual({ kind: 'guest', label: 'Guest' });
    expect(accountOf({ is_anonymous: true })).toMatchObject({ kind: 'guest' });
    expect(accountOf({ is_anonymous: false, email: 'a@b.c', app_metadata: { provider: 'google' } })).toEqual({ kind: 'google', label: 'Google' });
    expect(accountOf({ identities: [{ provider: 'google' }], email: 'a@b.c' })).toMatchObject({ kind: 'google', label: 'Google' });
    expect(accountOf({ app_metadata: { provider: 'web3' }, identities: [{ provider: 'web3', identity_data: { custom_claims: { address: ADDR, chain: 'solana' } } }] }))
      .toEqual({ kind: 'phantom', label: `${ADDR.slice(0, 4)}…${ADDR.slice(-4)}` });
    expect(accountOf({ email: 'x@y.z' })).toMatchObject({ kind: 'member', label: 'Signed in' });
    expect(isGuest({ is_anonymous: true })).toBe(true);
    expect(isGuest(undefined)).toBe(true);
    expect(isGuest({ email: 'x@y.z' })).toBe(false);
  });
  it('never puts a Google email on the label', () => {
    const a = accountOf({ email: 'person@gmail.com', user_metadata: { full_name: 'Pat Example' }, app_metadata: { provider: 'google', providers: ['google'] } });
    expect(a.label).toBe('Google');
    expect(JSON.stringify(a)).not.toMatch(/gmail|Pat Example/);
  });
});

describe('return URL', () => {
  it('comes back to this origin and path, dropping OAuth leftovers but keeping other query params', () => {
    expect(returnUrl(loc)).toBe('https://pokejam.xyz/');
    expect(returnUrl({ origin: 'https://pokejam.xyz', pathname: '/play/', search: '?ranked=1&code=abc&error=x' })).toBe('https://pokejam.xyz/play/?ranked=1');
  });
});

describe('Google sign-in', () => {
  it('is a plain Google OAuth sign-in and remembers to reopen Ranked', async () => {
    const f = fake();
    const st = store();
    await signInWithGoogle(f.sb, loc, st.s);
    expect(f.calls).toEqual([{ fn: 'oauth', arg: { provider: 'google', options: { redirectTo: 'https://pokejam.xyz/', queryParams: { prompt: 'select_account' } } } }]);
    expect(st.m.get(RETURN_KEY)).toBe('ranked');
  });
  it('an error clears the return marker and is thrown', async () => {
    const f = fake({ oauth: 'Unsupported provider: provider is not enabled' });
    const st = store();
    await expect(signInWithGoogle(f.sb, loc, st.s)).rejects.toThrow(/not enabled/);
    expect(st.m.has(RETURN_KEY)).toBe(false);
  });
});
