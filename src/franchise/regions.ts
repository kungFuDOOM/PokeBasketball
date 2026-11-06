// Franchise regions, in the order they unlock: Kanto first, then Johto. Each region is plain data: its dex range,
// eight gyms in badge order and one final opponent. A later region is a new entry here, not new season code.
import { POKEMON, type Mon, type PokeType } from '../data/pokemon';

/** A CPU team in the league: a gym (with its badge) or the region's final opponent. */
export interface LeagueTeam {
  name: string;
  abbr: string;
  color: string;
  color2: string;
  leader: string;
  /** Types this team's GM favors in the draft. */
  types: PokeType[];
  /** Added to every rating in games: gyms get tougher in badge order and the final opponent is the final boss. */
  boost: number;
  gym?: number;
  badge?: string;
  elite?: boolean;
}

/** A region's team. Kanto's teams draft their rosters; later regions bring a fixed roster (ace first). */
export interface RegionTeam extends LeagueTeam {
  /** City, for the gym's floor. */
  city?: string;
  /** Display name for the final opponent, e.g. "Johto Elite Four & Champion Lance". */
  title?: string;
  /** Dex number of the team's star; always `roster[0]`. */
  ace?: number;
  /** Ten distinct dex numbers. Missing: the team drafts (Kanto). */
  roster?: number[];
}

export interface RegionDef {
  id: string;
  /** Unlock order: 0 is open from the start, each next region needs the one before it. */
  index: number;
  name: string;
  generation: number;
  /** Inclusive National Dex range the region adds to the franchise pool. */
  dex: [number, number];
  /** Eight gyms in badge order (`gym` 1..8). */
  gyms: RegionTeam[];
  /** The ninth opponent, last in the schedule: one composite team (the only mode for now). */
  finale: RegionTeam;
}

export const KANTO: RegionDef = {
  id: 'kanto',
  index: 0,
  name: 'Kanto',
  generation: 1,
  dex: [1, 151],
  gyms: [
    { name: 'Pewter Boulders', abbr: 'PEW', color: '#a38c63', color2: '#2e271b', leader: 'Brock', types: ['Rock'], boost: -3, gym: 1, badge: 'Boulder' },
    { name: 'Cerulean Cascades', abbr: 'CER', color: '#2bb3d6', color2: '#0b2c38', leader: 'Misty', types: ['Water'], boost: -2, gym: 2, badge: 'Cascade' },
    { name: 'Vermilion Thunder', abbr: 'VER', color: '#f2c522', color2: '#3a2f06', leader: 'Lt. Surge', types: ['Electric'], boost: -1, gym: 3, badge: 'Thunder' },
    { name: 'Celadon Rainbows', abbr: 'CEL', color: '#5cb85c', color2: '#13301a', leader: 'Erika', types: ['Grass'], boost: 0, gym: 4, badge: 'Rainbow' },
    { name: 'Fuchsia Ninjas', abbr: 'FCH', color: '#b04fc4', color2: '#2d1236', leader: 'Koga', types: ['Poison'], boost: 1, gym: 5, badge: 'Soul' },
    { name: 'Saffron Psychics', abbr: 'SAF', color: '#f2668b', color2: '#3a1220', leader: 'Sabrina', types: ['Psychic'], boost: 2, gym: 6, badge: 'Marsh' },
    { name: 'Cinnabar Volcanoes', abbr: 'CIN', color: '#e8622c', color2: '#3d160b', leader: 'Blaine', types: ['Fire'], boost: 2, gym: 7, badge: 'Volcano' },
    { name: 'Viridian Quakes', abbr: 'VIR', color: '#7c9a3a', color2: '#1e2a0e', leader: 'Giovanni', types: ['Ground'], boost: 3, gym: 8, badge: 'Earth' },
  ],
  finale: { name: 'Indigo Elite', abbr: 'E4', color: '#d4a017', color2: '#2a2106', leader: 'The Elite Four', types: ['Ice', 'Fighting', 'Ghost', 'Dragon'], boost: 4, elite: true },
};

/**
 * Johto's teams have fixed rosters (no Johto starters in any gym), so their starting fives sit below Kanto's drafted
 * teams; the boosts, higher than Kanto's, make up part of that for a team that has already won Kanto.
 *
 * Star rule (every region after the first): a gym's roster is its own generation's Pokémon plus at most two on-type
 * stars from earlier generations, never a later one. Johto's stars are the leaders' Kanto signatures: Falkner's
 * Pidgeot, Bugsy's Scyther and Pinsir, Whitney's Snorlax and Tauros, Morty's Gengar and Haunter, Chuck's Poliwrath
 * and Hitmonlee, Jasmine's Magneton, Pryce's Lapras and Dewgong, Clair's Dragonite and Dragonair.
 */
export const JOHTO: RegionDef = {
  id: 'johto',
  index: 1,
  name: 'Johto',
  generation: 2,
  dex: [152, 251],
  gyms: [
    { name: 'Violet Soar', abbr: 'VIO', city: 'Violet City', color: '#8f7fd9', color2: '#1e1838', leader: 'Falkner', types: ['Flying'], boost: 3, gym: 1, badge: 'Zephyr',
      ace: 18, roster: [18, 164, 163, 177, 178, 226, 176, 193, 227, 198] },
    { name: 'Azalea Swarm', abbr: 'AZA', city: 'Azalea Town', color: '#8fb83a', color2: '#223010', leader: 'Bugsy', types: ['Bug'], boost: 4, gym: 2, badge: 'Hive',
      ace: 212, roster: [212, 123, 213, 205, 214, 168, 127, 167, 166, 165] },
    { name: 'Goldenrod Pride', abbr: 'GOL', city: 'Goldenrod City', color: '#e8b923', color2: '#3a2c06', leader: 'Whitney', types: ['Normal'], boost: 4, gym: 3, badge: 'Plain',
      ace: 241, roster: [241, 143, 128, 242, 233, 162, 203, 234, 235, 190] },
    // Gengar is Morty's ace, as in the games. Ariados (PF) and Tyranitar (C) fill the frontcourt: the only Ghosts up to
    // Gen 2 are the Gastly line and Misdreavus.
    { name: 'Ecruteak Specters', abbr: 'ECR', city: 'Ecruteak City', color: '#6c4fa3', color2: '#1b1230', leader: 'Morty', types: ['Ghost'], boost: 5, gym: 4, badge: 'Fog',
      ace: 94, roster: [94, 200, 93, 248, 168, 198, 202, 199, 197, 177] },
    // Poliwrath, Chuck's ace in the games, and Hitmonlee lead; Hitmontop and Tyrogue are the Gen 2 Fighting types.
    { name: 'Cianwood Crushers', abbr: 'CIA', city: 'Cianwood City', color: '#c0603a', color2: '#33170c', leader: 'Chuck', types: ['Fighting'], boost: 5, gym: 5, badge: 'Storm',
      ace: 62, roster: [62, 106, 237, 236, 232, 234, 195, 210, 215, 229] },
    // Magneton, from Jasmine's Magnemite. Chinchou (PG, Water/Electric) is the natural point guard.
    { name: 'Olivine Irons', abbr: 'OLI', city: 'Olivine City', color: '#9aa6b2', color2: '#22282e', leader: 'Jasmine', types: ['Steel'], boost: 6, gym: 6, badge: 'Mineral',
      ace: 208, roster: [208, 82, 212, 227, 205, 181, 171, 170, 195, 224] },
    // Lapras and Pryce's Dewgong are the Ice stars (Piloswine stays Piloswine: no later-generation evolutions here).
    { name: 'Mahogany Frost', abbr: 'MAH', city: 'Mahogany Town', color: '#7fd0e8', color2: '#0e2a33', leader: 'Pryce', types: ['Ice'], boost: 6, gym: 7, badge: 'Glacier',
      ace: 221, roster: [221, 131, 87, 225, 215, 238, 220, 226, 224, 186] },
    { name: 'Blackthorn Dragons', abbr: 'BLK', city: 'Blackthorn City', color: '#3d6fd8', color2: '#0f1a3a', leader: 'Clair', types: ['Dragon'], boost: 7, gym: 8, badge: 'Rising',
      ace: 230, roster: [230, 149, 148, 248, 247, 169, 207, 195, 227, 240] },
  ],
  // Lance's Dragonite (#149) is the finale's one earlier-generation star.
  finale: { name: 'Johto Elite', abbr: 'JOH', city: 'Indigo Plateau', title: 'Johto Elite Four & Champion Lance', color: '#b8323c', color2: '#2a0b0e',
    leader: 'Will · Koga · Bruno · Karen · Champion Lance', types: ['Psychic', 'Poison', 'Fighting', 'Dark', 'Dragon'], boost: 8, elite: true,
    ace: 149, roster: [149, 178, 169, 214, 248, 230, 196, 197, 237, 205] },
};

/** Every region, in unlock order. */
export const REGIONS: RegionDef[] = [KANTO, JOHTO];

export const regionById = (id: unknown): RegionDef | undefined => REGIONS.find((r) => r.id === id);

/** A region's nine CPU teams: the gyms in badge order, then the final opponent. */
export const regionTeams = (r: RegionDef): RegionTeam[] => [...r.gyms, r.finale];

/** The region after `r`, if any. */
export const nextRegion = (r: RegionDef): RegionDef | undefined => REGIONS.find((x) => x.index === r.index + 1);

/** Region ids whose Pokémon a franchise may draft and sign: the first region plus every unlocked one. */
export const openRegionIds = (unlocked: readonly string[] = []): string[] =>
  REGIONS.filter((r) => r.index === 0 || unlocked.indexOf(r.id) >= 0).map((r) => r.id);

/**
 * Whether a franchise may pick up `dex`, given its open regions (`openRegionIds`). Only the dex ranges of locked
 * regions are held back; Pokémon from outside every region range stay available as they always have.
 */
export function inPool(dex: number, open: readonly string[]): boolean {
  return !REGIONS.some((r) => open.indexOf(r.id) < 0 && dex >= r.dex[0] && dex <= r.dex[1]);
}

/** The franchise draft pool. `open` missing means no limit (Quick Play, Season Draft and drafts saved before regions). */
export const poolMons = (open?: readonly string[]): Mon[] => (open ? POKEMON.filter((m) => inPool(m.dex, open)) : [...POKEMON]);
