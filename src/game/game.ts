import { POSITIONS, bestEffectiveness, effectiveness, type Mon } from '../data/pokemon';
import { think } from './ai';
import {
  BALL_R, COURT_L, COURT_W, DIFFICULTIES, GRAVITY, HOOP_Y, RIM_R, RIM_Z,
  backDir, clamp, dist, emptyIntent, hoopX, isThree, lerp, rand, randn,
  type Ball, type GameConfig, type GameEvent, type Grade, type Intent, type Player, type TeamDef, type TeamId,
} from './types';

/** Meter value (0..1 fill) at which a jump shot is released perfectly. */
export const IDEAL_RELEASE = 0.8;
/** Seconds for the shot meter to fill from empty to full. */
const METER_TIME = 0.62;

export type Phase = 'tip' | 'live' | 'dead' | 'break' | 'final';
export type Sfx = 'dribble' | 'swish' | 'rim' | 'dunk' | 'buzzer' | 'block' | 'steal' | 'shove' | 'pass' | 'fire' | 'special' | 'catch' | 'bounce' | 'shot' | 'whistle';

/** +2 to every rating when the five starters cover all five positions. */
export function chemistry(roster: Mon[]): number {
  return new Set(roster.map((m) => m.pos)).size === 5 ? 2 : 0;
}

export function teamOvr(roster: Mon[]): number {
  if (!roster.length) return 0;
  return Math.round(roster.reduce((a, m) => a + m.ovr, 0) / roster.length) + chemistry(roster);
}

/** Stamina from the HP-heavy ratings: Snorlax and Blissey run all day, Pikachu needs breathers. */
export function staminaOf(mon: Mon): number {
  return clamp(Math.round(35 + mon.r.reb * 0.45 + mon.r.def * 0.15), 40, 99);
}

/**
 * Starting five for a roster: the best Pokémon at each position, unless that would start someone
 * far worse than the best available; then the rest by overall. Everyone else is the bench.
 */
export function bestLineup(mons: Mon[]): { starters: Mon[]; bench: Mon[] } {
  if (mons.length <= 5) return { starters: [...mons], bench: [] };
  const left = [...mons].sort((a, b) => b.ovr - a.ovr);
  const starters: Mon[] = [];
  for (const pos of POSITIONS) {
    const i = left.findIndex((m) => m.pos === pos);
    if (i >= 0 && left[i].ovr >= left[0].ovr - 8) starters.push(...left.splice(i, 1));
  }
  while (starters.length < 5) starters.push(left.shift()!);
  return { starters, bench: left };
}

function makePlayer(id: number, team: TeamId, slot: number, mon: Mon, boost: number): Player {
  const r = { ...mon.r };
  for (const k of Object.keys(r) as (keyof typeof r)[]) r[k] = clamp(r[k] + boost, 20, 99);
  return {
    id, team, slot, mon, r,
    size: mon.size,
    heightFt: 2.8 + mon.size * 1.7,
    x: 0, y: 0, z: 0, vx: 0, vy: 0, vz: 0,
    facing: team === 0 ? 1 : -1,
    back: false,
    runPhase: Math.random() * 6,
    state: 'free', stateT: 0,
    turbo: 1, turboOn: false,
    special: 0.2,
    fire: false, fireMakes: 0, streak: 0,
    stealCd: 0,
    meter: 0, releaseAt: IDEAL_RELEASE,
    dunk: null,
    fx: { surge: 0, phase: 0, slow: 0, lockin: false },
    stats: { pts: 0, fgm: 0, fga: 0, tpm: 0, tpa: 0, reb: 0, ast: 0, stl: 0, blk: 0, dnk: 0, sec: 0, gs: slot >= 0 ? 1 : 0 },
    ai: { think: 0, tx: 0, ty: 0, jitterT: 0, jx: 0, jy: 0, cutT: 0, jumpIn: -1, plan: 'none', planT: 0, dodge: 1, pullUp: false },
    intent: emptyIntent(),
    human: false,
    lastCatch: -9,
    lastPasser: null,
    energy: 1,
    stamina: staminaOf(mon),
    starter: slot >= 0,
    rotation: slot,
    hurt: 0,
  };
}

export class Game {
  readonly cfg: GameConfig;
  readonly teams: [TeamDef, TeamDef];
  readonly diff: (typeof DIFFICULTIES)[keyof typeof DIFFICULTIES];
  /** The ten Pokémon on the floor. */
  players: Player[] = [];
  /** Franchise reserves, not on the floor. */
  bench: Player[] = [];
  /** Subs the user asked for; they check in at the next dead ball. */
  pendingSubs: { out: Player; in: Player }[] = [];
  ball: Ball;
  score: [number, number] = [0, 0];
  offense: TeamId = 0;
  quarter = 1;
  clock: number;
  shotClock = 24;
  phase: Phase = 'tip';
  phaseT = 0;
  time = 0;
  user: Player | null = null;
  userInput: Intent = emptyIntent();
  events: GameEvent[] = [];
  sfx: Sfx[] = [];
  shake = 0;
  rimShake: [number, number] = [0, 0];
  netT: [number, number] = [0, 0];
  paused = false;
  private firstPossession: TeamId;
  private dribblePh = 0;

  constructor(cfg: GameConfig) {
    this.cfg = cfg;
    this.teams = [cfg.home, cfg.away];
    this.diff = DIFFICULTIES[cfg.difficulty];
    let id = 0;
    for (const t of [0, 1] as TeamId[]) {
      const def = this.teams[t];
      const roster = [...def.roster].sort((a, b) => POSITIONS.indexOf(a.pos) - POSITIONS.indexOf(b.pos));
      const cpuBoost = !def.human && cfg.home.human ? this.diff.cpuBoost : 0;
      const boost = chemistry(def.roster) + cpuBoost + (def.boost ?? 0);
      roster.forEach((mon, slot) => this.players.push(makePlayer(id++, t, slot, mon, boost)));
      (def.bench ?? []).forEach((mon, i) => {
        const p = makePlayer(id++, t, -1, mon, boost);
        p.rotation = 5 + i;
        this.bench.push(p);
      });
    }
    this.clock = cfg.quarterLen;
    this.firstPossession = Math.random() < 0.5 ? 0 : 1;
    this.ball = {
      x: 47, y: 25, z: 4, vx: 0, vy: 0, vz: 0,
      mode: 'loose', owner: null, shot: null, pass: null,
      fromShot: -1, lastTouch: 0, noPickup: 0, spin: 0,
    };
    this.startQuarter();
  }

  // ---------- queries used by AI, renderer and HUD ----------

  teamPlayers(t: TeamId): Player[] {
    return this.players.filter((p) => p.team === t);
  }
  /** Everyone dressed for a team: starters first, then the bench in the order they were listed. */
  rosterOf(t: TeamId): Player[] {
    return [...this.players, ...this.bench].filter((p) => p.team === t).sort((a, b) => a.id - b.id);
  }
  /** Tired players lose up to 18% of their speed and touch. */
  effort(p: Player): number {
    return p.energy >= 0.55 ? 1 : 0.82 + 0.18 * (p.energy / 0.55);
  }
  opponents(t: TeamId): Player[] {
    return this.players.filter((p) => p.team !== t);
  }
  distToHoop(p: Player): number {
    return dist(p.x, p.y, hoopX(p.team), HOOP_Y);
  }
  dunkRange(p: Player, turbo: boolean): number {
    let r = turbo ? 3 + p.r.ins * 0.09 : 4.2;
    if (p.fire) r += 4;
    return r;
  }
  /** Distance to the nearest opponent who is on their feet. */
  openness(p: Player): number {
    let best = 99;
    for (const q of this.players) {
      if (q.team === p.team || q.state === 'stun') continue;
      best = Math.min(best, dist(p.x, p.y, q.x, q.y));
    }
    return best;
  }
  greenWindow(p: Player): number {
    const userMult = p.human ? this.diff.green : 1;
    return (0.022 + (p.r.sht / 100) * 0.034) * userMult * (p.fire ? 1.7 : 1);
  }
  isHumanTeam(t: TeamId): boolean {
    return this.teams[t].human;
  }
  /** Block reaction delay for an AI defender. */
  reactTime(p: Player): number {
    const base = this.cfg.home.human && p.team === 1 ? this.diff.react : 0.2;
    return base + ((100 - p.r.def) / 100) * 0.25 + rand(0, 0.08);
  }
  aggro(p: Player): number {
    return this.cfg.home.human && p.team === 1 ? this.diff.aggro : 0.85;
  }

  // ---------- flow ----------

  private startQuarter() {
    const q = this.quarter;
    const start: TeamId = q > 4
      ? (Math.random() < 0.5 ? 0 : 1)
      : q === 1 || q === 4 ? this.firstPossession : ((1 - this.firstPossession) as TeamId);
    this.clock = q > 4 ? Math.max(30, Math.round(this.cfg.quarterLen / 2)) : this.cfg.quarterLen;
    this.shotClock = 24;
    if (this.cfg.stamina && q > 1) {
      const rest = q === 3 ? 0.3 : 0.15;
      for (const p of [...this.players, ...this.bench]) p.energy = Math.min(1, p.energy + rest);
      this.applyPendingSubs();
      this.autoSubs(0, true);
      this.autoSubs(1, true);
    }
    const offs = [[4, 25], [12, 9], [12, 41], [21, 17], [21, 33]];
    for (const p of this.players) {
      const [dx, y] = offs[p.slot];
      p.x = 47 + (p.team === 0 ? -dx : dx);
      p.y = y;
      p.z = 0; p.vx = 0; p.vy = 0; p.vz = 0;
      p.state = 'free'; p.stateT = 0; p.dunk = null; p.meter = 0;
      p.fx.slow = 0; p.fx.phase = 0; p.fx.surge = 0;
      p.facing = p.team === 0 ? 1 : -1;
      p.ai.jumpIn = -1; p.ai.plan = 'none';
    }
    this.offense = start;
    const pg = this.players.find((p) => p.team === start && p.slot === 0)!;
    this.giveBall(pg, true);
    this.phase = 'tip';
    this.phaseT = 1.8;
    this.updateUser(true);
    const label = q > 4 ? (q === 5 ? 'OVERTIME' : `${q - 4}OT`) : ['1ST', '2ND', '3RD', '4TH'][q - 1] + ' QUARTER';
    this.events.push({ kind: 'quarter', label, sub: `${this.teams[start].abbr} BALL` });
    this.sfx.push('whistle');
  }

  private endQuarter() {
    this.sfx.push('buzzer');
    const [a, b] = this.score;
    if (this.quarter >= 4 && a !== b) {
      this.phase = 'final';
      this.events.push({ kind: 'final' });
      return;
    }
    const label = this.quarter === 2 ? 'HALFTIME' : this.quarter >= 4 ? 'END OF REGULATION' : `END OF Q${this.quarter}`;
    const sub = this.quarter >= 4 ? 'TIED! GOING TO OVERTIME' : `${this.teams[0].abbr} ${a} - ${b} ${this.teams[1].abbr}`;
    this.events.push({ kind: 'quarter', label, sub });
    this.quarter++;
    this.phase = 'break';
    this.phaseT = 2.6;
  }

  private setOffense(t: TeamId, clock = 24) {
    const changed = t !== this.offense;
    this.offense = t;
    this.shotClock = clock;
    if (changed) this.updateUser(true);
  }

  private giveBall(p: Player, silent = false) {
    const b = this.ball;
    b.owner = p;
    b.mode = 'held';
    b.shot = null;
    b.pass = null;
    b.lastTouch = p.team;
    p.lastCatch = this.time;
    p.ai.think = Math.min(p.ai.think, rand(0.1, 0.3));
    if (p.team !== this.offense) this.setOffense(p.team);
    if (p.team === 1) this.autoSwitch(p);
    if (!silent) this.sfx.push('catch');
  }

  /** Picks the user's active player: the ball handler on offense, otherwise the current pick or a swap. */
  private updateUser(possessionChanged = false, swap = false) {
    if (!this.teams[0].human) return;
    const b = this.ball;
    let u = this.user;
    const ourBall = b.owner && b.owner.team === 0;
    if (ourBall) u = b.owner;
    else if (!u || possessionChanged || swap) {
      const exclude = swap && !possessionChanged ? u : null;
      let best: Player | null = null;
      let bd = Infinity;
      for (const p of this.teamPlayers(0)) {
        if (p === exclude) continue;
        const d = dist(p.x, p.y, b.x, b.y) + (p.state === 'stun' ? 20 : 0);
        if (d < bd) { bd = d; best = p; }
      }
      if (best) u = best;
    }
    for (const p of this.players) p.human = p === u;
    this.user = u;
  }

  /**
   * On defense, hands the user the defender who should pick up whoever just got the ball: his man-to-man
   * matchup if that defender is close enough to recover, otherwise the nearest one on his feet.
   * Leaves the user alone if they're already on the ball.
   */
  private autoSwitch(handler: Player) {
    if (!this.teams[0].human || this.cfg.autoSwitch === false) return;
    const u = this.user;
    const ok = (p: Player) => p.state !== 'stun';
    if (u && ok(u) && dist(u.x, u.y, handler.x, handler.y) < 6) return;
    const ours = this.teamPlayers(0).filter(ok);
    if (!ours.length) return;
    const d = (p: Player) => dist(p.x, p.y, handler.x, handler.y);
    const man = ours.find((p) => p.slot === handler.slot);
    const near = ours.reduce((a, b) => (d(b) < d(a) ? b : a));
    const pick = man && d(man) < d(near) + 8 ? man : near;
    if (pick === u) return;
    for (const p of this.players) p.human = p === pick;
    this.user = pick;
  }

  // ---------- main tick ----------

  update(dt: number) {
    if (this.paused || this.phase === 'final') return;
    this.time += dt;
    this.shake = Math.max(0, this.shake - dt * 2.5);
    for (const i of [0, 1]) {
      this.rimShake[i] = Math.max(0, this.rimShake[i] - dt * 3);
      this.netT[i] = Math.max(0, this.netT[i] - dt);
    }

    if (this.phase === 'break') {
      this.phaseT -= dt;
      if (this.phaseT <= 0) this.startQuarter();
      return;
    }
    if (this.phase === 'tip') {
      this.phaseT -= dt;
      this.updateBall(dt);
      if (this.phaseT <= 0) this.phase = 'live';
      return;
    }

    const b = this.ball;
    const live = this.phase === 'live';
    if (live) {
      this.clock -= dt;
      this.tickStamina(dt);
      const shotClockRuns = b.mode === 'held' || b.mode === 'pass' || (b.mode === 'loose' && b.fromShot === -1);
      if (shotClockRuns) this.shotClock -= dt;
    } else if (this.phase === 'dead') {
      this.phaseT -= dt;
      if (this.phaseT <= 0) this.inbound();
    }

    if (this.userInput.swap && !(b.owner && b.owner === this.user)) this.updateUser(false, true);
    else if (b.owner?.team === 0 && this.user !== b.owner) this.updateUser();

    for (const p of this.players) {
      p.intent = p.human ? this.userInput : think(this, p, dt);
    }
    for (const p of this.players) {
      if (this.phase === 'live') this.act(p, dt);
      this.movePlayer(p, dt);
    }
    this.separate();
    this.updateBall(dt);

    if (this.phase === 'live' || this.phase === 'dead') {
      const busy = b.mode === 'shot' || this.players.some((p) => p.state === 'dunk');
      if (this.clock <= 0 && !busy) {
        this.clock = 0;
        this.endQuarter();
        return;
      }
      if (this.clock < 0) this.clock = 0;
      if (live && this.shotClock <= 0 && !busy) this.shotClockViolation();
    }
  }

  private shotClockViolation() {
    const b = this.ball;
    this.events.push({ kind: 'shotclock', team: this.offense });
    this.sfx.push('buzzer');
    if (b.owner) {
      const o = b.owner;
      b.owner = null;
      b.mode = 'loose';
      b.vx = 0; b.vy = 0; b.vz = 3;
      b.x = o.x; b.y = o.y;
    }
    b.fromShot = -1;
    this.setOffense((1 - this.offense) as TeamId);
    this.phase = 'dead';
    this.phaseT = 1;
  }

  private inbound() {
    this.applyPendingSubs();
    this.autoSubs(0, false);
    this.autoSubs(1, false);
    const b = this.ball;
    let best: Player | null = null;
    let bd = Infinity;
    for (const p of this.teamPlayers(this.offense)) {
      if (p.state !== 'free') continue;
      const d = dist(p.x, p.y, b.x, b.y);
      if (d < bd) { bd = d; best = p; }
    }
    best ??= this.teamPlayers(this.offense)[0];
    this.phase = 'live';
    this.shotClock = 24;
    this.giveBall(best, true);
    this.updateUser(true);
  }

  // ---------- stamina and substitutions ----------

  private tickStamina(dt: number) {
    for (const p of this.players) p.stats.sec += dt;
    if (!this.cfg.stamina) return;
    // Scaled so tiredness follows game time the same way whatever the quarter length.
    const scale = 120 / this.cfg.quarterLen;
    for (const p of this.players) {
      const drain = 0.0044 * (1.6 - p.stamina / 100) + (p.turboOn ? 0.0022 : 0);
      p.energy = Math.max(0, p.energy - drain * scale * dt);
    }
    for (const p of this.bench) p.energy = Math.min(1, p.energy + 0.005 * scale * dt);
  }

  /**
   * The coach's rotation, run at dead balls and quarter breaks: tired players come out for the
   * freshest good fit on the bench, and rested starters come back in.
   */
  private autoSubs(t: TeamId, quarterBreak: boolean) {
    if (!this.cfg.stamina) return;
    const bench = () => this.bench.filter((p) => p.team === t && !p.hurt);
    if (!bench().length) return;
    // An injured player always comes out, even when the user runs the rotation.
    for (const hurt of this.teamPlayers(t).filter((p) => p.hurt && p !== this.ball.owner && p.state === 'free')) {
      const fill = bench().sort((a, b) => (b.mon.pos === hurt.mon.pos ? 6 : 0) + b.mon.ovr - b.rotation * 2 - ((a.mon.pos === hurt.mon.pos ? 6 : 0) + a.mon.ovr - a.rotation * 2))[0];
      if (fill) this.swap(hurt, fill);
    }
    if (t === 0 && this.teams[0].human && this.cfg.userAutoSubs === false) return;
    const onCourt = this.teamPlayers(t).sort((a, b) => a.energy - b.energy);
    let swaps = 0;
    for (const out of onCourt) {
      if (swaps >= (quarterBreak ? 5 : 2)) break;
      if (out === this.ball.owner || out.state !== 'free') continue;
      const tired = out.energy < (quarterBreak ? 0.6 : 0.5);
      let best: Player | null = null;
      let bs = -Infinity;
      for (const c of bench()) {
        const restedStarter = c.starter && !out.starter && c.energy >= 0.85;
        if (c.energy < 0.7 || !(tired || restedStarter)) continue;
        // Bench order matters: the coach goes to the 6th man before the 10th.
        const s = c.mon.ovr + (c.mon.pos === out.mon.pos ? 6 : 0) + c.energy * 10 + (restedStarter ? 8 : 0) - (c.rotation - 5) * 4;
        if (s > bs) { bs = s; best = c; }
      }
      if (best) {
        this.swap(out, best);
        swaps++;
      }
    }
  }

  /**
   * A sub the user called from the pause menu. It happens right away during a stoppage,
   * otherwise at the next dead ball. Returns false if the pair isn't valid.
   */
  requestSub(out: Player, sub: Player): boolean {
    if (out.team !== sub.team || !this.players.includes(out) || !this.bench.includes(sub) || sub.hurt) return false;
    this.pendingSubs = this.pendingSubs.filter((s) => s.out !== out && s.in !== sub);
    this.pendingSubs.push({ out, in: sub });
    if (this.phase === 'dead' || this.phase === 'break' || this.phase === 'tip') this.applyPendingSubs();
    else this.events.push({ kind: 'subQueued', out, in: sub });
    return true;
  }

  cancelSub(p: Player) {
    this.pendingSubs = this.pendingSubs.filter((s) => s.out !== p && s.in !== p);
  }

  private applyPendingSubs() {
    for (const s of this.pendingSubs) {
      if (this.players.includes(s.out) && this.bench.includes(s.in)) this.swap(s.out, s.in);
    }
    this.pendingSubs = [];
  }

  private swap(out: Player, sub: Player) {
    if (this.ball.owner === out) this.ball.owner = sub;
    sub.slot = out.slot;
    sub.x = out.x; sub.y = out.y; sub.z = 0;
    sub.vx = 0; sub.vy = 0; sub.vz = 0;
    sub.state = 'free'; sub.dunk = null; sub.meter = 0;
    sub.facing = out.facing;
    sub.ai.jumpIn = -1; sub.ai.plan = 'none';
    out.slot = -1;
    out.state = 'free'; out.dunk = null; out.z = 0; out.vz = 0;
    if (out.fire) {
      // Sitting down cools off a hot hand.
      out.fire = false;
      out.streak = 0;
      this.events.push({ kind: 'fire', player: out, on: false });
    }
    this.players[this.players.indexOf(out)] = sub;
    this.bench[this.bench.indexOf(sub)] = out;
    if (this.user === out) {
      this.user = sub;
      out.human = false;
      sub.human = true;
    }
    this.events.push({ kind: 'sub', out, in: sub });
  }

  // ---------- player actions ----------

  private act(p: Player, dt: number) {
    const it = p.intent;
    const b = this.ball;
    const hasBall = b.owner === p && b.mode === 'held';
    if (it.special && p.special >= 1 && p.state !== 'stun') this.useSpecial(p);
    if (p.state === 'stun' || p.state === 'dunk' || p.state === 'hang') return;

    if (p.state === 'shoot') {
      if (!hasBall) { p.state = 'free'; return; }
      p.meter += dt / METER_TIME;
      p.stateT += dt;
      const release = p.human ? !it.shootHeld : p.meter >= p.releaseAt;
      const landed = p.z <= 0 && p.stateT > 0.15;
      if (release || p.meter >= 1.25 || landed) this.releaseShot(p);
      return;
    }
    if (p.state === 'layup') {
      p.stateT += dt;
      if (hasBall && p.stateT >= 0.24) this.releaseLayup(p);
      return;
    }
    if (p.state === 'swipe') {
      p.stateT -= dt;
      if (p.stateT <= 0) p.state = 'free';
      return;
    }

    if (hasBall) {
      if (it.shoot) this.startShot(p);
      else if (it.pass) this.doPass(p);
    } else {
      if (it.shoot && p.z === 0) this.jump(p);
      if (it.steal) this.trySteal(p);
    }
  }

  private jump(p: Player) {
    p.vz = 14 + Math.max(p.r.blk, p.r.reb) * 0.05;
  }

  private startShot(p: Player) {
    const hx = hoopX(p.team);
    const d = this.distToHoop(p);
    const turbo = p.intent.turbo && (p.turbo > 0.05 || p.fx.surge > 0 || p.fire);
    p.facing = hx > p.x ? 1 : -1;
    if (d <= this.dunkRange(p, turbo)) {
      this.startDunk(p, false);
      return;
    }
    if (d <= 7.5) {
      p.state = 'layup';
      p.stateT = 0;
      p.vz = 12;
      return;
    }
    p.state = 'shoot';
    p.stateT = 0;
    p.meter = 0;
    p.vz = 10.5;
    p.vx *= 0.25;
    p.vy *= 0.25;
    if (!p.human) {
      const sigma = Math.max(0.05, 0.09 + (100 - p.r.sht) * 0.0018 - this.diff.cpuShot * (p.team === 1 ? 1 : 0));
      p.releaseAt = clamp(IDEAL_RELEASE + randn() * sigma, 0.3, 1.2);
    }
  }

  /** 1 = wide open, down to 0.35 = smothered. */
  contest(p: Player): number {
    if (p.fx.phase > 0) return 1;
    const hx = hoopX(p.team);
    const hd = Math.hypot(hx - p.x, HOOP_Y - p.y) || 1;
    let worst = 0;
    for (const q of this.players) {
      if (q.team === p.team || q.state === 'stun') continue;
      const d = dist(p.x, p.y, q.x, q.y);
      if (d > 7) continue;
      let c = (1 - d / 7) * (0.25 + q.r.def * 0.0025 + q.size * 0.06) * (q.z > 0.8 ? 1.4 : 1);
      const dot = ((q.x - p.x) * (hx - p.x) + (q.y - p.y) * (HOOP_Y - p.y)) / ((d || 1) * hd);
      if (dot < 0.3) c *= 0.6;
      worst = Math.max(worst, c);
    }
    return clamp(1 - worst, 0.35, 1);
  }

  private baseProb(p: Player, d: number, three: boolean): number {
    if (d < 8) return 0.55 + p.r.ins * 0.004;
    if (!three) return clamp(0.2 + p.r.sht * 0.0042 - (d - 8) * 0.007, 0.1, 0.75);
    return clamp(0.1 + p.r.sht * 0.0037 - Math.max(0, d - 24) * 0.03, 0.02, 0.6);
  }

  private releaseShot(p: Player) {
    const err = p.meter - IDEAL_RELEASE;
    const w = this.greenWindow(p);
    let grade: Grade;
    if (p.fx.lockin) { grade = 'perfect'; p.fx.lockin = false; }
    else if (Math.abs(err) <= w) grade = 'perfect';
    else if (Math.abs(err) <= w * 2.3) grade = 'good';
    else if (Math.abs(err) <= w * 4.5) grade = err < 0 ? 'early' : 'late';
    else grade = err < 0 ? 'very-early' : 'very-late';

    const d = this.distToHoop(p);
    const three = isThree(p.x, p.y, p.team);
    const contest = this.contest(p);
    const base = this.baseProb(p, d, three);
    let prob: number;
    switch (grade) {
      case 'perfect': prob = (three ? 0.86 : 0.94) - (1 - contest) * 0.55; break;
      case 'good': prob = base * contest + 0.06; break;
      case 'early': case 'late': prob = base * contest * 0.8; break;
      default: prob = base * contest * 0.3;
    }
    prob *= 0.7 + 0.3 * this.effort(p);
    if (p.fire) prob = Math.min(0.97, prob + 0.25);
    if (d > 35) prob = Math.min(prob, grade === 'perfect' ? 0.25 : 0.04);
    const make = Math.random() < prob;
    const airball = !make && grade.startsWith('very') && Math.random() < 0.4;
    this.events.push({ kind: 'release', player: p, grade });
    this.launchShot(p, make, airball, three ? 3 : 2, 'jump');
    p.state = 'free';
    p.meter = 0;
  }

  private releaseLayup(p: Player) {
    const contest = this.contest(p);
    let prob = (0.55 + p.r.ins * 0.004) * (0.45 + 0.55 * contest) * (0.7 + 0.3 * this.effort(p));
    if (p.fx.lockin) { prob = 0.97; p.fx.lockin = false; }
    if (p.fire) prob = Math.min(0.97, prob + 0.2);
    this.launchShot(p, Math.random() < prob, false, 2, 'layup');
    p.state = 'free';
  }

  private launchShot(p: Player, make: boolean, airball: boolean, points: 2 | 3, kind: 'jump' | 'layup') {
    const b = this.ball;
    const hx = hoopX(p.team);
    const x0 = p.x + p.facing * 0.3;
    const y0 = p.y;
    const z0 = p.z + p.heightFt + 0.4;
    let tx = hx;
    let ty = HOOP_Y;
    let tz = RIM_Z + 0.1;
    if (airball) {
      const bx = p.x - hx;
      const by = p.y - HOOP_Y;
      const l = Math.hypot(bx, by) || 1;
      const short = rand(3, 6);
      tx = hx + (bx / l) * short;
      ty = HOOP_Y + (by / l) * short + rand(-2, 2);
      tz = 6.5;
    } else if (!make) {
      const a = rand(0, Math.PI * 2);
      tx += Math.cos(a) * RIM_R * 1.25;
      ty += Math.sin(a) * RIM_R * 1.25;
    }
    const d = dist(x0, y0, tx, ty);
    const T = kind === 'layup' ? 0.55 : 0.75 + d * 0.017;
    b.owner = null;
    b.mode = 'shot';
    b.pass = null;
    b.fromShot = -1;
    b.lastTouch = p.team;
    b.shot = {
      shooter: p, make, airball, points, t: 0, T,
      x0, y0, z0, tx, ty, tz,
      vx: (tx - x0) / T, vy: (ty - y0) / T, vz: (tz - z0 + 0.5 * GRAVITY * T * T) / T,
      tested: new Set(),
      kind,
    };
    p.stats.fga++;
    if (points === 3) p.stats.tpa++;
    this.sfx.push('shot');
  }

  private startDunk(p: Player, oop: boolean) {
    const hx = hoopX(p.team);
    const d = this.distToHoop(p);
    const ang = Math.atan2(p.y - HOOP_Y, p.x - hx);
    const contest = this.contest(p);
    let prob = clamp(0.5 + p.r.ins * 0.0035 - (1 - contest) * 0.6, 0.3, 0.93) * (0.7 + 0.3 * this.effort(p));
    if (p.fire || p.fx.lockin) prob = 0.99;
    p.fx.lockin = false;
    p.dunk = {
      x0: p.x, y0: p.y, z0: p.z,
      x1: hx + Math.cos(ang) * 1.2, y1: HOOP_Y + Math.sin(ang) * 1.2,
      t: 0, T: clamp(0.42 + d * 0.04, 0.45, 1.0),
      peak: 3 + d * 0.3,
      spin: d > 9 && Math.random() < 0.65,
      make: Math.random() < prob,
      oop,
      tested: new Set(),
    };
    p.state = 'dunk';
    p.vx = 0; p.vy = 0; p.vz = 0;
    p.facing = hx > p.x ? 1 : -1;
    p.stats.fga++;
  }

  private updateDunk(p: Player, dt: number) {
    const dk = p.dunk!;
    dk.t += dt;
    const k = Math.min(1, dk.t / dk.T);
    const zEnd = RIM_Z + 0.5 - p.heightFt;
    p.x = lerp(dk.x0, dk.x1, k);
    p.y = lerp(dk.y0, dk.y1, k);
    p.z = Math.max(0, lerp(dk.z0, zEnd, Math.sqrt(k)) + 4 * k * (1 - k) * dk.peak);

    if (k > 0.25 && k < 0.97 && p.fx.phase <= 0) {
      for (const q of this.players) {
        if (q.team === p.team || dk.tested.has(q.id) || q.z < 0.8) continue;
        if (dist(p.x, p.y, q.x, q.y) > 3.6) continue;
        if (q.z + q.heightFt + 1.6 < p.z + p.heightFt) continue;
        dk.tested.add(q.id);
        const chance = clamp(0.25 + q.r.blk * 0.004 - p.r.ins * 0.0025 + (q.size - p.size) * 0.3, 0.08, 0.55);
        if (Math.random() < chance) {
          p.dunk = null;
          p.state = 'free';
          p.vz = 0;
          this.recordBlock(q, p);
          return;
        }
      }
    }

    if (k >= 1) {
      p.dunk = null;
      const hoopIdx = p.team === 0 ? 1 : 0;
      this.rimShake[hoopIdx] = 1;
      if (dk.make) {
        p.state = 'hang';
        p.stateT = 0.35;
        const b = this.ball;
        b.owner = null;
        b.mode = 'net';
        b.x = hoopX(p.team); b.y = HOOP_Y; b.z = RIM_Z;
        this.netT[hoopIdx] = 0.5;
        this.shake = 1;
        this.sfx.push('dunk');
        this.scoreBasket(p, 2, 'dunk');
      } else {
        p.state = 'free';
        p.vz = 0;
        const b = this.ball;
        b.owner = null;
        b.mode = 'loose';
        b.x = dk.x1; b.y = dk.y1; b.z = RIM_Z + 0.4;
        const a = Math.atan2(dk.y0 - HOOP_Y, dk.x0 - hoopX(p.team)) + rand(-1, 1);
        b.vx = Math.cos(a) * rand(6, 11);
        b.vy = Math.sin(a) * rand(6, 11);
        b.vz = rand(8, 13);
        b.fromShot = p.team;
        b.noPickup = 0.25;
        this.sfx.push('rim');
        this.events.push({ kind: 'miss', player: p, airball: false });
      }
    }
  }

  private recordBlock(blocker: Player, victim: Player) {
    const b = this.ball;
    const a = Math.atan2(b.y - blocker.y, b.x - blocker.x) + rand(-0.6, 0.6);
    b.owner = null;
    b.shot = null;
    b.mode = 'loose';
    b.vx = Math.cos(a) * rand(10, 18);
    b.vy = Math.sin(a) * rand(10, 18);
    b.vz = rand(2, 8);
    b.fromShot = victim.team;
    b.lastTouch = blocker.team;
    b.noPickup = 0.2;
    blocker.stats.blk++;
    blocker.special = Math.min(1, blocker.special + 0.35);
    this.events.push({ kind: 'block', player: blocker, victim });
    this.sfx.push('block');
  }

  private pickPassTarget(p: Player): Player | null {
    const mates = this.teamPlayers(p.team).filter((q) => q !== p && q.state !== 'stun');
    if (!mates.length) return null;
    const { mx, my } = p.intent;
    const mag = Math.hypot(mx, my);
    if (mag > 0.3) {
      let best: Player | null = null;
      let bs = 0.3;
      for (const q of mates) {
        const d = dist(p.x, p.y, q.x, q.y) || 1;
        const dot = ((q.x - p.x) * mx + (q.y - p.y) * my) / (d * mag);
        const s = dot - d * 0.004;
        if (s > bs) { bs = s; best = q; }
      }
      if (best) return best;
    }
    let best = mates[0];
    let bs = -Infinity;
    for (const q of mates) {
      const s = Math.min(this.openness(q), 10) + (40 - this.distToHoop(q)) * 0.1;
      if (s > bs) { bs = s; best = q; }
    }
    return best;
  }

  private doPass(p: Player) {
    const to = p.intent.passTo ?? this.pickPassTarget(p);
    if (!to || to === p) return;
    const b = this.ball;
    const oop = p.intent.turbo && this.distToHoop(to) < 17 && to.state === 'free';
    b.owner = null;
    b.mode = 'pass';
    b.lastTouch = p.team;
    b.pass = {
      from: p, to, oop, t: 0,
      speed: oop ? 32 : 46 + p.r.pas * 0.16,
      tested: new Set(),
      z0: b.z,
      dist0: Math.max(1, dist(b.x, b.y, to.x, to.y)),
    };
    to.ai.think = 0;
    this.sfx.push('pass');
  }

  private trySteal(p: Player) {
    if (p.stealCd > 0 || p.z > 0.5) return;
    p.stealCd = 0.6;
    p.state = 'swipe';
    p.stateT = 0.25;
    const owner = this.ball.mode === 'held' ? this.ball.owner : null;
    const turbo = p.intent.turbo && (p.turbo > 0.25 || p.fx.surge > 0 || p.fire);

    if (turbo) {
      let target: Player | null = null;
      if (owner && owner.team !== p.team && dist(p.x, p.y, owner.x, owner.y) < 4.8 && owner.state !== 'dunk') target = owner;
      else {
        let bd = 4.8;
        for (const q of this.players) {
          if (q.team === p.team || q.state === 'stun' || q.state === 'dunk') continue;
          const d = dist(p.x, p.y, q.x, q.y);
          if (d < bd) { bd = d; target = q; }
        }
      }
      if (!target) return;
      if (!(p.fx.surge > 0 || p.fire)) p.turbo = Math.max(0, p.turbo - 0.35);
      const mult = bestEffectiveness(p.mon.types, target.mon.types);
      let chance = 0.55 + (p.size - target.size) * 0.8 + (p.r.def - target.r.hnd) / 250;
      chance *= mult === 0 ? 0 : mult >= 2 ? 1.5 : mult < 1 ? 0.6 : 1;
      if (target.fx.phase > 0) chance = 0;
      const ok = Math.random() < clamp(chance, 0, 0.95);
      const l = dist(p.x, p.y, target.x, target.y) || 1;
      p.vx += ((target.x - p.x) / l) * 8;
      p.vy += ((target.y - p.y) / l) * 8;
      if (ok) this.knock(target, p, 1.1);
      this.events.push({ kind: 'shove', player: p, victim: target, mult, ok });
      this.sfx.push('shove');
      return;
    }

    if (!owner || owner.team === p.team || owner.state === 'dunk') return;
    if (dist(p.x, p.y, owner.x, owner.y) > 4.6) return;
    let chance = clamp(0.1 + (p.r.def - owner.r.hnd) / 220, 0.03, 0.38);
    if (owner.state === 'shoot' || owner.state === 'layup') chance *= 0.4;
    if (owner.fx.phase > 0) chance = 0;
    if (Math.random() < chance) {
      owner.state = 'free';
      owner.meter = 0;
      this.giveBall(p);
      p.stats.stl++;
      p.special = Math.min(1, p.special + 0.3);
      this.events.push({ kind: 'steal', player: p, victim: owner });
      this.sfx.push('steal');
    }
  }

  /** Injury chance grows as a player tires: up to 3x when fully gassed. */
  private maybeInjure(p: Player, base: number) {
    if (!this.cfg.injuries || p.hurt || Math.random() >= base * (1 + (1 - p.energy) * 2)) return;
    const r = Math.random();
    p.hurt = r < 0.6 ? 1 : r < 0.9 ? 2 : 3;
    p.energy = Math.min(p.energy, 0.15);
    this.events.push({ kind: 'injury', player: p, weeks: p.hurt });
    this.sfx.push('whistle');
  }

  private knock(target: Player, by: Player, dur: number) {
    this.maybeInjure(target, 0.012);
    const l = dist(target.x, target.y, by.x, by.y) || 1;
    const nx = (target.x - by.x) / l;
    const ny = (target.y - by.y) / l;
    target.state = 'stun';
    target.stateT = dur;
    target.meter = 0;
    target.dunk = null;
    target.vx = nx * 14;
    target.vy = ny * 14;
    target.vz = 5;
    const b = this.ball;
    if (b.owner === target) {
      b.owner = null;
      b.mode = 'loose';
      b.vx = nx * 8 + rand(-3, 3);
      b.vy = ny * 8 + rand(-3, 3);
      b.vz = 7;
      b.noPickup = 0.25;
      b.fromShot = -1;
    }
  }

  private setFire(p: Player) {
    if (p.fire) return;
    p.fire = true;
    p.fireMakes = 0;
    this.events.push({ kind: 'fire', player: p, on: true });
    this.sfx.push('fire');
  }

  private useSpecial(p: Player) {
    p.special = 0;
    const hits: { victim: Player; mult: number }[] = [];
    const moveType = p.mon.types[0];
    switch (p.mon.special) {
      case 'surge': p.fx.surge = 5; p.turbo = 1; break;
      case 'lockin': p.fx.lockin = true; break;
      case 'phase': p.fx.phase = 5; break;
      case 'blaze': this.setFire(p); break;
      case 'quake':
        this.shake = 1.2;
        for (const q of this.opponents(p.team)) {
          if (dist(p.x, p.y, q.x, q.y) > 14) continue;
          const mult = q.fx.phase > 0 ? 0 : effectiveness(moveType, q.mon.types);
          hits.push({ victim: q, mult });
          if (mult > 0 && q.state !== 'dunk') this.knock(q, p, 0.6 + 0.35 * mult);
        }
        break;
      case 'freeze':
        for (const q of this.opponents(p.team)) {
          const mult = effectiveness(moveType, q.mon.types);
          hits.push({ victim: q, mult });
          if (mult > 0) q.fx.slow = 3 + 1.5 * mult;
        }
        break;
    }
    this.events.push({ kind: 'special', player: p, hits });
    this.sfx.push('special');
  }

  private scoreBasket(p: Player, pts: number, how: 'jump' | 'layup' | 'dunk') {
    this.score[p.team] += pts;
    p.stats.pts += pts;
    p.stats.fgm++;
    if (pts === 3) p.stats.tpm++;
    if (how === 'dunk') p.stats.dnk++;
    const lp = p.lastPasser;
    if (lp && lp.team === p.team && this.time - p.lastCatch < 4) {
      lp.stats.ast++;
      lp.special = Math.min(1, lp.special + 0.12);
    }
    p.lastPasser = null;
    p.special = Math.min(1, p.special + 0.3);

    for (const q of this.opponents(p.team)) {
      q.streak = 0;
      if (q.fire) {
        q.fire = false;
        this.events.push({ kind: 'fire', player: q, on: false });
      }
    }
    p.streak++;
    if (p.fire) {
      p.fireMakes++;
      if (p.fireMakes >= 5) {
        p.fire = false;
        this.events.push({ kind: 'fire', player: p, on: false });
      }
    } else if (p.streak >= 3) this.setFire(p);

    this.events.push({ kind: 'score', player: p, points: pts, how });
    this.phase = 'dead';
    this.phaseT = 1.1;
    this.setOffense((1 - p.team) as TeamId);
  }

  // ---------- movement ----------

  private movePlayer(p: Player, dt: number) {
    p.stealCd = Math.max(0, p.stealCd - dt);
    p.fx.surge = Math.max(0, p.fx.surge - dt);
    p.fx.phase = Math.max(0, p.fx.phase - dt);
    p.fx.slow = Math.max(0, p.fx.slow - dt);

    if (p.state === 'dunk') { this.updateDunk(p, dt); return; }
    if (p.state === 'hang') {
      p.stateT -= dt;
      if (p.stateT <= 0) {
        p.state = 'free';
        p.vz = 0;
        this.maybeInjure(p, 0.003);
      }
      return;
    }

    let tx = 0;
    let ty = 0;
    p.turboOn = false;
    if (p.state === 'stun') {
      p.stateT -= dt;
      if (p.stateT <= 0 && p.z <= 0) p.state = 'free';
    } else if (p.state === 'layup') {
      const hx = hoopX(p.team);
      const l = this.distToHoop(p) || 1;
      tx = ((hx - p.x) / l) * 9;
      ty = ((HOOP_Y - p.y) / l) * 9;
    } else if (p.state === 'free' || p.state === 'swipe') {
      const it = p.intent;
      let mx = it.mx;
      let my = it.my;
      const m = Math.hypot(mx, my);
      if (m > 1) { mx /= m; my /= m; }
      const unlimited = p.fx.surge > 0 || p.fire;
      const turbo = it.turbo && m > 0.1 && (p.turbo > 0.02 || unlimited);
      let speed = (11 + p.r.spd * 0.085) * this.effort(p);
      if (turbo) speed *= 1.42;
      if (p.fx.surge > 0) speed *= 1.2;
      if (p.fx.slow > 0) speed *= 0.55;
      if (this.ball.owner === p) speed *= 0.94;
      if (p.state === 'swipe') speed *= 0.5;
      if (this.phase === 'tip') speed = 0;
      tx = mx * speed;
      ty = my * speed;
      if (turbo) {
        p.turboOn = true;
        if (!unlimited) p.turbo = Math.max(0, p.turbo - 0.38 * dt);
      }
    }
    if (!p.turboOn) p.turbo = Math.min(1, p.turbo + 0.16 * dt);

    if (p.state === 'stun') {
      const f = Math.min(1, 3 * dt);
      p.vx -= p.vx * f;
      p.vy -= p.vy * f;
    } else {
      const a = Math.min(1, (p.z > 0.05 ? 2 : 11) * dt);
      p.vx += (tx - p.vx) * a;
      p.vy += (ty - p.vy) * a;
    }
    p.x += p.vx * dt;
    p.y += p.vy * dt;
    if (p.z > 0 || p.vz > 0) {
      p.vz -= GRAVITY * dt;
      p.z += p.vz * dt;
      if (p.z <= 0) { p.z = 0; p.vz = 0; }
    }
    p.x = clamp(p.x, 0.6, COURT_L - 0.6);
    p.y = clamp(p.y, 0.6, COURT_W - 0.6);

    if (p.state === 'shoot' || p.state === 'layup') {
      p.facing = hoopX(p.team) > p.x ? 1 : -1;
      p.back = false;
    } else if (p.state !== 'stun') {
      if (Math.abs(p.vx) > 1.5) p.facing = p.vx > 0 ? 1 : -1;
      p.back = p.vy < -3 && Math.abs(p.vy) > Math.abs(p.vx) * 0.9;
    }
    p.runPhase += Math.hypot(p.vx, p.vy) * dt * 0.9;
  }

  private separate() {
    const ps = this.players;
    for (let i = 0; i < ps.length; i++) {
      const a = ps[i];
      if (a.state === 'dunk' || a.state === 'hang' || a.fx.phase > 0) continue;
      for (let j = i + 1; j < ps.length; j++) {
        const c = ps[j];
        if (c.state === 'dunk' || c.state === 'hang' || c.fx.phase > 0) continue;
        if (Math.abs(a.z - c.z) > 3) continue;
        const min = 1.1 * (a.size + c.size);
        let dx = c.x - a.x;
        let dy = c.y - a.y;
        let d = Math.hypot(dx, dy);
        if (d >= min) continue;
        if (d < 0.001) { dx = rand(-1, 1); dy = rand(-1, 1); d = Math.hypot(dx, dy) || 1; }
        const push = (min - d) / 2;
        a.x -= (dx / d) * push; a.y -= (dy / d) * push;
        c.x += (dx / d) * push; c.y += (dy / d) * push;
      }
    }
  }

  // ---------- ball ----------

  private updateBall(dt: number) {
    const b = this.ball;
    b.noPickup = Math.max(0, b.noPickup - dt);
    b.spin += dt * (b.mode === 'held' ? 4 : 10);
    switch (b.mode) {
      case 'held': this.ballInHands(b.owner!); break;
      case 'pass': this.updatePass(dt); break;
      case 'shot': this.updateShot(dt); break;
      case 'net':
        b.z -= 9 * dt;
        if (b.z <= 6.8) {
          b.mode = 'loose';
          b.vx = rand(-1.5, 1.5);
          b.vy = rand(-1.5, 1.5);
          b.vz = -4;
          b.fromShot = -1;
        }
        break;
      case 'loose':
        this.ballPhysics(dt);
        if (this.phase === 'live' && b.noPickup <= 0) this.loosePickup();
        break;
    }
  }

  private ballInHands(p: Player) {
    const b = this.ball;
    if (p.state === 'shoot' || p.state === 'layup' || p.state === 'dunk' || p.state === 'hang') {
      b.x = p.x + p.facing * 0.4;
      b.y = p.y + 0.2;
      b.z = p.z + p.heightFt + 0.4;
      return;
    }
    const moving = Math.hypot(p.vx, p.vy) > 3;
    const period = moving ? 0.36 : 0.5;
    const ph = (this.time % period) / period;
    if (this.dribblePh < 0.5 && ph >= 0.5 && this.phase !== 'tip') this.sfx.push('dribble');
    this.dribblePh = ph;
    b.x = p.x + p.facing * 0.9 * p.size;
    b.y = p.y + 0.5;
    b.z = p.z + BALL_R + Math.abs(Math.cos(ph * Math.PI)) * 2.2 * p.size;
  }

  private updatePass(dt: number) {
    const b = this.ball;
    const ps = b.pass!;
    ps.t += dt;
    const to = ps.to;
    const tx = to.x + to.facing * 0.6;
    const ty = to.y + 0.4;
    const tz = ps.oop ? Math.max(to.z + to.heightFt + 1, 9) : to.z + to.heightFt * 0.6;
    const dx = tx - b.x;
    const dy = ty - b.y;
    const d = Math.hypot(dx, dy);
    const step = ps.speed * dt;
    const prog = clamp(1 - d / ps.dist0, 0, 1);
    b.z = lerp(ps.z0, tz, prog) + Math.sin(prog * Math.PI) * (ps.oop ? 6 : 1.2);

    for (const q of this.players) {
      if (q.team === ps.from.team || ps.tested.has(q.id) || q.state === 'stun') continue;
      if (dist(q.x, q.y, b.x, b.y) > 2) continue;
      if (b.z > q.z + q.heightFt + 1.6) continue;
      ps.tested.add(q.id);
      let chance = clamp(0.08 + (q.r.def - ps.from.r.pas) / 200 + (q.human && q.intent.steal ? 0.2 : 0), 0.03, 0.4);
      if (ps.oop && q.z < 1) chance *= 0.2;
      if (Math.random() < chance) {
        this.giveBall(q);
        q.stats.stl++;
        q.special = Math.min(1, q.special + 0.3);
        this.events.push({ kind: 'steal', player: q, victim: ps.from });
        this.sfx.push('steal');
        return;
      }
    }

    if (d <= Math.max(step, 1.5)) {
      b.x = tx; b.y = ty;
      this.giveBall(to);
      to.lastPasser = ps.from;
      if (ps.oop && to.team === this.offense && this.distToHoop(to) < 18 && to.state === 'free') {
        this.events.push({ kind: 'oop', player: to });
        this.startDunk(to, true);
      }
      return;
    }
    b.x += (dx / d) * step;
    b.y += (dy / d) * step;
    if (ps.t > 2.5 || to.state === 'stun') {
      b.mode = 'loose';
      b.vx = (dx / d) * ps.speed * 0.5;
      b.vy = (dy / d) * ps.speed * 0.5;
      b.vz = 0;
      b.pass = null;
      b.fromShot = -1;
    }
  }

  private updateShot(dt: number) {
    const b = this.ball;
    const s = b.shot!;
    s.t += dt;
    const t = Math.min(s.t, s.T);
    b.x = s.x0 + s.vx * t;
    b.y = s.y0 + s.vy * t;
    b.z = s.z0 + s.vz * t - 0.5 * GRAVITY * t * t;

    if (t < s.T * 0.45 && s.shooter.fx.phase <= 0) {
      for (const q of this.players) {
        if (q.team === s.shooter.team || s.tested.has(q.id) || q.z < 0.8) continue;
        if (dist(q.x, q.y, b.x, b.y) > 3.2) continue;
        if (q.z + q.heightFt + 1.4 < b.z - 0.5) continue;
        s.tested.add(q.id);
        const chance = clamp(0.15 + q.r.blk * 0.004 - s.shooter.r.sht * 0.002 - (s.kind === 'layup' ? 0 : 0.05), 0.05, 0.6);
        if (Math.random() < chance) {
          this.recordBlock(q, s.shooter);
          return;
        }
      }
    }

    if (s.t < s.T) return;
    const hoopIdx = s.shooter.team === 0 ? 1 : 0;
    b.shot = null;
    if (s.airball) {
      b.mode = 'loose';
      b.vx = s.vx; b.vy = s.vy; b.vz = s.vz - GRAVITY * s.T;
      b.fromShot = s.shooter.team;
      this.events.push({ kind: 'miss', player: s.shooter, airball: true });
    } else if (s.make) {
      b.mode = 'net';
      b.x = hoopX(s.shooter.team); b.y = HOOP_Y; b.z = RIM_Z;
      this.netT[hoopIdx] = 0.5;
      this.sfx.push('swish');
      this.scoreBasket(s.shooter, s.points, s.kind);
    } else {
      b.mode = 'loose';
      const hx = hoopX(s.shooter.team);
      const a = Math.atan2(s.y0 - HOOP_Y, s.x0 - hx) + rand(-1.3, 1.3);
      const sp = rand(5, 12);
      b.vx = Math.cos(a) * sp;
      b.vy = Math.sin(a) * sp;
      b.vz = rand(7, 13);
      b.fromShot = s.shooter.team;
      b.noPickup = 0.25;
      this.rimShake[hoopIdx] = 0.6;
      this.sfx.push('rim');
      this.events.push({ kind: 'miss', player: s.shooter, airball: false });
    }
  }

  private ballPhysics(dt: number) {
    const b = this.ball;
    b.vz -= GRAVITY * dt;
    b.x += b.vx * dt;
    b.y += b.vy * dt;
    b.z += b.vz * dt;
    if (b.z < BALL_R) {
      b.z = BALL_R;
      if (b.vz < -2.5) {
        if (b.vz < -5) this.sfx.push('bounce');
        b.vz = -b.vz * 0.6;
        b.vx *= 0.88;
        b.vy *= 0.88;
      } else b.vz = 0;
    }
    if (b.z <= BALL_R + 0.01) {
      const f = Math.min(1, 1.5 * dt);
      b.vx -= b.vx * f;
      b.vy -= b.vy * f;
    }
    if (b.x < 0.5) { b.x = 0.5; b.vx = Math.abs(b.vx) * 0.5; }
    if (b.x > COURT_L - 0.5) { b.x = COURT_L - 0.5; b.vx = -Math.abs(b.vx) * 0.5; }
    if (b.y < 0.5) { b.y = 0.5; b.vy = Math.abs(b.vy) * 0.5; }
    if (b.y > COURT_W - 0.5) { b.y = COURT_W - 0.5; b.vy = -Math.abs(b.vy) * 0.5; }
  }

  private loosePickup() {
    const b = this.ball;
    let best: Player | null = null;
    let bs = -Infinity;
    for (const p of this.players) {
      if (p.state === 'stun' || p.state === 'dunk' || p.state === 'hang') continue;
      if (dist(p.x, p.y, b.x, b.y) > 1.4 + p.size * 0.6) continue;
      if (b.z > p.z + p.heightFt + 1.6) continue;
      const s = p.r.reb + Math.random() * 35 + (p.z > 0.5 ? 10 : 0);
      if (s > bs) { bs = s; best = p; }
    }
    if (!best) return;
    const fromShot = b.fromShot;
    if (fromShot !== -1) {
      best.stats.reb++;
      best.special = Math.min(1, best.special + 0.1);
    }
    b.fromShot = -1;
    const offensiveBoard = fromShot !== -1 && best.team === fromShot;
    this.giveBall(best);
    if (offensiveBoard) this.shotClock = Math.max(this.shotClock, 14);
    else if (fromShot !== -1) this.shotClock = 24;
  }

  /** x the camera should center on. */
  focusX(): number {
    const b = this.ball;
    if (b.owner) return b.owner.x - backDir(b.owner.team) * 8;
    return b.x;
  }
}
