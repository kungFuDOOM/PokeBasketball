import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { BotCheckError } from './capacity';
import { ensureSignedIn, type SignInDeps } from './supabase';

type Resp = { data: { user: { id: string } | null }; error: { message: string; code?: string; status?: number } | null };
function fake(opts: { session?: string | null; answers?: Resp[] }) {
  const calls: unknown[] = [];
  const answers = [...(opts.answers ?? [])];
  const sb = {
    auth: {
      getSession: async () => ({ data: { session: opts.session ? { user: { id: opts.session } } : null } }),
      signInAnonymously: async (arg?: unknown) => { calls.push(arg); return answers.shift() ?? { data: { user: { id: 'new' } }, error: null }; },
    },
  } as unknown as SupabaseClient;
  return { sb, calls };
}
function deps(on = true, fail?: Error) {
  let n = 0;
  const d: SignInDeps = { captchaOn: on, token: async () => { if (fail) throw fail; return `tok${++n}`; } };
  return { d, count: () => n };
}
const refused: Resp = { data: { user: null }, error: { message: 'captcha verification process failed', code: 'captcha_failed', status: 400 } };

describe('anonymous sign-in and Auth CAPTCHA', () => {
  it('a returning player with a session gets no check and no sign-in', async () => {
    const f = fake({ session: 'me' });
    const t = deps();
    expect(await ensureSignedIn(f.sb, t.d)).toBe('me');
    expect([f.calls.length, t.count()]).toEqual([0, 0]);
  });

  it('a first sign-in, and a re-sign-in after a cleared/expired session, each send a fresh captchaToken', async () => {
    const t = deps();
    const f = fake({});
    expect(await ensureSignedIn(f.sb, t.d)).toBe('new');
    expect(await ensureSignedIn(f.sb, t.d)).toBe('new'); // session gone again
    expect(f.calls).toEqual([{ options: { captchaToken: 'tok1' } }, { options: { captchaToken: 'tok2' } }]);
  });

  it('sends no options when the build has no site key', async () => {
    const f = fake({});
    await ensureSignedIn(f.sb, deps(false).d);
    expect(f.calls).toEqual([undefined]);
  });

  it('an expired or used token gets one new check, then a friendly bot-check error', async () => {
    const t = deps();
    const f = fake({ answers: [refused] });
    expect(await ensureSignedIn(f.sb, t.d)).toBe('new');
    expect(f.calls).toEqual([{ options: { captchaToken: 'tok1' } }, { options: { captchaToken: 'tok2' } }]);

    const g = fake({ answers: [refused, refused] });
    const err = await ensureSignedIn(g.sb, deps().d).catch((e) => e);
    expect(err).toBeInstanceOf(BotCheckError);
    expect(err.message).toMatch(/Try again/);
  });

  it('a widget failure is a BotCheckError and signs nothing in; the next try works', async () => {
    const f = fake({});
    const err = await ensureSignedIn(f.sb, deps(true, new Error('closed')).d).catch((e) => e);
    expect(err).toBeInstanceOf(BotCheckError);
    expect(f.calls).toEqual([]);
    expect(await ensureSignedIn(f.sb, deps().d)).toBe('new');
  });

  it('other auth errors keep their status for the busy mapping; concurrent callers share one sign-in', async () => {
    const f = fake({ answers: [{ data: { user: null }, error: { message: 'Request rate limit reached', status: 429 } }] });
    const err = await ensureSignedIn(f.sb, deps().d).catch((e) => e);
    expect(err.status).toBe(429);
    const t = deps();
    const g = fake({});
    await Promise.all([ensureSignedIn(g.sb, t.d), ensureSignedIn(g.sb, t.d)]);
    expect([g.calls.length, t.count()]).toEqual([1, 1]);
  });
});
