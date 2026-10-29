import { describe, expect, it } from 'vitest';
import data from './nameFilterData.json';
import { POKEMON } from '../../data/pokemon';
import { FILTER, checkUsername, displayName, normalizeName, serverNameError } from './username';

describe('normalizeName', () => {
  it('lowercases, maps look-alikes, strips separators and collapses repeats', () => {
    expect(normalizeName('Sh1t')).toEqual(expect.arrayContaining(['shit', 'shlt']));
    expect(normalizeName('F_u.c-k')).toEqual(['fuk'.replace('fuk', 'fuck')]);
    expect(normalizeName('fuuuck')).toEqual(['fuck']);
    expect(normalizeName('$h!7')).toEqual(['shit']);
    expect(normalizeName('@dm1n')).toEqual(expect.arrayContaining(['admin']));
    expect(normalizeName('4ce8')).toEqual(['aceb']);
  });
});

describe('checkUsername rules', () => {
  it('enforces length and charset', () => {
    expect(checkUsername('ab')).toBe('length');
    expect(checkUsername('a'.repeat(17))).toBe('length');
    expect(checkUsername('abc')).toBeNull();
    expect(checkUsername('a'.repeat(16))).toBeNull();
    expect(checkUsername('bad name')).toBe('charset');
    expect(checkUsername('café_x')).toBe('charset');
    expect(checkUsername('<b>hi</b>')).toBe('charset');
    expect(checkUsername('1234')).toBe('charset');
    expect(checkUsername('___')).toBe('charset');
    expect(checkUsername('Ash_Ketchum9')).toBeNull();
  });

  it('blocks reserved names however they are dressed up', () => {
    for (const n of ['admin', 'Administrator', 'MODERATOR', 'mod', 'PokeJam', 'official', 'support', 'staff', 'system', 'dev', 'developer', 'kungfudoom', 'CryptoDoom', 'root', 'null', 'undefined', 'a_d_m_i_n', 'adm1n', 'Aadmin']) {
      expect(checkUsername(n), n).not.toBeNull();
    }
  });

  it('blocks staff impersonation', () => {
    for (const n of ['Admin_Joe', 'xXadminXx', 'TheMod', 'm0d_squad', 'Staff4Life', 'OfficialPJ', 'SupportGuy', 'pokejam_bob', 'kungfudoom_fan', 'Moderator_Ann']) {
      expect(checkUsername(n), n).toBe('impersonation');
    }
    for (const n of ['Modern_Art', 'Moody_Blue', 'Stafford', 'Commodore64']) expect(checkUsername(n), n).toBeNull();
  });
});

describe('profanity filter', () => {
  it('catches leetspeak, separators and repeats', () => {
    for (const n of ['fuck', 'FUCK_you', 'f_u_c_k', 'fuuuck', 'fvck'.replace('v', 'u'), 'sh1t', 'b1tch', 'xXshitXx', 'big_dick', 'Dickhead9', 'p0rn', 'Sex', 's3x', 'a55', 'Asss']) {
      expect(checkUsername(n), n).toBe('profanity');
    }
  });

  it('catches every severe term as a substring (built from the data file)', () => {
    for (const t of data.severe) {
      const name = `xx${t}`;
      if (name.length > 16) continue;
      if (data.allow.some((a: string) => name.includes(a))) continue;
      expect(checkUsername(name), name).not.toBeNull();
    }
  });

  it('mild terms only match as a whole name or a whole _ segment', () => {
    expect(checkUsername('ass_man')).toBe('profanity');
    expect(checkUsername('Ass')).toBe('profanity');
    for (const n of ['Assassin', 'Classy', 'Analyst', 'Titan', 'Cumberland', 'Sextant', 'Essex', 'As_Is', 'Kung_Fu']) expect(checkUsername(n), n).toBeNull();
  });

  it('allowlist avoids Scunthorpe-style false positives', () => {
    for (const n of ['Scunthorpe', 'Penistone', 'Nigeria', 'Shiitake', 'Dickens', 'Dickinson', 'Montenegro', 'Pussycat', 'Fagin', 'Retardant']) {
      expect(checkUsername(n), n).toBeNull();
    }
  });

  it('no Pokémon name or common trainer name trips the filter', () => {
    for (const p of POKEMON) {
      const n = p.name.replace(/[^A-Za-z0-9]/g, '');
      if (n.length >= 3 && n.length <= 16) expect(checkUsername(n), p.name).toBeNull();
    }
    for (const n of ['Ash', 'Misty_99', 'BrockSolid', 'Red', 'Blue_Oak', 'Gary_Oak', 'TeamRocket', 'HoopDreams', 'Dunk_Master']) expect(checkUsername(n), n).toBeNull();
  });
});

describe('helpers', () => {
  it('lists are loaded and non-trivial', () => {
    expect(FILTER.severe.length).toBeGreaterThan(30);
    expect(FILTER.mild.length).toBeGreaterThan(20);
    // A collapsed severe term that is too short would match inside innocent names ("kkk" collapses to "k").
    for (const t of FILTER.severe) expect(t.length, t).toBeGreaterThanOrEqual(3);
  });
  it('maps server errors to text', () => {
    expect(serverNameError('username:taken')).toMatch(/taken/);
    expect(serverNameError('error: username:cooldown:12')).toMatch(/12 days/);
    expect(serverNameError('username:cooldown:1')).toMatch(/1 day\./);
    expect(serverNameError('boom')).toBeNull();
  });
  it('falls back to Player', () => {
    expect(displayName(null)).toBe('Player');
    expect(displayName('  ')).toBe('Player');
    expect(displayName('Ash')).toBe('Ash');
  });
});
