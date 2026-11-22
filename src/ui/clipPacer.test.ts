import { describe, expect, it } from 'vitest';
import { createClipPacer } from './clipPacer';

const simulate = (hz: number, seconds: number, jitter = 0) => {
  const p = createClipPacer(30);
  const out: number[] = [];
  for (let t = 0, i = 0; t < seconds * 1000; i++, t = (i * 1000) / hz + (jitter ? Math.sin(i) * jitter : 0)) if (p.accept(t)) out.push(t);
  return out;
};

describe('clip pacer', () => {
  it('paints the first call immediately', () => expect(createClipPacer().accept(1234)).toBe(true));
  it('drops a call 1ms later, accepts one 33ms+ later', () => {
    const p = createClipPacer();
    expect(p.accept(0)).toBe(true);
    expect(p.accept(1)).toBe(false);
    expect(p.accept(20)).toBe(false);
    expect(p.accept(34)).toBe(true);
  });
  for (const hz of [120, 60, 30]) {
    it(`holds ~30fps with no tiny gaps over 6s of ${hz}Hz rAF`, () => {
      const t = simulate(hz, 6, 0.5);
      expect(t.length).toBeGreaterThanOrEqual(175);
      expect(t.length).toBeLessThanOrEqual(185);
      for (let i = 1; i < t.length; i++) expect(t[i] - t[i - 1]).toBeGreaterThan(24);
    });
  }
  it('does not burst after a long stall', () => {
    const p = createClipPacer();
    p.accept(0);
    expect(p.accept(500)).toBe(true);
    expect(p.accept(508)).toBe(false);
  });
});
