// "My Drafted Team": the ten Pokémon from a Season Draft, saved so Quick Play and Franchise can start from them.
// Format is documented in docs/drafted-team.md.
import { POKEMON, monByDex, type Mon } from '../data/pokemon';
import { bestLineup } from '../game/game';
import { cpuPick, type DraftTeam } from '../screens/draft';
import { abbr, shuffle } from '../util';
import { cleanName } from './share';

export const DRAFTED_KEY = 'pokejam.draftedTeam';

export interface DraftedTeam {
  v: 1;
  name: string;
  abbr?: string;
  colors: { color: string; color2: string };
  /** Ten dex numbers, in draft order. */
  dex: number[];
  /** Five indices into `dex`: the starting lineup. */
  starters: number[];
  record?: { w: number; l: number };
  rank?: number;
  savedAt: number;
}

const HEX = /^#[0-9a-f]{6}$/i;

export function startersOf(mons: Mon[]): number[] {
  const { starters } = bestLineup(mons);
  return starters.map((m) => mons.indexOf(m));
}

export function saveDrafted(t: Omit<DraftedTeam, 'v' | 'dex' | 'starters' | 'savedAt'> & { mons: Mon[] }) {
  const { mons, ...rest } = t;
  const out: DraftedTeam = { ...rest, v: 1, dex: mons.map((m) => m.dex), starters: startersOf(mons), savedAt: Date.now() };
  try {
    localStorage.setItem(DRAFTED_KEY, JSON.stringify(out));
  } catch { /* storage unavailable */ }
}

/** Reads and validates the saved team; anything malformed counts as no team. */
export function loadDrafted(): DraftedTeam | null {
  try {
    const raw = localStorage.getItem(DRAFTED_KEY);
    if (!raw) return null;
    const t = JSON.parse(raw) as Partial<DraftedTeam> | null;
    if (!t || t.v !== 1 || typeof t.name !== 'string' || !Array.isArray(t.dex) || !Array.isArray(t.starters)) return null;
    const known = new Set(POKEMON.map((m) => m.dex));
    if (t.dex.length !== 10 || !t.dex.every((d) => Number.isInteger(d) && known.has(d))) return null;
    if (t.starters.length !== 5 || new Set(t.starters).size !== 5 || !t.starters.every((i) => Number.isInteger(i) && i >= 0 && i < 10)) return null;
    if (!t.colors || !HEX.test(t.colors.color) || !HEX.test(t.colors.color2)) return null;
    const name = cleanName(t.name);
    if (!name) return null;
    const rec = t.record;
    return {
      v: 1, name, dex: t.dex, starters: t.starters, colors: { color: t.colors.color, color2: t.colors.color2 },
      abbr: typeof t.abbr === 'string' ? t.abbr.slice(0, 4).toUpperCase() : undefined,
      record: rec && Number.isInteger(rec.w) && Number.isInteger(rec.l) && rec.w >= 0 && rec.l >= 0 ? { w: rec.w, l: rec.l } : undefined,
      rank: Number.isInteger(t.rank) && t.rank! > 0 ? t.rank : undefined,
      savedAt: typeof t.savedAt === 'number' ? t.savedAt : 0,
    };
  } catch {
    return null;
  }
}

/** Renames the saved team (share card, share link and title-page line all read it from here). */
export function renameDrafted(name: string): DraftedTeam | null {
  const t = loadDrafted();
  const clean = cleanName(name);
  if (!t || !clean) return t;
  const next: DraftedTeam = { ...t, name: clean, abbr: abbr(clean) };
  try {
    localStorage.setItem(DRAFTED_KEY, JSON.stringify(next));
  } catch { /* storage unavailable */ }
  return next;
}

export const draftedMons = (t: DraftedTeam): Mon[] => t.dex.map(monByDex);
/** The starting five, always from the shared by-position rule (older saves may hold a different `starters`). */
export const draftedStarters = (t: DraftedTeam): Mon[] => bestLineup(draftedMons(t)).starters;

export type TeamSource = 'draft' | 'mine' | 'random';

/** Five random Pokémon (or a bench-less lineup) drafted CPU-style from `pool`, which loses the picks. */
export function cpuRoster(pool: Mon[], size: number, types: DraftTeam['types'] = []): Mon[] {
  const roster: Mon[] = [];
  while (roster.length < size && pool.length) {
    const m = cpuPick(pool, roster, types);
    pool.splice(pool.indexOf(m), 1);
    roster.push(m);
  }
  return roster;
}

/**
 * Drafts a whole league without the draft screen: snake order, CPU picks. When `fixed` is given, team 0
 * (the user) keeps exactly those Pokémon and every other team drafts from the rest.
 */
export function autoDraft(teams: DraftTeam[], size: number, fixed?: Mon[]): { rosters: Mon[][]; leftovers: Mon[] } {
  const pool = [...POKEMON].sort((a, b) => b.ovr - a.ovr);
  const rosters: Mon[][] = teams.map(() => []);
  if (fixed) {
    rosters[0] = [...fixed];
    for (const m of fixed) pool.splice(pool.indexOf(m), 1);
  }
  const order = shuffle(teams.map((_, i) => i));
  for (let round = 0; round < size; round++) {
    for (const t of round % 2 ? [...order].reverse() : order) {
      if (fixed && t === 0) continue;
      const m = cpuPick(pool, rosters[t], teams[t].types);
      pool.splice(pool.indexOf(m), 1);
      rosters[t].push(m);
    }
  }
  return { rosters, leftovers: pool };
}
