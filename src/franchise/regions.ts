// Franchise regions, in the order they unlock: Kanto, then Johto, then Hoenn, then Sinnoh. Each region is plain data: its dex
// range, eight gyms in badge order and one final opponent. A later region is a new entry here, not new season code
// (see "Franchise regions" in the README).
import { EVOLUTIONS, POKEMON, type Mon, type PokeType } from '../data/pokemon';

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
  /** Dex number of the team's star; always `roster[0]`. */
  ace?: number;
  /** Ten distinct dex numbers. Missing: the team drafts (the Indigo Elite). */
  roster?: number[];
}

/** A region's team. The Indigo Elite drafts; every gym brings a fixed roster (ace first). */
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

export const KANTO: RegionDef = {
  id: 'kanto',
  index: 0,
  name: 'Kanto',
  generation: 1,
  dex: [1, 151],
  // Hand-made Gen 1 lines. `bestLineup` picks the five, one per position. The card OVR is that five's rounded
  // mean: about 88 at Pewter, climbing to the low 90s at Viridian. Boosts stay 0-4. Brock and Misty have no
  // legendary. From Vermilion on, each gym has exactly one and that one starts. Erika has none (Celebi is Gen 2).
  gyms: [
    // Golem starts at power forward. Aerodactyl, Kabutops and Rhyperior are the other rock stars. Dugtrio is the
    // point guard: no rock plays PG. Onix, Omastar, Rhydon, Rhyhorn and Graveler are the bench.
    { name: 'Pewter Boulders', abbr: 'PEW', color: '#a38c63', color2: '#2e271b', leader: 'Brock', types: ['Rock'], boost: 0, gym: 1, badge: 'Boulder',
      ace: 76, roster: [76, 142, 141, 51, 464, 139, 95, 112, 111, 75] },
    // Starmie, Kingdra, Vaporeon, Blastoise and Gyarados. All water.
    { name: 'Cerulean Cascades', abbr: 'CER', color: '#2bb3d6', color2: '#0b2c38', leader: 'Misty', types: ['Water'], boost: 0, gym: 2, badge: 'Cascade',
      ace: 121, roster: [121, 230, 134, 9, 130, 91, 55, 99, 73, 87] },
    // Zapdos starts at small forward. Raichu, Electrode, Electivire and Magnezone fill the other four. All electric.
    { name: 'Vermilion Thunder', abbr: 'VER', color: '#f2c522', color2: '#3a2f06', leader: 'Lt. Surge', types: ['Electric'], boost: 1, gym: 3, badge: 'Thunder',
      ace: 145, roster: [145, 26, 101, 466, 462, 135, 25, 239, 172, 81] },
    // No legendary. Venusaur starts at center, with Leafeon, Bellossom, Victreebel and Vileplume.
    { name: 'Celadon Rainbows', abbr: 'CEL', color: '#5cb85c', color2: '#13301a', leader: 'Erika', types: ['Grass'], boost: 1, gym: 4, badge: 'Rainbow',
      ace: 3, roster: [3, 470, 71, 45, 182, 465, 47, 114, 70, 69] },
    // Articuno starts. Gen 1 has no Poison legendary. Crobat, Venomoth, Nidoqueen and Muk start with him.
    { name: 'Fuchsia Ninjas', abbr: 'FCH', color: '#b04fc4', color2: '#2d1236', leader: 'Koga', types: ['Poison'], boost: 2, gym: 5, badge: 'Soul',
      ace: 144, roster: [144, 169, 49, 31, 89, 24, 110, 94, 15, 42] },
    // Mew stays at point guard. Alakazam starts at small forward beside Espeon, Hypno and Exeggutor.
    { name: 'Saffron Psychics', abbr: 'SAF', color: '#f2668b', color2: '#3a1220', leader: 'Sabrina', types: ['Psychic'], boost: 2, gym: 6, badge: 'Marsh',
      ace: 151, roster: [151, 65, 196, 97, 103, 122, 124, 199, 80, 64] },
    // Moltres starts. Charizard is left off so he cannot take the wing. Ninetales, Magmortar and Flareon start.
    // Dragonite is the center: Gen 1 has no fire center.
    { name: 'Cinnabar Volcanoes', abbr: 'CIN', color: '#e8622c', color2: '#3d160b', leader: 'Blaine', types: ['Fire'], boost: 3, gym: 7, badge: 'Volcano',
      ace: 146, roster: [146, 38, 467, 136, 149, 78, 59, 128, 463, 242] },
    // Mewtwo starts. Nidoking, Steelix and Marowak are the ground stars. Persian is the point guard: Dugtrio plays for Brock.
    { name: 'Viridian Quakes', abbr: 'VIR', color: '#7c9a3a', color2: '#1e2a0e', leader: 'Giovanni', types: ['Ground'], boost: 4, gym: 8, badge: 'Earth',
      ace: 150, roster: [150, 53, 105, 34, 208, 28, 115, 106, 57, 237] },
  ],
  finale: { name: 'Indigo Elite', abbr: 'E4', color: '#d4a017', color2: '#2a2106', leader: 'The Elite Four', types: ['Ice', 'Fighting', 'Ghost', 'Dragon'], boost: 7, elite: true },
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

/**
 * Hoenn: each roster is ten fully evolved Pokémon, the region's own Gen 3 (#252-386, no starters, no legendaries) plus
 * at most two on-type stars from Gens 1-2, never a later generation; the finale stays all Gen 3. The five who start
 * come from the same `bestLineup` the games use, so each roster is built to play five natural positions (the +2
 * chemistry) with every starter 70+ OVR. Hoenn is thin at some positions in some types (no Rock point guard, no
 * Electric center), so the strongest Gen 3 Pokémon of another type fills the gap rather than a weak on-type one.
 * The stars are the best on-type picks: Roxanne's Aerodactyl and Kabutops, Brawly's Hitmonchan and Hitmonlee,
 * Wattson's Magneton and Ampharos, Flannery's Houndoom and Charizard, Norman's Porygon2 and Kangaskhan, Winona's
 * Charizard and Dragonite, Tate & Liza's Espeon and Girafarig, Juan's Starmie and Kingdra. The boosts then ramp the
 * starting fives to a Kanto-like climb, a little above it for a team that has beaten two regions.
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
    { name: 'Rustboro Stones', abbr: 'RUS', city: 'Rustboro City', color: '#b08d57', color2: '#2e2414', leader: 'Roxanne', types: ['Rock'], boost: 2, gym: 1, badge: 'Stone',
      ace: 306, roster: [306, 282, 142, 141, 369, 348, 346, 338, 337, 299] },
    { name: 'Dewford Breakers', abbr: 'DEW', city: 'Dewford Town', color: '#d0703a', color2: '#35180a', leader: 'Brawly', types: ['Fighting'], boost: 6, gym: 2, badge: 'Knuckle',
      ace: 297, roster: [297, 282, 107, 106, 286, 308, 310, 321, 291, 277] },
    { name: 'Mauville Dynamos', abbr: 'MAU', city: 'Mauville City', color: '#f5c518', color2: '#3a2f06', leader: 'Wattson', types: ['Electric'], boost: 5, gym: 3, badge: 'Dynamo',
      ace: 310, roster: [310, 289, 82, 319, 181, 311, 312, 376, 306, 297] },
    { name: 'Lavaridge Flames', abbr: 'LAV', city: 'Lavaridge Town', color: '#e2492f', color2: '#3a120b', leader: 'Flannery', types: ['Fire'], boost: 3, gym: 4, badge: 'Heat',
      ace: 6, roster: [6, 282, 229, 373, 323, 324, 350, 310, 291, 277] },
    { name: 'Petalburg Balance', abbr: 'PET', city: 'Petalburg City', color: '#a8a77a', color2: '#2a2a1c', leader: 'Norman', types: ['Normal'], boost: 7, gym: 5, badge: 'Balance',
      ace: 289, roster: [289, 277, 233, 335, 115, 295, 264, 301, 351, 352] },
    { name: 'Fortree Feathers', abbr: 'FOR', city: 'Fortree City', color: '#6fb7e8', color2: '#0f2a3a', leader: 'Winona', types: ['Flying'], boost: 4, gym: 6, badge: 'Feather',
      ace: 373, roster: [373, 6, 291, 284, 149, 277, 357, 334, 267, 279] },
    { name: 'Mossdeep Minds', abbr: 'MOS', city: 'Mossdeep City', color: '#e05a9c', color2: '#3a1026', leader: 'Tate & Liza', types: ['Psychic'], boost: 8, gym: 7, badge: 'Mind',
      ace: 376, roster: [376, 282, 196, 203, 338, 344, 326, 337, 358, 308] },
    { name: 'Sootopolis Rain', abbr: 'SOO', city: 'Sootopolis City', color: '#2f78d0', color2: '#0c1e38', leader: 'Juan', types: ['Water'], boost: 7, gym: 8, badge: 'Rain',
      ace: 121, roster: [121, 230, 319, 350, 321, 365, 369, 367, 368, 342] },
  ],
  // All Gen 3. Steven's Mawile: Steel, and from Granite Cave, where the player first meets him.
  finale: { name: 'Hoenn Elite', abbr: 'EVR', city: 'Ever Grande City', title: 'Hoenn Elite Four & Champion Steven', color: '#5b7fa6', color2: '#141f2c',
    leader: 'Sidney · Phoebe · Glacia · Drake · Champion Steven', types: ['Dark', 'Ghost', 'Ice', 'Dragon', 'Steel'], boost: 10, elite: true,
    ace: 376, roster: [376, 303, 284, 319, 373, 306, 330, 365, 275, 359] },
};

/**
 * Sinnoh: each roster is ten fully evolved Pokémon, the region's own Gen 4 (#387-493, no starters, no legendaries)
 * plus at most two on-type stars from Gens 1-3, never a later generation; the finale stays all Gen 4. The five who
 * start come from the same `bestLineup` the games use, so each roster is built to play five natural positions (the +2
 * chemistry) with every starter 70+ OVR. Gen 4 is thin in places (no Rock point guard, no Electric point guard worth
 * the name, few Ghost or Water big men), so the strongest Gen 4 Pokémon of another type fills the gap, and strong
 * off-type Pokémon are left off a roster that would let them take a starting spot from the gym's own. The stars are
 * the best on-type picks: Roark's Aerodactyl and Kabutops, Gardenia's Victreebel, Maylene's Machamp and Hariyama,
 * Crasher Wake's Starmie and Milotic, Fantina's Gengar, Byron's Scizor and Steelix, Volkner's Jolteon; Candice and
 * the Elite are all Gen 4. The boosts then ramp the starting fives to a Kanto-like climb, as in Johto and Hoenn.
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
    { name: 'Oreburgh Miners', abbr: 'ORE', city: 'Oreburgh City', color: '#8a8f99', color2: '#22252b', leader: 'Roark', types: ['Rock'], boost: 3, gym: 1, badge: 'Coal',
      ace: 464, roster: [464, 429, 409, 142, 141, 476, 411, 398, 467, 437] },
    { name: 'Eterna Blooms', abbr: 'ETE', city: 'Eterna City', color: '#5fb05a', color2: '#143018', leader: 'Gardenia', types: ['Grass'], boost: 4, gym: 2, badge: 'Forest',
      ace: 465, roster: [465, 407, 470, 71, 460, 455, 471, 421, 424, 452] },
    { name: 'Veilstone Brawlers', abbr: 'VEI', city: 'Veilstone City', color: '#c8553d', color2: '#34120b', leader: 'Maylene', types: ['Fighting'], boost: 2, gym: 3, badge: 'Cobble',
      ace: 448, roster: [448, 68, 297, 475, 454, 468, 429, 452, 424, 477] },
    { name: 'Pastoria Marshes', abbr: 'PAS', city: 'Pastoria City', color: '#3f9bd6', color2: '#0d2a40', leader: 'Crasher Wake', types: ['Water'], boost: 5, gym: 4, badge: 'Fen',
      ace: 419, roster: [419, 121, 350, 457, 472, 423, 424, 430, 468, 452] },
    { name: 'Hearthome Phantoms', abbr: 'HEA', city: 'Hearthome City', color: '#8a5ec4', color2: '#22123a', leader: 'Fantina', types: ['Ghost'], boost: 7, gym: 5, badge: 'Relic',
      ace: 429, roster: [429, 477, 426, 478, 94, 467, 479, 442, 424, 430] },
    { name: 'Canalave Anchors', abbr: 'CAN', city: 'Canalave City', color: '#7d8fa3', color2: '#1a222b', leader: 'Byron', types: ['Steel'], boost: 3, gym: 6, badge: 'Mine',
      ace: 448, roster: [448, 462, 437, 212, 208, 476, 411, 468, 429, 424] },
    { name: 'Snowpoint Blizzards', abbr: 'SNO', city: 'Snowpoint City', color: '#9fdcf2', color2: '#10303d', leader: 'Candice', types: ['Ice'], boost: 9, gym: 7, badge: 'Icicle',
      ace: 461, roster: [461, 471, 478, 473, 460, 452, 424, 468, 477, 463] },
    { name: 'Sunyshore Voltage', abbr: 'SUN', city: 'Sunyshore City', color: '#f2cf2f', color2: '#3a3006', leader: 'Volkner', types: ['Electric'], boost: 6, gym: 8, badge: 'Beacon',
      ace: 466, roster: [466, 405, 462, 135, 465, 467, 479, 468, 463, 424] },
  ],
  // All Gen 4. Cynthia's Garchomp leads; Aaron's Yanmega, Bertha's Hippowdon, Flint's Magmortar and Lucian's Gallade.
  finale: { name: 'Sinnoh Elite', abbr: 'SNL', city: 'Sinnoh League', title: 'Sinnoh Elite Four & Champion Cynthia', color: '#6a5acd', color2: '#16123a',
    leader: 'Aaron · Bertha · Flint · Lucian · Champion Cynthia', types: ['Bug', 'Ground', 'Fire', 'Psychic', 'Dragon'], boost: 7, elite: true,
    ace: 445, roster: [445, 450, 467, 475, 469, 468, 437, 472, 464, 429] },
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
 * Dex numbers of later-gen Pokémon whose evolution family contains a Gen 1 (dex 1-151) member, built from `EVOLUTIONS`
 * in both directions (a baby like Pichu is in Pikachu's family). Mamoswine, Togekiss, Garchomp and the like have no
 * Gen 1 relative, so they are not here.
 */
const gen1FamilyDexes = (): ReadonlySet<number> => {
  const adj = new Map<number, Set<number>>();
  const link = (a: number, b: number) => {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a)!.add(b);
    adj.get(b)!.add(a);
  };
  for (const [from, e] of Object.entries(EVOLUTIONS)) for (const to of e.to) link(Number(from), to);
  const out = new Set<number>();
  const seen = new Set<number>();
  for (const start of adj.keys()) {
    if (seen.has(start)) continue;
    const fam = [start];
    seen.add(start);
    for (let i = 0; i < fam.length; i++) for (const n of adj.get(fam[i])!) if (!seen.has(n)) { seen.add(n); fam.push(n); }
    if (fam.some((d) => d <= KANTO.dex[1])) for (const d of fam) out.add(d);
  }
  return out;
};
let familyCache: ReadonlySet<number> | undefined;

/** Whether `dex` is a later-gen Pokémon in a Gen 1 evolution family (Scizor, Steelix, Blissey, Pichu, ...). */
export const isGen1FamilyDex = (dex: number): boolean => dex > KANTO.dex[1] && (familyCache ??= gen1FamilyDexes()).has(dex);

/**
 * The Indigo Elite drafts Gen 1 plus later-gen Pokémon in a Gen 1 evolution family, whatever the user's pool holds
 * (including the Hoenn/Sinnoh `open` exceptions). The eight gyms do not draft: they keep the rosters above. This is
 * only a CPU rule: the user's draft, free agents and trades use `poolMons`.
 */
export const isKantoCpuMon = (m: Pick<Mon, 'dex'>): boolean => (m.dex >= KANTO.dex[0] && m.dex <= KANTO.dex[1]) || isGen1FamilyDex(m.dex);

/**
 * Extra boost for the nine Kanto CPU teams (gyms in badge order, then the Elite) when the league returns to Kanto after a
 * Sinnoh title. The user's roster then holds later-gen Pokémon, so the same Kanto fives need a little more to feel the
 * same. Fixed per slot, added in `bringBackKanto`; a new franchise does not use it.
 */
export const KANTO_RETURN_BUMP: readonly number[] = [1, 1, 2, 2, 2, 2, 1, 2, 2];

/** The franchise draft pool. `open` missing means no limit (Quick Play, Season Draft and drafts saved before regions). */
export const poolMons = (open?: readonly string[]): Mon[] => (open ? POKEMON.filter((m) => inPool(m.dex, open)) : [...POKEMON]);
