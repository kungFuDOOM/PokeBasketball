// Messages and shapes shared by the game client and the Pack Battles server.

import type { PackTier } from '../battles/service';
import type { Snapshot, WireInput } from '../game/sync';

/** USDC has 6 decimals; every server amount is an integer number of these base units. */
export const USDC_DECIMALS = 6;
export const MICRO = 10 ** USDC_DECIMALS;
/** Display a base-unit amount as dollars, e.g. 12500000 -> "$12.50". */
export const usd = (micro: number) => {
  const d = micro / MICRO;
  return `$${d.toFixed(Number.isInteger(d) ? 0 : 2)}`;
};

export interface PublicConfig {
  cluster: 'mainnet-beta' | 'devnet';
  usdcMint: string;
  /** Where players send USDC deposits from their own wallet. */
  houseWallet: string;
  houseUsdcAccount: string;
  restrictedRegions: string[];
  minDeposit: number;
  tiers: { tier: PackTier; price: number; entry: number }[];
  pickSeconds: number;
}

export interface Me {
  wallet: string;
  teamName: string;
  balance: number;
  eligibility: { adult: boolean; region: string } | null;
  blocked: string | null;
}

export type BattleState = 'open' | 'ready' | 'drafting' | 'playing' | 'done' | 'cancelled' | 'void';

export interface PlayerRef {
  wallet: string;
  teamName: string;
}

export interface BattleView {
  id: string;
  tier: PackTier;
  quarterLen: number;
  state: BattleState;
  host: PlayerRef;
  guest: PlayerRef | null;
  /** 0 = host, 1 = guest; set once a game finishes (or someone forfeits). */
  winner: 0 | 1 | null;
  score: [number, number] | null;
  forfeit: boolean;
  /** sha256 of the server seed, published before anyone plays. */
  commit: string;
  createdAt: number;
  /** Your side in this battle, when you're in it. */
  side: 0 | 1 | null;
}

export type PrizeState = 'pending' | 'sending' | 'sent' | 'failed';

export interface PrizeView {
  id: string;
  battleId: string;
  tier: PackTier;
  state: PrizeState;
  mode: 'gift' | 'open' | null;
  memo: string | null;
  rarity: string | null;
  nftAddress: string | null;
  createdAt: number;
}

export interface DepositView {
  signature: string;
  amount: number;
  createdAt: number;
}

export interface WithdrawalView {
  id: string;
  amount: number;
  address: string;
  state: 'requested' | 'sent' | 'rejected';
  signature: string | null;
  createdAt: number;
}

/** Everything needed to replay a finished battle and check the result. */
export interface Proof {
  battleId: string;
  commit: string;
  serverSeed: string;
  hostSeed: string;
  guestSeed: string;
  seed: number;
  start: MatchStart;
  /** One [host, guest] input pair per tick. */
  inputs: [WireInput, WireInput][];
  score: [number, number];
  winner: 0 | 1;
  forfeit: boolean;
}

export interface TeamSpec {
  name: string;
  abbr: string;
  color: string;
  color2: string;
  roster: number[];
}

export interface MatchStart {
  seed: number;
  quarterLen: number;
  home: TeamSpec;
  away: TeamSpec;
}

export interface DraftView {
  /** Team index (0 host, 1 guest) for each pick, in order. */
  order: (0 | 1)[];
  picks: number[];
  /** ms epoch when the current pick auto-picks. */
  deadline: number;
  teamNames: [string, string];
}

/** Server -> client. */
export type ServerMsg =
  | { t: 'hello'; side: 0 | 1; battle: BattleView }
  | { t: 'wait'; who: (0 | 1)[] }
  | { t: 'draft'; draft: DraftView }
  | { t: 'start'; start: MatchStart; tick: number; snap: Snapshot | null }
  | { t: 'ticks'; from: number; inputs: [WireInput, WireInput][] }
  | { t: 'hash'; tick: number; h: number }
  | { t: 'snap'; tick: number; snap: Snapshot }
  | { t: 'presence'; connected: [boolean, boolean]; forfeitAt: number | null }
  | { t: 'final'; battle: BattleView }
  | { t: 'error'; message: string };

/** Client -> server. */
export type ClientMsg =
  | { t: 'pick'; dex: number }
  | { t: 'in'; mx: number; my: number; b: number }
  | { t: 'resync' }
  | { t: 'ready' };
