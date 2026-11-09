// 3-Point Contest data model. Pure types and constants: no DOM, no canvas.
import type { Mon } from '../data/pokemon';

export const RACKS = 5;
export const BALLS_PER_RACK = 5;
export const TOTAL_BALLS = RACKS * BALLS_PER_RACK;
export const CONTEST_SECONDS = 60;
/** 4 normal racks x 6 + one all-money rack x 10. */
export const MAX_SCORE = 34;

export type RackId = 0 | 1 | 2 | 3 | 4;
export type ShotResult = 'make' | 'miss';
export type Phase = 'ready' | 'live' | 'paused' | 'done';

/** A rack spot on the home (right) hoop's arc. Court feet: x 0..94, y 0..50. */
export interface Spot {
  rack: RackId;
  label: string;
  x: number;
  y: number;
}

export interface BallResult {
  rack: RackId;
  index: number; // 0..4
  money: boolean;
  result: ShotResult;
  points: number;
}

export interface ContestState {
  shooter: Mon;
  moneyRack: RackId;
  phase: Phase;
  /** Seconds left; starts at CONTEST_SECONDS, only runs while 'live'. */
  timeLeft: number;
  /** Next ball to shoot, 0..TOTAL_BALLS. */
  ballIndex: number;
  results: BallResult[];
  /**
   * A shot released while 'live' that has not landed yet. It still counts if the buzzer sounds while it is in
   * the air: recordShot accepts exactly that one shot after the phase has become 'done'.
   */
  inFlight: boolean;
}

export interface ContestSummary {
  score: number;
  makes: number;
  attempts: number;
  moneyMakes: number;
  timeLeft: number;
  finishedEarly: boolean;
}

/** Hook for the future Kabuto King bonus. Normal sorting for now: this returns null. */
export type FeaturedShooter = { dex: number; badge: string } | null;
