import { describe, expect, it } from 'vitest';
import { TOKEN_2022, pjamWholes, walletWhole, wholeTokens, type Rpc } from './balance.ts';

const MINT = 'GQe9QiBBV4G6bRUCxx2JgKrzT7G7RD17FJquBWgVpump';

const account = (pubkey: string, amount: string, o: { mint?: string; state?: string } = {}) => ({
  pubkey, account: { data: { parsed: { info: { mint: o.mint ?? MINT, state: o.state ?? 'initialized', tokenAmount: { amount } } } } },
});

function rpc(map: Record<string, unknown>): Rpc & { calls: string[] } {
  const calls: string[] = [];
  return { calls, async call<T>(method: string, params: unknown[]): Promise<T> {
    calls.push(method);
    const key = method + JSON.stringify(params);
    if (!(key in map)) throw new Error('unexpected ' + key);
    return map[key] as T;
  } };
}

const opts = { encoding: 'jsonParsed', commitment: 'finalized' };
const rpcKey = (method: string, params: unknown[]) => method + JSON.stringify(params);

describe('whole tokens', () => {
  it('drops the mint decimals', () => {
    expect(wholeTokens(1_500_000n, 6)).toBe(1n);
    expect(wholeTokens(999_999n, 6)).toBe(0n);
    expect(() => wholeTokens(1n, -1)).toThrow(/decimals/);
  });

  it('sums both token programs, skips frozen and other mints, and dedupes', async () => {
    const fake = rpc({
      [rpcKey('getAccountInfo', [MINT, opts])]: { value: { data: { parsed: { info: { decimals: 6 } } } } },
      [rpcKey('getTokenAccountsByOwner', ['wallet', { mint: MINT }, opts])]: { value: [account('A', '1500000'), account('A', '1500000'), account('F', '9000000', { state: 'frozen' })] },
      [rpcKey('getTokenAccountsByOwner', ['wallet', { programId: TOKEN_2022 }, opts])]: { value: [account('B', '500000'), account('C', '999999999', { mint: 'other' })] },
    });
    expect(await walletWhole(fake, MINT, 'wallet')).toBe(2n);
  });

  it('maps each player, and a missing wallet is zero', async () => {
    const fake = rpc({
      [rpcKey('getAccountInfo', [MINT, opts])]: { value: { data: { parsed: { info: { decimals: 6 } } } } },
      [rpcKey('getTokenAccountsByOwner', ['w', { mint: MINT }, opts])]: { value: [account('A', '2000000000000')] },
      [rpcKey('getTokenAccountsByOwner', ['w', { programId: TOKEN_2022 }, opts])]: { value: [] },
    });
    const got = await pjamWholes(fake, MINT, [{ user_id: 'u1', wallet: 'w' }, { user_id: 'u2', wallet: null }]);
    expect(got).toEqual({ u1: ['2000000'], u2: [] });
  });

  it('keeps each wallet balance, so the database can cap them one by one', async () => {
    const fake = rpc({
      [rpcKey('getAccountInfo', [MINT, opts])]: { value: { data: { parsed: { info: { decimals: 6 } } } } },
      [rpcKey('getTokenAccountsByOwner', ['a', { mint: MINT }, opts])]: { value: [account('A', '6000000000000')] },
      [rpcKey('getTokenAccountsByOwner', ['a', { programId: TOKEN_2022 }, opts])]: { value: [] },
      [rpcKey('getTokenAccountsByOwner', ['b', { mint: MINT }, opts])]: { value: [account('B', '6000000000000')] },
      [rpcKey('getTokenAccountsByOwner', ['b', { programId: TOKEN_2022 }, opts])]: { value: [] },
    });
    const got = await pjamWholes(fake, MINT, [{ user_id: 'u', wallets: ['a', 'b'] }]);
    expect(got.u).toEqual(['6000000', '6000000']);
  });

  it('refuses a mint the chain does not have', async () => {
    const fake = rpc({ [rpcKey('getAccountInfo', [MINT, opts])]: { value: null } });
    await expect(walletWhole(fake, MINT, 'w')).rejects.toThrow(/mint not found/);
  });
});
