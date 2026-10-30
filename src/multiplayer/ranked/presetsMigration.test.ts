// @ts-ignore Node's fs has no type declarations in this project.
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RANKED_PRESETS } from './presets';

const NAME = '20261124_pokejam_ranked_presets.sql';
const DIR = new URL('../../../supabase/migrations/', import.meta.url);
const sql = readFileSync(new URL(NAME, DIR), 'utf8');

describe('ranked presets migration (static)', () => {
  it('creates the tables, functions and the ranked match info', () => {
    for (const s of [
      'pokejam_ranked_presets',
      'pokejam_ranked_picks',
      'pokejam_ranked_pick',
      'create or replace function public.pokejam_match_info',
      'host_roster',
      'enable row level security',
      'security definer',
    ]) {
      expect(sql).toContain(s);
    }
  });

  it('is additive only', () => {
    expect(sql).not.toMatch(/drop\s+table|drop\s+function|delete\s+from/i);
  });

  it('sorts after every other migration', () => {
    const files = readdirSync(DIR).filter((f: string) => f.endsWith('.sql')).sort();
    expect(files[files.length - 1]).toBe(NAME);
  });

  it('seeds exactly the client presets', () => {
    const rows = [...sql.matchAll(/\('([A-F])',\s*'((?:[^']|'')*)',\s*array\[([\d,\s]+)\]\)/g)].map((r) => ({
      id: r[1],
      name: r[2].replace(/''/g, "'"),
      dex: r[3].split(',').map((n: string) => Number(n.trim())),
    }));
    expect(rows).toEqual(RANKED_PRESETS.map((p) => ({ id: p.id, name: p.name, dex: [...p.dex] })));
  });
});
