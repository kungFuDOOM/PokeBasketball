// Ranked rating store on this device (localStorage key pokejam.rank). Phase 2 moves this server-side.
import type { RatingStore } from '../shared/matchService';
import { applyResult, newRank, type MatchOutcome, type RankState } from './rank';

export const RANK_KEY = 'pokejam.rank';
type Store = Pick<Storage, 'getItem' | 'setItem'> | null;

export class LocalRankStore implements RatingStore<MatchOutcome> {
  constructor(private store: Store = typeof localStorage === 'undefined' ? null : localStorage) {}
  get(): RankState {
    try {
      const raw = this.store?.getItem(RANK_KEY);
      if (raw) return { ...newRank(), ...JSON.parse(raw) };
    } catch { /* corrupt or unavailable storage: start fresh */ }
    return newRank();
  }
  mmr() { return this.get().mmr; }
  apply(oppMmr: number, won: boolean): MatchOutcome {
    const o = applyResult(this.get(), oppMmr, won);
    try { this.store?.setItem(RANK_KEY, JSON.stringify(o.state)); } catch { /* storage unavailable */ }
    return o;
  }
}
