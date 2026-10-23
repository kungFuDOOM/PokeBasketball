import { describe, expect, it } from 'vitest';
import { abbr, cleanAbbr, lettersName, typingLetters } from './util';

describe('letters-only team names', () => {
  it('keeps only letters and single spaces, trimmed', () => {
    expect(lettersName('D00m #1!')).toBe('Dm');
    expect(lettersName('  Pallet   Town  ')).toBe('Pallet Town');
    expect(lettersName('Team 🔥 Rocket')).toBe('Team Rocket');
    expect(lettersName('123 !!!')).toBe('');
    expect(lettersName('abcdefghij klmnopqrstuvwxyz')).toHaveLength(20);
  });
  it('strips while typing but keeps a trailing space for the next word', () => {
    expect(typingLetters('Doom ')).toBe('Doom ');
    expect(typingLetters(' Doom  9Squad')).toBe('Doom Squad');
  });
  it('abbreviations are letters only, uppercase, max 3', () => {
    expect(cleanAbbr('d0#om!')).toBe('DOM');
    expect(cleanAbbr('ab1c2d')).toBe('ABC');
    expect(abbr('D00m #1!')).toBe('DM');
    expect(abbr('42')).toBe('YOU');
  });
});
