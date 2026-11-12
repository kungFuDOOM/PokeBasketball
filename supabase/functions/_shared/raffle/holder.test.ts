import { describe, expect, it } from 'vitest';
import { PJAM_COUNTED_CAP, PJAM_PER_ENTRY, holderEntriesForWallets, RAFFLE_DEFAULTS } from '../../../../src/raffle/entries';
import { holderFromWholes, holderHandler, type HolderDeps } from './holder.ts';

const USER = '11111111-1111-4111-8111-111111111111';
const ORIGIN = 'https://pokejam.xyz';

const deps = (over: Partial<HolderDeps> = {}): HolderDeps => ({
  userOf: async () => ({ id: USER, anonymous: false }),
  walletsOf: async () => ['wallet'],
  wholes: async () => [1_500_000n],
  config: async () => ({ pjamPerEntry: PJAM_PER_ENTRY, pjamCountedCap: PJAM_COUNTED_CAP, pjamMint: 'mint' }),
  ...over,
});

const post = (opts: { jwt?: string; origin?: string } = {}) => new Request('https://fn.test', {
  method: 'POST',
  headers: { origin: opts.origin ?? ORIGIN, authorization: opts.jwt === '' ? '' : `Bearer ${opts.jwt ?? 'jwt'}` },
  body: '{}',
});

describe('holder entries from whole tokens', () => {
  it('matches the raffle maths, and caps each balance', () => {
    expect(holderFromWholes([1_500_000n, 1_500_000n], PJAM_PER_ENTRY, PJAM_COUNTED_CAP)).toBe(2);
    expect(holderFromWholes([6_000_000n, 6_000_000n], PJAM_PER_ENTRY, PJAM_COUNTED_CAP)).toBe(10);
    expect(holderFromWholes([999_999n], PJAM_PER_ENTRY, PJAM_COUNTED_CAP)).toBe(0);
    expect(holderFromWholes([6_000_000n, 6_000_000n], PJAM_PER_ENTRY, PJAM_COUNTED_CAP))
      .toBe(holderEntriesForWallets([6_000_000n, 6_000_000n], RAFFLE_DEFAULTS));
  });
});

describe('holder handler', () => {
  it('returns the signed-in player\'s holder entries and does not take a balance from the browser', async () => {
    const seen: string[][] = [];
    const d = deps({ wholes: async (_mint, wallets) => { seen.push(wallets); return [2_000_000n]; } });
    const res = await holderHandler(post(), [ORIGIN], d);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, wallet: 'wallet', holder: 2 });
    expect(seen).toEqual([['wallet']]);
  });

  it('caps each wallet before adding', async () => {
    const d = deps({
      walletsOf: async () => ['a', 'b'],
      wholes: async () => [6_000_000n, 1_500_000n],
    });
    const body = await (await holderHandler(post(), [ORIGIN], d)).json() as { holder: number };
    expect(body.holder).toBe(6);
  });

  it('a player with no wallet has no holder entries', async () => {
    const res = await holderHandler(post(), [ORIGIN], deps({ walletsOf: async () => [] }));
    expect(await res.json()).toEqual({ ok: true, wallet: null, holder: 0 });
  });

  it('refuses a guest, a missing session, and a foreign origin', async () => {
    expect((await holderHandler(post(), [ORIGIN], deps({ userOf: async () => ({ id: USER, anonymous: true }) }))).status).toBe(403);
    expect((await holderHandler(post({ jwt: '' }), [ORIGIN], deps())).status).toBe(401);
    expect((await holderHandler(post({ origin: 'https://other.example' }), [ORIGIN], deps())).status).toBe(403);
    expect((await holderHandler(new Request('https://fn.test', { method: 'GET', headers: { origin: ORIGIN } }), [ORIGIN], deps())).status).toBe(405);
  });

  it('a chain failure does not invent a balance', async () => {
    const res = await holderHandler(post(), [ORIGIN], deps({ wholes: async () => { throw new Error('mint not found'); } }));
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: expect.stringMatching(/balance/) });
  });
});
