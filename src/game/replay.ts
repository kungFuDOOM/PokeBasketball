// Play of the Game: an instant replay of the best moment, shown after the final buzzer.
//
// The engine is deterministic (seeded RNG, fixed 60 Hz tick), so a replay is just the starting state plus the
// player's inputs. While the game is played, the recorder keeps every tick's input (quantized the same way online
// play does, so the live game and its replay see identical numbers), a snapshot every 2 seconds, a state hash
// every half second, the player's substitution requests, and every moment worth replaying. At the end it rebuilds
// the best one from the nearest snapshot and checks the rebuilt game against the live hashes on the way: if
// anything differs, there's no replay rather than a wrong one.
import { Game } from './game';
import { TICK, packInput, restore, snapshot, stateHash, unpackInput, type Snapshot, type WireInput } from './sync';
import type { GameConfig, GameEvent, Intent, Player, TeamId } from './types';

const SNAP_EVERY = 120;
const HASH_EVERY = 30;
/** The clip starts this long before the moment (the steal, the break, the pass) and runs this long after. */
export const LEAD_IN = 4.5;
export const FOLLOW = 2;

export type HighlightKind = 'dunk' | 'oop' | 'three' | 'buzzer' | 'block' | 'steal' | 'fire' | 'special';

export interface Highlight {
  kind: HighlightKind;
  /** The tick the moment happened on (after it was simulated). */
  tick: number;
  team: TeamId;
  playerId: number;
  name: string;
  /** e.g. "SLAM DUNK", "GAME WINNER · FROM DOWNTOWN". */
  title: string;
  /** How good it was (picks the play). */
  value: number;
}

interface Candidate extends Highlight {
  /** Score after the play. */
  score: [number, number];
  late: boolean;
}

const TITLES: Record<HighlightKind, string> = {
  dunk: 'SLAM DUNK', oop: 'ALLEY-OOP SLAM', three: 'FROM DOWNTOWN', buzzer: 'BUZZER BEATER', block: 'REJECTED',
  steal: 'PICKPOCKET', fire: 'ON FIRE', special: 'SUPER EFFECTIVE',
};
const BASE: Record<HighlightKind, number> = { buzzer: 90, oop: 55, fire: 38, dunk: 32, three: 28, block: 26, special: 22, steal: 14 };

/** What the replay needs to step one tick the way the live game did. */
interface TickLog { input: WireInput; subs: [number, number][]; autoSubs?: boolean }

export class ReplayRecorder {
  /** Ticks simulated so far. */
  tick = 0;
  private log: TickLog[] = [];
  /** Snapshots, with the auto-subs setting at the time (it lives on the config, which snapshots leave out). */
  private snaps = new Map<number, { s: Snapshot; autoSubs: boolean | undefined }>();
  private hashes = new Map<number, number>();
  private candidates: Candidate[] = [];
  private lastOop = new Map<number, number>();
  private pendingSubs: [number, number][] = [];
  private pendingAuto: boolean | undefined;
  /** Who leads (0, 1, or null when level) and the last tick the lead changed hands. */
  private leader: TeamId | null = null;
  private lastLeadChange = -1;

  constructor(private cfg: GameConfig, private seed: number) {}

  /** Call before each tick with the player's input; returns the input to give the game (quantized). */
  before(g: Game, intent: Intent): Intent {
    if (this.tick % SNAP_EVERY === 0) this.snaps.set(this.tick, { s: snapshot(g), autoSubs: g.cfg.userAutoSubs });
    const w = packInput(intent);
    this.log[this.tick] = { input: w, subs: this.pendingSubs.splice(0), autoSubs: this.pendingAuto };
    this.pendingAuto = undefined;
    return unpackInput(w);
  }

  /** The player asked for a sub (it takes effect inside the next tick, as it does live). */
  sub(out: Player, inn: Player) {
    this.pendingSubs.push([out.id, inn.id]);
  }

  /** The player turned auto subs on or off. */
  autoSubs(on: boolean) {
    this.pendingAuto = on;
  }

  /** Call after each tick with the events it produced. */
  after(g: Game, events: GameEvent[]) {
    this.tick++;
    if (this.tick % HASH_EVERY === 0) this.hashes.set(this.tick, stateHash(g));
    const leader: TeamId | null = g.score[0] === g.score[1] ? null : g.score[0] > g.score[1] ? 0 : 1;
    if (leader !== this.leader && leader !== null) this.lastLeadChange = this.tick;
    this.leader = leader;
    for (const e of events) this.consider(g, e);
  }

  private consider(g: Game, e: GameEvent) {
    const add = (kind: HighlightKind, p: Player, extra = 0) => {
      const late = g.quarter >= 4 && g.clock <= 30;
      this.candidates.push({
        kind, tick: this.tick, team: p.team, playerId: p.id, name: p.mon.name.toUpperCase(), title: TITLES[kind],
        value: BASE[kind] + extra, score: [g.score[0], g.score[1]], late,
      });
    };
    if (e.kind === 'oop') this.lastOop.set(e.player.id, this.tick);
    else if (e.kind === 'score') {
      const oop = e.how === 'dunk' && this.tick - (this.lastOop.get(e.player.id) ?? -1e9) < 90;
      if (oop) add('oop', e.player, e.player.fire ? 8 : 0);
      else if (e.how === 'dunk') add('dunk', e.player, e.player.fire ? 8 : 0);
      else if (e.points === 3) add('three', e.player, e.player.fire ? 8 : 0);
    } else if (e.kind === 'buzzerbeater') {
      // Replaces the plain basket it came with.
      const i = this.candidates.findIndex((c) => c.tick === this.tick && c.playerId === e.player.id);
      if (i >= 0) this.candidates.splice(i, 1);
      add('buzzer', e.player, e.points === 3 ? 10 : 0);
    } else if (e.kind === 'block') add('block', e.player);
    else if (e.kind === 'steal') add('steal', e.player);
    else if (e.kind === 'fire' && e.on) add('fire', e.player);
    else if (e.kind === 'special' && e.hits.some((h) => h.mult >= 2)) add('special', e.player, 4 * e.hits.length);
  }

  /** The play of the game, once it's over: the best moment, favouring the player's own team and late drama. */
  best(g: Game): Highlight | null {
    const winner: TeamId | null = g.score[0] === g.score[1] ? null : g.score[0] > g.score[1] ? 0 : 1;
    const human = ([0, 1] as TeamId[]).find((t) => g.isHumanTeam(t));
    // The game winner: the basket that put the winners ahead for good, in the last 30 seconds.
    const isWinner = (c: Candidate) => c.late && c.team === winner && c.tick === this.lastLeadChange
      && c.kind !== 'block' && c.kind !== 'steal' && c.kind !== 'fire';
    let best: Candidate | null = null;
    let bestValue = -1;
    for (const c of this.candidates) {
      if (c.tick < LEAD_IN / TICK * 0.4) continue; // nothing to show before it
      let v = c.value;
      if (isWinner(c)) v += 45;
      else if (c.late) v += 12;
      if (human !== undefined && c.team === human) v *= 1.5;
      if (v > bestValue || (v === bestValue && best && c.tick > best.tick)) { best = c; bestValue = v; }
    }
    if (!best) return null;
    return { ...best, value: bestValue, title: isWinner(best) ? `GAME WINNER · ${best.title}` : best.title };
  }

  /**
   * Rebuild the clip around a highlight: a fresh game from the nearest snapshot, stepped silently to the clip's
   * start and checked against the live game's hashes. Null if it can't be rebuilt exactly.
   */
  clip(h: Highlight): ReplayClip | null {
    const start = Math.max(0, h.tick - Math.round(LEAD_IN / TICK));
    const end = Math.min(this.tick, h.tick + Math.round(FOLLOW / TICK));
    const from = Math.floor(start / SNAP_EVERY) * SNAP_EVERY;
    const snap = this.snaps.get(from);
    if (!snap) return null;
    try {
      const g = new Game({ ...this.cfg, seed: this.seed, userAutoSubs: snap.autoSubs });
      restore(g, JSON.parse(JSON.stringify(snap.s)) as Snapshot);
      const clip = new ReplayClip(g, this.log, this.hashes, from, start, h.tick, end);
      while (clip.tick < start) clip.step();
      g.events.length = 0;
      g.sfx.length = 0;
      return clip.ok ? clip : null;
    } catch {
      return null;
    }
  }
}

/** A rebuilt stretch of the game, stepped one tick at a time with the recorded inputs. */
export class ReplayClip {
  /** False once the rebuilt game differs from what was played. */
  ok = true;

  constructor(readonly game: Game, private log: TickLog[], private hashes: Map<number, number>,
    public tick: number, readonly start: number, readonly moment: number, readonly end: number) {}

  get done(): boolean {
    return this.tick >= this.end || !this.ok;
  }

  /** One tick, exactly as it went live. Events and sounds are left on the game for the caller. */
  step() {
    const g = this.game;
    const entry = this.log[this.tick];
    if (!entry) { this.ok = false; return; }
    if (entry.autoSubs !== undefined) g.cfg.userAutoSubs = entry.autoSubs;
    for (const [outId, inId] of entry.subs) {
      const all = [...g.players, ...g.bench];
      const out = all.find((p) => p.id === outId);
      const inn = all.find((p) => p.id === inId);
      if (out && inn) g.requestSub(out, inn);
    }
    g.userInput = unpackInput(entry.input);
    g.update(TICK);
    this.tick++;
    const want = this.hashes.get(this.tick);
    if (want !== undefined && want !== stateHash(g)) this.ok = false;
  }
}
