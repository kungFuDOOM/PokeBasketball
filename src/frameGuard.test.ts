import { describe, expect, it } from 'vitest';
import { ALLOWED_HOSTS, frameGuardVerdict } from './frameGuard';

const XYZ = 'https://pokejam.xyz';

describe('frameGuardVerdict', () => {
  it('allows top-level pokejam.xyz', () => {
    expect(frameGuardVerdict({ hostname: 'pokejam.xyz', isTop: true })).toEqual({ ok: true });
  });

  it('allows top-level localhost and other dev hosts', () => {
    for (const hostname of ['localhost', '127.0.0.1', '[::1]', '::1', 'www.pokejam.xyz', 'kungfudoom.github.io']) {
      expect(frameGuardVerdict({ hostname, isTop: true })).toEqual({ ok: true });
    }
  });

  it('blocks a foreign hostname, even top-level', () => {
    expect(frameGuardVerdict({ hostname: 'evil.example', isTop: true }).ok).toBe(false);
    expect(frameGuardVerdict({ hostname: 'pokejam.xyz.evil.example', isTop: true }).ok).toBe(false);
    expect(frameGuardVerdict({ hostname: '', isTop: true }).ok).toBe(false);
  });

  it('does not allow pokejam-test.vercel.app or Vercel previews', () => {
    expect(ALLOWED_HOSTS).not.toContain('pokejam-test.vercel.app');
    expect(frameGuardVerdict({ hostname: 'pokejam-test.vercel.app', isTop: true }).ok).toBe(false);
    expect(frameGuardVerdict({ hostname: 'pokejam-git-main-x.vercel.app', isTop: true }).ok).toBe(false);
  });

  it('blocks framing by pokejam.org (ancestorOrigins)', () => {
    const v = frameGuardVerdict({ hostname: 'pokejam.xyz', isTop: false, ancestorOrigins: ['https://pokejam.org'] });
    expect(v.ok).toBe(false);
  });

  it('blocks a sandboxed frame with a null origin', () => {
    expect(frameGuardVerdict({ hostname: 'pokejam.xyz', isTop: false, ancestorOrigins: ['null'] }).ok).toBe(false);
    expect(frameGuardVerdict({ hostname: 'pokejam.xyz', isTop: false, referrer: 'null' }).ok).toBe(false);
    expect(
      frameGuardVerdict({ hostname: 'pokejam.xyz', isTop: false, referrer: '', sameOriginTopOrigin: 'null' }).ok,
    ).toBe(false);
  });

  it('blocks a frame with empty referrer and no ancestorOrigins', () => {
    expect(frameGuardVerdict({ hostname: 'pokejam.xyz', isTop: false, referrer: '' }).ok).toBe(false);
    expect(frameGuardVerdict({ hostname: 'pokejam.xyz', isTop: false, ancestorOrigins: [], referrer: '' }).ok).toBe(false);
    expect(frameGuardVerdict({ hostname: 'pokejam.xyz', isTop: false }).ok).toBe(false);
  });

  it('blocks an unparseable referrer', () => {
    expect(frameGuardVerdict({ hostname: 'pokejam.xyz', isTop: false, referrer: 'not a url' }).ok).toBe(false);
  });

  it('allows a same-origin frame', () => {
    expect(
      frameGuardVerdict({ hostname: 'localhost', isTop: false, ancestorOrigins: ['http://localhost:5173'], sameOriginTopOrigin: 'http://localhost:5173' }),
    ).toEqual({ ok: true });
    expect(
      frameGuardVerdict({ hostname: 'localhost', isTop: false, referrer: 'http://localhost:5173/admin.html', sameOriginTopOrigin: 'http://localhost:5173' }),
    ).toEqual({ ok: true });
  });

  it('allows framing by pokejam.xyz and www.pokejam.xyz', () => {
    expect(frameGuardVerdict({ hostname: 'pokejam.xyz', isTop: false, ancestorOrigins: [XYZ] })).toEqual({ ok: true });
    expect(frameGuardVerdict({ hostname: 'pokejam.xyz', isTop: false, ancestorOrigins: ['https://www.pokejam.xyz'] })).toEqual({ ok: true });
    expect(frameGuardVerdict({ hostname: 'pokejam.xyz', isTop: false, referrer: 'https://www.pokejam.xyz/x' })).toEqual({ ok: true });
  });

  it('blocks when one ancestor among allowed ones is foreign', () => {
    const v = frameGuardVerdict({
      hostname: 'pokejam.xyz', isTop: false, ancestorOrigins: [XYZ, 'https://pokejam.org', 'https://www.pokejam.xyz'],
    });
    expect(v.ok).toBe(false);
  });

  it('prefers ancestorOrigins over referrer', () => {
    const v = frameGuardVerdict({ hostname: 'pokejam.xyz', isTop: false, ancestorOrigins: ['https://pokejam.org'], referrer: `${XYZ}/` });
    expect(v.ok).toBe(false);
  });

  it('blocks a foreign referrer and http (not https) pokejam.xyz', () => {
    expect(frameGuardVerdict({ hostname: 'pokejam.xyz', isTop: false, referrer: 'https://pokejam.org/' }).ok).toBe(false);
    expect(frameGuardVerdict({ hostname: 'pokejam.xyz', isTop: false, referrer: 'http://pokejam.xyz/' }).ok).toBe(false);
  });
});
