import { describe, expect, it } from 'vitest';
import { adsConfig, PJAM_MAINNET } from './config.ts';

const from = (env: Record<string, string>) => adsConfig((k) => env[k]);

describe('ads config', () => {
  it('is devnet by default, and needs the test mint there', () => {
    expect(() => from({})).toThrow(/AD_MINT is not set/);
    expect(from({ AD_MINT: 'X' })).toMatchObject({ cluster: 'devnet', mint: 'X', rpcUrl: 'https://api.devnet.solana.com', priorityMicroLamports: 0 });
  });

  it("refuses mainnet without kungFuDOOM's approval, and then burns the official $PJAM with no faucet", () => {
    expect(() => from({ ADS_CLUSTER: 'mainnet-beta' })).toThrow(/devnet-only/);
    const c = from({ ADS_CLUSTER: 'mainnet-beta', ADS_ALLOW_MAINNET: 'approved-by-kungfudoom', AD_FAUCET_SECRET: '[1,2,3]', AD_MINT: 'SomeOtherMint' });
    expect(c).toMatchObject({ cluster: 'mainnet-beta', mint: PJAM_MAINNET, faucetSecret: undefined, priorityMicroLamports: 20_000 });
    expect(PJAM_MAINNET).toBe('GQe9QiBBV4G6bRUCxx2JgKrzT7G7RD17FJquBWgVpump');
  });
});
