import { describe, expect, it } from 'vitest';
import { cheatTag, REPEAT_MIN, sortReported, type MatchCheck } from './cheatTag';

const check = (over: Partial<MatchCheck> = {}): MatchCheck => ({
  match_id: 'm1', queue: 'ranked', has_evidence: true, status: null, agrees: null, cheater_is_reported: null, ...over,
});
const row = (user_id: string, reports: number, last_at: string, checks?: MatchCheck[]) => ({ user_id, reports, last_at, checks });

describe('cheatTag', () => {
  it('flags an invalid verdict', () => {
    expect(cheatTag([check({ status: 'invalid' })])).toBe('flagged');
  });

  it('flags a final verdict that disagrees with the recorded winner', () => {
    expect(cheatTag([check({ status: 'final', agrees: false })])).toBe('flagged');
  });

  it('flags a forfeit by the reported player', () => {
    expect(cheatTag([check({ status: 'forfeit', cheater_is_reported: true })])).toBe('flagged');
  });

  it('does not flag the reported player for an opponent\'s forfeit', () => {
    expect(cheatTag([check({ status: 'forfeit', cheater_is_reported: false })])).toBe('none');
    expect(cheatTag([check({ status: 'forfeit', cheater_is_reported: false }), check({ status: 'final', agrees: true })])).toBe('clean');
  });

  it('is clean with an agreeing final verdict and nothing flagged', () => {
    expect(cheatTag([check({ status: 'final', agrees: true }), check({ status: 'incomplete' })])).toBe('clean');
  });

  it('is flagged when one match is clean and another is flagged', () => {
    expect(cheatTag([check({ status: 'final', agrees: true }), check({ status: 'invalid' })])).toBe('flagged');
  });

  it('is no check for Social, no evidence, incomplete, not judged, or no checks at all', () => {
    expect(cheatTag([check({ queue: 'social', has_evidence: false })])).toBe('none');
    expect(cheatTag([check({ has_evidence: false })])).toBe('none');
    expect(cheatTag([check({ status: 'incomplete' })])).toBe('none');
    expect(cheatTag([check({ status: 'final', agrees: null })])).toBe('none');
    expect(cheatTag([])).toBe('none');
    expect(cheatTag(undefined)).toBe('none');
    expect(cheatTag(null)).toBe('none');
  });
});

describe('sortReported', () => {
  it('puts flagged before a higher report count', () => {
    const many = row('many', 9, '2026-10-30T00:00:00Z', [check({ status: 'final', agrees: true })]);
    const flagged = row('flagged', 1, '2026-10-01T00:00:00Z', [check({ status: 'invalid' })]);
    expect(sortReported([many, flagged]).map((r) => r.user_id)).toEqual(['flagged', 'many']);
  });

  it('puts repeat-reported before single reports, then more reports, then the latest', () => {
    expect(REPEAT_MIN).toBe(2);
    const rows = [
      row('one-new', 1, '2026-10-30T00:00:00Z'),
      row('two-old', 2, '2026-10-01T00:00:00Z'),
      row('three', 3, '2026-10-02T00:00:00Z'),
      row('two-new', 2, '2026-10-20T00:00:00Z'),
      row('one-old', 1, '2026-10-05T00:00:00Z'),
    ];
    expect(sortReported(rows).map((r) => r.user_id)).toEqual(['three', 'two-new', 'two-old', 'one-new', 'one-old']);
  });

  it('keeps the input order for ties and does not mutate the input', () => {
    const at = '2026-10-30T00:00:00Z';
    const rows = [row('a', 1, at), row('b', 1, at), row('c', 1, at), row('d', 1, at)];
    const before = rows.map((r) => r.user_id);
    expect(sortReported(rows).map((r) => r.user_id)).toEqual(['a', 'b', 'c', 'd']);
    expect(rows.map((r) => r.user_id)).toEqual(before);
  });
});
