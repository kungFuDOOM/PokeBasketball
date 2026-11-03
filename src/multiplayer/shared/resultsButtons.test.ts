import { describe, expect, it } from 'vitest';
import { FIND_RANKED_LABEL, onlineResultsButtons } from './resultsButtons';

describe('online results buttons', () => {
  it('Ranked: FIND RANKED OPPONENT, no Play again or rematch, Back and Report stay', () => {
    const b = onlineResultsButtons('ranked');
    expect(b[0]).toEqual({ id: 'find-ranked', label: 'FIND RANKED OPPONENT', kind: 'primary' });
    expect(FIND_RANKED_LABEL).toBe('FIND RANKED OPPONENT');
    expect(b.map((x) => x.id)).toEqual(['find-ranked', 'hub', 'report']);
    expect(b.some((x) => /again|rematch/i.test(x.label) || x.id === 'again')).toBe(false);
  });

  it('Social (casual): still Play again', () => {
    const b = onlineResultsButtons('social');
    expect(b.map((x) => [x.id, x.label])).toEqual([['again', 'Play again'], ['hub', 'Back'], ['report', 'Report or block']]);
  });
});
