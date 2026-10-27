import { describe, expect, it } from 'vitest';
import { BANNER_ADS, boardAfterAd } from './ads';
import { COURTS } from './courts';

describe('boardAfterAd', () => {
  it('drops the first segment and keeps the rest', () => {
    expect(boardAfterAd('VERMILION CITY ★ S.S. ANNE ★ SHOCK THE CROWD')).toBe('S.S. ANNE ★ SHOCK THE CROWD');
  });
  it('is empty when there is only one segment', () => {
    expect(boardAfterAd('ONLY')).toBe('');
  });
  it('leaves every court some board text', () => {
    for (const c of Object.values(COURTS)) expect(boardAfterAd(c.board).length).toBeGreaterThan(0);
  });
});

describe('BANNER_ADS', () => {
  it('has a $PJAM half and a YOUR AD HERE half as separate entries', () => {
    expect(BANNER_ADS).toHaveLength(2);
    expect(BANNER_ADS[0].text).toBe('$PJAM · OFFICIAL POKEJAM TOKEN');
    expect(BANNER_ADS[1].text).toBe('YOUR AD HERE');
    expect(BANNER_ADS[0]).not.toBe(BANNER_ADS[1]);
    for (const a of BANNER_ADS) expect(Object.keys(a).sort()).toEqual(['bg', 'border', 'color', 'enabled', 'tag', 'tagBg', 'text']);
  });
  it('makes no price or investment claims', () => {
    for (const a of BANNER_ADS) expect(a.text).not.toMatch(/price|profit|invest|moon|gain|return|\d+x/i);
  });
});
