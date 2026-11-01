// @ts-ignore Node's fs has no type declarations in this project.
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { TIERS, TOP_DIV, ZENITH_IDX } from './rank';
import { badgeRankOf, renderRankBadge, BADGE_FILES, ZENITH_BADGE, badgeImgForTier, badgeImgHtml, badgeUrl, stemForTier } from './badge';

const file = (s: string, x2 = false) => new URL(`../../public/ranks/${s}${x2 ? '@2x' : ''}.png`, import.meta.url);

describe('rank badge art', () => {
  it('has one file per tier plus Zenith, at 1x and 2x', () => {
    expect(BADGE_FILES.length).toBe(TIERS.length);
    for (const s of [...BADGE_FILES, ZENITH_BADGE]) {
      expect(existsSync(file(s)), s).toBe(true);
      expect(existsSync(file(s, true)), `${s}@2x`).toBe(true);
    }
  });
  it('maps every tier name and Zenith to its file', () => {
    expect(TIERS.map(stemForTier)).toEqual([...BADGE_FILES]);
    expect(stemForTier('Pokémon Master')).toBe('master');
    expect(stemForTier('Zenith')).toBe('zenith');
    expect(stemForTier('Nope')).toBeNull();
  });
  it('maps every division index to its tier badge, with alt text', () => {
    for (let d = 0; d <= TOP_DIV; d++) expect(badgeImgHtml(d)).toContain(`ranks/${BADGE_FILES[Math.floor(d / 3)]}.png`);
    expect(badgeImgHtml(ZENITH_IDX)).toContain('ranks/zenith.png');
    expect(badgeImgHtml(ZENITH_IDX)).toContain('alt="Zenith"');
    expect(badgeImgHtml(0)).toContain('alt="Bronze"');
    expect(badgeImgHtml(TOP_DIV)).toContain('alt="Pokémon Master"');
    expect(badgeImgHtml(0)).toContain('@2x.png 2x');
  });
  it('local-mock badge: image for a tier, nothing when unranked', () => {
    expect(badgeImgForTier('Gold')).toContain('ranks/gold.png');
    expect(badgeImgForTier(null)).toBe('');
    expect(badgeUrl('gold', true)).toMatch(/ranks\/gold@2x\.png$/);
  });

  describe('renderRankBadge', () => {
    it('placed: tier art plus the division as text, Zenith uses its own art', () => {
      const h = renderRankBadge({ divIdx: 7 });
      expect(h).toContain('data-rk-badge="ranked"');
      expect(h).toContain('ranks/gold.png');
      expect(h).toContain('Gold 2');
      expect(renderRankBadge({ divIdx: ZENITH_IDX })).toContain('ranks/zenith.png');
    });
    it('unranked: a grey placeholder saying Unranked, no tier art', () => {
      for (const h of [renderRankBadge(null), renderRankBadge(badgeRankOf(null))]) {
        expect(h).toContain('data-rk-badge="unranked"');
        expect(h).toContain('Unranked');
        expect(h).not.toContain('<img');
      }
    });
    it('placement: shows progress, no tier art', () => {
      const h = renderRankBadge(badgeRankOf({ placing: true, placementsPlayed: 2, divIdx: null }));
      expect(h).toContain('data-rk-badge="placing"');
      expect(h).toContain('Placement 2/5');
      expect(h).not.toContain('<img');
    });
    it('label:false keeps the accessible name on placeholders', () => {
      expect(renderRankBadge(null, { label: false })).toContain('aria-label="Unranked"');
    });
  });
});
