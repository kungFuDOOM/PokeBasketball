// The franchise player draft: CPU teams take the best available from the same pool as the user.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { POKEMON, type Mon } from '../data/pokemon';
import { LEAGUE } from '../franchise/league';
import { poolMons } from '../franchise/regions';
import { autoDraft } from '../season/team';
import { cpuPick, draftScreen, type DraftTeam } from './draft';
import { snakePicks } from './draft.logic';

/** Deterministic Math.random (mulberry32). */
function seeded(seed: number) {
  let a = seed;
  vi.spyOn(Math, 'random').mockImplementation(() => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  });
}

/** Just enough DOM for `draftScreen` to run: every element accepts anything, and clicks are captured. */
function fakeDom() {
  let click: ((e: unknown) => void) | undefined;
  const element = (): any => {
    const own: Record<string | symbol, unknown> = {
      addEventListener: (type: string, fn: (e: unknown) => void) => { if (type === 'click') click ??= fn; }, // the first one is the draft screen's own
      querySelector: (s: string) => (s === '#sum-name' || s === '.sw.on' ? null : element()),
      querySelectorAll: () => [],
      [Symbol.toPrimitive]: () => '',
    };
    return new Proxy(function () {}, {
      get: (_, k) => (k in own ? own[k] : (own[k] = element())),
      set: (_, k, v) => { own[k] = v; return true; },
      apply: () => element(),
    });
  };
  vi.stubGlobal('document', element());
  vi.stubGlobal('window', { setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {}, matchMedia: () => ({ matches: true }) });
  /** Clicks the button with this `data-a`. */
  const press = (a: string) => click!({ stopPropagation: () => {}, preventDefault: () => {}, target: {
    closest: (s: string) => (s === '[data-a]' || s === `[data-a="${a}"]` ? { dataset: { a } } : null),
    classList: { contains: () => false },
  } });
  return { root: element(), press };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('the franchise player draft with only Kanto open', () => {
  it('drafts from poolMons([kanto]); CPU teams take the best available from it', () => {
    const { root, press } = fakeDom();
    const teams: DraftTeam[] = [{ name: 'Me', abbr: 'MEE', color: '#000000', color2: '#ffffff', human: true }, ...LEAGUE.map((t) => ({ ...t, human: false }))];
    const order = teams.map((_, i) => i);
    const state = { teams, order, taken: [] as number[], rounds: 10, regions: ['kanto'] };
    const pool = poolMons(['kanto']);
    let result: { rosters: Mon[][]; leftovers: Mon[] } | undefined;
    seeded(7);
    // The same options as `draft` in main.ts.
    draftScreen(root, state, { blip: () => {} } as never, (rosters, leftovers) => { result = { rosters, leftovers }; }, () => {}, () => {},
      { pool });
    press('sim');
    press('continue');
    const { rosters, leftovers } = result!;

    const dexes = (mons: Mon[]) => mons.map((m) => m.dex).sort((a, b) => a - b);
    expect(dexes([...rosters.flat(), ...leftovers])).toEqual(dexes(pool));

    // Pick by pick, it is plain `cpuPick`: no locked stars, no strongest-first gym drafter.
    seeded(7);
    const left = [...pool].sort((a, b) => b.ovr - a.ovr);
    const want: Mon[][] = teams.map(() => []);
    for (const t of snakePicks(order, 10)) {
      const m = cpuPick(left, want[t]);
      left.splice(left.indexOf(m), 1);
      want[t].push(m);
    }
    expect(rosters.map(dexes)).toEqual(want.map(dexes));
  });
});

describe('cpuPick is best available', () => {
  it('always takes the highest OVR that fits an open slot', () => {
    const card = (name: string, ovr: number, pos: Mon['pos'], type: Mon['types'][number]) => ({ ...POKEMON[0], name, ovr, pos, types: [type] }) as Mon;
    const arceus = card('Arceus', 97, 'C', 'Normal');
    const mewtwo = card('Mewtwo', 96, 'SF', 'Psychic');
    const water = card('Water star', 94, 'PG', 'Water');
    const gym = { ...LEAGUE.find((t) => t.types?.includes('Water'))!, human: false };
    for (const r of [0, 0.5, 0.999999]) {
      // A Water gym still takes Arceus, even as its third pick with no Water player yet.
      expect(cpuPick([water, mewtwo, arceus], [], () => r)).toBe(arceus);
      expect(cpuPick([water, mewtwo, arceus], [card('A', 90, 'SG', 'Fire'), card('B', 90, 'PF', 'Fire')], () => r)).toBe(arceus);
      // Two centers already: Arceus doesn't fit, so the next highest does.
      expect(cpuPick([water, arceus, mewtwo], [card('C1', 90, 'C', 'Rock'), card('C2', 89, 'C', 'Rock')], () => r)).toBe(mewtwo);
      // One center is not a reason to prefer an empty position.
      expect(cpuPick([mewtwo, arceus], [card('C1', 90, 'C', 'Rock')], () => r)).toBe(arceus);
      // Nothing fits: highest OVR.
      expect(cpuPick([card('C3', 80, 'C', 'Rock'), arceus], [arceus, arceus], () => r)).toBe(arceus);
    }
    vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    expect(autoDraft([gym], 1, undefined, [water, mewtwo, arceus]).rosters[0]).toEqual([arceus]);
  });
});
