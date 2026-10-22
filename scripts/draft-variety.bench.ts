// Throwaway: how much do a user's first picks vary across 20 Season Drafts, old vs new draft behavior?
// Run: npx vitest run --config scripts/vitest.variety.config.ts
import { it } from 'vitest';
import { POKEMON, type Mon, type PokeType } from '../src/data/pokemon';
import { LEAGUE } from '../src/franchise/league';
import { countAt, cpuPick } from '../src/screens/draft';
import { snakePicks } from '../src/screens/draft.logic';
import { shuffle } from '../src/util';

const DRAFTS = Number(process.env.DRAFTS ?? 20);
const ROUNDS = 10;

/** The pre-change cpuPick: best available + need + type + Math.random()*5, no reach cap. */
function oldPick(pool: Mon[], roster: Mon[], types: PokeType[] = []): Mon {
  let best = pool[0];
  let bs = -Infinity;
  for (const m of pool) {
    const need = [5, 2, 0][Math.min(2, countAt(roster, m.pos))];
    const s = m.ovr + need + (m.types.some((t) => types.includes(t)) ? 8 : 0) + Math.random() * 5;
    if (s > bs) { bs = s; best = m; }
  }
  return best;
}

/** One Season Draft (user + 9 league teams, 10 rounds). The user always takes the first card shown (sorted by OVR). */
function draft(mode: 'old' | 'new', fixedSlot: number | null): number[] {
  const pool = [...POKEMON].sort((a, b) => b.ovr - a.ovr);
  const teams = [{ types: [] as PokeType[] }, ...LEAGUE];
  const order = fixedSlot === null ? shuffle(teams.map((_, i) => i)) : (() => { const o = shuffle(teams.slice(1).map((_, i) => i + 1)); o.splice(fixedSlot - 1, 0, 0); return o; })();
  const rosters: Mon[][] = teams.map(() => []);
  for (const t of snakePicks(order, ROUNDS)) {
    const m = t === 0 ? pool[0] : (mode === 'new' ? cpuPick : oldPick)(pool, rosters[t], teams[t].types);
    pool.splice(pool.indexOf(m), 1);
    rosters[t].push(m);
  }
  return rosters[0].slice(0, 3).map((m) => m.dex);
}

function report(label: string, mode: 'old' | 'new', fixedSlot: number | null) {
  const runs = Array.from({ length: DRAFTS }, () => draft(mode, fixedSlot));
  const distinct3 = new Set(runs.flat()).size;
  const firsts = new Map<number, number>();
  for (const r of runs) firsts.set(r[0], (firsts.get(r[0]) ?? 0) + 1);
  const [topDex, topN] = [...firsts].sort((a, b) => b[1] - a[1])[0];
  const name = POKEMON.find((m) => m.dex === topDex)!.name;
  console.log(`${label.padEnd(34)} distinct players in first 3 picks: ${String(distinct3).padStart(2)} | first pick == most common (${name}): ${topN}/${DRAFTS} (${Math.round((topN / DRAFTS) * 100)}%) | distinct first picks: ${firsts.size}`);
}

it('draft variety, old vs new', () => {
  console.log(`\n${DRAFTS} Season Drafts, user auto-picks the top card each round`);
  for (const [slot, fixed] of [['random slot (as in game)', null], ['pick slot 5 always', 5], ['pick slot 10 always', 10]] as const) {
    report(`OLD, ${slot}`, 'old', fixed);
    report(`NEW, ${slot}`, 'new', fixed);
  }
});
