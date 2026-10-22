// Throwaway: 200 seeded Season Drafts (user + 9 gym teams, 10 rounds), PR #16's cpuPick vs the current one.
// Run: npx vitest run --config scripts/vitest.typestar.config.ts
import { it } from 'vitest';
import { POKEMON, type Mon, type PokeType } from '../src/data/pokemon';
import { LEAGUE } from '../src/franchise/league';
import { CPU_REACH, cpuPick } from '../src/screens/draft';
import { snakePicks } from '../src/screens/draft.logic';

const DRAFTS = Number(process.env.DRAFTS ?? 200);
const ROUNDS = 10;

function mulberry(seed: number) {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** PR #16's cpuPick: on-type only until the team has one. */
function pr16Pick(pool: Mon[], roster: Mon[], types: PokeType[], rng: () => number): Mon {
  const isOn = (m: Mon) => m.types.some((t) => types.includes(t));
  if (types.length && !roster.some(isOn)) {
    const on = pool.filter(isOn);
    if (on.length) pool = on;
  }
  const count = (pos: string) => roster.filter((m) => m.pos === pos).length;
  const floor = Math.max(...pool.map((m) => m.ovr)) - CPU_REACH;
  let best = pool[0];
  let bs = -Infinity;
  for (const m of pool) {
    if (m.ovr < floor) continue;
    const need = [5, 2, 0][Math.min(2, count(m.pos))];
    const s = m.ovr + need + rng() * 9;
    if (s > bs) { bs = s; best = m; }
  }
  return best;
}

function run(mode: 'before' | 'after') {
  const teams = [{ types: [] as PokeType[] }, ...LEAGUE];
  let firstGap = 0, firsts = 0, maxGap = 0, maxAnyGap = 0, by3 = 0, by3Avail = 0, topOn = 0, themed = 0, laterOn = 0, later = 0, base = 0;
  for (let d = 0; d < DRAFTS; d++) {
    const rng = mulberry(1000 + d);
    const order = teams.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
    const pool = [...POKEMON].sort((a, b) => b.ovr - a.ovr);
    const rosters: Mon[][] = teams.map(() => []);
    const avail3 = teams.map(() => false);
    for (const t of snakePicks(order, ROUNDS)) {
      const ty = teams[t].types;
      const isOn = (m: Mon) => m.types.some((x) => ty.includes(x));
      if (t && rosters[t].length < 3 && pool.some(isOn)) avail3[t] = true;
      const m = t === 0 ? cpuPick(pool, rosters[t], [], rng) : mode === 'before' ? pr16Pick(pool, rosters[t], ty, rng) : cpuPick(pool, rosters[t], ty, rng);
      const gap = pool[0].ovr - m.ovr;
      if (t) {
        maxAnyGap = Math.max(maxAnyGap, gap);
        if (!rosters[t].length) { firstGap += gap; firsts++; maxGap = Math.max(maxGap, gap); }
      }
      pool.splice(pool.indexOf(m), 1);
      rosters[t].push(m);
    }
    rosters.forEach((r, t) => {
      if (!t) return;
      const ty = teams[t].types;
      const isOn = (m: Mon) => m.types.some((x) => ty.includes(x));
      themed++;
      if (r.slice(0, 3).some(isOn)) by3++;
      if (avail3[t]) by3Avail++;
      const top = Math.max(...r.map((m) => m.ovr));
      if (r.some((m) => m.ovr === top && isOn(m))) topOn++;
      const firstOn = r.findIndex(isOn);
      for (const m of r.slice(firstOn + 1)) { later++; if (isOn(m)) laterOn++; }
      base += POKEMON.filter(isOn).length / POKEMON.length;
    });
  }
  const pct = (a: number, b: number) => `${((100 * a) / b).toFixed(1)}%`;
  console.log(`${mode}: first-pick gap avg ${(firstGap / firsts).toFixed(2)} (max ${maxGap}), any-pick max gap ${maxAnyGap}; ` +
    `on-type by pick 3 ${pct(by3, themed)} (on-type available ${pct(by3Avail, themed)}); top-OVR player on-type ${pct(topOn, themed)}; ` +
    `on-type share after the star ${pct(laterOn, later)} vs pool base ${pct(base, themed)}`);
}

it('type-star bench', () => { run('before'); run('after'); });
