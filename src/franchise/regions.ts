// Franchise regions, in the order they unlock: Kanto, then Johto, then Hoenn, then Sinnoh. Each region is plain data: its dex
// range, eight gyms in badge order and one final opponent. A later region is a new entry here, not new season code
// (see "Franchise regions" in the README).
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
  /**
   * Dex number of the star the team locks before the draft. It always starts. The rest of the roster is drafted (see
   * `kantoDraft.ts`). Every gym and finale has one except the Indigo Elite.
   */
  star?: number;
}

/** A region's team. Every region's teams draft their rosters around their stars; later regions add a city. */
export interface RegionTeam extends LeagueTeam {
  /** City, for the gym's floor. */
  city?: string;
  /** Display name for the final opponent, e.g. "Johto Elite Four & Champion Lance". */
  title?: string;
}

export interface RegionDef {
  id: string;
  /** Unlock order: 0 is open from the start, each next region needs the one before it. */
  index: number;
  name: string;
  generation: number;
  /** Inclusive National Dex range the region adds to the franchise pool. */
  dex: [number, number];
  /**
   * Dex numbers inside `dex` that were in the game before the region was added: they stay in every franchise pool,
   * locked region or not, so nobody loses a Pokémon they could already draft.
   */
  open?: number[];
  /** Eight gyms in badge order (`gym` 1..8). */
  gyms: RegionTeam[];
  /** The ninth opponent, last in the schedule: one composite team (the only mode for now). */
  finale: RegionTeam;
}

/** Bump when any region's gym stars, drafter or boosts change: older saves rebuild their gyms and Elite once on load. */
export const GYMS_REV = 6;
/** The name from when only Kanto's teams were rebuilt. */
export const KANTO_GYMS_REV = GYMS_REV;

export const KANTO: RegionDef = {
  id: 'kanto',
  index: 0,
  name: 'Kanto',
  generation: 1,
  dex: [1, 151],
  // Each gym locks its star, then drafts the best Pokémon left (from every region, see `kantoDraft.ts`) at every other
  // spot. The star is the gym's best Gen 1 family Pokémon of its type or its legendary; Koga's Articuno and Giovanni's
  // Mewtwo are legendaries that are off type. The boosts are small and are set so that game strength (card OVR plus
  // boost) rises with every badge; they only fill the gaps the drafted cards leave, so they need not rise themselves.
  gyms: [
    { name: 'Pewter Boulders', abbr: 'PEW', color: '#a38c63', color2: '#2e271b', leader: 'Brock', types: ['Rock'], boost: 0, gym: 1, badge: 'Boulder', star: 464 },
    { name: 'Cerulean Cascades', abbr: 'CER', color: '#2bb3d6', color2: '#0b2c38', leader: 'Misty', types: ['Water'], boost: 0, gym: 2, badge: 'Cascade', star: 9 },
    { name: 'Vermilion Thunder', abbr: 'VER', color: '#f2c522', color2: '#3a2f06', leader: 'Lt. Surge', types: ['Electric'], boost: 0, gym: 3, badge: 'Thunder', star: 145 },
    { name: 'Celadon Rainbows', abbr: 'CEL', color: '#5cb85c', color2: '#13301a', leader: 'Erika', types: ['Grass'], boost: 2, gym: 4, badge: 'Rainbow', star: 3 },
    { name: 'Fuchsia Ninjas', abbr: 'FCH', color: '#b04fc4', color2: '#2d1236', leader: 'Koga', types: ['Poison'], boost: 2, gym: 5, badge: 'Soul', star: 144 },
    { name: 'Saffron Psychics', abbr: 'SAF', color: '#f2668b', color2: '#3a1220', leader: 'Sabrina', types: ['Psychic'], boost: 0, gym: 6, badge: 'Marsh', star: 151 },
    { name: 'Cinnabar Volcanoes', abbr: 'CIN', color: '#e8622c', color2: '#3d160b', leader: 'Blaine', types: ['Fire'], boost: 2, gym: 7, badge: 'Volcano', star: 146 },
    { name: 'Viridian Quakes', abbr: 'VIR', color: '#7c9a3a', color2: '#1e2a0e', leader: 'Giovanni', types: ['Ground'], boost: 1, gym: 8, badge: 'Earth', star: 150 },
  ],
  finale: { name: 'Indigo Elite', abbr: 'E4', color: '#d4a017', color2: '#2a2106', leader: 'The Elite Four', types: ['Ice', 'Fighting', 'Ghost', 'Dragon'], boost: 3, elite: true },
};

/**
 * Johto, Hoenn and Sinnoh draft like Kanto: each gym and final opponent locks its star, then the nine take the best
 * Pokémon left at every other spot from every region (see `kantoDraft.ts`), never one on the user's team (a team keeps
 * its star even then). No two teams in a region share a star. The team's type shows in the star and only breaks draft
 * ties. The boosts are 0 to 4 and are set, against a 91 OVR user team, so that game strength (card OVR plus boost)
 * rises with every badge and the final opponent tops gym 8; they are all the boost a gym ever gets.
 *
 * Johto's gym 1 card is already 90, so its ramp runs 90 to 97; Hoenn's and Sinnoh's run 89 to 96. All three finals play at 99.
 */
export const JOHTO: RegionDef = {
  id: 'johto',
  index: 1,
  name: 'Johto',
  generation: 2,
  dex: [152, 251],
  gyms: [
    { name: 'Violet Soar', abbr: 'VIO', city: 'Violet City', color: '#8f7fd9', color2: '#1e1838', leader: 'Falkner', types: ['Flying'], boost: 0, gym: 1, badge: 'Zephyr', star: 169 },
    { name: 'Azalea Swarm', abbr: 'AZA', city: 'Azalea Town', color: '#8fb83a', color2: '#223010', leader: 'Bugsy', types: ['Bug'], boost: 2, gym: 2, badge: 'Hive', star: 212 },
    { name: 'Goldenrod Pride', abbr: 'GOL', city: 'Goldenrod City', color: '#e8b923', color2: '#3a2c06', leader: 'Whitney', types: ['Normal'], boost: 2, gym: 3, badge: 'Plain', star: 143 },
    { name: 'Ecruteak Specters', abbr: 'ECR', city: 'Ecruteak City', color: '#6c4fa3', color2: '#1b1230', leader: 'Morty', types: ['Ghost'], boost: 3, gym: 4, badge: 'Fog', star: 94 },
    { name: 'Cianwood Crushers', abbr: 'CIA', city: 'Cianwood City', color: '#c0603a', color2: '#33170c', leader: 'Chuck', types: ['Fighting'], boost: 3, gym: 5, badge: 'Storm', star: 214 },
    { name: 'Olivine Irons', abbr: 'OLI', city: 'Olivine City', color: '#9aa6b2', color2: '#22282e', leader: 'Jasmine', types: ['Steel'], boost: 3, gym: 6, badge: 'Mineral', star: 208 },
    { name: 'Mahogany Frost', abbr: 'MAH', city: 'Mahogany Town', color: '#7fd0e8', color2: '#0e2a33', leader: 'Pryce', types: ['Ice'], boost: 4, gym: 7, badge: 'Glacier', star: 131 },
    { name: 'Blackthorn Dragons', abbr: 'BLK', city: 'Blackthorn City', color: '#3d6fd8', color2: '#0f1a3a', leader: 'Clair', types: ['Dragon'], boost: 3, gym: 8, badge: 'Rising', star: 149 },
  ],
  finale: { name: 'Johto Elite', abbr: 'JOH', city: 'Indigo Plateau', title: 'Johto Elite Four & Champion Lance', color: '#b8323c', color2: '#2a0b0e',
    leader: 'Will · Koga · Bruno · Karen · Champion Lance', types: ['Psychic', 'Poison', 'Fighting', 'Dark', 'Dragon'], boost: 3, elite: true, star: 248 },
};

/**
 * Hoenn (see Johto's comment for how its teams are built). Steven keeps Metagross, so Tate & Liza's star is Espeon.
 */
export const HOENN: RegionDef = {
  id: 'hoenn',
  index: 2,
  name: 'Hoenn',
  generation: 3,
  dex: [252, 386],
  // The fourteen Hoenn Pokémon hand-tuned before the region existed.
  open: [254, 257, 260, 282, 303, 310, 350, 373, 376, 380, 381, 382, 383, 384],
  gyms: [
    { name: 'Rustboro Stones', abbr: 'RUS', city: 'Rustboro City', color: '#b08d57', color2: '#2e2414', leader: 'Roxanne', types: ['Rock'], boost: 0, gym: 1, badge: 'Stone', star: 306 },
    { name: 'Dewford Breakers', abbr: 'DEW', city: 'Dewford Town', color: '#d0703a', color2: '#35180a', leader: 'Brawly', types: ['Fighting'], boost: 2, gym: 2, badge: 'Knuckle', star: 297 },
    { name: 'Mauville Dynamos', abbr: 'MAU', city: 'Mauville City', color: '#f5c518', color2: '#3a2f06', leader: 'Wattson', types: ['Electric'], boost: 2, gym: 3, badge: 'Dynamo', star: 310 },
    { name: 'Lavaridge Flames', abbr: 'LAV', city: 'Lavaridge Town', color: '#e2492f', color2: '#3a120b', leader: 'Flannery', types: ['Fire'], boost: 0, gym: 4, badge: 'Heat', star: 6 },
    { name: 'Petalburg Balance', abbr: 'PET', city: 'Petalburg City', color: '#a8a77a', color2: '#2a2a1c', leader: 'Norman', types: ['Normal'], boost: 1, gym: 5, badge: 'Balance', star: 289 },
    { name: 'Fortree Feathers', abbr: 'FOR', city: 'Fortree City', color: '#6fb7e8', color2: '#0f2a3a', leader: 'Winona', types: ['Flying'], boost: 2, gym: 6, badge: 'Feather', star: 373 },
    { name: 'Mossdeep Minds', abbr: 'MOS', city: 'Mossdeep City', color: '#e05a9c', color2: '#3a1026', leader: 'Tate & Liza', types: ['Psychic'], boost: 2, gym: 7, badge: 'Mind', star: 196 },
    { name: 'Sootopolis Rain', abbr: 'SOO', city: 'Sootopolis City', color: '#2f78d0', color2: '#0c1e38', leader: 'Juan', types: ['Water'], boost: 1, gym: 8, badge: 'Rain', star: 121 },
  ],
  finale: { name: 'Hoenn Elite', abbr: 'EVR', city: 'Ever Grande City', title: 'Hoenn Elite Four & Champion Steven', color: '#5b7fa6', color2: '#141f2c',
    leader: 'Sidney · Phoebe · Glacia · Drake · Champion Steven', types: ['Dark', 'Ghost', 'Ice', 'Dragon', 'Steel'], boost: 3, elite: true, star: 376 },
};

/**
 * Sinnoh (see Johto's comment for how its teams are built). Maylene keeps Lucario, so Byron's star is his Steelix.
 */
export const SINNOH: RegionDef = {
  id: 'sinnoh',
  index: 3,
  name: 'Sinnoh',
  generation: 4,
  dex: [387, 493],
  // The fifteen Sinnoh Pokémon hand-tuned before the region existed.
  open: [392, 405, 437, 445, 448, 454, 461, 462, 464, 465, 466, 468, 470, 473, 475],
  gyms: [
    { name: 'Oreburgh Miners', abbr: 'ORE', city: 'Oreburgh City', color: '#8a8f99', color2: '#22252b', leader: 'Roark', types: ['Rock'], boost: 1, gym: 1, badge: 'Coal', star: 464 },
    { name: 'Eterna Blooms', abbr: 'ETE', city: 'Eterna City', color: '#5fb05a', color2: '#143018', leader: 'Gardenia', types: ['Grass'], boost: 1, gym: 2, badge: 'Forest', star: 465 },
    { name: 'Veilstone Brawlers', abbr: 'VEI', city: 'Veilstone City', color: '#c8553d', color2: '#34120b', leader: 'Maylene', types: ['Fighting'], boost: 0, gym: 3, badge: 'Cobble', star: 448 },
    { name: 'Pastoria Marshes', abbr: 'PAS', city: 'Pastoria City', color: '#3f9bd6', color2: '#0d2a40', leader: 'Crasher Wake', types: ['Water'], boost: 2, gym: 4, badge: 'Fen', star: 419 },
    { name: 'Hearthome Phantoms', abbr: 'HEA', city: 'Hearthome City', color: '#8a5ec4', color2: '#22123a', leader: 'Fantina', types: ['Ghost'], boost: 2, gym: 5, badge: 'Relic', star: 429 },
    { name: 'Canalave Anchors', abbr: 'CAN', city: 'Canalave City', color: '#7d8fa3', color2: '#1a222b', leader: 'Byron', types: ['Steel'], boost: 2, gym: 6, badge: 'Mine', star: 208 },
    { name: 'Snowpoint Blizzards', abbr: 'SNO', city: 'Snowpoint City', color: '#9fdcf2', color2: '#10303d', leader: 'Candice', types: ['Ice'], boost: 1, gym: 7, badge: 'Icicle', star: 461 },
    { name: 'Sunyshore Voltage', abbr: 'SUN', city: 'Sunyshore City', color: '#f2cf2f', color2: '#3a3006', leader: 'Volkner', types: ['Electric'], boost: 4, gym: 8, badge: 'Beacon', star: 466 },
  ],
  // Cynthia's Garchomp leads.
  finale: { name: 'Sinnoh Elite', abbr: 'SNL', city: 'Sinnoh League', title: 'Sinnoh Elite Four & Champion Cynthia', color: '#6a5acd', color2: '#16123a',
    leader: 'Aaron · Bertha · Flint · Lucian · Champion Cynthia', types: ['Bug', 'Ground', 'Fire', 'Psychic', 'Dragon'], boost: 3, elite: true, star: 445 },
};

/** Every region, in unlock order. */
export const REGIONS: RegionDef[] = [KANTO, JOHTO, HOENN, SINNOH];

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
 * regions are held back, less each region's `open` list; Pokémon from outside every region range stay available
 * as they always have.
 */
export function inPool(dex: number, open: readonly string[]): boolean {
  return !REGIONS.some((r) => open.indexOf(r.id) < 0 && dex >= r.dex[0] && dex <= r.dex[1] && !(r.open ?? []).includes(dex));
}

/**
 * Extra boost for the nine Kanto CPU teams (gyms in badge order, then the Elite) when the league returns to Kanto after a
 * Sinnoh title. The user's roster then holds later-gen Pokémon, so the same Kanto fives need a little more to feel the
 * same. Fixed per slot, added in `bringBackKanto`; a new franchise does not use it.
 */
export const KANTO_RETURN_BUMP: readonly number[] = [1, 1, 2, 2, 2, 2, 1, 2, 2];

/** The franchise draft pool. `open` missing means no limit (Quick Play, Season Draft and drafts saved before regions). */
export const poolMons = (open?: readonly string[]): Mon[] => (open ? POKEMON.filter((m) => inPool(m.dex, open)) : [...POKEMON]);
