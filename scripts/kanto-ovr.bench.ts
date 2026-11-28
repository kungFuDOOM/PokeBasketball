// Measures the Kanto gyms' mean starting-five ratings over N drafts, in a new franchise and after a Sinnoh-title return.
//   OVR_OUT=/path/ovr-now.json npx vitest run -c scripts/vitest.kantoovr.config.ts
// effective = starting-five mean OVR + chemistry + boost (effectiveStrength in league.ts); lineups come from bestLineup.
import { it, vi } from 'vitest';
import { writeFileSync } from 'node:fs';
import { POKEMON } from '../src/data/pokemon';
import { bestLineup, chemistry } from '../src/game/game';
import { autoDraft } from '../src/season/team';
import { withKingKabuto } from '../src/kabuto/king';
import { LEAGUE, bringBackKanto, createFranchise, monOf, type Franchise } from '../src/franchise/league';
import { openRegionIds, poolMons } from '../src/franchise/regions';

vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {}, key: () => null, length: 0 });
const N = Number(process.env.OVR_N ?? 40);
const ALL = ['johto', 'hoenn', 'sinnoh'];

function draft(unlocked: string[]): Franchise {
  const teams = [{ name: 'Pallet Town', abbr: 'PAL', color: '#3b6fd8', color2: '#16224a', human: true }, ...LEAGUE.map((t) => ({ ...t, human: false }))];
  const { rosters, leftovers } = autoDraft(teams, 10, undefined, withKingKabuto(poolMons(openRegionIds(unlocked))));
  const used = new Set([...rosters.flat(), ...leftovers]);
  const f = createFranchise(teams, rosters, [...leftovers, ...POKEMON.filter((m) => !used.has(m))]);
  if (unlocked.length) f.unlockedRegions = unlocked;
  return f;
}

function measure(f: Franchise, acc: Record<string, { raw: number; eff: number; later: number; laterDex: Record<string, number> }>) {
  for (const t of f.teams.slice(1)) {
    const mons = t.roster.map((u) => monOf(f, u));
    const s = bestLineup(mons).starters;
    const raw = s.reduce((a, m) => a + m.ovr, 0) / s.length;
    const a = (acc[t.abbr] ??= { raw: 0, eff: 0, later: 0, laterDex: {} });
    a.raw += raw;
    a.eff += raw + chemistry(s) + (t.boost ?? 0);
    for (const m of mons) if (m.dex > 151) { a.later++; a.laterDex[m.name] = (a.laterDex[m.name] ?? 0) + 1; }
  }
}

it('kanto ovr', () => {
  const nf: any = {}, sn: any = {};
  let boosts: Record<string, number> = {};
  for (let i = 0; i < N; i++) {
    measure(draft([]), nf);
    const f = draft(ALL);
    bringBackKanto(f);
    measure(f, sn);
    for (const t of f.teams.slice(1)) boosts[t.abbr] = t.boost ?? 0;
  }
  const fmt = (acc: any) => Object.entries(acc).map(([team, a]: any) => ({ team, raw: +(a.raw / N).toFixed(1), eff: +(a.eff / N).toFixed(1), laterPerRoster: +(a.later / N).toFixed(2), laterDex: a.laterDex }));
  writeFileSync(process.env.OVR_OUT ?? '/tmp/ovr-now.json', JSON.stringify({ n: N, boostsOnReturn: boosts, newFranchise: fmt(nf), afterSinnoh: fmt(sn) }, null, 1));
});
