import { describe, expect, it } from 'vitest';
import { menuSignedIn, profileButtonHtml } from './menu';

describe('menu profile button', () => {
  it('signed out: Sign in, a caption, and a matching aria-label', () => {
    const h = profileButtonHtml(false);
    expect(h).toContain('>Sign in<small>Use your wallet or Discord to create a profile</small>');
    expect(h).toContain('aria-label="Sign in. Use your wallet or Discord to create a profile"');
    expect(h).not.toContain('>Profile<');
  });

  it('signed in: Profile, no caption, and a profile aria-label', () => {
    const h = profileButtonHtml(true);
    expect(h).toContain('aria-label="Your profile and stats"');
    expect(h).toContain('>Profile</button>');
    expect(h).not.toContain('<small>');
    expect(h).not.toContain('Use your wallet or Discord');
    expect(h).not.toContain('Sign in');
  });
});

describe('menu session', () => {
  it('a missing, guest, or unreadable session is signed out', () => {
    expect(menuSignedIn(null)).toBe(false);
    expect(menuSignedIn('')).toBe(false);
    expect(menuSignedIn('not-json')).toBe(false);
    expect(menuSignedIn('{"user":null}')).toBe(false);
    expect(menuSignedIn('{"user":{"is_anonymous":true}}')).toBe(false);
  });

  it('a real account is signed in', () => {
    expect(menuSignedIn('{"user":{"is_anonymous":false}}')).toBe(true);
    expect(menuSignedIn('{"user":{}}')).toBe(true);
  });
});
