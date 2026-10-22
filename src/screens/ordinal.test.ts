import { describe, expect, it } from 'vitest';
import { ordinal } from './draft.logic';

describe('ordinal', () => {
  it('labels draft spots', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(ordinal)).toEqual(['1st', '2nd', '3rd', '4th', '5th', '6th', '7th', '8th', '9th', '10th']);
    expect([11, 12, 13, 17, 21, 22, 23, 24].map(ordinal)).toEqual(['11th', '12th', '13th', '17th', '21st', '22nd', '23rd', '24th']);
  });
});
