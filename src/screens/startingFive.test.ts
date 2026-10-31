import { describe, expect, it } from 'vitest';
import { CALLS } from '../game/announcer';
import { INTRO_LENGTH, introOrder } from './startingFive';

describe('the starting-five intro', () => {
  it('saves your team for last, and goes away then home when nobody is "you"', () => {
    expect(introOrder(0)).toEqual([1, 0]);
    expect(introOrder(1)).toEqual([0, 1]);
    expect(introOrder(null)).toEqual([1, 0]);
  });

  it('is short: under nine seconds from the title to tip-off', () => {
    expect(INTRO_LENGTH).toBeLessThan(9);
  });

  it('has the announcer lines it says', () => {
    expect(CALLS.lineups).toEqual(['lineups_1', 'lineups_2']);
    expect(CALLS.yourfive).toEqual(['yourfive']);
  });
});
