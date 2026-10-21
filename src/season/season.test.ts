import { describe, expect, it } from 'vitest';
import { POKEMON, type Mon } from '../data/pokemon';
import { LEAGUE } from '../franchise/league';
import { decodeShare, encodeShare, shareFromHash, type SharedTeam } from './share';
import { simulateSeason, type SimInput } from './sim';
import { gradeOfOvr, teamGrade } from './grade';
import { shareText } from './shareImage';
import { gradeOfOvr as draftGrade } from '../screens/draftView';
import { bestLineup, teamOvr } from '../game/game';
import { monByDex } from '../data/pokemon';

const byOvr = [...POKEMON].sort((a, b) => b.ovr - a.ovr);

/** Deterministic league: teams take turns down the ovr-sorted pool. */
function input(seed: number): SimInput {
  const n = 1 + LEAGUE.length;
  const rosters: Mon[][] = Array.from({ length: n }, () => []);
  byOvr.slice(0, n * 10).forEach((m, i) => rosters[i % n].push(m));
  return {
    seed,
    teams: rosters.map((roster, i) => ({
      name: i ? LEAGUE[i - 1].name : 'Pallet Town', abbr: i ? LEAGUE[i - 1].abbr : 'PAL',
      color: '#3b6fd8', color2: '#16224a', boost: i ? LEAGUE[i - 1].boost : 0, roster,
    })),
  };
}

describe('simulateSeason', () => {
  it('is deterministic for a seed and differs between seeds', () => {
    expect(simulateSeason(input(7))).toEqual(simulateSeason(input(7)));
    expect(simulateSeason(input(7)).standings).not.toEqual(simulateSeason(input(8)).standings);
  });

  it('plays 10-player teams and keeps the books straight', () => {
    const inp = input(42);
    expect(inp.teams.every((t) => t.roster.length === 10)).toBe(true);
    const r = simulateSeason(inp);
    const n = inp.teams.length;
    expect(r.standings).toHaveLength(n);
    const games = (n - 1) * 2;
    for (const s of r.standings) expect(s.w + s.l).toBe(games);
    expect(r.standings.reduce((a, s) => a + s.w, 0)).toBe(r.standings.reduce((a, s) => a + s.l, 0));
    expect(r.standings.reduce((a, s) => a + s.pf, 0)).toBe(r.standings.reduce((a, s) => a + s.pa, 0));
    expect(r.weeks).toHaveLength(games);
    expect(r.user.w + r.user.l).toBe(games);
    expect(r.user.w).toBe(r.weeks.filter((w) => w.win).length);
  });

  it('ranks 1..n once each, in record order', () => {
    const r = simulateSeason(input(3));
    expect(r.standings.map((s) => s.rank)).toEqual(r.standings.map((_, i) => i + 1));
    for (let i = 1; i < r.standings.length; i++) expect(r.standings[i - 1].w).toBeGreaterThanOrEqual(r.standings[i].w);
    const me = r.standings.find((s) => s.team === 0)!;
    expect(r.user.rank).toBe(me.rank);
    expect(r.user.seed).toBe(me.rank <= 4 ? me.rank : 0);
  });

  it('plays three playoff games and reports a consistent result', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const r = simulateSeason(input(seed));
      expect(r.playoffs).toHaveLength(3);
      const won = r.playoffs.filter((g) => g.winner === 0).length;
      const inIt = r.playoffs.some((g) => g.a === 0 || g.b === 0);
      expect(inIt).toBe(r.user.seed > 0);
      if (r.user.playoff === 'champion') expect(won).toBe(2);
      if (r.user.playoff === 'missed') expect(won).toBe(0);
      expect(r.players).toHaveLength(10);
      expect(r.pots).toBeGreaterThanOrEqual(0);
      expect(r.pots).toBeLessThan(10);
    }
  });

  it('rewards a stronger team', () => {
    const wins = (reverse: boolean) => {
      let w = 0;
      for (let seed = 1; seed <= 30; seed++) {
        const inp = input(seed);
        if (reverse) inp.teams[0].roster = byOvr.slice(-10);
        else inp.teams[0].roster = byOvr.slice(0, 10);
        w += simulateSeason(inp).user.w;
      }
      return w;
    };
    expect(wins(false)).toBeGreaterThan(wins(true));
  });

  it('rejects odd or tiny leagues', () => {
    const inp = input(1);
    expect(() => simulateSeason({ ...inp, teams: inp.teams.slice(0, 3) })).toThrow();
  });

  it('uses one grade scale: the draft summary and the season results agree', () => {
    expect(draftGrade).toBe(gradeOfOvr);
    expect(gradeOfOvr(95)).toBe('A+');
    expect(gradeOfOvr(70)).toBe('D');
    for (const seed of [1, 2, 3, 4, 5]) {
      const inp = input(seed);
      const res = simulateSeason(inp);
      const mine = inp.teams[0].roster;
      const draftOvr = teamOvr(bestLineup(mine).starters);
      expect(res.user.ovr).toBe(draftOvr);
      expect(res.user.grade).toBe(gradeOfOvr(draftOvr));
      expect(teamGrade(mine.map((m) => monByDex(m.dex))).grade).toBe(res.user.grade);
    }
  });
});

const team: SharedTeam = {
  name: 'Pallet Town', color: '#3b6fd8', color2: '#16224a',
  dex: byOvr.slice(0, 10).map((m) => m.dex), w: 12, l: 6, rank: 2, teams: 10, seed: 2, playoff: 'final',
};

describe('share links', () => {
  it('round-trips', () => {
    expect(decodeShare(encodeShare(team))).toEqual(team);
    const odd = { ...team, name: 'Pokéjam ★ 日本', w: 0, l: 18, rank: 10, seed: 0, playoff: 'missed' as const };
    expect(decodeShare(encodeShare(odd))).toEqual(odd);
  });

  it('is compact and URL-safe', () => {
    const code = encodeShare(team);
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(code.length).toBeLessThan(100);
  });

  it('reads the hash form', () => {
    expect(shareFromHash(`#s=${encodeShare(team)}`)).toEqual(team);
    expect(shareFromHash('#other')).toBeNull();
    expect(shareFromHash('')).toBeNull();
  });

  it('rejects garbage', () => {
    const good = encodeShare(team);
    for (const bad of ['', 'x', '!!!!', '<script>', 'AAAA', good.slice(0, -3), `${good}AAAA`, 'A'.repeat(500), '../../etc', good.replace(/^./, 'z')]) {
      expect(decodeShare(bad)).toBeNull();
    }
  });

  it('rejects out-of-range fields', () => {
    const tweak = (f: (b: Uint8Array) => void) => {
      const bin = atob(encodeShare(team).replace(/-/g, '+').replace(/_/g, '/') + '=='.slice(0, (4 - (encodeShare(team).length % 4)) % 4));
      const b = Uint8Array.from(bin, (c) => c.charCodeAt(0));
      f(b);
      let s = '';
      b.forEach((x) => (s += String.fromCharCode(x)));
      return decodeShare(btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''));
    };
    expect(tweak(() => {})).toEqual(team);
    expect(tweak((b) => (b[0] = 9))).toBeNull(); // version
    expect(tweak((b) => { b[1] = 0xff; b[2] = 0xff; })).toBeNull(); // unknown dex
    expect(tweak((b) => (b[29] = 11))).toBeNull(); // rank above team count
    expect(tweak((b) => (b[31] = 7))).toBeNull(); // playoff code
    expect(tweak((b) => { b[27] = 0; b[28] = 0; })).toBeNull(); // no games
  });

  it('share text has the record, the shared grade and the link', () => {
    const url = 'https://pokejam.xyz/#s=abc';
    const g = teamGrade(team.dex.map((d) => monByDex(d))).grade;
    expect(shareText(team, url)).toBe(`My PokeJam team went 12-6, grade ${g} ${url}`);
  });

  it('strips markup and control characters from names', () => {
    const d = decodeShare(encodeShare({ ...team, name: '<img src=x onerror=1>\u0000‮Bad' }));
    expect(d?.name).not.toMatch(/[<>\u0000‮]/);
  });
});
