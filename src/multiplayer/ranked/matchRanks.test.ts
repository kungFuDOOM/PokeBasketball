import { describe, expect, it } from 'vitest';
import { renderRankBadge } from '../../ranked/badge';
import { parseMatchRanks } from './serverRank';

const wire = {
  host: { status: 'ranked', placements_played: 5, placements_total: 5, div_idx: 7, tier: 'Gold', division: 2 },
  guest: { status: 'placing', placements_played: 2, placements_total: 5 },
};

describe('pokejam_match_ranks mapping', () => {
  it('picks my side and the opponent side', () => {
    expect(parseMatchRanks(wire, 0)).toEqual({ me: { divIdx: 7 }, opp: { placing: 2, of: 5 } });
    expect(parseMatchRanks(wire, 1)).toEqual({ me: { placing: 2, of: 5 }, opp: { divIdx: 7 } });
  });
  it('an opponent with no rank row is Unranked (null), not missing', () => {
    expect(parseMatchRanks({ host: wire.host, guest: { status: 'unranked' } }, 0).opp).toBeNull();
  });
  it('Zenith maps to its division index', () => {
    expect(parseMatchRanks({ host: { status: 'ranked', div_idx: 24 }, guest: { status: 'unranked' } }, 1).opp).toEqual({ divIdx: 24 });
  });
  it('anything unusable leaves the side out, so no badge is drawn', () => {
    for (const bad of [null, undefined, 'x', 5, [], {}, { host: null, guest: 3 }]) expect(parseMatchRanks(bad, 0)).toEqual({});
    expect(parseMatchRanks({ host: { status: 'ranked', div_idx: 99 }, guest: { status: 'ranked' } }, 0)).toEqual({});
  });
  it('clamps placement counts and tolerates numbers sent as strings', () => {
    expect(parseMatchRanks({ host: { status: 'placing', placements_played: '9', placements_total: '5' }, guest: { status: 'ranked', div_idx: '3' } }, 1))
      .toEqual({ me: { divIdx: 3 }, opp: { placing: 5, of: 5 } });
  });
  it('renders as badges: tier art, Placement x/y, Unranked', () => {
    const r = parseMatchRanks(wire, 1);
    expect(renderRankBadge(r.opp!)).toContain('Gold 2');
    expect(renderRankBadge(r.me!)).toContain('Placement 2/5');
    expect(renderRankBadge(parseMatchRanks({ host: { status: 'unranked' }, guest: wire.guest }, 1).opp!)).toContain('Unranked');
  });
});
