import { describe, expect, it } from 'vitest';
import { KING_KABUTO, kingKabutoActive } from './config';

const t = (iso: string) => Date.parse(iso);
const START = t(KING_KABUTO.start);
const END = t(KING_KABUTO.end);

describe('King Kabuto window', () => {
  it('is closed just before the start', () => expect(kingKabutoActive(t('2026-11-08T23:59:59-08:00'))).toBe(false));
  it('opens exactly at the start (inclusive)', () => expect(kingKabutoActive(START)).toBe(true));
  it('is open mid-window', () => expect(kingKabutoActive(t('2026-11-15T12:00:00-08:00'))).toBe(true));
  it('is open on the last ms before the end', () => expect(kingKabutoActive(END - 1)).toBe(true));
  it('closes exactly at the end (exclusive)', () => expect(kingKabutoActive(END)).toBe(false));
  it('is closed after the end', () => expect(kingKabutoActive(t('2026-12-01T00:00:00-08:00'))).toBe(false));
  it('start is before end', () => expect(START).toBeLessThan(END));
  it('dates carry the PST offset and the LA time zone', () => {
    expect(KING_KABUTO.start.endsWith('-08:00')).toBe(true);
    expect(KING_KABUTO.end.endsWith('-08:00')).toBe(true);
    expect(KING_KABUTO.tz).toBe('America/Los_Angeles');
  });
});
