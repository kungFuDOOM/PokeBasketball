import { describe, expect, it } from 'vitest';
import { copyText, shareText, xIntentUrl } from './share';

const potg = { name: 'Lugia', pts: 18 };

describe('shareText', () => {
  it('brags after a win and names the player of the game', () => {
    expect(shareText({ opponent: 'Viridian City Gym', userScore: 46, oppScore: 45, potg }))
      .toBe('I beat Viridian City Gym 46-45 on PokeJam! 🏀 Player of the game: Lugia (18 PTS)');
  });
  it('says a close loss was close', () => {
    expect(shareText({ opponent: 'Viridian City Gym', userScore: 45, oppScore: 46, potg }))
      .toBe('Lost a close one 45-46 to Viridian City Gym on PokeJam 🏀 Can you beat them?');
  });
  it('treats a 3-point loss as close and a 4-point loss as big', () => {
    expect(shareText({ opponent: 'X', userScore: 40, oppScore: 43 })).toContain('close one');
    expect(shareText({ opponent: 'X', userScore: 40, oppScore: 44 })).toContain('blown out 40-44 by X');
  });
  it('words a big loss differently', () => {
    expect(shareText({ opponent: 'Cerulean Cascades', userScore: 30, oppScore: 60 }))
      .toBe('Got blown out 30-60 by Cerulean Cascades on PokeJam 🏀 Think you can do better?');
  });
  it('handles a tie', () => {
    expect(shareText({ opponent: 'X', userScore: 50, oppScore: 50 })).toContain('50-50 tie');
  });
  it('leaves out the player of the game when there is none', () => {
    const t = shareText({ opponent: 'X', userScore: 10, oppScore: 5, potg: null });
    expect(t).toBe('I beat X 10-5 on PokeJam! 🏀');
    expect(t).not.toContain('Player of the game');
  });
  it('falls back when the opponent name is blank', () => {
    expect(shareText({ opponent: '  ', userScore: 2, oppScore: 1 })).toContain('I beat the CPU');
  });
});

describe('xIntentUrl / copyText', () => {
  it('encodes the text and the site url', () => {
    const text = 'I beat A&B 46-45 on PokeJam! 🏀 #1';
    const u = new URL(xIntentUrl(text));
    expect(u.origin + u.pathname).toBe('https://x.com/intent/post');
    expect(u.searchParams.get('text')).toBe(text);
    expect(u.searchParams.get('url')).toBe('https://pokejam.xyz');
    expect(xIntentUrl(text)).toContain('&url=https%3A%2F%2Fpokejam.xyz');
    expect(xIntentUrl(text)).not.toContain('A&B');
  });
  it('appends the link for copying', () => {
    expect(copyText('hi')).toBe('hi https://pokejam.xyz');
  });
});
