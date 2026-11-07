// Shooter picker rows: every Pokémon, best shooters first. Pure (no DOM).
import { POKEMON, type Mon } from '../data/pokemon';
import type { FeaturedShooter } from './types';

/** Filters by name (case-insensitive) or dex number ("25" or "#25"); sorts by Sht desc, then name. */
export function pickerRows(query: string, featured: FeaturedShooter, pool: readonly Mon[] = POKEMON): Mon[] {
  const q = query.trim().toLowerCase();
  const num = q.replace(/^#/, '');
  const byDex = /^\d+$/.test(num);
  const rows = pool.filter((m) => !q || m.name.toLowerCase().includes(q) || (byDex && String(m.dex).startsWith(num)))
    .sort((a, b) => b.r.sht - a.r.sht || a.name.localeCompare(b.name) || a.dex - b.dex);
  if (featured) {
    const i = rows.findIndex((m) => m.dex === featured.dex);
    if (i > 0) rows.unshift(...rows.splice(i, 1));
  }
  return rows;
}
