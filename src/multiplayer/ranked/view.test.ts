import { describe, expect, it } from 'vitest';
import type { ReportOutcome } from '../shared/matchService';
import { parseMe, parseRankResult, type RankedMe } from './serverRank';
import { postMatchHtml, rankChipHtml, signInPanelHtml, tierClass } from './view';

const me = (o: Partial<RankedMe> = {}): RankedMe => ({
  season: 1, daysLeft: 31, placing: false, placementsPlayed: 5, divIdx: 7, points: 40, zenith: false, shieldCharge: 1, shieldLossesLeft: null,
  shieldActive: true, wins: 3, losses: 2, cooldownUntil: null, ...o,
});
const done = (result: unknown, m: RankedMe | null = null): ReportOutcome => ({ queue: 'ranked', status: 'done', result: parseRankResult(result) ?? undefined, me: m ?? undefined });

describe('parseMe (pokejam_ranked_me)', () => {
  it('reads a placed player', () => {
    expect(parseMe({ season: 1, days_left: 30, status: 'ranked', placements_played: 5, div_idx: 7, points: 40, shield_charge: 0, shield_losses_left: 2, shield_active: true, wins: 4, losses: 3, cooldown_until: null }))
      .toMatchObject({ season: 1, daysLeft: 30, placing: false, divIdx: 7, points: 40, shieldCharge: 0, shieldLossesLeft: 2, shieldActive: true, zenith: false });
  });
  it('hides the numbers while placing, even if the server sent a seed', () => {
    expect(parseMe({ status: 'placing', placements_played: 2, div_idx: 3, points: 50 })).toMatchObject({ placing: true, placementsPlayed: 2, divIdx: null, points: null });
  });
  it('survives missing fields, strings and junk', () => {
    expect(parseMe({})).toMatchObject({ placing: true, placementsPlayed: 0, season: null, shieldCharge: null, wins: 0 });
    expect(parseMe({ status: 'ranked', div_idx: '24', points: '340' })).toMatchObject({ placing: false, zenith: true, divIdx: 24, points: 340 });
    expect(parseMe({ placements_played: 99, status: 'placing' })?.placementsPlayed).toBe(5);
    for (const bad of [null, undefined, 'x', 7, []]) expect(parseMe(bad)).toBeNull();
  });
});

describe('parseRankResult leniency', () => {
  it('numbers sent as strings are read; a missing placing flag is inferred from the placement count', () => {
    expect(parseRankResult({ placing: false, delta: '15', before: '395', after: '410' })).toMatchObject({ delta: 15, before: 395, after: 410 });
    expect(parseRankResult({ placements_played: 3 })).toMatchObject({ placing: true, placementsPlayed: 3 });
    expect(parseRankResult({ placements_played: 5 })).toMatchObject({ placing: false });
  });
});

describe('rank chip', () => {
  it('shows tier, division, points, season badge and shield', () => {
    const h = rankChipHtml(me());
    expect(h).toContain('Gold 2'); // div_idx 7
    expect(h).toContain('40 / 100');
    expect(h).toContain('S1');
    expect(h).toContain('Demotion Guard ready');
    expect(h).toContain('31 days left');
    expect(h).toContain(tierClass(7));
  });
  it('placements: progress only, no tier, no points, no points bar', () => {
    const h = rankChipHtml(me({ placing: true, placementsPlayed: 2, divIdx: null, points: null }));
    expect(h).toContain('Placement 2 / 5');
    expect(h).not.toMatch(/rk-bar|pts|\/ 100|Bronze|Silver|Gold/);
  });
  it('Zenith has points and a crest colour but no bar and no shield', () => {
    const h = rankChipHtml(me({ divIdx: 24, points: 340, zenith: true, shieldActive: false }));
    expect(h).toContain('Zenith');
    expect(h).toContain('340 pts');
    expect(h).toContain('tier-z');
    expect(h).not.toContain('rk-bar');
    expect(h).not.toContain('Guard');
  });
  it('a spent shield says when it recharges; above Gold the shield is not mentioned; no data is a quiet message', () => {
    expect(rankChipHtml(me({ shieldCharge: 0, shieldLossesLeft: 1 }))).toContain('Guard recharges in 1 loss');
    expect(rankChipHtml(me({ shieldActive: false }))).not.toContain('Guard');
    expect(rankChipHtml(null)).toContain('Rank unavailable');
  });
});

describe('post-match points', () => {
  it('a win shows +points, the move and the bar', () => {
    const h = postMatchHtml(done({ placing: false, event: null, placements_played: 5, before: 740, after: 762, delta: 22, div_idx: 7, points: 62 }, me({ points: 62 })), true);
    expect(h).toContain('+22 pts');
    expect(h).toContain('WIN');
    expect(h).toContain('width:62%');
    expect(h).toContain('Gold 2 · 40 pts → Gold 2 · 62 pts');
    expect(h).not.toContain('rk-anim');
  });
  it('a loss shows -points', () => {
    expect(postMatchHtml(done({ placing: false, delta: -17, before: 762, after: 745, div_idx: 7, points: 45 }), false)).toContain('-17 pts');
  });
  it('promotion plays the rank-up reveal with a Skip button', () => {
    const h = postMatchHtml(done({ placing: false, event: 'promoted', before: 790, after: 812, delta: 22, div_idx: 8, points: 12 }));
    expect(h).toContain('rk-up');
    expect(h).toContain('Rank up!');
    expect(h).toContain('data-rk-skip');
  });
  it('Zenith entry and demotion have their own reveals', () => {
    expect(postMatchHtml(done({ placing: false, event: 'zenith', before: 2395, after: 2500, delta: 20, div_idx: 24, points: 100 }))).toContain('Welcome to Zenith!');
    const d = postMatchHtml(done({ placing: false, event: 'demoted', before: 805, after: 778, delta: -27, div_idx: 7, points: 78 }, me({ shieldCharge: 0, shieldLossesLeft: 3 })));
    expect(d).toContain('rk-down');
    expect(d).toContain('Demoted to');
    expect(d).toContain('Guard recharges in 3 losses');
  });
  it('a shielded loss says the shield was used and when it recharges', () => {
    const h = postMatchHtml(done({ placing: false, event: 'shielded', before: 700, after: 700, delta: -19, div_idx: 7, points: 0 }, me({ points: 0, shieldCharge: 0, shieldLossesLeft: 3 })));
    expect(h).toContain('Demotion Guard used');
    expect(h).toContain('Guard recharges in 3 losses');
  });
  it('mid-placement shows progress and never a number of points', () => {
    const h = postMatchHtml(done({ placing: true, placements_played: 3, event: null, before: 400, after: 400, delta: 12, div_idx: 4, points: 0 }), true);
    expect(h).toContain('Placement 3 / 5');
    expect(h).toContain('2 more matches');
    expect(h).not.toMatch(/pts|[+-]\d+ /);
  });
  it('the fifth placement reveals the rank', () => {
    const h = postMatchHtml(done({ placing: true, event: 'placed', placements_played: 5, before: 400, after: 440, delta: 40, div_idx: 4, points: 40 }));
    expect(h).toContain('Placed: Silver 2 · 40 pts'); // div_idx 4
    expect(h).toContain('rk-placed');
  });
  it('pending and void results, and a missing result, are plain', () => {
    expect(postMatchHtml({ queue: 'ranked', status: 'pending' })).toContain('Waiting for your opponent');
    expect(postMatchHtml({ queue: 'ranked', status: 'void' })).toContain('not rated');
    expect(postMatchHtml({ queue: 'ranked', status: 'done' })).toBe('');
  });
  it('copes with a result that has almost nothing in it', () => {
    expect(() => postMatchHtml(done({ placing: false }))).not.toThrow();
    expect(() => postMatchHtml(done({ placing: false, event: 'promoted' }))).not.toThrow();
  });
});

describe('sign-in panel', () => {
  it('offers Google and, depending on the device, Phantom sign-in, the phone deep link or the download page', () => {
    const base = signInPanelHtml({ kind: 'sign-in' }, { google: true });
    expect(base).toContain('data-a="google"');
    expect(base).toContain('data-a="phantom"');
    expect(base).toContain('Signing in with Google keeps your guest stats');
    expect(signInPanelHtml({ kind: 'open-in-phantom', href: 'https://phantom.app/ul/browse/x?ref=y' })).toContain('href="https://phantom.app/ul/browse/x?ref=y"');
    const install = signInPanelHtml({ kind: 'install', href: 'https://phantom.app/download' });
    expect(install).toContain('https://phantom.app/download');
    expect(install).toContain('rel="noopener"');
  });
  it('Phantom-only (Google flag off): no Google button, copy or gap, and Phantom is the primary button', () => {
    for (const a of [{ kind: 'sign-in' as const }, { kind: 'open-in-phantom' as const, href: 'https://phantom.app/ul/x' }, { kind: 'install' as const, href: 'https://phantom.app/download' }]) {
      const h = signInPanelHtml(a, { google: false });
      expect(h).not.toMatch(/google/i);
      expect(h).toMatch(/class="btn primary big" data-a="phantom/);
      expect(h).toMatch(/rk-signin-btns">\s*<(button|a) /); // the Phantom button is the first child: no empty slot before it
    }
    expect(signInPanelHtml({ kind: 'sign-in' }, { google: false })).toContain('A wallet is a fresh account');
  });
  it('escapes the error and disables the buttons while busy', () => {
    const h = signInPanelHtml({ kind: 'sign-in' }, { busy: true, error: '<b>x</b>', google: true });
    expect(h).toContain('&lt;b&gt;');
    expect(h).not.toContain('<b>x</b>');
    expect(h.match(/ disabled/g)?.length).toBe(2);
    expect(signInPanelHtml({ kind: 'sign-in' }, { busy: true, google: false }).match(/ disabled/g)?.length).toBe(1);
  });
  it('contains no Marvel names', () => {
    for (const h of [rankChipHtml(me({ divIdx: 24, points: 5 })), signInPanelHtml({ kind: 'sign-in' })]) expect(h).not.toMatch(/celestial|eternity|one above all/i);
  });
});
