import type { CourtStyle } from '../data/courts';
import type { Mon, Ratings } from '../data/pokemon';

export type TeamId = 0 | 1;

// Court is measured in feet. x runs baseline to baseline (0..94), y runs far sideline to near sideline (0..50), z is height.
export const COURT_L = 94;
export const COURT_W = 50;
export const HOOP_Y = 25;
export const RIM_Z = 10;
export const RIM_R = 0.75;
export const GRAVITY = 32;
export const BALL_R = 0.45;

/** Team 0 (home) attacks the right hoop, team 1 attacks the left. */
export function hoopX(attacking: TeamId): number {
  return attacking === 0 ? 88.75 : 5.25;
}
/** Unit x-direction pointing from a team's attacking hoop back toward half court. */
export function backDir(attacking: TeamId): number {
  return attacking === 0 ? -1 : 1;
}

export function isThree(x: number, y: number, attacking: TeamId): boolean {
  const dx = x - hoopX(attacking);
  const dy = y - HOOP_Y;
  const d = Math.hypot(dx, dy);
  if (Math.abs(dy) >= 22 && Math.abs(dx) < 9) return true;
  return d >= 23.75;
}

export type Difficulty = 'rookie' | 'pro' | 'allstar' | 'legend';

export const DIFFICULTIES: Record<Difficulty, {
  label: string;
  cpuBoost: number; // added to every CPU rating
  green: number; // multiplier on the user's perfect-release window
  aggro: number; // CPU steal / shove frequency
  react: number; // CPU block reaction delay, seconds
  cpuShot: number; // lowers CPU release noise
  contest: number; // how much defenders bother the user's jumpers (1 = full)
  assist: boolean; // user's player keeps guarding their man while the stick is idle
  catchup: number; // how much the CPU eases off when it builds a big lead (0 = never)
}> = {
  rookie: { label: 'Rookie', cpuBoost: -14, green: 1.9, aggro: 0.3, react: 0.5, cpuShot: -0.1, contest: 0.5, assist: true, catchup: 1 },
  pro: { label: 'Pro', cpuBoost: -5, green: 1.35, aggro: 0.6, react: 0.3, cpuShot: -0.04, contest: 0.8, assist: true, catchup: 0.5 },
  allstar: { label: 'All-Star', cpuBoost: 0, green: 1.1, aggro: 0.9, react: 0.2, cpuShot: 0, contest: 0.9, assist: false, catchup: 0 },
  legend: { label: 'Legend', cpuBoost: 4, green: 0.85, aggro: 1.15, react: 0.12, cpuShot: 0.03, contest: 1, assist: false, catchup: 0 },
};

export interface TeamDef {
  name: string;
  abbr: string;
  color: string;
  color2: string;
  roster: Mon[]; // the five starters, any order
  /** Franchise reserves; empty or missing means no subs. */
  bench?: Mon[];
  human: boolean;
  /** Added to every rating (franchise gyms and the Elite Four). */
  boost?: number;
  /** Shown in the pre-game intro, e.g. "BROCK wants to ball!" */
  coach?: string;
}

export interface GameConfig {
  home: TeamDef;
  away: TeamDef;
  quarterLen: number; // seconds
  difficulty: Difficulty;
  /** Whose floor the game is on; defaults to a classic court in the home team's colors. */
  court?: CourtStyle;
  /** Franchise rule: players tire, play worse when tired, and get subbed. Off in Quick Play. */
  stamina?: boolean;
  /** false: the coach never subs the human team; the user does it from the pause menu. */
  userAutoSubs?: boolean;
  /** On defense, switch the user to the defender guarding whoever catches the ball (default on). */
  autoSwitch?: boolean;
  /** Franchise rule: hard knockdowns and big landings can injure, more often when tired. */
  injuries?: boolean;
  /** The luck source for every roll in the game (default: a stream from `seed`, or Math.random when neither is given). */
  rng?: () => number;
  /** Seeds the game's random stream; the same seed and inputs replay the same game. */
  seed?: number;
}

export interface Intent {
  mx: number;
  my: number;
  turbo: boolean;
  shoot: boolean; // pressed this frame
  shootHeld: boolean;
  pass: boolean;
  steal: boolean;
  special: boolean;
  swap: boolean;
  passTo?: Player; // AI only
}

export function emptyIntent(): Intent {
  return { mx: 0, my: 0, turbo: false, shoot: false, shootHeld: false, pass: false, steal: false, special: false, swap: false };
}

export interface PStats {
  pts: number; fgm: number; fga: number; tpm: number; tpa: number;
  reb: number; ast: number; stl: number; blk: number; dnk: number;
  /** Seconds of game clock on the court. */
  sec: number;
  /** Games started. */
  gs: number;
}

export type PState = 'free' | 'shoot' | 'layup' | 'dunk' | 'hang' | 'stun' | 'swipe';

export interface DunkPath {
  x0: number; y0: number; z0: number;
  x1: number; y1: number;
  t: number; T: number; peak: number;
  spin: boolean;
  make: boolean;
  oop: boolean;
  tested: Set<number>;
}

export interface AIState {
  think: number;
  tx: number; ty: number;
  jitterT: number; jx: number; jy: number;
  cutT: number;
  jumpIn: number; // pending reaction jump countdown, -1 for none
  plan: 'drive' | 'hold' | 'shoot' | 'jumper' | 'pass' | 'none';
  planT: number;
  dodge: number;
  pullUp: boolean; // ball handler plans to stop at the arc and shoot
  /** Decisions made so far (feeds Game.mix). */
  n: number;
  /** Building urge to reach for the ball; fires a steal attempt at a threshold. */
  reach: number;
}

export interface Player {
  id: number;
  team: TeamId;
  slot: number; // 0 PG … 4 C, used for matchups and floor spots
  mon: Mon;
  r: Ratings;
  size: number;
  heightFt: number;
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  facing: 1 | -1;
  back: boolean;
  runPhase: number;
  state: PState;
  stateT: number;
  turbo: number;
  turboOn: boolean;
  special: number;
  fire: boolean;
  fireMakes: number;
  streak: number;
  stealCd: number;
  meter: number; // shot meter 0..1.25
  releaseAt: number; // AI shot release target
  dunk: DunkPath | null;
  fx: { surge: number; phase: number; slow: number; lockin: boolean };
  stats: PStats;
  ai: AIState;
  intent: Intent;
  human: boolean; // currently driven by the user
  lastCatch: number; // game time of last catch, for assists
  lastPasser: Player | null;
  /** 1 = fresh, 0 = gassed. Only drains when the game uses stamina. */
  energy: number;
  /** 40-99: how slowly energy drains. */
  stamina: number;
  starter: boolean;
  /** Depth chart position: 0-4 starters, 5+ bench in the order the coach should use them. */
  rotation: number;
  /** Weeks out if hurt in this game; 0 = healthy. */
  hurt: number;
}

export type BallMode = 'held' | 'pass' | 'shot' | 'loose' | 'net';

export interface ShotInfo {
  shooter: Player;
  make: boolean;
  airball: boolean;
  points: 2 | 3;
  t: number; T: number;
  x0: number; y0: number; z0: number;
  tx: number; ty: number; tz: number;
  vx: number; vy: number; vz: number;
  tested: Set<number>;
  kind: 'jump' | 'layup';
  /** How far the release missed the ideal, in green windows (negative = early). */
  off: number;
}

export interface PassInfo {
  from: Player;
  to: Player;
  oop: boolean;
  t: number;
  speed: number;
  z0: number;
  dist0: number;
  /** Each defender's own reach jitter for this pass, drawn the first time the ball gets near them. */
  jit?: Map<number, number>;
}

export interface Ball {
  x: number; y: number; z: number;
  vx: number; vy: number; vz: number;
  mode: BallMode;
  owner: Player | null;
  shot: ShotInfo | null;
  pass: PassInfo | null;
  fromShot: TeamId | -1; // a miss is live; the team that shot it, for off/def rebound
  lastTouch: TeamId;
  noPickup: number; // seconds during which nobody can grab
  spin: number;
}

export type Grade = 'perfect' | 'good' | 'early' | 'late' | 'very-early' | 'very-late' | 'layup' | 'dunk';

export type GameEvent =
  | { kind: 'score'; player: Player; points: number; how: 'jump' | 'layup' | 'dunk' }
  | { kind: 'miss'; player: Player; airball: boolean }
  | { kind: 'release'; player: Player; grade: Grade }
  | { kind: 'block'; player: Player; victim: Player }
  | { kind: 'steal'; player: Player; victim: Player }
  | { kind: 'shove'; player: Player; victim: Player; mult: number; ok: boolean }
  | { kind: 'special'; player: Player; hits: { victim: Player; mult: number }[] }
  | { kind: 'fire'; player: Player; on: boolean }
  | { kind: 'oop'; player: Player }
  | { kind: 'sub'; out: Player; in: Player }
  | { kind: 'subQueued'; out: Player; in: Player }
  | { kind: 'injury'; player: Player; weeks: number }
  | { kind: 'shotclock'; team: TeamId }
  | { kind: 'jumpball'; winner: Player; loser: Player }
  | { kind: 'buzzerbeater'; player: Player; points: number }
  | { kind: 'quarter'; label: string; sub: string }
  | { kind: 'final' };

export const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const dist = (ax: number, ay: number, bx: number, by: number) => Math.hypot(ax - bx, ay - by);

/** A small seedable stream (mulberry32): the same seed always gives the same sequence in [0, 1). */
export function seededRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The production stream: the platform's Math.random. Gameplay only ever calls the stream a Game was given. */
export const platformRng = (): number => Math.random();
