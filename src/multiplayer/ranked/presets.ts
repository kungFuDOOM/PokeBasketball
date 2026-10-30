import { monByDex, type Mon } from '../../data/pokemon';

/** A fixed Ranked team. Both players pick one blind before the match. `dex` is ordered PG, SG, SF, PF, C. */
export interface RankedPreset {
  id: 'A' | 'B' | 'C' | 'D' | 'E' | 'F';
  name: string;
  dex: [number, number, number, number, number];
}

/**
 * The six Ranked teams. Every one totals exactly 425 OVR (an 85 average), every member is Ranked-legal
 * (isRankedLegal) and rated 81-88, no Pokémon is on two teams, and each team's raw ratings stay close to the
 * others' (see presets.test.ts). Keep the server seed (migration 20261120) in step with this list.
 */
export const RANKED_PRESETS: readonly RankedPreset[] = [
  { id: 'A', name: 'Night Furnace', dex: [78, 229, 94, 9, 208] }, // Rapidash, Houndoom, Gengar, Blastoise, Steelix
  { id: 'B', name: 'Jungle Fury', dex: [254, 392, 475, 115, 130] }, // Sceptile, Infernape, Gallade, Kangaskhan, Gyarados
  { id: 'C', name: 'Iron Bloom', dex: [135, 142, 212, 31, 3] }, // Jolteon, Aerodactyl, Scizor, Nidoqueen, Venusaur
  { id: 'D', name: 'Fang & Fist', dex: [571, 448, 612, 62, 697] }, // Zoroark, Lucario, Haxorus, Poliwrath, Tyrantrum
  { id: 'E', name: 'Sky Hammers', dex: [169, 959, 257, 628, 465] }, // Crobat, Tinkaton, Blaziken, Braviary, Tangrowth
  { id: 'F', name: 'Dragon Mind', dex: [65, 123, 635, 373, 473] }, // Alakazam, Scyther, Hydreigon, Salamence, Mamoswine
];

/**
 * A fingerprint of both rosters (home then away, dex ids in order): 32-bit FNV-1a. Ranked players swap it in the
 * handshake, so two clients that would build different games refuse to start.
 */
export function rosterDigest(dex: number[][]): number {
  let h = 0x811c9dc5;
  for (const id of dex.flat()) {
    h ^= id;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

/** A preset's five, PG to C. */
export function presetRoster(id: RankedPreset['id']): Mon[] {
  const p = RANKED_PRESETS.find((x) => x.id === id);
  if (!p) throw new Error(`unknown ranked preset ${id}`);
  return p.dex.map(monByDex);
}
