// Season Draft: a fast, stat-based season sim. Pure and deterministic for a given seed; no DOM, no engine games.
import { POSITIONS, type Mon } from '../data/pokemon';
import { bestLineup, chemistry } from '../game/game';

export interface SimTeamIn {
  name: string;
  abbr: string;
  color: string;
  color2: string;
  /** League boost (gym leaders and the Elite Four); the user's team has none. */
  boost?: number;
  roster: Mon[];
}

export interface SimInput {
  seed: number;
  /** Index 0 is the user's team. Needs an even number of teams, at least 4. */
  teams: SimTeamIn[];
}

export type Playoff = 'missed' | 'semis' | 'final' | 'champion';

export interface Standing {
  team: number;
  name: string;
  abbr: string;
  color: string;
  w: number;
  l: number;
  pf: number;
  pa: number;
  /** 1 = best record. */
  rank: number;
}

export interface WeekResult {
  week: number;
  opp: number;
  home: boolean;
  pf: number;
  pa: number;
  win: boolean;
}

export interface PlayoffGame {
  round: 'semi' | 'final';
  a: number;
  b: number;
  sa: number;
  sb: number;
  winner: number;
}

export interface PlayerLine {
  dex: number;
  name: string;
  pos: Mon['pos'];
  ovr: number;
  starter: boolean;
  ppg: number;
  rpg: number;
  apg: number;
  spg: number;
  bpg: number;
}

export interface SeasonResult {
  seed: number;
  weeks: WeekResult[];
  standings: Standing[];
  playoffs: PlayoffGame[];
  user: {
    w: number;
    l: number;
    rank: number;
    teams: number;
    /** Playoff seed 1-4, or 0 when the team missed. */
    seed: number;
    playoff: Playoff;
    ppg: number;
    oppg: number;
    grade: string;
    ovr: number;
  };
  players: PlayerLine[];
  /** Index into `players`. */
  pots: number;
}

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

interface Profile {
  off: number;
  def: number;
  power: number;
  ovr: number;
  starters: Mon[];
  bench: Mon[];
}

function profile(t: SimTeamIn): Profile {
  const { starters, bench } = bestLineup(t.roster);
  const lift = (t.boost ?? 0) + chemistry(starters);
  const depth = (avg(bench.map((m) => m.ovr)) - 60) * 0.08;
  const off = avg(starters.map((m) => m.r.sht * 0.3 + m.r.ins * 0.25 + m.r.spd * 0.15 + m.r.pas * 0.15 + m.r.hnd * 0.15)) + lift + depth;
  const def = avg(starters.map((m) => m.r.def * 0.3 + m.r.blk * 0.25 + m.r.reb * 0.25 + m.r.spd * 0.2)) + lift + depth;
  const ovr = Math.round(avg(starters.map((m) => m.ovr)) + lift);
  return { off, def, power: off + def, ovr, starters, bench };
}

/** Points for each side of one game. Never a tie: the stronger team wins the overtime coin flip. */
function playGame(r: () => number, a: Profile, b: Profile, aHome: boolean): [number, number] {
  const gauss = () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
  const home = 1.8;
  let sa = 64 + (a.off - 74) * 0.8 - (b.def - 74) * 0.55 + (aHome ? home : 0) + gauss() * 7;
  let sb = 64 + (b.off - 74) * 0.8 - (a.def - 74) * 0.55 + (aHome ? 0 : home) + gauss() * 7;
  sa = Math.max(30, Math.round(sa));
  sb = Math.max(30, Math.round(sb));
  if (sa === sb) {
    const pa = 1 / (1 + Math.exp((b.power - a.power) / 12));
    if (r() < pa) sa += 1 + Math.floor(r() * 3);
    else sb += 1 + Math.floor(r() * 3);
  }
  return [sa, sb];
}

/** Round-robin rounds (circle method): every team plays every other once. */
export function roundRobin(n: number): [number, number][][] {
  const ids = Array.from({ length: n }, (_, i) => i);
  const rounds: [number, number][][] = [];
  for (let k = 0; k < n - 1; k++) {
    const games: [number, number][] = [];
    for (let i = 0; i < n / 2; i++) games.push([ids[i], ids[n - 1 - i]]);
    rounds.push(games);
    ids.splice(1, 0, ids.pop()!);
  }
  return rounds;
}

export function gradeOf(w: number, l: number, playoff: Playoff): string {
  const gp = w + l;
  const score = (gp ? w / gp : 0) * 100 + (playoff === 'champion' ? 15 : playoff === 'final' ? 8 : playoff === 'semis' ? 3 : 0);
  const steps: [number, string][] = [[95, 'A+'], [85, 'A'], [75, 'A-'], [68, 'B+'], [60, 'B'], [52, 'B-'], [45, 'C+'], [38, 'C'], [30, 'C-']];
  return steps.find(([min]) => score >= min)?.[1] ?? 'D';
}

/** Share of a team total each player earns, from a per-player weight and minutes (starters 30, bench 10). */
function shares(p: Profile, roster: Mon[], weight: (m: Mon) => number): number[] {
  const ws = roster.map((m) => weight(m) * (p.starters.includes(m) ? 30 : 10));
  const sum = ws.reduce((a, b) => a + b, 0) || 1;
  return ws.map((w) => w / sum);
}

export function simulateSeason(input: SimInput): SeasonResult {
  const { teams } = input;
  const n = teams.length;
  if (n < 4 || n % 2) throw new Error('A season needs an even number of teams, at least 4');
  const r = rng(input.seed);
  const prof = teams.map(profile);
  const rec = teams.map((t, i) => ({ team: i, name: t.name, abbr: t.abbr, color: t.color, w: 0, l: 0, pf: 0, pa: 0, rank: 0 }));
  const rounds = roundRobin(n);
  const weeks: WeekResult[] = [];

  const me = teams[0].roster;
  const mine = prof[0];
  const tot = me.map(() => ({ pts: 0, reb: 0, ast: 0, stl: 0, blk: 0 }));
  const shPts = shares(mine, me, (m) => (m.r.sht * 0.3 + m.r.ins * 0.3 + m.r.spd * 0.1 + m.r.hnd * 0.15 + m.r.pas * 0.15) ** 2);
  const shReb = shares(mine, me, (m) => m.r.reb ** 2.5);
  const shAst = shares(mine, me, (m) => (m.r.pas * 0.6 + m.r.hnd * 0.4) ** 3);
  const shStl = shares(mine, me, (m) => (m.r.def * 0.5 + m.r.spd * 0.5) ** 3);
  const shBlk = shares(mine, me, (m) => m.r.blk ** 4);

  // Two passes of the round robin, home and away swapped.
  for (let leg = 0; leg < 2; leg++) {
    for (let k = 0; k < rounds.length; k++) {
      const week = leg * rounds.length + k + 1;
      for (const [x, y] of rounds[k]) {
        const [a, b] = leg ? [y, x] : [x, y];
        const [sa, sb] = playGame(r, prof[a], prof[b], true);
        rec[a].pf += sa; rec[a].pa += sb; rec[b].pf += sb; rec[b].pa += sa;
        rec[sa > sb ? a : b].w++;
        rec[sa > sb ? b : a].l++;
        if (a === 0 || b === 0) {
          const home = a === 0;
          const pf = home ? sa : sb;
          const pa = home ? sb : sa;
          weeks.push({ week, opp: home ? b : a, home, pf, pa, win: pf > pa });
          // The user's players share what the team did that night.
          const ast = Math.round(pf * 0.28);
          const reb = Math.round(34 + (mine.def - 74) * 0.25);
          me.forEach((_, i) => {
            tot[i].pts += pf * shPts[i];
            tot[i].reb += reb * shReb[i];
            tot[i].ast += ast * shAst[i];
            tot[i].stl += (6 + (mine.def - 74) * 0.08) * shStl[i];
            tot[i].blk += (4 + (mine.def - 74) * 0.06) * shBlk[i];
          });
        }
      }
    }
  }

  const order = [...rec].sort((p, q) => q.w - p.w || q.pf - q.pa - (p.pf - p.pa) || p.name.localeCompare(q.name));
  order.forEach((s, i) => (s.rank = i + 1));

  // Top four make the playoffs: 1v4 and 2v3, then the final. One game each; the higher seed hosts.
  const playoffs: PlayoffGame[] = [];
  const meet = (round: 'semi' | 'final', a: number, b: number): number => {
    const [sa, sb] = playGame(r, prof[a], prof[b], true);
    const winner = sa > sb ? a : b;
    playoffs.push({ round, a, b, sa, sb, winner });
    return winner;
  };
  const top = order.slice(0, 4).map((s) => s.team);
  const f1 = meet('semi', top[0], top[3]);
  const f2 = meet('semi', top[1], top[2]);
  const champ = meet('final', f1, f2);

  const mineRec = rec[0];
  const seed = top.indexOf(0) + 1;
  const playoff: Playoff = champ === 0 ? 'champion' : seed === 0 ? 'missed' : [f1, f2].includes(0) ? 'final' : 'semis';
  const gp = weeks.length;
  const players: PlayerLine[] = me.map((m, i) => ({
    dex: m.dex, name: m.name, pos: m.pos, ovr: m.ovr, starter: mine.starters.includes(m),
    ppg: tot[i].pts / gp, rpg: tot[i].reb / gp, apg: tot[i].ast / gp, spg: tot[i].stl / gp, bpg: tot[i].blk / gp,
  })).map((p) => ({ ...p, ppg: round1(p.ppg), rpg: round1(p.rpg), apg: round1(p.apg), spg: round1(p.spg), bpg: round1(p.bpg) }));
  const value = (p: PlayerLine) => p.ppg + p.rpg * 1.2 + p.apg * 1.5 + p.spg * 2 + p.bpg * 2;
  let pots = 0;
  players.forEach((p, i) => { if (value(p) > value(players[pots])) pots = i; });

  return {
    seed: input.seed,
    weeks,
    standings: order,
    playoffs,
    user: {
      w: mineRec.w, l: mineRec.l, rank: mineRec.rank, teams: n, seed, playoff,
      ppg: round1(mineRec.pf / gp), oppg: round1(mineRec.pa / gp),
      grade: gradeOf(mineRec.w, mineRec.l, playoff), ovr: mine.ovr,
    },
    players,
    pots,
  };
}

const round1 = (x: number) => Math.round(x * 10) / 10;

export const PLAYOFF_TEXT: Record<Playoff, string> = {
  champion: 'League Champions',
  final: 'Lost in the Final',
  semis: 'Lost in the Semifinals',
  missed: 'Missed the Playoffs',
};

/** Positions are listed PG..C everywhere. */
export const byPosition = (a: Mon, b: Mon) => POSITIONS.indexOf(a.pos) - POSITIONS.indexOf(b.pos);
