import { describe, expect, it } from 'vitest';
import { speedAt, zoomAt, zoomFor } from './potg';

describe('the replay camera and slow motion', () => {
  it('eases into deep slow motion around the moment and back out, without jumps', () => {
    expect(speedAt(-200)).toBe(1);
    expect(speedAt(0)).toBeLessThan(0.3);
    expect(speedAt(200)).toBe(1);
    for (let r = -200; r < 200; r++) expect(Math.abs(speedAt(r + 1) - speedAt(r)), `tick ${r}`).toBeLessThan(0.06);
    expect(Math.min(...Array.from({ length: 400 }, (_, i) => speedAt(i - 200)))).toBe(speedAt(0));
  });

  it('follows the build-up pushed in, goes tightest on the moment, and eases back a little after', () => {
    expect(zoomAt(-200)).toBeGreaterThan(1.2);
    expect(zoomAt(0)).toBeGreaterThan(zoomAt(-200) + 0.5);
    expect(zoomAt(200)).toBeLessThan(zoomAt(0));
    expect(zoomAt(200)).toBeGreaterThan(zoomAt(-200));
    for (let r = -200; r < 200; r++) expect(Math.abs(zoomAt(r + 1) - zoomAt(r)), `tick ${r}`).toBeLessThan(0.05);
  });
});

describe('phone and desktop cameras', () => {
  it('a phone-sized stage keeps more of the play in frame than a desktop one, but still pushes in', () => {
    const phone = zoomFor(390);
    const desk = zoomFor(1280);
    expect(zoomAt(0, phone)).toBeLessThan(zoomAt(0, desk));
    expect(zoomAt(0, phone)).toBeGreaterThan(1.5);
    expect(zoomAt(-200, phone)).toBeGreaterThan(1.1);
    expect(zoomFor(0)).toBe(desk); // not measured yet: the default
  });
});
