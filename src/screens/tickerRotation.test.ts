import { describe, expect, it } from 'vitest';
import { TICKER_TIP_RATIO, tickerRotation, type TickerSlot } from './tickerRotation';

const TIPS = ['Hold shoot', 'Dunk', 'Lineup bonus', 'Matchups', 'Signature move', 'Bench'];

function tipShare(slots: TickerSlot[]): number {
  const tips = slots.filter((s) => s.kind === 'tip').length;
  const ads = slots.filter((s) => s.kind === 'ad').length;
  return tips / (tips + ads);
}

function adsBeforeFirstTip(slots: TickerSlot[]): number {
  const at = slots.findIndex((s) => s.kind === 'tip');
  return at === -1 ? slots.length : at;
}

describe('tickerRotation', () => {
  it('keeps the tip share in the configured band, one tip after every five ads', () => {
    expect(TICKER_TIP_RATIO).toBeGreaterThanOrEqual(0.15);
    expect(TICKER_TIP_RATIO).toBeLessThanOrEqual(0.2);
    expect(TICKER_TIP_RATIO).toBeCloseTo(1 / 6, 10);

    const slots = tickerRotation(['RIPIT', 'SECOND'], TIPS);
    expect(slots[0]).toEqual({ kind: 'ad', text: 'RIPIT' });
    expect(tipShare(slots)).toBeCloseTo(TICKER_TIP_RATIO, 10);
    expect(adsBeforeFirstTip(slots)).toBe(5);
    expect(slots.filter((s) => s.kind === 'ad')).toHaveLength(TIPS.length * 5);
    expect(slots.filter((s) => s.kind === 'tip').map((s) => s.text)).toEqual(TIPS);

    const pattern = slots.map((s) => s.kind).join('');
    expect(pattern).toBe('ad'.repeat(5).concat('tip').repeat(TIPS.length));
    expect(slots.filter((s) => s.kind === 'ad').map((s) => s.text)).toEqual(
      Array.from({ length: TIPS.length * 5 }, (_, i) => (i % 2 === 0 ? 'RIPIT' : 'SECOND')),
    );
  });

  it('honors a different ratio: one tip after every four ads at 20 percent', () => {
    const slots = tickerRotation(['A', 'B', 'C'], ['t1', 't2'], 0.2);
    expect(tipShare(slots)).toBeCloseTo(0.2, 10);
    expect(adsBeforeFirstTip(slots)).toBe(4);
    expect(slots.map((s) => s.text)).toEqual([
      'A', 'B', 'C', 'A', 't1',
      'B', 'C', 'A', 'B', 't2',
    ]);
  });

  it('does not place the same tip twice in a row when another tip exists', () => {
    const fallback = tickerRotation([], ['A', 'A', 'B', 'B', 'A']);
    expect(fallback).toEqual([
      { kind: 'tip', text: 'A' },
      { kind: 'tip', text: 'B' },
      { kind: 'tip', text: 'A' },
    ]);
    for (let i = 1; i < fallback.length; i++) expect(fallback[i].text).not.toBe(fallback[i - 1].text);

    const booked = tickerRotation(['AD'], ['Same', 'Same', 'Other']);
    expect(booked.filter((s) => s.kind === 'tip').map((s) => s.text)).toEqual(['Same', 'Same', 'Other']);
    for (let i = 1; i < booked.length; i++) {
      const prev = booked[i - 1];
      const cur = booked[i];
      if (cur.kind === 'tip' && prev.kind === 'tip') expect(cur.text).not.toBe(prev.text);
    }
  });

  it('keeps a single distinct tip once when nothing else can separate repeats', () => {
    expect(tickerRotation([], ['Only', 'Only'])).toEqual([{ kind: 'tip', text: 'Only' }]);
    const booked = tickerRotation(['AD'], ['Only']);
    expect(booked.filter((s) => s.kind === 'tip')).toEqual([{ kind: 'tip', text: 'Only' }]);
    expect(booked[0].kind).toBe('ad');
    expect(booked[booked.length - 1]).toEqual({ kind: 'tip', text: 'Only' });
  });

  it('falls back to the tips when no ad is booked, and to ads when there are no tips', () => {
    expect(tickerRotation([], TIPS)).toEqual(TIPS.map((text) => ({ kind: 'tip', text })));
    expect(tickerRotation(['ONLY'], [])).toEqual([{ kind: 'ad', text: 'ONLY' }]);
    expect(tickerRotation([], [])).toEqual([]);
    expect(tickerRotation(['ONLY'], TIPS, 0).every((s) => s.kind === 'ad')).toBe(true);
  });
});
