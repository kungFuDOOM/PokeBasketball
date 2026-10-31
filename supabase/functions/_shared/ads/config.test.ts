import { describe, expect, it } from 'vitest';
import { adsConfig, adsConfigLive, PJAM_MAINNET } from './config.ts';

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

const live = (env: Record<string, string>, cluster?: 'devnet' | 'mainnet-beta') => adsConfigLive((k) => env[k], cluster ? { cluster } : {});

describe('ads config: live function (pokejam-ads-live)', () => {
  it('refuses mainnet unless ADS_ALLOW_MAINNET is exactly "true"', () => {
    for (const v of [undefined, '', 'TRUE', 'True', ' true', 'true ', '1', 'yes', 'approved-by-kungfudoom']) {
      const env: Record<string, string> = v === undefined ? {} : { ADS_ALLOW_MAINNET: v };
      expect(() => live(env)).toThrow(/refuses mainnet/);
      expect(() => live(env, 'mainnet-beta')).toThrow(/refuses mainnet/);
    }
    expect(live({ ADS_ALLOW_MAINNET: 'true' })).toMatchObject({ cluster: 'mainnet-beta', rpcUrl: 'https://api.mainnet-beta.solana.com', priorityMicroLamports: 20_000 });
  });

  it('has no faucet on mainnet, whatever is set', () => {
    const c = live({ ADS_ALLOW_MAINNET: 'true', AD_FAUCET_SECRET: '[1,2,3]' });
    expect(c.faucetSecret).toBeUndefined();
  });

  it('burns the official $PJAM by default, overridable by ADS_PJAM_MINT (never by AD_MINT)', () => {
    expect(live({ ADS_ALLOW_MAINNET: 'true', AD_MINT: 'SomeOtherMint' }).mint).toBe(PJAM_MAINNET);
    const other = 'So11111111111111111111111111111111111111112';
    expect(live({ ADS_ALLOW_MAINNET: 'true', ADS_PJAM_MINT: other }).mint).toBe(other);
    expect(() => live({ ADS_ALLOW_MAINNET: 'true', ADS_PJAM_MINT: 'not a mint!' })).toThrow(/not a valid Solana address/);
  });

  it('reads only ADS_LIVE_* for RPC, origins and priority fee, so it never shares the devnet secrets', () => {
    const env = {
      ADS_ALLOW_MAINNET: 'true', ADS_RPC_URL: 'https://devnet.example', ADS_ALLOWED_ORIGINS: 'https://test.example', ADS_PRIORITY_MICROLAMPORTS: '7',
    };
    expect(live(env)).toMatchObject({ rpcUrl: 'https://api.mainnet-beta.solana.com', origins: [], priorityMicroLamports: 20_000 });
    expect(live({ ...env, ADS_LIVE_RPC_URL: 'https://rpc.example', ADS_LIVE_ALLOWED_ORIGINS: 'https://pokejam.xyz, https://www.pokejam.xyz', ADS_LIVE_PRIORITY_MICROLAMPORTS: '50000' }))
      .toMatchObject({ rpcUrl: 'https://rpc.example', origins: ['https://pokejam.xyz', 'https://www.pokejam.xyz'], priorityMicroLamports: 50_000 });
  });

  it('on devnet needs its own test mint (never the real token) and may run the faucet', () => {
    expect(() => live({}, 'devnet')).toThrow(/ADS_PJAM_MINT is not set/);
    const m = 'So11111111111111111111111111111111111111112';
    expect(live({ ADS_PJAM_MINT: m, AD_FAUCET_SECRET: '[1,2,3]' }, 'devnet'))
      .toMatchObject({ cluster: 'devnet', mint: m, faucetSecret: '[1,2,3]', rpcUrl: 'https://api.devnet.solana.com', priorityMicroLamports: 0 });
  });
});

describe('ads config: devnet function (pokejam-ads) is unchanged by the live secrets', () => {
  it('ignores ADS_ALLOW_MAINNET=true, ADS_PJAM_MINT and ADS_LIVE_*', () => {
    const shared = { AD_MINT: 'X', ADS_ALLOW_MAINNET: 'true', ADS_PJAM_MINT: PJAM_MAINNET, ADS_LIVE_RPC_URL: 'https://rpc.example', ADS_LIVE_ALLOWED_ORIGINS: 'https://pokejam.xyz', AD_FAUCET_SECRET: '[1]' };
    expect(from(shared)).toEqual(from({ AD_MINT: 'X', AD_FAUCET_SECRET: '[1]' }));
    expect(from(shared)).toMatchObject({ cluster: 'devnet', mint: 'X', rpcUrl: 'https://api.devnet.solana.com', origins: [], faucetSecret: '[1]' });
    // "true" is not the devnet function's approval phrase: it still refuses mainnet.
    expect(() => from({ ...shared, ADS_CLUSTER: 'mainnet-beta' })).toThrow(/devnet-only/);
  });
});
