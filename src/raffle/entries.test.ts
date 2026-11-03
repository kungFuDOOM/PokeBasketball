import { describe, expect, it } from 'vitest';
import {
  DRAW_ALGORITHM, HOLDER_ENTRY_CAP, PJAM_MINT, RAFFLE_DEFAULTS, clampConfig, configFromJson, configToJson,
  creditsOffline, pickWinner, raffleTicket, scoreRaffle, type RaffleCounts, type RaffleConfig,
} from './entries';

const counts = (o: Partial<RaffleCounts> = {}): RaffleCounts => ({
  offline: 3, online: 3, onlineWins: 0, socialMatches: 0, shares: 1, rankSteps: 1, zenith: false, ...o,
});

describe('config', () => {
  it('defaults are the documented amounts', () => {
    expect(RAFFLE_DEFAULTS).toEqual({
      offlineGames: 3, onlineGames: 3, social: 1, rankSteps: 1,
      pjamPerEntry: 1_000_000, pjamMint: PJAM_MINT,
      grindOnlinePerEntry: 10, grindWinsPerEntry: 3, bonusCap: 5,
    });
    expect(DRAW_ALGORITHM).toBe('uint64be-mod-v1');
  });
  it('clamps wild values and keeps a bad mint off the config', () => {
    const c = clampConfig({ offlineGames: 0, onlineGames: 500, social: 1.5, rankSteps: -2, pjamPerEntry: 9, pjamMint: 'nope', grindOnlinePerEntry: 10, grindWinsPerEntry: 3, bonusCap: 99 });
    expect(c.offlineGames).toBe(3);
    expect(c.onlineGames).toBe(3);
    expect(c.social).toBe(1);
    expect(c.rankSteps).toBe(1);
    expect(c.pjamPerEntry).toBe(9);
    expect(c.pjamMint).toBe(PJAM_MINT);
    expect(c.bonusCap).toBe(5);
  });
  it('round-trips the json the database stores', () => {
    expect(configFromJson(configToJson(RAFFLE_DEFAULTS))).toEqual(RAFFLE_DEFAULTS);
  });
});

describe('entries', () => {
  const cfg: RaffleConfig = RAFFLE_DEFAULTS;
  it('one base entry when every challenge is done, and nothing before that', () => {
    expect(scoreRaffle(counts(), cfg, 0n).total).toBe(1);
    expect(scoreRaffle(counts({ offline: 2 }), cfg, 5_000_000n).total).toBe(0);
    expect(scoreRaffle(counts({ shares: 0, socialMatches: 0 }), cfg, 0n).base).toBe(false);
  });
  it('a social match and a share both count, and Zenith finishes the rank challenge', () => {
    expect(scoreRaffle(counts({ shares: 0, socialMatches: 1, rankSteps: 0 }), cfg, 0n).base).toBe(false);
    expect(scoreRaffle(counts({ shares: 0, socialMatches: 1, rankSteps: 0, zenith: true }), cfg, 0n).base).toBe(true);
  });
  it('grind needs extra online games and a win target, then holder entries add, and the bonus cap is 5', () => {
    const none = scoreRaffle(counts({ online: 12, onlineWins: 2 }), cfg, 0n);
    expect(none.grind).toBe(0);
    const one = scoreRaffle(counts({ online: 13, onlineWins: 3 }), cfg, 0n);
    expect(one.grind).toBe(1);
    expect(one.total).toBe(2);
    const held = scoreRaffle(counts(), cfg, 2_000_000n);
    expect(held.holder).toBe(2);
    expect(held.total).toBe(3);
    const both = scoreRaffle(counts({ online: 53, onlineWins: 15 }), cfg, 5_000_000n);
    expect(both.grind).toBe(5);
    expect(both.holder).toBe(5);
    expect(both.bonus).toBe(5);
    expect(both.total).toBe(6);
  });
  it('dust below one whole entry does not count, and a huge balance clamps', () => {
    expect(scoreRaffle(counts(), cfg, 999_999n).holder).toBe(0);
    expect(scoreRaffle(counts(), cfg, (BigInt(HOLDER_ENTRY_CAP) + 1n) * 1_000_000n).holder).toBe(HOLDER_ENTRY_CAP);
  });
  it('a bonus cap of 0 leaves the base entry only', () => {
    const tight = { ...cfg, bonusCap: 0 };
    expect(scoreRaffle(counts({ online: 100, onlineWins: 50 }), tight, 9_000_000n).total).toBe(1);
  });
});

describe('the draw', () => {
  const seed = (last: number) => {
    const b = new Uint8Array(32);
    b[7] = last;
    return b;
  };
  it('ticket is the first 8 bytes, unsigned, modulo the total', () => {
    expect(raffleTicket(seed(0), 6n)).toBe(0n);
    expect(raffleTicket(seed(7), 6n)).toBe(1n);
    const high = new Uint8Array(32);
    high[0] = 0xff;
    expect(raffleTicket(high, 6n)).toBe((0xffn << 56n) % 6n);
  });
  it('walks entries in id order, so more entries means a wider slice', () => {
    const entrants = [{ id: 'b', entries: 1 }, { id: 'a', entries: 5 }];
    expect(pickWinner(entrants, seed(0))).toBe('a');
    expect(pickWinner(entrants, seed(5))).toBe('b');
    expect(pickWinner(entrants, seed(4))).toBe('a');
    expect(pickWinner([{ id: 'a', entries: 0 }], seed(0))).toBeNull();
  });
});

describe('offline credit', () => {
  it('counts a played game only', () => {
    expect(creditsOffline('played')).toBe(true);
    expect(creditsOffline('simmed')).toBe(false);
    expect(creditsOffline('watched')).toBe(false);
  });
});
