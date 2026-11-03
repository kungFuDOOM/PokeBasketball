import { describe, expect, it } from 'vitest';
import { raffleDrawHandler, type RaffleDrawDeps } from './handler.ts';

const deps = (over: Partial<RaffleDrawDeps> = {}): RaffleDrawDeps & { commits: unknown[] } => {
  const commits: unknown[] = [];
  return {
    commits,
    isAdmin: async () => true,
    adminId: async () => 'admin',
    prep: async () => ({ ok: true, already: false, mint: 'mint', qualifiers: [{ user_id: 'u', wallet: 'w' }] }),
    balances: async () => ({ u: '2000000' }),
    commit: async (week, balances, adminId) => { commits.push({ week, balances, adminId }); return { ok: true, draw: { winner_id: 'u' } }; },
    ...over,
  };
};

const post = (body: unknown, jwt = 'jwt') => new Request('https://x/raffle', { method: 'POST', headers: { authorization: `Bearer ${jwt}`, origin: 'https://pokejam.xyz' }, body: JSON.stringify(body) });

describe('raffle draw handler', () => {
  it('draws a closed week and passes the balances through, not a winner', async () => {
    const d = deps();
    const res = await raffleDrawHandler(post({ week: '2026-10-26' }), { origins: ['https://pokejam.xyz'] }, d);
    expect(res.status).toBe(200);
    expect(d.commits).toEqual([{ week: '2026-10-26', balances: { u: '2000000' }, adminId: 'admin' }]);
  });

  it('does not read balances when the week was already drawn or is still open', async () => {
    let reads = 0;
    const already = deps({ prep: async () => ({ ok: true, already: true, draw: { winner_id: 'u' } }), balances: async () => { reads++; return {}; } });
    const res = await raffleDrawHandler(post({ week: '2026-10-26' }), { origins: [] }, already);
    expect(res.status).toBe(200);
    expect(already.commits).toHaveLength(0);
    const open = deps({ prep: async () => ({ ok: false, code: 'open' }) });
    expect((await raffleDrawHandler(post({ week: '2026-10-26' }), { origins: [] }, open)).status).toBe(409);
    expect(reads).toBe(0);
  });

  it('a chain failure records nothing', async () => {
    const d = deps({ balances: async () => { throw new Error('mint not found'); } });
    const res = await raffleDrawHandler(post({ week: '2026-10-26' }), { origins: [] }, d);
    expect(res.status).toBe(502);
    expect(d.commits).toHaveLength(0);
  });

  it('refuses a player, a bad week, and a foreign origin', async () => {
    const d = deps({ isAdmin: async () => false });
    expect((await raffleDrawHandler(post({ week: '2026-10-26' }), { origins: [] }, d)).status).toBe(403);
    expect((await raffleDrawHandler(post({ week: 'Monday' }), { origins: [] }, deps())).status).toBe(400);
    expect((await raffleDrawHandler(post({ week: '2026-10-26' }), { origins: ['https://other.example'] }, deps())).status).toBe(403);
    expect((await raffleDrawHandler(new Request('https://x', { method: 'POST' }), { origins: [] }, deps())).status).toBe(401);
  });
});
