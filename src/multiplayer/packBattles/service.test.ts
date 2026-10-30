import { describe, expect, it } from 'vitest';
import type { RpcClient, SupabaseMatchService } from '../shared/onlineMatchService';
import { PackService, usd, validWallet } from './service';

const WALLET = '9wqysMYY4DTcbPjSZpGQU3pF29YUw9w6A1a8XDKVhezh';

/** A fake server: pokejam_pack_find answers from `finds` in order; every call is logged. */
function fake(finds: (string | null | Error)[]) {
  const calls: { fn: string; args?: Record<string, unknown> }[] = [];
  const db: RpcClient = {
    rpc: async (fn, args) => {
      calls.push({ fn, args });
      if (fn === 'pokejam_pack_find') {
        const r = finds.shift() ?? null;
        return r instanceof Error ? { data: null, error: { message: r.message } } : { data: r, error: null };
      }
      return { data: null, error: null };
    },
  };
  const match = { matchInfo: async (id: string) => ({ id }) } as unknown as SupabaseMatchService;
  return { db, match, calls };
}

describe('PackService', () => {
  it('polls the queue with the tier, wallet and prize setting until paired, then reads the match', async () => {
    const f = fake([null, 'm-1']);
    const svc = new PackService(f.db, f.match);
    expect(await svc.find('pokemon_25', ` ${WALLET} `, true)).toEqual({ id: 'm-1' });
    expect(f.calls.filter((c) => c.fn === 'pokejam_pack_find')).toHaveLength(2);
    expect(f.calls[0].args).toEqual({ p_tier: 'pokemon_25', p_wallet: WALLET, p_prefer_cash: true });
  }, 10_000);

  it('cancelling a search leaves the queue (the server refunds the entry)', async () => {
    const f = fake([null, null, null]);
    const svc = new PackService(f.db, f.match);
    const abort = new AbortController();
    const p = svc.find('pokemon_50', WALLET, false, abort.signal);
    setTimeout(() => abort.abort(), 50);
    await expect(p).rejects.toThrow(/aborted/);
    expect(f.calls[f.calls.length - 1].fn).toBe('pokejam_pack_leave');
  });

  it('runs the human check again when the server asks, and passes on any other refusal', async () => {
    const forced: boolean[] = [];
    const f = fake([new Error('human check needed'), 'm-2']);
    const svc = new PackService(f.db, f.match, async (force) => { forced.push(force); });
    expect(await svc.find('pokemon_25', WALLET, false)).toEqual({ id: 'm-2' });
    expect(forced).toEqual([false, true]);
    const g = fake([new Error('insufficient balance: 0 available, 13125000 needed')]);
    await expect(new PackService(g.db, g.match).find('pokemon_25', WALLET, false)).rejects.toThrow(/insufficient balance/);
  });

  it('formats USDC and checks wallet addresses like the server', () => {
    expect(usd(25_000_000)).toBe('$25');
    expect(usd(13_125_000)).toBe('$13.13');
    expect(validWallet(WALLET)).toBe(true);
    expect(validWallet('not a wallet')).toBe(false);
    expect(validWallet('0OIl' + WALLET.slice(4))).toBe(false); // base58 has no 0, O, I or l
  });
});
