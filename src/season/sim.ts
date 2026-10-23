// Season Draft: a fast, stat-based season sim. Deterministic for a given seed (all luck comes from one rng); no DOM, no engine games.
import { POSITIONS, type Mon } from '../data/pokemon';
import { bestLineup, chemistry } from '../game/game';
import { seededRng } from '../game/types';
import { teamGrade } from './grade';

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
  /** The one luck source for the season (default: a stream from `seed`). Same seed, same season. */
  rng?: () => number;
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
  /** End-of-season All-Stars from every team: exactly one per slot, PG, SG, SF, PF, C. */
  allStars: AllStar[];
}

export interface AllStar extends PlayerLine {
  /** The All-Star slot this player fills (their listed position, or the slot they started in). */
  slot: Mon['pos'];
  /** Index into the league's teams (0 is yours). */
  team: number;
  teamName: string;
  color: string;
}

/** Position-weighted season score for All-Star voting: guards for playmaking, bigs for boards and blocks. */
const ALL_STAR_WEIGHTS: Record<Mon['pos'], { pts: number; reb: number; ast: number; stl: number; blk: number }> = {
  PG: { pts: 1, reb: 0.8, ast: 2, stl: 2, blk: 1 },
  SG: { pts: 1.2, reb: 0.9, ast: 1.3, stl: 2, blk: 1.2 },
  SF: { pts: 1.1, reb: 1.3, ast: 1.2, stl: 2, blk: 1.8 },
  PF: { pts: 1, reb: 1.6, ast: 0.9, stl: 1.5, blk: 2.5 },
  C: { pts: 1, reb: 1.8, ast: 0.8, stl: 1.2, blk: 3 },
};
export const allStarScore = (p: PlayerLine, slot: Mon['pos']) => {
  const w = ALL_STAR_WEIGHTS[slot];
  return p.ppg * w.pts + p.rpg * w.reb + p.apg * w.ast + p.spg * w.stl + p.bpg * w.blk;
};

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

/** Night-to-night luck on each side's points (std dev): small next to the ratings gap, so upsets happen mostly between close teams. */
const NIGHT = 2.6;

/** Points for each side of one game: set by the two teams' ratings, plus a little luck from `r`. Never a tie: the stronger team wins the overtime. */
function playGame(r: () => number, a: Profile, b: Profile, aHome: boolean): [number, number] {
  const gauss = () => Math.sqrt(-2 * Math.log(1 - r())) * Math.cos(2 * Math.PI * r());
  const home = 1.8;
  let sa = 64 + (a.off - 74) * 0.8 - (b.def - 74) * 0.55 + (aHome ? home : 0) + gauss() * NIGHT;
  let sb = 64 + (b.off - 74) * 0.8 - (a.def - 74) * 0.55 + (aHome ? 0 : home) + gauss() * NIGHT;
  sa = Math.max(30, Math.round(sa));
  sb = Math.max(30, Math.round(sb));
  if (sa === sb) {
    const edge = 2 + Math.min(4, Math.round(Math.abs(a.power - b.power) / 4));
    if (a.power > b.power || (a.power === b.power && aHome)) sa += edge;
    else sb += edge;
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
  const r = input.rng ?? seededRng(input.seed);
  const prof = teams.map(profile);
  const rec = teams.map((t, i) => ({ team: i, name: t.name, abbr: t.abbr, color: t.color, w: 0, l: 0, pf: 0, pa: 0, rank: 0 }));
  const rounds = roundRobin(n);
  const weeks: WeekResult[] = [];

  const me = teams[0].roster;
  const mine = prof[0];
  // Per-player season totals for every team (the All-Stars come from the whole league). No random draws here,
  // so tracking them leaves every score exactly as the rng decides.
  const book = teams.map((t, i) => {
    const p = prof[i];
    const ro = t.roster;
    return {
      tot: ro.map(() => ({ pts: 0, reb: 0, ast: 0, stl: 0, blk: 0 })),
      pts: shares(p, ro, (m) => (m.r.sht * 0.3 + m.r.ins * 0.3 + m.r.spd * 0.1 + m.r.hnd * 0.15 + m.r.pas * 0.15) ** 2),
      reb: shares(p, ro, (m) => m.r.reb ** 2.5),
      ast: shares(p, ro, (m) => (m.r.pas * 0.6 + m.r.hnd * 0.4) ** 3),
      stl: shares(p, ro, (m) => (m.r.def * 0.5 + m.r.spd * 0.5) ** 3),
      blk: shares(p, ro, (m) => m.r.blk ** 4),
      gp: 0,
    };
  });
  /** A team's players share what the team did that night. */
  const credit = (i: number, pf: number) => {
    const b = book[i];
    const d = prof[i].def;
    const ast = Math.round(pf * 0.28);
    const reb = Math.round(34 + (d - 74) * 0.25);
    b.gp++;
    b.tot.forEach((t, k) => {
      t.pts += pf * b.pts[k];
      t.reb += reb * b.reb[k];
      t.ast += ast * b.ast[k];
      t.stl += (6 + (d - 74) * 0.08) * b.stl[k];
      t.blk += (4 + (d - 74) * 0.06) * b.blk[k];
    });
  };
  const tot = book[0].tot;

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
        credit(a, sa);
        credit(b, sb);
        if (a === 0 || b === 0) {
          const home = a === 0;
          const pf = home ? sa : sb;
          const pa = home ? sb : sa;
          weeks.push({ week, opp: home ? b : a, home, pf, pa, win: pf > pa });
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

  // All-Stars: for each slot, the best season (position-weighted) among players listed at that position or who
  // started there; ties go to the team with more wins, then overall, then dex. Nobody is picked twice.
  const lines = teams.flatMap((t, ti) => {
    const g = book[ti].gp || 1;
    const lu = bestLineup(t.roster);
    return t.roster.map((m, k): PlayerLine & { team: number; started?: Mon['pos'] } => {
      const x = book[ti].tot[k];
      const si = lu.starters.indexOf(m);
      return {
        dex: m.dex, name: m.name, pos: m.pos, ovr: m.ovr, starter: si >= 0, team: ti, started: si >= 0 ? lu.slots[si] : undefined,
        ppg: round1(x.pts / g), rpg: round1(x.reb / g), apg: round1(x.ast / g), spg: round1(x.stl / g), bpg: round1(x.blk / g),
      };
    });
  });
  const taken = new Set<string>();
  const allStars: AllStar[] = POSITIONS.flatMap((slot) => {
    const pool = lines.filter((p) => (p.pos === slot || p.started === slot) && !taken.has(`${p.team}:${p.dex}`));
    pool.sort((p, q) => allStarScore(q, slot) - allStarScore(p, slot) || rec[q.team].w - rec[p.team].w || q.ovr - p.ovr || p.dex - q.dex);
    const best = pool[0];
    if (!best) return [];
    taken.add(`${best.team}:${best.dex}`);
    const { started: _s, ...line } = best;
    return [{ ...line, slot, teamName: teams[best.team].name, color: teams[best.team].color }];
  });

  return {
    seed: input.seed,
    weeks,
    standings: order,
    playoffs,
    user: {
      w: mineRec.w, l: mineRec.l, rank: mineRec.rank, teams: n, seed, playoff,
      ppg: round1(mineRec.pf / gp), oppg: round1(mineRec.pa / gp),
      ...teamGrade(mine.starters.concat(mine.bench)),
    },
    players,
    pots,
    allStars,
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
