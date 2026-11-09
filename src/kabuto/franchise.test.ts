import { describe, expect, it } from 'vitest';
import { EVOLUTIONS, POKEMON, monByDex } from '../data/pokemon';
import { LEAGUE, createFranchise, evolutionOf, monOf, tradeValue, type Franchise } from '../franchise/league';
import { kingKabutoMon, withKingKabuto } from './king';

const DURING = Date.parse('2026-11-15T12:00:00-08:00');
const AFTER = Date.parse('2026-12-01T12:00:00-08:00');

/** A two-team league: the user's roster and one gym's, from `pool`, with the rest as free agents. */
function league(mine: number[], pool = POKEMON): Franchise {
  const pick = (dexes: number[]) => dexes.map((d) => pool.find((m) => m.dex === d)!);
  const teams = [
    { name: 'Pallet Town', abbr: 'PAL', color: '#3b6fd8', color2: '#16224a', human: true },
    { ...LEAGUE[0], human: false },
  ];
  const rosters = [pick(mine), pick([74, 95, 111, 76, 142])];
  const used = new Set(rosters.flat().map((m) => m.dex));
  return createFranchise(teams, rosters, pool.filter((m) => !used.has(m.dex)));
}

const kingUid = (f: Franchise) => Object.values(f.players).find((p) => p.dex === 140)!.uid;

describe('King Kabuto in Franchise', () => {
  it('is in the franchise draft pool during his event and not after it', () => {
    expect(withKingKabuto(POKEMON, DURING).some((m) => m.name === 'King Kabuto')).toBe(true);
    expect(withKingKabuto(POKEMON, AFTER).some((m) => m.name === 'King Kabuto')).toBe(false);
  });

  it('a team that drafted him keeps the King card, through a save round trip and after the event', () => {
    const f = league([25, 140, 6, 9, 143], withKingKabuto(POKEMON, DURING));
    const saved = JSON.parse(JSON.stringify(f)) as Franchise;
    const king = monOf(saved, kingUid(saved));
    expect(king.name).toBe('King Kabuto');
    expect(king.ovr).toBe(kingKabutoMon().ovr);
    expect(king.r.sht).toBe(kingKabutoMon().r.sht);
    expect(saved.players[kingUid(saved)].king).toBe(true);
  });

  it('keeps his level-up gains on top of the King card', () => {
    const f = league([25, 140, 6, 9, 143], withKingKabuto(POKEMON, DURING));
    const p = f.players[kingUid(f)];
    p.bonus = { spd: 3 };
    expect(monOf(f, p.uid).r.spd).toBe(kingKabutoMon().r.spd + 3);
    expect(monOf(f, p.uid).name).toBe('King Kabuto');
  });

  it('never evolves, while a plain Kabuto still can', () => {
    const f = league([25, 140, 6, 9, 143], withKingKabuto(POKEMON, DURING));
    expect(EVOLUTIONS[140]).toBeDefined();
    expect(evolutionOf(f.players[kingUid(f)])).toBeUndefined();
    expect(evolutionOf({ ...f.players[kingUid(f)], king: undefined })).toBe(EVOLUTIONS[140]);
    expect(Number.isFinite(tradeValue(f, kingUid(f)))).toBe(true);
  });

  it('an undrafted King joins free agency as a plain Kabuto', () => {
    const f = league([25, 448, 6, 9, 143], withKingKabuto(POKEMON, DURING));
    const uid = kingUid(f);
    expect(f.freeAgents).toContain(uid);
    expect(f.players[uid].king).toBeUndefined();
    expect(monOf(f, uid).name).toBe('Kabuto');
    expect(monOf(f, uid).r).toEqual(monByDex(140).r);
  });

  it('a franchise drafted after the event has only the plain Kabuto', () => {
    const f = league([25, 140, 6, 9, 143], withKingKabuto(POKEMON, AFTER));
    expect(monOf(f, kingUid(f)).name).toBe('Kabuto');
    expect(f.players[kingUid(f)].king).toBeUndefined();
  });
});
