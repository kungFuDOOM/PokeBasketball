import { describe, expect, it } from 'vitest';
import { turnstileError } from './captcha';
import { ensureHuman, needsHuman, serverReason, type HumanDeps } from './human';
import { SupabaseMatchService, type RpcClient } from './onlineMatchService';

const NOW = Date.parse('2026-10-23T12:00:00Z');
function deps(status: { required: boolean; until: string | null }, verdict: { ok?: boolean; reason?: string } | null = { ok: true }, enabled = true) {
  const log: string[] = [];
  const d: HumanDeps = {
    enabled, now: () => NOW,
    rpc: async (fn) => { log.push(fn); return { data: status, error: null }; },
    token: async () => { log.push('turnstile'); return 'tok'; },
    invoke: async (t) => { log.push(`verify:${t}`); return verdict; },
  };
  return { d, log };
}

describe('the human check before online matches', () => {
  it('shows nothing when the build has no site key, or the server does not require it', async () => {
    const off = deps({ required: true, until: null }, { ok: true }, false);
    await ensureHuman(off.d);
    expect(off.log).toEqual([]);
    const notRequired = deps({ required: false, until: null });
    await ensureHuman(notRequired.d);
    expect(notRequired.log).toEqual(['pokejam_human_status']);
  });

  it('a pass that is still good is used; one about to run out (or missing) means a new check, verified by the server', async () => {
    const good = deps({ required: true, until: '2026-10-23T12:10:00Z' });
    await ensureHuman(good.d);
    expect(good.log).toEqual(['pokejam_human_status']);
    const stale = deps({ required: true, until: '2026-10-23T12:00:30Z' });
    await ensureHuman(stale.d);
    expect(stale.log).toEqual(['pokejam_human_status', 'turnstile', 'verify:tok']);
    const failed = deps({ required: true, until: null }, { ok: false, reason: '403 check failed' });
    await expect(ensureHuman(failed.d)).rejects.toThrow('The server refused the bot check (403 check failed). Try again.');
    await expect(ensureHuman(deps({ required: true, until: null }, null).d)).rejects.toThrow(/refused the bot check \(no answer\)/);
  });

  it('a failure says which step refused: Cloudflare (with its error code) or our server (with its reason)', async () => {
    expect(turnstileError('110200').message).toBe("Cloudflare's bot check failed (error 110200: this site isn't on the widget's hostname list). Try again.");
    expect(turnstileError('600010').message).toMatch(/error 600010: the challenge wasn't passed/);
    expect(turnstileError().message).toMatch(/error unknown\)/);
    const http = (status: number, body: unknown) => ({ name: 'FunctionsHttpError', message: 'Edge Function returned a non-2xx status code', context: new Response(JSON.stringify(body), { status }) });
    expect(await serverReason(http(404, { code: 'NOT_FOUND', message: 'Requested function was not found' }))).toBe('404 Requested function was not found');
    expect(await serverReason(http(403, { error: 'origin not allowed' }))).toBe('403 origin not allowed');
    expect(await serverReason(http(403, { error: 'check failed' }))).toBe('403 check failed');
    expect(await serverReason({ name: 'FunctionsFetchError', message: 'Failed to send a request to the Edge Function' })).toMatch(/not deployed, or this site not in HUMAN_ALLOWED_ORIGINS/);
  });

  it('matchmaking runs the check first, and once more if the server still says "human check needed"', async () => {
    const calls: string[] = [];
    let refuse = 1;
    const db: RpcClient = {
      rpc(fn) {
        calls.push(fn);
        if (fn === 'pokejam_create_room' && refuse-- > 0) return Promise.resolve({ data: null, error: { message: 'human check needed' } });
        return Promise.resolve({ data: fn === 'pokejam_create_room' ? 'ABC123' : null, error: null });
      },
    };
    const human: boolean[] = [];
    const svc = new SupabaseMatchService(db, 'me', ['social'], async (force) => { human.push(force); });
    expect(await svc.createRoom(120)).toBe('ABC123');
    expect(human).toEqual([false, true]);
    expect(calls).toEqual(['pokejam_create_room', 'pokejam_create_room']);
    expect(needsHuman(new Error('human check needed'))).toBe(true);
  });
});
