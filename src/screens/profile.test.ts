import { describe, expect, it } from 'vitest';
import type { RankedMe } from '../multiplayer/ranked/serverRank';
import { postMatchHtml, usernamePickerHtml, versusHtml } from '../multiplayer/ranked/view';
import { profileHtml, winRate, type ProfileModel } from './profile';

const me: RankedMe = { season: 1, daysLeft: 20, placing: false, placementsPlayed: 5, divIdx: 7, points: 40, zenith: false, shieldCharge: 1,
  shieldLossesLeft: null, shieldActive: true, wins: 12, losses: 8, peakIdx: 9, cooldownUntil: null };
const model = (o: Partial<ProfileModel> = {}): ProfileModel => ({ rankedOn: true, onlineAvailable: true, signedIn: true, username: 'Ash_K', nextChangeAt: null, me,
  social: { played: 10, won: 6 }, local: { franchise: 'Pallet Town · Season 2 · 6-3', drafted: null }, ...o });
const phantom = { kind: 'install', href: 'https://phantom.app/download' } as const;
const XSS = '<img src=x onerror=alert(1)>"\'&';

describe('profileHtml', () => {
  it('shows username, rank, record, win rate, placements and peak for a signed-in player', () => {
    const h = profileHtml(model(), phantom);
    expect(h).toContain('Ash_K');
    expect(h).toContain('data-rk="ranked"');
    expect(h).toContain('12W – 8L');
    expect(h).toContain('60%');
    expect(h).toContain('Placements');
    expect(h).toContain('Peak rank');
    expect(h).toContain('Social');
    expect(h).toContain('Franchise');
    expect(h).not.toContain('data-rk="signin"');
  });

  it('shows placement progress instead of a record while placing', () => {
    const h = profileHtml(model({ me: { ...me, placing: true, placementsPlayed: 2, divIdx: null, points: null } }), phantom);
    expect(h).toContain('2 / 5 played');
    expect(h).not.toContain('Win rate');
  });

  it('gives a guest the sign-in panel and their local stats, no ranked sections', () => {
    const h = profileHtml(model({ signedIn: false, username: null, me: null }), phantom);
    expect(h).toContain('data-rk="signin"');
    expect(h).toContain('Guest');
    expect(h).toContain('Franchise');
    expect(h).not.toContain('Ranked record');
    expect(h).not.toContain('data-a="rename"');
  });

  it('hides every ranked part when Ranked is off in the build', () => {
    const h = profileHtml(model({ rankedOn: false }), phantom);
    expect(h).not.toMatch(/Ranked|rk-chip|signin|rename|Peak rank/);
    expect(h).toContain('Franchise');
    const g = profileHtml(model({ rankedOn: false, signedIn: false, username: null, me: null }), phantom);
    expect(g).not.toMatch(/Ranked|signin|Sign in/);
  });

  it('never prints an email or wallet address', () => {
    const h = profileHtml(model(), phantom);
    expect(h).not.toMatch(/@[a-z0-9-]+\.[a-z]/i);
  });

  it('win rate', () => {
    expect(winRate(0, 0)).toBe('–');
    expect(winRate(1, 2)).toBe('33%');
  });
});

describe('usernames are escaped wherever they render', () => {
  const clean = (h: string) => {
    expect(h).not.toContain('<img');
    expect(h).not.toContain('onerror=alert(1)>');
  };
  it('profile', () => clean(profileHtml(model({ username: XSS }), phantom)));
  it('picker value and error', () => clean(usernamePickerHtml({ value: XSS, error: XSS, note: XSS })));
  it('versus line and post-match screen', () => {
    clean(versusHtml({ me: XSS, opp: XSS }));
    clean(postMatchHtml({ queue: 'ranked', status: 'pending', names: { me: XSS, opp: XSS } }));
  });
  it('falls back to Player', () => {
    expect(versusHtml({ me: null, opp: '' })).toContain('Player</span> <i>vs</i> <span class="rk-opp">Player');
    expect(versusHtml(undefined)).toBe('');
  });
});
