// What the Pack Battles screens need from a backend. HttpBackend (net/http.ts) talks to the real server;
// LocalBackend (battles/local.ts) is the offline preview.

import type { BattleView, Me, PrizeView, PublicConfig } from '../net/protocol';
import type { PackTier } from './service';

export interface Backend {
  /** True for the real server: online draft and games, real money. */
  readonly online: boolean;
  config(): Promise<PublicConfig>;
  /** Null when signed out. */
  me(): Promise<Me | null>;
  open(): Promise<BattleView[]>;
  mine(): Promise<BattleView[]>;
  prizes(): Promise<PrizeView[]>;
  setEligibility(adult: boolean, region: string): Promise<Me>;
  setTeamName(name: string): Promise<Me>;
  create(tier: PackTier, quarterLen: number): Promise<BattleView>;
  accept(id: string): Promise<BattleView>;
  cancel(id: string): Promise<void>;
}

export class ApiError extends Error {
  constructor(message: string, readonly status = 0) {
    super(message);
  }
}
