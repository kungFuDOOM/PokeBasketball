// Home courts: every franchise team plays on its own floor.

export interface CourtStyle {
  /** Arena name shown before tip-off and on the matchup card. */
  venue: string;
  wood: string;
  /** Painted keys. */
  paint: string;
  /** Out-of-bounds border around the floor. */
  apron: string;
  lines: string;
  /** Center circle logo: the Poké Ball, or a badge name (see src/ui/badges.ts). */
  logo: string;
  /** Painted on the floor near the far sideline. */
  floorText: string;
  /** Scrolling LED sign along the far sideline. */
  board: string;
  boardColor: string;
  /** Shirt colors in the stands, home colors first. */
  crowd: string[];
}

const STANDS = ['#f4f1e8', '#2a2f55', '#ffcb05', '#e3350d'];

export const COURTS: Record<string, CourtStyle> = {
  'Pallet Town': {
    venue: 'Pallet Town Gym', wood: '#d99a5b', paint: '#3b6fd8', apron: '#16224a', lines: '#faf7ee', logo: 'pokeball',
    floorText: 'PALLET TOWN', board: 'WELCOME TO PALLET TOWN ★ PROF. OAK\'S LAB ★ WHERE IT ALL BEGINS', boardColor: '#7aa2ff',
    crowd: ['#3b6fd8', '#3b6fd8', '#f4f1e8', '#e3350d', '#ffcb05'],
  },
  'Pewter Boulders': {
    venue: 'Pewter City Gym', wood: '#b9a789', paint: '#7d6e55', apron: '#2e271b', lines: '#f2ece0', logo: 'Boulder',
    floorText: 'PEWTER CITY', board: 'PEWTER CITY ★ PEWTER MUSEUM OF SCIENCE ★ ROCK SOLID DEFENSE', boardColor: '#d8c9a8',
    crowd: ['#a38c63', '#8d939c', '#5a4d38', '#f4f1e8'],
  },
  'Cerulean Cascades': {
    venue: 'Cerulean City Gym', wood: '#86c6dc', paint: '#1f7fa8', apron: '#0b2c38', lines: '#ffffff', logo: 'Cascade',
    floorText: 'CERULEAN CITY', board: 'CERULEAN CITY ★ CERULEAN CAPE ★ MAKE A SPLASH', boardColor: '#7fe0ff',
    crowd: ['#2bb3d6', '#3fa9f5', '#ffffff', '#f2668b'],
  },
  'Vermilion Thunder': {
    venue: 'Vermilion City Gym', wood: '#e2aa5c', paint: '#2b2b2b', apron: '#3a2f06', lines: '#f6d23a', logo: 'Thunder',
    floorText: 'VERMILION CITY', board: 'VERMILION CITY ★ S.S. ANNE ★ SHOCK THE CROWD', boardColor: '#f6d23a',
    crowd: ['#f2c522', '#2b2b2b', '#f2c522', '#f6a623'],
  },
  'Celadon Rainbows': {
    venue: 'Celadon City Gym', wood: '#d8b27b', paint: '#4f9e4f', apron: '#13301a', lines: '#fbf6e8', logo: 'Rainbow',
    floorText: 'CELADON CITY', board: 'CELADON CITY ★ CELADON DEPT. STORE ★ IN FULL BLOOM', boardColor: '#9be37b',
    crowd: ['#5cb85c', '#e8483c', '#f5c518', '#3b82f6'],
  },
  'Fuchsia Ninjas': {
    venue: 'Fuchsia City Gym', wood: '#a98a9c', paint: '#7d2d8e', apron: '#2d1236', lines: '#f6ecf7', logo: 'Soul',
    floorText: 'FUCHSIA CITY', board: 'FUCHSIA CITY ★ SAFARI ZONE ★ NINJA DEFENSE', boardColor: '#e59bf2',
    crowd: ['#b04fc4', '#ec5fa1', '#2d1236', '#f4f1e8'],
  },
  'Saffron Psychics': {
    venue: 'Saffron City Gym', wood: '#e4b583', paint: '#d94f78', apron: '#3a1220', lines: '#fff4f7', logo: 'Marsh',
    floorText: 'SAFFRON CITY', board: 'SAFFRON CITY ★ SILPH CO. ★ MIND GAMES', boardColor: '#ff9ab8',
    crowd: ['#f2668b', '#e2b93b', '#f4f1e8', '#a33ea1'],
  },
  'Cinnabar Volcanoes': {
    venue: 'Cinnabar Island Gym', wood: '#8c4c33', paint: '#d4421c', apron: '#3d160b', lines: '#ffd2a8', logo: 'Volcano',
    floorText: 'CINNABAR ISLAND', board: 'CINNABAR ISLAND ★ POKéMON LAB ★ FEEL THE HEAT', boardColor: '#ff8a4a',
    crowd: ['#e8622c', '#e2452b', '#ffb347', '#2b2b2b'],
  },
  'Viridian Quakes': {
    venue: 'Viridian City Gym', wood: '#b79c69', paint: '#55702a', apron: '#1e2a0e', lines: '#f4f0dc', logo: 'Earth',
    floorText: 'VIRIDIAN CITY', board: 'VIRIDIAN CITY ★ VIRIDIAN FOREST ★ THE EARTH SHAKES', boardColor: '#a8d46a',
    crowd: ['#7c9a3a', '#4fae4a', '#2b2b2b', '#e3350d'],
  },
  'Indigo Elite': {
    venue: 'Indigo Plateau', wood: '#2c2650', paint: '#4a3c8c', apron: '#120f24', lines: '#e8c55a', logo: 'Elite',
    floorText: 'INDIGO PLATEAU', board: 'INDIGO PLATEAU ★ POKéMON LEAGUE ★ FACE THE ELITE FOUR', boardColor: '#e8c55a',
    crowd: ['#d4a017', '#4a3c8c', '#f4f1e8', '#d4a017'],
  },
};

/** The user's floor: the Pallet Town design, renamed for their team. */
export function userCourt(name: string): CourtStyle {
  const n = name.toUpperCase();
  return { ...COURTS['Pallet Town'], venue: `${name} Arena`, floorText: n, board: `HOME OF THE ${n} ★ PALLET TOWN ★ WHERE IT ALL BEGINS` };
}

/** A team's home court; teams without a designed floor get a classic one in their colors. */
export function courtFor(team: { name: string; color: string; color2: string }): CourtStyle {
  return COURTS[team.name] ?? {
    venue: `${team.name} Arena`, wood: '#d99a5b', paint: team.color, apron: team.color2, lines: '#faf7ee', logo: 'pokeball',
    floorText: team.name.toUpperCase(), board: `${team.name.toUpperCase()} ★ POKé JAM ★ SILPH CO. ★ POKé MART`, boardColor: '#ffcb05',
    crowd: [team.color, team.color, ...STANDS],
  };
}
