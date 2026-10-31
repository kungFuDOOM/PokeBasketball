import { describe, expect, it } from 'vitest';
import { AD_THEMES, BANNER_ADS, HOUSE_AD, adTextOk, boardAds, boardAfterAd, bookableHalfOn, cleanAdText, houseAds, setLiveAds } from './ads';
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

describe('the two halves', () => {
  it('keeps $PJAM as the fixed house half and YOUR AD HERE as the bookable half', () => {
    expect(houseAds().map((a) => a.text)).toEqual(['$PJAM · OFFICIAL POKEJAM TOKEN']);
    expect(bookableHalfOn()).toBe(true);
    // The unbooked bookable half looks exactly like main's YOUR AD HERE panel.
    const yours = BANNER_ADS[1];
    expect(HOUSE_AD.text).toBe(yours.text);
    const th = AD_THEMES[HOUSE_AD.theme];
    expect([th.bg, th.color, th.border, th.tagBg]).toEqual([yours.bg, yours.color, yours.border, yours.tagBg]);
  });
});

describe('the ads on the board', () => {
  it('runs the house ad when nothing is booked, and drops a booked ad the moment it ends', () => {
    setLiveAds([]);
    expect(boardAds()).toEqual([HOUSE_AD]);
    const now = Date.now();
    setLiveAds([{ text: 'ONE', theme: 'fire', until: now + 1000 }, { text: 'TWO', theme: 'ice', until: now + 5000 }]);
    expect(boardAds(now).map((a) => a.text)).toEqual(['ONE', 'TWO']);
    expect(boardAds(now + 2000).map((a) => a.text)).toEqual(['TWO']);
    expect(boardAds(now + 6000)).toEqual([HOUSE_AD]);
  });

  it('ignores a theme this build does not know', () => {
    setLiveAds([{ text: 'NEW', theme: 'shadow' as never, until: Date.now() + 1000 }]);
    expect(boardAds()).toEqual([HOUSE_AD]);
  });
});

describe('ad text', () => {
  it('is typed in capitals, one space at a time, 24 at most', () => {
    expect(cleanAdText('  hold   $pjam')).toBe('HOLD $PJAM');
    expect(cleanAdText('x'.repeat(30))).toHaveLength(24);
  });
  it('allows what the LED font and the server allow', () => {
    expect(adTextOk('$PJAM @POKEJAM 100% #1')).toBe(true);
    expect(adTextOk('POKEJAM.XYZ/PLAY')).toBe(true);
    for (const bad of ['', ' ', 'EMOJI 🏀', '<B>', 'ÉCLAIR', 'X'.repeat(25)]) expect(adTextOk(bad)).toBe(false);
  });
  it('has the eight themes the server accepts', () => {
    // supabase/migrations/20261104_pokejam_ads.sql: theme in (...)
    expect(Object.keys(AD_THEMES).sort()).toEqual(['electric', 'fire', 'ghost', 'gold', 'grass', 'ice', 'psychic', 'water']);
  });
});
