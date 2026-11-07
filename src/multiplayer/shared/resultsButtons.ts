// The buttons under an online match's box score. Ranked has no rematch: the same two players are not paired
// again straight away (the server never pairs a player with their last Ranked opponent within 1 hour, see the last_opp skip in migration 20261207), so the primary button starts a fresh search.
export type ResultsButton = { id: string; label: string; kind?: 'primary' | 'ghost' };

export const FIND_RANKED_LABEL = 'FIND RANKED OPPONENT';

export function onlineResultsButtons(queue: 'social' | 'ranked' | 'pack'): ResultsButton[] {
  const first: ResultsButton = queue === 'ranked'
    ? { id: 'find-ranked', label: FIND_RANKED_LABEL, kind: 'primary' }
    : { id: 'again', label: 'Play again', kind: 'primary' };
  return [first, { id: 'hub', label: 'Back', kind: 'ghost' }, { id: 'report', label: 'Report or block', kind: 'ghost' }];
}
