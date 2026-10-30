import { describe, expect, it } from 'vitest';
import { LEAGUE } from './franchise/league';
import { isNameBlocked, safeName } from './nameFilter';

describe('name filter', () => {
  it('lets ordinary team names through (no Scunthorpe problem)', () => {
    const ok = ['Classic', 'Assassins', 'Grasshoppers', 'Cockatoos', 'Shiitake', 'Scunthorpe', 'Essex', 'Pushers', 'Analysts', 'Therapists',
      'Titans', 'Dickens', 'Pallet Town', 'Bass Boys', 'Sussex Sharks', 'Cumberland', 'Assist Kings', 'Night Owls', 'Navy Seals'];
    for (const n of ok) expect(isNameBlocked(n), n).toBe(false);
  });
  it('lets every default league team through', () => {
    for (const t of LEAGUE) expect(isNameBlocked(t.name), t.name).toBe(false);
  });
  it('blocks vulgar words and slurs, including disguised ones', () => {
    const bad = ['fuck', 'FUCK', 'f u c k', 'f.u.c.k', 'fuuuuck', 'fvck', 'sh1t', 'sh!t', 'shit', 'shiiit', 'bitch', 'b1tch', 'cunt',
      'nigger', 'nigga', 'n1gger', 'n i g g a', 'n-i-g-g-a', 'nigg3r', 'faggot', 'fag', 'Kissass', 'Ass', 'a s s', 'Ass Kickers', 'asshole', 'Big Dick',
      'dickheads', 'Pussy Club', 'whore', 'retard', 'Team Hitler', 'porn', 'sex', 'cum', 'fck', 'Mother Fvckers', 'tit', '5h1t', '$hit'];
    for (const n of bad) expect(isNameBlocked(n), n).toBe(true);
  });
  it('safeName swaps a blocked name for the fallback', () => {
    expect(safeName('Pallet Town', 'Trainer')).toBe('Pallet Town');
    expect(safeName('f u c k', 'Trainer')).toBe('Trainer');
  });
});
