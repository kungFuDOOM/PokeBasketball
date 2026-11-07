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
 * Johto's teams have fixed rosters (no Johto starters in any gym), ten fully evolved Pokémon each: the region's own
 * generation plus at most two on-type stars from Gen 1, never a later one. The five who start are picked by the same
 * `bestLineup` the games use, so they are built to play five natural positions (that is the +2 chemistry) and every
 * one of them is 70+ OVR; where Johto has too few Pokémon of the gym's type at a position, the strongest Gen 2
 * Pokémon of another type fills it. The boosts ramp the finished starting fives to a Kanto-like climb, a little above
 * it for a team that has already won Kanto: about 86 effective at Violet up to 91 at Blackthorn and 93 for the Elite.
 * The stars are the strongest Gen 1 Pokémon of each gym's type (Charizard and Dragonite for Falkner, Snorlax for
 * Whitney, Lapras and Jynx for Pryce, Dragonite for Clair, Alakazam and Gengar for the Elite).
 */
export const JOHTO: RegionDef = {
  id: 'johto',
  index: 1,
  name: 'Johto',
  generation: 2,
  dex: [152, 251],
  gyms: [
    { name: 'Violet Soar', abbr: 'VIO', city: 'Violet City', color: '#8f7fd9', color2: '#1e1838', leader: 'Falkner', types: ['Flying'], boost: 0, gym: 1, badge: 'Zephyr',
      ace: 169, roster: [169, 6, 178, 227, 149, 189, 198, 226, 193, 207] },
    { name: 'Azalea Swarm', abbr: 'AZA', city: 'Azalea Town', color: '#8fb83a', color2: '#223010', leader: 'Bugsy', types: ['Bug'], boost: 3, gym: 2, badge: 'Hive',
      ace: 212, roster: [212, 169, 49, 214, 205, 193, 166, 213, 168, 127] },
    { name: 'Goldenrod Pride', abbr: 'GOL', city: 'Goldenrod City', color: '#e8b923', color2: '#3a2c06', leader: 'Whitney', types: ['Normal'], boost: 6, gym: 3, badge: 'Plain',
      ace: 143, roster: [143, 53, 233, 234, 217, 241, 242, 203, 162, 164] },
    // Gengar is Morty's ace and the one Gen 1 Ghost worth a star; Ghosts are thin in Gen 2, so Tyranitar, Espeon and
    // Heracross fill in around Misdreavus.
    { name: 'Ecruteak Specters', abbr: 'ECR', city: 'Ecruteak City', color: '#6c4fa3', color2: '#1b1230', leader: 'Morty', types: ['Ghost'], boost: 3, gym: 4, badge: 'Fog',
      ace: 94, roster: [94, 248, 200, 196, 214, 208, 229, 230, 232, 217] },
    // Heracross and the Gen 1 stars Hitmonchan and Hitmonlee; Hitmontop is the one Gen 2 Fighting type.
    { name: 'Cianwood Crushers', abbr: 'CIA', city: 'Cianwood City', color: '#c0603a', color2: '#33170c', leader: 'Chuck', types: ['Fighting'], boost: 3, gym: 5, badge: 'Storm',
      ace: 214, roster: [214, 248, 169, 107, 106, 237, 208, 232, 217, 197] },
    // Magneton, from Jasmine's Magnemite, is the one Gen 1 star; Crobat plays point guard.
    { name: 'Olivine Irons', abbr: 'OLI', city: 'Olivine City', color: '#9aa6b2', color2: '#22282e', leader: 'Jasmine', types: ['Steel'], boost: 5, gym: 6, badge: 'Mineral',
      ace: 208, roster: [208, 169, 82, 212, 227, 205, 197, 189, 242, 199] },
    // Lapras and Jynx are the Ice stars; Gen 2 has only Piloswine, Sneasel and Delibird, so Scizor and Espeon fill in.
    { name: 'Mahogany Frost', abbr: 'MAH', city: 'Mahogany Town', color: '#7fd0e8', color2: '#0e2a33', leader: 'Pryce', types: ['Ice'], boost: 7, gym: 7, badge: 'Glacier',
      ace: 131, roster: [131, 212, 124, 196, 221, 215, 225, 229, 230, 197] },
    { name: 'Blackthorn Dragons', abbr: 'BLK', city: 'Blackthorn City', color: '#3d6fd8', color2: '#0f1a3a', leader: 'Clair', types: ['Dragon'], boost: 3, gym: 8, badge: 'Rising',
      ace: 149, roster: [149, 169, 230, 212, 214, 248, 208, 232, 217, 197] },
  ],
  // Alakazam (Psychic) and Gengar (Poison) are the finale's two Gen 1 stars.
  finale: { name: 'Johto Elite', abbr: 'JOH', city: 'Indigo Plateau', title: 'Johto Elite Four & Champion Lance', color: '#b8323c', color2: '#2a0b0e',
    leader: 'Will · Koga · Bruno · Karen · Champion Lance', types: ['Psychic', 'Poison', 'Fighting', 'Dark', 'Dragon'], boost: 6, elite: true,
    ace: 248, roster: [248, 65, 196, 94, 214, 169, 229, 230, 197, 178] },
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
